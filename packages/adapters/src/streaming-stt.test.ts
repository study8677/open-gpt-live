import assert from "node:assert/strict";
import { test } from "vitest";

import {
  OpenAIRealtimeSTTProvider,
  type StreamingSTTWebSocket
} from "./streaming-stt";

type FakeSocketEvent = "open" | "message" | "error" | "close";

class FakeSocket implements StreamingSTTWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<FakeSocketEvent, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(
    event: "close",
    listener: (code: number, reason: unknown) => void
  ): this;
  on(
    event: FakeSocketEvent,
    listener:
      | (() => void)
      | ((data: unknown) => void)
      | ((code: number, reason: unknown) => void)
  ): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(event: object): void {
    this.emit("message", JSON.stringify(event));
  }

  private emit(event: FakeSocketEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

test("opens an OpenAI transcription session and maps transcript events", async () => {
  const socket = new FakeSocket();
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  const provider = new OpenAIRealtimeSTTProvider({
    apiKey: "test-key",
    language: "en",
    delay: "low",
    webSocketFactory: (url, options) => {
      requestedUrl = url;
      requestedHeaders = options.headers;
      return socket;
    }
  });

  const pendingSession = provider.createSession({ language: "zh" });
  socket.open();
  const session = await pendingSession;

  assert.equal(
    requestedUrl,
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-whisper"
  );
  assert.deepEqual(requestedHeaders, { Authorization: "Bearer test-key" });
  assert.deepEqual(JSON.parse(socket.sent[0] ?? "{}"), {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: {
            model: "gpt-realtime-whisper",
            language: "zh",
            delay: "low"
          },
          turn_detection: null
        }
      }
    }
  });

  session.appendAudio(Uint8Array.from([0, 1, 2, 255]));
  session.commit();
  assert.deepEqual(JSON.parse(socket.sent[1] ?? "{}"), {
    type: "input_audio_buffer.append",
    audio: "AAEC/w=="
  });
  assert.deepEqual(JSON.parse(socket.sent[2] ?? "{}"), {
    type: "input_audio_buffer.commit"
  });

  const iterator = session[Symbol.asyncIterator]();
  socket.message({
    type: "conversation.item.input_audio_transcription.delta",
    event_id: "event-1",
    item_id: "item-1",
    content_index: 0,
    delta: "你好"
  });
  socket.message({
    type: "conversation.item.input_audio_transcription.completed",
    event_id: "event-2",
    item_id: "item-1",
    content_index: 0,
    transcript: "你好。"
  });
  socket.message({
    type: "error",
    event_id: "event-3",
    error: { code: "bad_audio", message: "Audio was invalid" }
  });

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "delta",
      itemId: "item-1",
      contentIndex: 0,
      delta: "你好",
      providerEventId: "event-1"
    }
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "completed",
      itemId: "item-1",
      contentIndex: 0,
      transcript: "你好。",
      providerEventId: "event-2"
    }
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "error",
      code: "bad_audio",
      message: "Audio was invalid",
      providerEventId: "event-3"
    }
  });

  session.close();
  assert.equal((await iterator.next()).done, true);
  assert.deepEqual(socket.closeCalls, [
    { code: 1000, reason: "client closed" }
  ]);
});

test("rejects an empty commit without sending it", async () => {
  const socket = new FakeSocket();
  const provider = new OpenAIRealtimeSTTProvider({
    apiKey: "test-key",
    webSocketFactory: () => socket
  });

  const pendingSession = provider.createSession();
  socket.open();
  const session = await pendingSession;

  assert.throws(() => session.commit(), /empty realtime STT audio buffer/);
  assert.equal(socket.sent.length, 1);
  session.close();
});

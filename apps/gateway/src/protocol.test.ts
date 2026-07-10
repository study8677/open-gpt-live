import assert from "node:assert/strict";
import {
  WS_EVENTS,
  parseClientMessage,
  parseServerMessage
} from "@open-gpt-live/protocol";
import { test } from "vitest";

test("parseClientMessage accepts a complete audio chunk", () => {
  const result = parseClientMessage({
    type: WS_EVENTS.AUDIO_CHUNK,
    requestId: "audio-1",
    chunk: "AQID",
    mimeType: "audio/webm",
    sequence: 0,
    isFinal: true,
    turnMode: "ptt"
  });

  assert.deepEqual(result, {
    success: true,
    data: {
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: "audio-1",
      chunk: "AQID",
      mimeType: "audio/webm",
      sequence: 0,
      isFinal: true,
      turnMode: "ptt"
    }
  });
});

test("parseClientMessage rejects non-object and unknown messages", () => {
  assert.deepEqual(parseClientMessage(null), {
    success: false,
    error: "message must be a JSON object"
  });
  assert.deepEqual(parseClientMessage({ type: "future.event" }), {
    success: false,
    error: "unsupported message type: future.event"
  });
});

test("parseClientMessage rejects missing and invalid required fields", () => {
  assert.deepEqual(
    parseClientMessage({ type: WS_EVENTS.USER_TEXT, requestId: "request-1" }),
    { success: false, error: "user.text text must be a string" }
  );
  assert.deepEqual(
    parseClientMessage({
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: "audio-1",
      mimeType: "audio/webm",
      sequence: -1
    }),
    {
      success: false,
      error: "audio.chunk sequence must be a non-negative integer"
    }
  );
  assert.deepEqual(
    parseClientMessage({
      type: WS_EVENTS.VAD_SPEECH_END,
      requestId: "audio-1",
      endedAt: 42,
      reason: "unknown"
    }),
    {
      success: false,
      error: "vad.speech_end reason must be silence, manual, or cancelled"
    }
  );
});

test("parseServerMessage validates Gateway messages before browser state", () => {
  assert.deepEqual(
    parseServerMessage({
      type: WS_EVENTS.TTS_CHUNK,
      requestId: "reply-1",
      sequence: 0,
      chunk: "AQID",
      mimeType: "audio/mpeg",
      segmentIndex: 0,
      isFinal: true
    }),
    {
      success: true,
      data: {
        type: WS_EVENTS.TTS_CHUNK,
        requestId: "reply-1",
        sequence: 0,
        chunk: "AQID",
        mimeType: "audio/mpeg",
        segmentIndex: 0,
        isFinal: true
      }
    }
  );

  assert.deepEqual(
    parseServerMessage({
      type: WS_EVENTS.LLM_DONE,
      requestId: "reply-1",
      reason: "future"
    }),
    {
      success: false,
      error: "llm.done requires requestId and a valid reason"
    }
  );
});

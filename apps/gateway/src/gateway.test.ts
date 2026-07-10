import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import type {
  LLMMessage,
  LLMProvider,
  STTProvider,
  StreamingSTTEvent,
  StreamingSTTSession,
  TTSProvider
} from "@open-gpt-live/adapters";
import {
  WS_EVENTS,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import {
  createGatewayServer,
  type GatewayProviders,
  type GatewayServerOptions
} from "./gateway.js";

test("gateway exposes a no-store health endpoint", async () => {
  const server = await createGatewayServer({
    port: 0,
    providers: defaultProviders(),
    healthDetails: { version: "test", realtimeStt: false }
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.service, "open-gpt-live-gateway");
    assert.equal(body.connections, 0);
    assert.equal(body.version, "test");
    assert.equal(body.realtimeStt, false);
    assert.equal(typeof body.uptimeSeconds, "number");
  } finally {
    await server.close();
  }
});

test("gateway returns deterministic errors for malformed client messages", async () => {
  await withGateway(defaultProviders(), {}, async (client) => {
    client.sendRaw("{");
    await client.waitFor(
      (message) =>
        message.type === "error" && message.message === "Invalid JSON message"
    );

    client.send({ type: "future.event" });
    await client.waitFor(
      (message) =>
        message.type === "error" &&
        message.message.includes("unsupported message type: future.event")
    );

    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "missing-text" });
    await client.waitFor(
      (message) =>
        message.type === "error" &&
        message.message.includes("user.text text must be a string")
    );
  });
});

test("a malformed WebSocket frame cannot terminate the gateway process", async () => {
  const server = await createGatewayServer({
    port: 0,
    providers: defaultProviders()
  });
  const rawSocket = createConnection({ host: "127.0.0.1", port: server.port });
  rawSocket.on("error", () => undefined);

  try {
    await once(rawSocket, "connect");
    rawSocket.write(
      [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n")
    );
    const [handshake] = (await once(rawSocket, "data")) as [Buffer];
    assert.match(handshake.toString(), /^HTTP\/1\.1 101 /);

    const rejected = Promise.race([
      once(rawSocket, "data"),
      once(rawSocket, "close")
    ]);
    // FIN + RSV1 + text with no negotiated extension. The empty payload is
    // correctly masked, so RSV1 is the protocol violation under test.
    rawSocket.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));
    await rejected;
    rawSocket.destroy();

    const healthyClient = await TestClient.connect(server.port);
    try {
      healthyClient.send({
        type: WS_EVENTS.USER_TEXT,
        requestId: "after-malformed-frame",
        text: "still alive"
      });
      await healthyClient.waitFor(isDone("after-malformed-frame", "stop"));
    } finally {
      await healthyClient.close();
    }
  } finally {
    rawSocket.destroy();
    await server.close();
  }
});

test("text turns preserve event order and connection history", async () => {
  const calls: LLMMessage[][] = [];
  const llm: LLMProvider = {
    async *streamText(messages) {
      calls.push(messages.map((message) => ({ ...message })));
      yield { delta: calls.length === 1 ? "first reply" : "second reply" };
    }
  };

  await withGateway(defaultProviders({ llm }), {}, async (client) => {
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "text-1",
      text: "hello"
    });
    await client.waitFor(isDone("text-1", "stop"));

    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "text-2",
      text: "again"
    });
    await client.waitFor(isDone("text-2", "stop"));

    assert.deepEqual(typesFor(client.messages, "text-1"), [
      WS_EVENTS.LLM_DELTA,
      WS_EVENTS.LLM_DONE
    ]);
    assert.deepEqual(
      calls[1]?.map(({ role, content }) => `${role}:${content}`),
      [
        "system:You are OpenGPT Live, a concise realtime AI assistant. Answer clearly and keep context from the conversation.",
        "user:hello",
        "assistant:first reply",
        "user:again"
      ]
    );
  });
});

test("push-to-talk chunks aggregate before final transcription", async () => {
  const audioInputs: number[][] = [];
  const stt: STTProvider = {
    async transcribe(input) {
      audioInputs.push([...input.data]);
      return { text: "spoken words" };
    }
  };

  await withGateway(defaultProviders({ stt }), {}, async (client) => {
    client.send(audioChunk("ptt-1", [1, 2], 0, false, "ptt"));
    client.send(audioChunk("ptt-1", [3, 4], 1, true, "ptt"));

    await client.waitFor(isDone("ptt-1", "stop"));
    assert.deepEqual(audioInputs, [[1, 2, 3, 4]]);
    assert.deepEqual(typesFor(client.messages, "ptt-1"), [
      WS_EVENTS.TRANSCRIPT_FINAL,
      WS_EVENTS.LLM_DELTA,
      WS_EVENTS.LLM_DONE
    ]);
  });
});

test("oversized audio is rejected and its turn state is cleared", async () => {
  const audioInputs: number[][] = [];
  const stt: STTProvider = {
    async transcribe(input) {
      audioInputs.push([...input.data]);
      return { text: "small audio" };
    }
  };

  await withGateway(
    defaultProviders({ stt }),
    { maxAudioTurnBytes: 4 },
    async (client) => {
      client.send(audioChunk("limit-1", [1, 2, 3, 4, 5], 0, true, "ptt"));
      await client.waitFor(isDone("limit-1", "error"));

      client.send(audioChunk("limit-1", [9], 0, true, "ptt"));
      await client.waitFor(
        (message) =>
          message.type === WS_EVENTS.TRANSCRIPT_FINAL &&
          message.requestId === "limit-1"
      );

      assert.deepEqual(audioInputs, [[9]]);
      const error = client.messages.find(
        (message) =>
          message.type === "error" && message.requestId === "limit-1"
      );
      assert.equal(
        error?.type === "error" ? error.message : undefined,
        "Audio turn is too large to transcribe"
      );
    }
  );
});

test("live chunks are dispatched before speech end and emit partial then final text", async () => {
  const audioInputs: number[][] = [];
  let nowCalls = 0;
  const stt: STTProvider = {
    async transcribe(input) {
      audioInputs.push([...input.data]);
      return { text: audioInputs.length === 1 ? "partial" : "final" };
    }
  };

  await withGateway(
    defaultProviders({ stt }),
    {
      now: () => (nowCalls++ === 0 ? 0 : 3_000),
      livePartialInitialIntervalMs: 1,
      livePartialLongTurnIntervalMs: 1,
      livePartialLongTurnAfterMs: 10_000
    },
    async (client) => {
      client.send({
        type: WS_EVENTS.VAD_SPEECH_START,
        requestId: "live-1",
        turnMode: "live",
        startedAt: 0
      });
      client.send(audioChunk("live-1", [7, 8], 0, false, "live"));
      await client.waitFor(
        (message) =>
          message.type === WS_EVENTS.TRANSCRIPT_PARTIAL &&
          message.requestId === "live-1"
      );
      client.send({
        type: WS_EVENTS.VAD_SPEECH_END,
        requestId: "live-1",
        endedAt: 3_100,
        reason: "silence"
      });

      await client.waitFor(isDone("live-1", "stop"));
      assert.deepEqual(audioInputs, [
        [7, 8],
        [7, 8]
      ]);
      assert.deepEqual(typesFor(client.messages, "live-1"), [
        WS_EVENTS.TRANSCRIPT_PARTIAL,
        WS_EVENTS.TRANSCRIPT_FINAL,
        WS_EVENTS.LLM_DELTA,
        WS_EVENTS.LLM_DONE
      ]);
    }
  );
});

test("live PCM is appended to streaming STT and uses its partial and final transcript", async () => {
  const session = new MockStreamingSTTSession("你好", "你好，世界");
  let batchCalls = 0;
  const providers = defaultProviders({
    stt: {
      async transcribe() {
        batchCalls += 1;
        return { text: "batch fallback" };
      }
    },
    streamingStt: {
      async createSession() {
        return session;
      }
    }
  });

  await withGateway(providers, {}, async (client) => {
    client.send({
      type: WS_EVENTS.VAD_SPEECH_START,
      requestId: "streaming-live",
      turnMode: "live",
      startedAt: 1
    });
    client.send(
      audioChunk(
        "streaming-live",
        [1, 0, 2, 0],
        0,
        false,
        "live",
        "audio/pcm;rate=24000"
      )
    );
    client.send(
      audioChunk(
        "streaming-live",
        [],
        1,
        true,
        "live",
        "audio/pcm;rate=24000"
      )
    );
    client.send({
      type: WS_EVENTS.VAD_SPEECH_END,
      requestId: "streaming-live",
      endedAt: 100,
      reason: "silence"
    });

    await client.waitFor(isDone("streaming-live", "stop"));
    assert.deepEqual(session.appended, [[1, 0, 2, 0]]);
    assert.equal(session.commits, 1);
    assert.equal(batchCalls, 0);
    assert.deepEqual(typesFor(client.messages, "streaming-live"), [
      WS_EVENTS.TRANSCRIPT_PARTIAL,
      WS_EVENTS.TRANSCRIPT_FINAL,
      WS_EVENTS.LLM_DELTA,
      WS_EVENTS.LLM_DONE
    ]);
  });
});

test("failed streaming STT falls back to a valid PCM WAV batch transcription", async () => {
  const inputs: Array<{ data: Uint8Array; mimeType: string; filename?: string }> = [];
  const providers = defaultProviders({
    stt: {
      async transcribe(input) {
        inputs.push(input);
        return { text: "batch recovered" };
      }
    },
    streamingStt: {
      async createSession() {
        throw new Error("realtime unavailable");
      }
    }
  });

  await withGateway(providers, {}, async (client) => {
    client.send({
      type: WS_EVENTS.VAD_SPEECH_START,
      requestId: "streaming-fallback",
      turnMode: "live",
      startedAt: 1
    });
    client.send(
      audioChunk(
        "streaming-fallback",
        [1, 0, 2, 0],
        0,
        false,
        "live",
        "audio/pcm;rate=24000"
      )
    );
    client.send({
      type: WS_EVENTS.VAD_SPEECH_END,
      requestId: "streaming-fallback",
      endedAt: 100,
      reason: "silence"
    });

    await client.waitFor(isDone("streaming-fallback", "stop"));
    assert.ok(inputs.length >= 1);
    const finalInput = inputs.at(-1);
    assert.equal(finalInput?.mimeType, "audio/wav");
    assert.equal(finalInput?.filename, "recording.wav");
    assert.equal(
      Buffer.from(finalInput?.data ?? []).subarray(0, 4).toString(),
      "RIFF"
    );
    assert.equal(finalInput?.data.byteLength, 48);
  });
});

test("an empty realtime transcript falls back to batch STT", async () => {
  const session = new MockStreamingSTTSession("", "");
  let batchCalls = 0;
  await withGateway(
    defaultProviders({
      streamingStt: {
        async createSession() {
          return session;
        }
      },
      stt: {
        async transcribe() {
          batchCalls += 1;
          return { text: "batch transcript" };
        }
      }
    }),
    {},
    async (client) => {
      client.send({
        type: WS_EVENTS.VAD_SPEECH_START,
        requestId: "empty-realtime",
        turnMode: "live",
        startedAt: 1
      });
      client.send(
        audioChunk(
          "empty-realtime",
          [1, 0],
          0,
          false,
          "live",
          "audio/pcm;rate=24000"
        )
      );
      client.send({
        type: WS_EVENTS.VAD_SPEECH_END,
        requestId: "empty-realtime",
        endedAt: 100,
        reason: "silence"
      });

      await client.waitFor(isDone("empty-realtime", "stop"));
      assert.equal(batchCalls, 1);
      const final = client.messages.find(
        (message) =>
          message.type === WS_EVENTS.TRANSCRIPT_FINAL &&
          message.requestId === "empty-realtime"
      );
      assert.equal(
        final?.type === WS_EVENTS.TRANSCRIPT_FINAL ? final.text : undefined,
        "batch transcript"
      );
    }
  );
});

test("a cancelled live turn never reaches STT or LLM and releases its request id", async () => {
  let sttCalls = 0;
  let llmCalls = 0;
  const providers = defaultProviders({
    stt: {
      async transcribe() {
        sttCalls += 1;
        return { text: "new turn" };
      }
    },
    llm: {
      async *streamText() {
        llmCalls += 1;
        yield { delta: "reply" };
      }
    }
  });

  await withGateway(providers, {}, async (client) => {
    client.send({
      type: WS_EVENTS.VAD_SPEECH_START,
      requestId: "cancelled-live",
      turnMode: "live",
      startedAt: 1
    });
    client.send(audioChunk("cancelled-live", [1, 0], 0, false, "live"));
    client.send({
      type: WS_EVENTS.VAD_SPEECH_END,
      requestId: "cancelled-live",
      endedAt: 10,
      reason: "cancelled"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sttCalls, 0);
    assert.equal(llmCalls, 0);

    client.send(audioChunk("cancelled-live", [9], 0, true, "ptt"));
    await client.waitFor(isDone("cancelled-live", "stop"));
    assert.equal(sttCalls, 1);
    assert.equal(llmCalls, 1);
  });
});

test("interrupt clears an unfinished push-to-talk audio turn", async () => {
  const inputs: number[][] = [];
  const providers = defaultProviders({
    stt: {
      async transcribe(input) {
        inputs.push([...input.data]);
        return { text: "clean turn" };
      }
    }
  });

  await withGateway(providers, {}, async (client) => {
    client.send(audioChunk("cancelled-ptt", [1, 2], 0, false, "ptt"));
    client.send({
      type: WS_EVENTS.INTERRUPT,
      requestId: "cancelled-ptt",
      reason: "cancel recording"
    });
    client.send(audioChunk("cancelled-ptt", [9], 0, true, "ptt"));
    await client.waitFor(isDone("cancelled-ptt", "stop"));
    assert.deepEqual(inputs, [[9]]);
  });
});

test("interrupt after realtime commit does not trigger batch STT fallback", async () => {
  const session = new HangingStreamingSTTSession();
  let batchCalls = 0;
  let llmCalls = 0;
  await withGateway(
    defaultProviders({
      streamingStt: {
        async createSession() {
          return session;
        }
      },
      stt: {
        async transcribe() {
          batchCalls += 1;
          return { text: "should not run" };
        }
      },
      llm: {
        async *streamText() {
          llmCalls += 1;
          yield { delta: "should not run" };
        }
      }
    }),
    { streamingSttFinalTimeoutMs: 30 },
    async (client) => {
      client.send({
        type: WS_EVENTS.VAD_SPEECH_START,
        requestId: "cancel-after-commit",
        turnMode: "live",
        startedAt: 1
      });
      client.send(
        audioChunk(
          "cancel-after-commit",
          [1, 0],
          0,
          false,
          "live",
          "audio/pcm;rate=24000"
        )
      );
      client.send({
        type: WS_EVENTS.VAD_SPEECH_END,
        requestId: "cancel-after-commit",
        endedAt: 10,
        reason: "silence"
      });
      await waitUntil(() => session.commits === 1);
      client.send({
        type: WS_EVENTS.INTERRUPT,
        requestId: "cancel-after-commit",
        reason: "user cancelled"
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(batchCalls, 0);
      assert.equal(llmCalls, 0);
    }
  );
});

test("interrupt aborts an active LLM request exactly once", async () => {
  let aborted = false;
  const llm: LLMProvider = {
    async *streamText(_messages, options) {
      yield { delta: "started" };
      await waitForAbort(options?.signal);
      aborted = options?.signal?.aborted ?? false;
    }
  };

  await withGateway(defaultProviders({ llm }), {}, async (client) => {
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "interrupt-1",
      text: "keep talking"
    });
    await client.waitFor(
      (message) =>
        message.type === WS_EVENTS.LLM_DELTA &&
        message.requestId === "interrupt-1"
    );
    client.send({ type: WS_EVENTS.INTERRUPT, reason: "test" });
    await client.waitFor(isDone("interrupt-1", "interrupted"));
    await waitUntil(() => aborted);

    assert.equal(
      client.messages.filter(
        (message) =>
          message.type === WS_EVENTS.LLM_DONE &&
          message.requestId === "interrupt-1"
      ).length,
      1
    );
  });
});

test("a new user request interrupts the old run and starts a clean run", async () => {
  let callIndex = 0;
  let firstAborted = false;
  const llm: LLMProvider = {
    async *streamText(_messages, options) {
      const index = callIndex++;
      if (index === 0) {
        yield { delta: "old" };
        await waitForAbort(options?.signal);
        firstAborted = options?.signal?.aborted ?? false;
        return;
      }
      yield { delta: "new" };
    }
  };

  await withGateway(defaultProviders({ llm }), {}, async (client) => {
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "old-run",
      text: "old"
    });
    await client.waitFor(
      (message) =>
        message.type === WS_EVENTS.LLM_DELTA && message.requestId === "old-run"
    );
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "new-run",
      text: "new"
    });

    await client.waitFor(isDone("old-run", "interrupted"));
    await client.waitFor(isDone("new-run", "stop"));
    await waitUntil(() => firstAborted);
    assert.equal(callIndex, 2);
  });
});

test("TTS chunks have monotonic sequence and ordered terminal events", async () => {
  const tts: TTSProvider = {
    async *synthesize() {
      yield audioOutput([1, 2]);
      yield audioOutput([3, 4]);
    }
  };

  await withGateway(defaultProviders({ tts }), {}, async (client) => {
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "tts-1",
      text: "speak"
    });
    await client.waitFor(
      (message) =>
        message.type === WS_EVENTS.TTS_END && message.requestId === "tts-1"
    );

    const messages = client.messages.filter(
      (message) => "requestId" in message && message.requestId === "tts-1"
    );
    assert.deepEqual(messages.map((message) => message.type), [
      WS_EVENTS.LLM_DELTA,
      WS_EVENTS.LLM_DONE,
      WS_EVENTS.TTS_START,
      WS_EVENTS.TTS_CHUNK,
      WS_EVENTS.TTS_END
    ]);
    const chunks = messages.filter(
      (message) => message.type === WS_EVENTS.TTS_CHUNK
    );
    assert.deepEqual(
      chunks.map((message) => message.sequence),
      [0]
    );
    assert.deepEqual(
      chunks.map((message) => message.isFinal),
      [true]
    );
    assert.deepEqual(
      chunks.map((message) => [...Buffer.from(message.chunk, "base64")]),
      [[1, 2, 3, 4]]
    );
  });
});

test("STT errors terminate the turn and allow the request id to be reused", async () => {
  let calls = 0;
  const stt: STTProvider = {
    async transcribe() {
      calls += 1;
      if (calls === 1) throw new Error("mock STT failed");
      return { text: "recovered" };
    }
  };

  await withGateway(defaultProviders({ stt }), {}, async (client) => {
    client.send(audioChunk("stt-error", [1], 0, true, "ptt"));
    await client.waitFor(isDone("stt-error", "error"));
    client.send(audioChunk("stt-error", [2], 0, true, "ptt"));
    await client.waitFor(
      (message) =>
        message.type === WS_EVENTS.TRANSCRIPT_FINAL &&
        message.requestId === "stt-error"
    );
    assert.equal(calls, 2);
  });
});

test("LLM errors clear the active run before the next request", async () => {
  let calls = 0;
  const llm: LLMProvider = {
    async *streamText() {
      calls += 1;
      if (calls === 1) throw new Error("mock LLM failed");
      yield { delta: "recovered" };
    }
  };

  await withGateway(defaultProviders({ llm }), {}, async (client) => {
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "llm-error",
      text: "fail"
    });
    await client.waitFor(isDone("llm-error", "error"));
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "llm-retry",
      text: "retry"
    });
    await client.waitFor(isDone("llm-retry", "stop"));
    assert.equal(calls, 2);
    assert.equal(typesFor(client.messages, "llm-error").at(-1), WS_EVENTS.LLM_DONE);
  });
});

test("TTS errors emit error termination and do not leave an active run", async () => {
  let calls = 0;
  const tts: TTSProvider = {
    async *synthesize() {
      calls += 1;
      if (calls === 1) throw new Error("mock TTS failed");
      yield audioOutput([5]);
    }
  };

  await withGateway(defaultProviders({ tts }), {}, async (client) => {
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "tts-error",
      text: "fail"
    });
    await client.waitFor(
      (message) =>
        message.type === WS_EVENTS.TTS_END &&
        message.requestId === "tts-error" &&
        message.reason === "error"
    );
    client.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "tts-retry",
      text: "retry"
    });
    await client.waitFor(
      (message) =>
        message.type === WS_EVENTS.TTS_END &&
        message.requestId === "tts-retry" &&
        message.reason === "stop"
    );
    assert.equal(calls, 2);
    assert.equal(
      client.messages.some(
        (message) =>
          message.type === "error" &&
          message.requestId === "tts-error" &&
          message.message === "mock TTS failed"
      ),
      true
    );
  });
});

test("WebSocket close aborts unfinished LLM and STT provider calls", async () => {
  let llmAborted = false;
  let sttStarted = false;
  let sttAborted = false;
  const llm: LLMProvider = {
    async *streamText(_messages, options) {
      yield { delta: "started" };
      await waitForAbort(options?.signal);
      llmAborted = options?.signal?.aborted ?? false;
    }
  };
  const stt: STTProvider = {
    async transcribe(_input, options) {
      sttStarted = true;
      await waitForAbort(options?.signal);
      sttAborted = options?.signal?.aborted ?? false;
      throw new Error("aborted");
    }
  };

  const server = await createGatewayServer({
    port: 0,
    providers: defaultProviders({ llm, stt })
  });
  const llmClient = await TestClient.connect(server.port);
  const sttClient = await TestClient.connect(server.port);
  try {
    llmClient.send({
      type: WS_EVENTS.USER_TEXT,
      requestId: "disconnect-llm",
      text: "wait"
    });
    await llmClient.waitFor(
      (message) =>
        message.type === WS_EVENTS.LLM_DELTA &&
        message.requestId === "disconnect-llm"
    );
    sttClient.send(audioChunk("disconnect-stt", [1], 0, true, "ptt"));
    await waitUntil(() => sttStarted);

    await Promise.all([llmClient.close(), sttClient.close()]);
    await waitUntil(() => llmAborted && sttAborted);
  } finally {
    await llmClient.close();
    await sttClient.close();
    await server.close();
  }
});

type GatewayOverrides = Partial<GatewayProviders>;
type GatewayTestOptions = Omit<
  GatewayServerOptions,
  "providers" | "port" | "host"
>;

function defaultProviders(overrides: GatewayOverrides = {}): GatewayProviders {
  const llm: LLMProvider =
    overrides.llm ??
    ({
      async *streamText() {
        yield { delta: "mock reply" };
      }
    } satisfies LLMProvider);
  const stt: STTProvider =
    overrides.stt ??
    ({
      async transcribe() {
        return { text: "mock transcript" };
      }
    } satisfies STTProvider);
  return {
    llm,
    stt,
    ...(overrides.streamingStt === undefined
      ? {}
      : { streamingStt: overrides.streamingStt }),
    ...(overrides.tts === undefined ? {} : { tts: overrides.tts })
  };
}

async function withGateway(
  providers: GatewayProviders,
  options: GatewayTestOptions,
  run: (client: TestClient) => Promise<void>
): Promise<void> {
  const server = await createGatewayServer({
    ...options,
    port: 0,
    providers
  });
  const client = await TestClient.connect(server.port);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

class TestClient {
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const listener of this.listeners) listener();
    });
    socket.on("error", () => undefined);
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new TestClient(socket);
    await once(socket, "open");
    await client.waitFor((message) => message.type === WS_EVENTS.SESSION_START);
    return client;
  }

  send(value: unknown): void {
    this.sendRaw(JSON.stringify(value));
  }

  sendRaw(value: string): void {
    this.socket.send(value);
  }

  async waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 2_000
  ): Promise<ServerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    return await new Promise<ServerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(
          new Error(
            `Timed out waiting for message. Received: ${JSON.stringify(this.messages)}`
          )
        );
      }, timeoutMs);
      const check = (): void => {
        const message = this.messages.find(predicate);
        if (!message) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(message);
      };
      this.listeners.add(check);
      check();
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CLOSING) {
      await once(this.socket, "close");
      return;
    }
    this.socket.close();
    await once(this.socket, "close");
  }
}

function audioChunk(
  requestId: string,
  bytes: number[],
  sequence: number,
  isFinal: boolean,
  turnMode: "ptt" | "live",
  mimeType = "audio/webm"
): Record<string, unknown> {
  return {
    type: WS_EVENTS.AUDIO_CHUNK,
    requestId,
    chunk: Buffer.from(bytes).toString("base64"),
    mimeType,
    sequence,
    isFinal,
    turnMode
  };
}

class MockStreamingSTTSession implements StreamingSTTSession {
  readonly inputFormat = {
    encoding: "pcm_s16le" as const,
    sampleRateHz: 24000 as const,
    channels: 1 as const
  };
  readonly appended: number[][] = [];
  commits = 0;
  private readonly events: StreamingSTTEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<StreamingSTTEvent>) => void
  > = [];
  private closed = false;

  constructor(
    private readonly partial: string,
    private readonly final: string
  ) {}

  appendAudio(audio: Uint8Array): void {
    this.appended.push([...audio]);
  }

  commit(): void {
    this.commits += 1;
    if (this.partial) {
      this.push({
        type: "delta",
        itemId: "item-1",
        contentIndex: 0,
        delta: this.partial
      });
    }
    this.push({
      type: "completed",
      itemId: "item-1",
      contentIndex: 0,
      transcript: this.final
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamingSTTEvent> {
    return {
      next: async () => {
        const event = this.events.shift();
        if (event) {
          return { value: event, done: false };
        }
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<StreamingSTTEvent>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }

  private push(event: StreamingSTTEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.events.push(event);
  }
}

class HangingStreamingSTTSession implements StreamingSTTSession {
  readonly inputFormat = {
    encoding: "pcm_s16le" as const,
    sampleRateHz: 24000 as const,
    channels: 1 as const
  };
  commits = 0;
  private closed = false;
  private readonly waiters: Array<
    (result: IteratorResult<StreamingSTTEvent>) => void
  > = [];

  appendAudio(): void {}

  commit(): void {
    this.commits += 1;
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamingSTTEvent> {
    return {
      next: async () => {
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<StreamingSTTEvent>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}

function audioOutput(bytes: number[]): {
  audio: Uint8Array;
  mimeType: string;
  format: string;
} {
  return {
    audio: Uint8Array.from(bytes),
    mimeType: "audio/mpeg",
    format: "mp3"
  };
}

function isDone(
  requestId: string,
  reason: "stop" | "interrupted" | "error"
): (message: ServerMessage) => boolean {
  return (message) =>
    message.type === WS_EVENTS.LLM_DONE &&
    message.requestId === requestId &&
    message.reason === reason;
}

function typesFor(messages: ServerMessage[], requestId: string): string[] {
  return messages
    .filter((message) => "requestId" in message && message.requestId === requestId)
    .map((message) => message.type);
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

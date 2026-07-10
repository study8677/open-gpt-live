import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  OpenAILLMProvider,
  OpenAITTSProvider,
  OpenAIWhisperProvider,
  isOpenAIHostedUrl
} from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("recognizes only the hosted OpenAI API as credential-required", () => {
  assert.equal(isOpenAIHostedUrl("https://api.openai.com/v1"), true);
  assert.equal(isOpenAIHostedUrl("https://API.OPENAI.COM/v1/"), true);
  assert.equal(isOpenAIHostedUrl("http://ollama:11434/v1"), false);
  assert.equal(isOpenAIHostedUrl("http://speaches:8000/v1"), false);
  assert.equal(isOpenAIHostedUrl("not a URL"), true);
});

test("hosted OpenAI adapters still reject missing credentials", async () => {
  stubEmptyProviderKeys();
  const llm = new OpenAILLMProvider({ apiKey: "", baseUrl: "https://api.openai.com/v1" });
  await assert.rejects(
    async () => {
      for await (const _chunk of llm.streamText([{ role: "user", content: "hi" }])) {
        // The iterator must be advanced before an async generator executes.
      }
    },
    /OPENAI_API_KEY is required/
  );

  const stt = new OpenAIWhisperProvider({
    apiKey: "",
    baseUrl: "https://api.openai.com/v1"
  });
  await assert.rejects(
    stt.transcribe({ data: new Uint8Array([1]), mimeType: "audio/wav" }),
    /STT_API_KEY or OPENAI_API_KEY is required/
  );

  const tts = new OpenAITTSProvider({
    apiKey: "",
    baseUrl: "https://api.openai.com/v1"
  });
  await assert.rejects(
    async () => {
      for await (const _chunk of tts.synthesize({ text: "hi" })) {
        // The iterator must be advanced before an async generator executes.
      }
    },
    /TTS_API_KEY or OPENAI_API_KEY is required/
  );
});

test("keyless self-hosted adapters omit Authorization and preserve OpenAI contracts", async () => {
  stubEmptyProviderKeys();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });

      if (url.endsWith("/chat/completions")) {
        return new Response(
          'data: {"choices":[{"delta":{"content":"local"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      if (url.endsWith("/audio/transcriptions")) {
        return Response.json({ text: "local transcript" });
      }
      if (url.endsWith("/audio/speech")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" }
        });
      }
      return new Response("not found", { status: 404 });
    })
  );

  const llm = new OpenAILLMProvider({
    apiKey: "",
    baseUrl: "http://ollama:11434/v1",
    model: "qwen2.5:1.5b"
  });
  const deltas: string[] = [];
  for await (const chunk of llm.streamText([{ role: "user", content: "hi" }])) {
    deltas.push(chunk.delta);
  }
  assert.deepEqual(deltas, ["local"]);

  const stt = new OpenAIWhisperProvider({
    apiKey: "",
    baseUrl: "http://speaches:8000/v1",
    model: "Systran/faster-whisper-small"
  });
  assert.deepEqual(
    await stt.transcribe({
      data: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      filename: "turn.wav"
    }),
    { text: "local transcript" }
  );

  const tts = new OpenAITTSProvider({
    apiKey: "",
    baseUrl: "http://speaches:8000/v1",
    model: "speaches-ai/Kokoro-82M-v1.0-ONNX",
    voice: "zf_xiaobei",
    format: "mp3"
  });
  assert.equal(tts.configured, true);
  const audio: number[] = [];
  for await (const chunk of tts.synthesize({ text: "你好" })) {
    audio.push(...chunk.audio);
    assert.equal(chunk.mimeType, "audio/mpeg");
  }
  assert.deepEqual(audio, [1, 2, 3]);

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(new Headers(request.init.headers).has("Authorization"), false);
  }

  const sttBody = requests[1]?.init.body;
  assert.ok(sttBody instanceof FormData);
  assert.equal(sttBody.get("model"), "Systran/faster-whisper-small");
  assert.ok(sttBody.get("file") instanceof Blob);

  const ttsBody = JSON.parse(String(requests[2]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(ttsBody, {
    model: "speaches-ai/Kokoro-82M-v1.0-ONNX",
    input: "你好",
    voice: "zf_xiaobei",
    response_format: "mp3"
  });
});

function stubEmptyProviderKeys(): void {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("STT_API_KEY", "");
  vi.stubEnv("TTS_API_KEY", "");
}

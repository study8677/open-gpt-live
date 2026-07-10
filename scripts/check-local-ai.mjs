import assert from "node:assert/strict";

const ollamaUrl = stripTrailingSlash(
  process.env.LOCAL_AI_OLLAMA_URL ?? "http://localhost:11434"
);
const speachesUrl = stripTrailingSlash(
  process.env.LOCAL_AI_SPEACHES_URL ?? "http://localhost:8000"
);
const llmModel = process.env.OPENAI_MODEL ?? "qwen2.5:1.5b";
const sttModel = process.env.STT_MODEL ?? "Systran/faster-whisper-small";
const ttsModel =
  process.env.TTS_MODEL ?? "speaches-ai/Kokoro-82M-v1.0-ONNX";
const ttsVoice = process.env.TTS_VOICE ?? "zf_xiaobei";

await checkHealth();
await checkModels();
await checkStreamingChat();
const synthesizedAudio = await checkSpeechSynthesis();
await checkTranscription(synthesizedAudio);

console.log("local-ai provider smoke check: ok");

async function checkHealth() {
  const [ollama, speaches] = await Promise.all([
    fetchJson(`${ollamaUrl}/api/tags`),
    fetchJson(`${speachesUrl}/health`)
  ]);
  assert.ok(Array.isArray(ollama.models), "Ollama /api/tags returned no models array");
  assert.ok(speaches, "Speaches /health returned an empty response");
  console.log("health: Ollama and Speaches reachable");
}

async function checkModels() {
  const [ollama, speaches] = await Promise.all([
    fetchJson(`${ollamaUrl}/api/tags`),
    fetchJson(`${speachesUrl}/v1/models`)
  ]);
  assert.ok(Array.isArray(ollama.models), "Ollama /api/tags returned no models array");
  assert.ok(Array.isArray(speaches.data), "Speaches /v1/models returned no data array");

  const ollamaModels = ollama.models.map((model) => model.name ?? model.model);
  assert.ok(
    ollamaModels.includes(llmModel),
    `Ollama model ${llmModel} is missing; found: ${ollamaModels.join(", ")}`
  );

  const speechModels = speaches.data.map((model) => model.id);
  assert.ok(
    speechModels.includes(sttModel),
    `Speaches STT model ${sttModel} is missing; found: ${speechModels.join(", ")}`
  );
  assert.ok(
    speechModels.includes(ttsModel),
    `Speaches TTS model ${ttsModel} is missing; found: ${speechModels.join(", ")}`
  );
  console.log("models: LLM, STT, and TTS models installed");
}

async function checkStreamingChat() {
  const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: llmModel,
      messages: [{ role: "user", content: "Reply with only: OK" }],
      stream: true,
      max_tokens: 8
    })
  });
  await assertOk(response, "Ollama streaming Chat Completions");
  const body = await response.text();
  assert.match(body, /^data:/m, "Ollama response was not an SSE stream");
  assert.match(body, /"choices"/, "Ollama stream contained no Chat Completions choice");
  const streamedText = body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)))
    .map((event) => event.choices?.[0]?.delta?.content ?? "")
    .join("");
  assert.ok(streamedText.trim(), "Ollama stream contained no assistant text");
  console.log("llm: OpenAI-compatible streaming response received");
}

async function checkSpeechSynthesis() {
  const response = await fetch(`${speachesUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ttsModel,
      voice: ttsVoice,
      input: "你好，这是本地语音测试。",
      response_format: "mp3"
    })
  });
  await assertOk(response, "Speaches speech synthesis");
  const audio = new Uint8Array(await response.arrayBuffer());
  assert.ok(audio.byteLength > 0, "Speaches returned empty TTS audio");
  console.log(`tts: received ${audio.byteLength} MP3 bytes`);
  return audio;
}

async function checkTranscription(audio) {
  const formData = new FormData();
  formData.append("model", sttModel);
  formData.append("file", new Blob([audio], { type: "audio/mpeg" }), "local-ai-smoke.mp3");
  const response = await fetch(`${speachesUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData
  });
  await assertOk(response, "Speaches transcription");
  const result = await response.json();
  assert.equal(typeof result.text, "string", "Speaches response contained no transcript text");
  assert.ok(result.text.trim(), "Speaches returned an empty transcript");
  console.log(`stt: transcript received (${JSON.stringify(result.text)})`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  await assertOk(response, url);
  return response.json();
}

async function assertOk(response, label) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} failed (${response.status}): ${body}`);
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

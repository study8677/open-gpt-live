import assert from "node:assert/strict";
import { test } from "vitest";
import { loadGatewayRuntimeConfig } from "./config.js";

test("production config fails fast without the LLM API key", () => {
  assert.throws(
    () => loadGatewayRuntimeConfig({ NODE_ENV: "production" }),
    /OPENAI_API_KEY is required/
  );
});

test("production config allows keyless self-hosted HTTP providers", () => {
  const config = loadGatewayRuntimeConfig({
    NODE_ENV: "production",
    OPENAI_BASE_URL: "http://ollama:11434/v1",
    STT_BASE_URL: "http://speaches:8000/v1",
    TTS_BASE_URL: "http://speaches:8000/v1",
    TTS_ENABLED: "true"
  });

  assert.equal(config.ttsEnabled, true);
  assert.equal(config.realtimeSttEnabled, false);
});

test("production config still requires credentials for hosted OpenAI STT and TTS", () => {
  assert.throws(
    () =>
      loadGatewayRuntimeConfig({
        NODE_ENV: "production",
        OPENAI_BASE_URL: "http://ollama:11434/v1",
        STT_BASE_URL: "https://api.openai.com/v1"
      }),
    /STT_API_KEY or OPENAI_API_KEY is required for api\.openai\.com/
  );

  assert.throws(
    () =>
      loadGatewayRuntimeConfig({
        NODE_ENV: "production",
        OPENAI_BASE_URL: "http://ollama:11434/v1",
        STT_BASE_URL: "http://speaches:8000/v1",
        TTS_BASE_URL: "https://api.openai.com/v1",
        TTS_ENABLED: "true"
      }),
    /TTS_API_KEY or OPENAI_API_KEY is required for api\.openai\.com/
  );
});

test("runtime config parses realtime STT, text-only TTS, and origins", () => {
  const config = loadGatewayRuntimeConfig({
    NODE_ENV: "production",
    OPENAI_API_KEY: "test-key",
    GATEWAY_PORT: "9000",
    ALLOWED_ORIGINS: "https://one.example, https://two.example",
    TTS_ENABLED: "false",
    STT_REALTIME_ENABLED: "true",
    STT_REALTIME_LANGUAGE: "zh",
    STT_REALTIME_DELAY: "low"
  });

  assert.equal(config.port, 9000);
  assert.deepEqual(config.allowedOrigins, [
    "https://one.example",
    "https://two.example"
  ]);
  assert.equal(config.ttsEnabled, false);
  assert.equal(config.realtimeSttEnabled, true);
  assert.equal(config.realtimeSttLanguage, "zh");
  assert.equal(config.realtimeSttDelay, "low");
});

test("runtime config rejects invalid boolean and realtime delay values", () => {
  assert.throws(
    () =>
      loadGatewayRuntimeConfig({
        OPENAI_API_KEY: "test-key",
        TTS_ENABLED: "sometimes"
      }),
    /TTS_ENABLED must be true/
  );
  assert.throws(
    () =>
      loadGatewayRuntimeConfig({
        OPENAI_API_KEY: "test-key",
        STT_REALTIME_DELAY: "fastest"
      }),
    /STT_REALTIME_DELAY must be one of/
  );
  assert.throws(
    () =>
      loadGatewayRuntimeConfig({
        OPENAI_API_KEY: "test-key",
        ALLOWED_ORIGINS: "https://example.com/application"
      }),
    /exact http\(s\) origins without paths/
  );
});

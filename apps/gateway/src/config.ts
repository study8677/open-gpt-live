import {
  isOpenAIHostedUrl,
  type OpenAIRealtimeTranscriptionDelay
} from "@open-gpt-live/adapters";

export interface GatewayRuntimeConfig {
  host: string;
  port: number;
  allowedOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  ttsEnabled: boolean;
  ttsFormat: string;
  ttsVoice?: string;
  realtimeSttEnabled: boolean;
  realtimeSttLanguage?: string;
  realtimeSttDelay?: OpenAIRealtimeTranscriptionDelay;
}

const realtimeDelayValues = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const;

export function loadGatewayRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): GatewayRuntimeConfig {
  const port = parseInteger(env.GATEWAY_PORT, 8787, "GATEWAY_PORT", 0, 65_535);
  const production = env.NODE_ENV === "production";
  const openAiApiKey = nonEmpty(env.OPENAI_API_KEY);
  const openAiBaseUrl =
    nonEmpty(env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1";
  const sttApiKey = nonEmpty(env.STT_API_KEY) ?? openAiApiKey;
  const sttBaseUrl = nonEmpty(env.STT_BASE_URL) ?? openAiBaseUrl;
  const ttsApiKey = nonEmpty(env.TTS_API_KEY) ?? openAiApiKey;
  const ttsBaseUrl = nonEmpty(env.TTS_BASE_URL) ?? openAiBaseUrl;

  if (production && isOpenAIHostedUrl(openAiBaseUrl) && !openAiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for api.openai.com when NODE_ENV=production"
    );
  }
  if (production && isOpenAIHostedUrl(sttBaseUrl) && !sttApiKey) {
    throw new Error(
      "STT_API_KEY or OPENAI_API_KEY is required for api.openai.com when NODE_ENV=production"
    );
  }

  const ttsEnabled = parseBoolean(
    env.TTS_ENABLED,
    Boolean(ttsApiKey),
    "TTS_ENABLED"
  );
  if (
    production &&
    ttsEnabled &&
    isOpenAIHostedUrl(ttsBaseUrl) &&
    !ttsApiKey
  ) {
    throw new Error(
      "TTS_API_KEY or OPENAI_API_KEY is required for api.openai.com when TTS_ENABLED=true"
    );
  }

  const realtimeSttEnabled = parseBoolean(
    env.STT_REALTIME_ENABLED,
    false,
    "STT_REALTIME_ENABLED"
  );
  if (realtimeSttEnabled && !sttApiKey) {
    throw new Error(
      "STT_REALTIME_ENABLED requires STT_API_KEY or OPENAI_API_KEY"
    );
  }

  const realtimeSttDelay = optionalEnum(
    env.STT_REALTIME_DELAY,
    realtimeDelayValues,
    "STT_REALTIME_DELAY"
  );
  const logLevel = optionalEnum(
    env.LOG_LEVEL,
    ["debug", "info", "warn", "error"] as const,
    "LOG_LEVEL"
  ) ?? "info";

  return {
    host: nonEmpty(env.GATEWAY_HOST) ?? "0.0.0.0",
    port,
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    logLevel,
    ttsEnabled,
    ttsFormat: nonEmpty(env.TTS_FORMAT) ?? "mp3",
    ...(nonEmpty(env.TTS_VOICE) ? { ttsVoice: nonEmpty(env.TTS_VOICE) } : {}),
    realtimeSttEnabled,
    ...(nonEmpty(env.STT_REALTIME_LANGUAGE)
      ? { realtimeSttLanguage: nonEmpty(env.STT_REALTIME_LANGUAGE) }
      : {}),
    ...(realtimeSttDelay ? { realtimeSttDelay } : {})
  };
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function optionalEnum<const T extends readonly string[]>(
  value: string | undefined,
  choices: T,
  name: string
): T[number] | undefined {
  const normalized = nonEmpty(value);
  if (!normalized) return undefined;
  if (choices.includes(normalized)) return normalized as T[number];
  throw new Error(`${name} must be one of: ${choices.join(", ")}`);
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== entry
    ) {
      throw new Error(
        `ALLOWED_ORIGINS must contain exact http(s) origins without paths: ${entry}`
      );
    }
  }
  return entries;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

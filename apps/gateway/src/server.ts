import {
  OpenAILLMProvider,
  OpenAIRealtimeSTTProvider,
  OpenAITTSProvider,
  OpenAIWhisperProvider,
  type OpenAIRealtimeTranscriptionDelay,
  type StreamingSTTProvider,
  type TTSProvider
} from "@open-gpt-live/adapters";
import { WebSocket } from "ws";
import { loadGatewayRuntimeConfig } from "./config.js";
import { loadProjectEnvironment } from "./environment.js";
import { createGatewayServer } from "./gateway.js";
import { createJsonLogger } from "./logger.js";

loadProjectEnvironment();

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "gateway.start_failed",
      error: error instanceof Error ? error.message : String(error)
    })
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const config = loadGatewayRuntimeConfig();
  const logger = createJsonLogger(config.logLevel);
  const ttsProvider = createTtsProvider(config.ttsEnabled);
  const streamingSttProvider = createStreamingSttProvider(
    config.realtimeSttEnabled,
    config.realtimeSttLanguage,
    config.realtimeSttDelay
  );

  const gateway = await createGatewayServer({
    port: config.port,
    host: config.host,
    allowedOrigins: config.allowedOrigins,
    providers: {
      llm: new OpenAILLMProvider(),
      stt: new OpenAIWhisperProvider(),
      ...(streamingSttProvider === undefined
        ? {}
        : { streamingStt: streamingSttProvider }),
      ...(ttsProvider === undefined ? {} : { tts: ttsProvider })
    },
    ttsFormat: config.ttsFormat,
    ttsVoice: config.ttsVoice,
    logger,
    healthDetails: {
      version: "0.2.0",
      realtimeStt: config.realtimeSttEnabled,
      tts: config.ttsEnabled
    }
  });

  logger.info("gateway.started", {
    host: config.host,
    port: gateway.port,
    health: `http://${config.host}:${gateway.port}/healthz`,
    realtimeStt: config.realtimeSttEnabled,
    tts: config.ttsEnabled
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("gateway.stopping", { signal });
    await gateway.close();
    logger.info("gateway.stopped", { signal });
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function createTtsProvider(enabled: boolean): TTSProvider | undefined {
  if (!enabled) {
    return undefined;
  }
  return new OpenAITTSProvider();
}

function createStreamingSttProvider(
  enabled: boolean,
  language?: string,
  delay?: OpenAIRealtimeTranscriptionDelay
): StreamingSTTProvider | undefined {
  if (!enabled) {
    return undefined;
  }
  return new OpenAIRealtimeSTTProvider({
    webSocketFactory: (url, options) =>
      new WebSocket(url, { headers: options.headers }),
    language,
    delay
  });
}

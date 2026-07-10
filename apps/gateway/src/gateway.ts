import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type {
  LLMMessage,
  LLMProvider,
  STTProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  TTSProvider
} from "@open-gpt-live/adapters";
import {
  WS_EVENTS,
  parseClientMessage,
  type AudioChunkMessage,
  type ClientMessage,
  type LlmDoneMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_MAX_AUDIO_TURN_BYTES = 25 * 1024 * 1024;

const defaultSystemPrompt =
  "You are OpenGPT Live, a concise realtime AI assistant. Answer clearly and keep context from the conversation.";

export interface GatewayProviders {
  llm: LLMProvider;
  stt: STTProvider;
  streamingStt?: StreamingSTTProvider;
  tts?: TTSProvider;
}

export interface GatewayServerOptions {
  providers: GatewayProviders;
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  maxAudioTurnBytes?: number;
  livePartialInitialIntervalMs?: number;
  livePartialLongTurnIntervalMs?: number;
  livePartialLongTurnAfterMs?: number;
  streamingSttFinalTimeoutMs?: number;
  ttsSegmentMinLength?: number;
  ttsSegmentMaxLength?: number;
  ttsFormat?: string;
  ttsVoice?: string;
  systemPrompt?: string;
  createId?: () => string;
  now?: () => number;
  logger?: GatewayLogger;
  healthDetails?: Record<string, string | number | boolean>;
}

export interface GatewayServerHandle {
  readonly webSocketServer: WebSocketServer;
  readonly httpServer: HttpServer;
  readonly port: number;
  close(): Promise<void>;
}

export interface GatewayLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

interface GatewayConfig {
  maxAudioTurnBytes: number;
  livePartialInitialIntervalMs: number;
  livePartialLongTurnIntervalMs: number;
  livePartialLongTurnAfterMs: number;
  streamingSttFinalTimeoutMs: number;
  ttsSegmentMinLength: number;
  ttsSegmentMaxLength: number;
  ttsFormat: string;
  ttsVoice?: string;
  systemPrompt: string;
  createId: () => string;
  now: () => number;
  logger: GatewayLogger;
}

const noopLogger: GatewayLogger = {
  info() {},
  warn() {},
  error() {}
};

interface ActiveRun {
  requestId: string;
  controller: AbortController;
  stage: "llm_streaming" | "tts_streaming" | "done" | "interrupted" | "error";
  text: string;
  interrupted: boolean;
  llmDoneSent: boolean;
  ttsStarted: boolean;
  ttsEnded: boolean;
  ttsSequence: number;
  ttsSegmentIndex: number;
}

interface SessionState {
  sessionId: string;
  history: LLMMessage[];
  current?: ActiveRun;
  audioTurns: Map<string, ActiveAudioTurn>;
}

interface ActiveAudioTurn {
  requestId: string;
  turnMode: "ptt" | "live";
  state: "recording" | "transcribing" | "done" | "error";
  mimeType: string;
  chunks: Buffer[];
  byteLength: number;
  lastSequence: number;
  startedAt: number;
  partialSequence: number;
  lastPartialAt: number;
  partialInFlight: boolean;
  controllers: Set<AbortController>;
  streaming?: ActiveStreamingTranscription;
}

interface ActiveStreamingTranscription {
  controller: AbortController;
  ready: Promise<void>;
  session?: StreamingSTTSession;
  pendingAudio: Buffer[];
  transcript: string;
  finalTranscript?: string;
  error?: Error;
  waiters: Array<{
    resolve: (transcript: string) => void;
    reject: (error: Error) => void;
  }>;
}

export async function createGatewayServer(
  options: GatewayServerOptions
): Promise<GatewayServerHandle> {
  const config: GatewayConfig = {
    maxAudioTurnBytes:
      options.maxAudioTurnBytes ?? DEFAULT_MAX_AUDIO_TURN_BYTES,
    livePartialInitialIntervalMs: options.livePartialInitialIntervalMs ?? 2_000,
    livePartialLongTurnIntervalMs: options.livePartialLongTurnIntervalMs ?? 5_000,
    livePartialLongTurnAfterMs: options.livePartialLongTurnAfterMs ?? 30_000,
    streamingSttFinalTimeoutMs: options.streamingSttFinalTimeoutMs ?? 15_000,
    ttsSegmentMinLength: options.ttsSegmentMinLength ?? 24,
    ttsSegmentMaxLength: options.ttsSegmentMaxLength ?? 240,
    ttsFormat: options.ttsFormat ?? "mp3",
    ttsVoice: options.ttsVoice,
    systemPrompt: options.systemPrompt ?? defaultSystemPrompt,
    createId: options.createId ?? randomUUID,
    now: options.now ?? Date.now,
    logger: options.logger ?? noopLogger
  };

  validateConfig(config);

  const startedAt = Date.now();
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      const body = JSON.stringify({
        status: "ok",
        service: "open-gpt-live-gateway",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        connections: webSocketServer.clients.size,
        ...options.healthDetails
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin }, done) => {
      if (allowedOrigins.size === 0 || !origin || allowedOrigins.has(origin)) {
        done(true);
        return;
      }
      done(false, 403, "Origin is not allowed");
    }
  });

  webSocketServer.on("connection", (socket) => {
    const connection = new GatewayConnection(
      socket,
      options.providers,
      config
    );
    connection.start();
  });

  await listenHttpServer(httpServer, options.port ?? 0, options.host);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeWebSocketServer(webSocketServer);
    await closeHttpServer(httpServer);
    throw new Error("Gateway did not bind to a TCP port");
  }

  return {
    webSocketServer,
    httpServer,
    port: address.port,
    close: async () => {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await closeWebSocketServer(webSocketServer);
      await closeHttpServer(httpServer);
    }
  };
}

class GatewayConnection {
  private readonly session: SessionState;
  private disposed = false;
  private messageQueue = Promise.resolve();

  constructor(
    private readonly socket: WebSocket,
    private readonly providers: GatewayProviders,
    private readonly config: GatewayConfig
  ) {
    this.session = {
      sessionId: config.createId(),
      audioTurns: new Map(),
      history: [{ role: "system", content: config.systemPrompt }]
    };
  }

  start(): void {
    this.config.logger.info("session.connected", {
      sessionId: this.session.sessionId
    });
    this.send({
      type: WS_EVENTS.SESSION_START,
      sessionId: this.session.sessionId,
      status: "ready"
    });

    this.socket.on("message", (raw) => {
      const message = raw.toString();
      this.messageQueue = this.messageQueue
        .then(() => this.handleRawMessage(message))
        .catch((error: unknown) => {
          this.send({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unknown gateway message error"
          });
        });
    });
    this.socket.on("error", (error) => {
      this.config.logger.warn("session.socket_error", {
        sessionId: this.session.sessionId,
        error: error.message
      });
      this.dispose("websocket error");
      if (this.socket.readyState !== WebSocket.CLOSED) {
        this.socket.terminate();
      }
    });
    this.socket.once("close", () => {
      this.dispose("socket closed");
    });
  }

  private handleRawMessage(raw: string): void {
    if (this.disposed) {
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      this.send({ type: "error", message: "Invalid JSON message" });
      return;
    }

    const result = parseClientMessage(input);
    if (!result.success) {
      this.send({
        type: "error",
        message: `Invalid client message: ${result.error}`
      });
      return;
    }

    this.handleMessage(result.data);
  }

  private handleMessage(message: ClientMessage): void {
    if (message.type === WS_EVENTS.SESSION_START) {
      if (message.sessionId) {
        this.session.sessionId = message.sessionId;
      }
      this.send({
        type: WS_EVENTS.SESSION_START,
        sessionId: this.session.sessionId,
        status: "ready"
      });
      return;
    }

    if (message.type === WS_EVENTS.INTERRUPT) {
      if (message.requestId) {
        this.cancelAudioTurn(
          message.requestId,
          message.reason ?? "user interrupt"
        );
      }
      this.interruptCurrentRun(
        message.reason ?? "user interrupt",
        message.requestId
      );
      return;
    }

    if (message.type === WS_EVENTS.PLAYBACK_ACK) {
      return;
    }

    if (message.type === WS_EVENTS.VAD_SPEECH_START) {
      this.startLiveAudioTurn(message.requestId);
      return;
    }

    if (message.type === WS_EVENTS.VAD_SPEECH_END) {
      if (message.reason === "cancelled") {
        this.cancelAudioTurn(message.requestId, "client cancelled live turn");
        return;
      }
      void this.finishLiveAudioTurn(message.requestId);
      return;
    }

    if (message.type === WS_EVENTS.USER_TEXT) {
      const text = message.text.trim();
      if (!text) {
        this.send({
          type: "error",
          message: "user.text requires non-empty text"
        });
        return;
      }
      void this.handleUserText(
        message.requestId ?? this.config.createId(),
        text
      );
      return;
    }

    void this.handleAudioChunk(message);
  }

  private async handleUserText(requestId: string, text: string): Promise<void> {
    if (this.session.current) {
      this.interruptCurrentRun("new user message");
    }

    this.session.history.push({ role: "user", content: text });
    await this.streamAssistantResponse(requestId);
  }

  private async handleAudioChunk(message: AudioChunkMessage): Promise<void> {
    const turn = this.getOrCreateAudioTurn(message);

    if (message.chunk) {
      const chunk = Buffer.from(message.chunk, "base64");
      if (
        turn.byteLength + chunk.byteLength >
        this.config.maxAudioTurnBytes
      ) {
        this.config.logger.warn("audio.rejected", {
          sessionId: this.session.sessionId,
          requestId: message.requestId,
          reason: "size_limit"
        });
        this.deleteAudioTurn(turn, "audio limit exceeded");
        this.send({
          type: "error",
          requestId: message.requestId,
          message: "Audio turn is too large to transcribe"
        });
        this.send({
          type: WS_EVENTS.LLM_DONE,
          requestId: message.requestId,
          reason: "error"
        });
        return;
      }

      turn.chunks.push(chunk);
      turn.byteLength += chunk.byteLength;
      turn.lastSequence = Math.max(turn.lastSequence, message.sequence);
      this.appendStreamingAudio(turn, chunk);
    }

    if (!message.isFinal) {
      this.maybeSchedulePartialTranscription(turn);
      return;
    }

    if (turn.turnMode === "live") {
      return;
    }

    await this.finishAudioTurn(turn);
  }

  private startLiveAudioTurn(requestId: string): void {
    if (this.session.audioTurns.has(requestId)) {
      return;
    }

    const startedAt = this.config.now();
    const turn: ActiveAudioTurn = {
      requestId,
      turnMode: "live",
      state: "recording",
      mimeType: "audio/pcm;rate=24000",
      chunks: [],
      byteLength: 0,
      lastSequence: -1,
      startedAt,
      partialSequence: 0,
      lastPartialAt: startedAt,
      partialInFlight: false,
      controllers: new Set()
    };
    this.session.audioTurns.set(requestId, turn);
    this.beginStreamingTranscription(turn);
  }

  private async finishLiveAudioTurn(requestId: string): Promise<void> {
    const turn = this.session.audioTurns.get(requestId);
    if (!turn || turn.turnMode !== "live" || turn.state !== "recording") {
      return;
    }
    if (turn.streaming) {
      try {
        const transcript = await this.finishStreamingTranscription(turn);
        if (
          transcript &&
          !this.disposed &&
          this.session.audioTurns.get(turn.requestId) === turn
        ) {
          turn.state = "done";
          this.deleteAudioTurn(turn, "streaming transcription completed");
          this.send({
            type: WS_EVENTS.TRANSCRIPT_FINAL,
            requestId: turn.requestId,
            text: transcript
          });
          await this.handleUserText(turn.requestId, transcript);
          return;
        }
        if (
          !transcript &&
          !this.disposed &&
          this.session.audioTurns.get(turn.requestId) === turn
        ) {
          turn.streaming.session?.close(1000, "empty realtime transcript");
          turn.streaming = undefined;
          turn.state = "recording";
        }
      } catch (error) {
        if (
          this.disposed ||
          this.session.audioTurns.get(turn.requestId) !== turn
        ) {
          return;
        }
        // Realtime transcription is optional. Fall back to the batch STT
        // adapter with the PCM audio already accumulated for this turn.
        this.config.logger.warn("stt.realtime_fallback", {
          sessionId: this.session.sessionId,
          requestId: turn.requestId,
          error: toError(error).message
        });
        turn.streaming?.session?.close(1011, "using batch STT fallback");
        turn.streaming = undefined;
        turn.state = "recording";
      }
    }
    await this.finishAudioTurn(turn);
  }

  private beginStreamingTranscription(turn: ActiveAudioTurn): void {
    const provider = this.providers.streamingStt;
    if (!provider || turn.turnMode !== "live") {
      return;
    }

    const controller = new AbortController();
    turn.controllers.add(controller);
    const streaming: ActiveStreamingTranscription = {
      controller,
      ready: Promise.resolve(),
      pendingAudio: [],
      transcript: "",
      waiters: []
    };
    turn.streaming = streaming;
    streaming.ready = provider
      .createSession({ signal: controller.signal })
      .then((session) => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          this.session.audioTurns.get(turn.requestId) !== turn
        ) {
          session.close(1000, "turn no longer active");
          return;
        }
        streaming.session = session;
        for (const audio of streaming.pendingAudio.splice(0)) {
          session.appendAudio(audio);
        }
        void this.consumeStreamingTranscription(turn, streaming, session);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.failStreamingTranscription(streaming, toError(error));
        }
        throw error;
      });

    // Creation may fail before the turn ends. The failure is retained on the
    // turn and handled by the batch fallback instead of becoming unhandled.
    void streaming.ready.catch(() => undefined);
  }

  private appendStreamingAudio(turn: ActiveAudioTurn, audio: Buffer): void {
    const streaming = turn.streaming;
    if (!streaming || streaming.error || streaming.controller.signal.aborted) {
      return;
    }
    try {
      if (streaming.session) {
        streaming.session.appendAudio(audio);
      } else {
        streaming.pendingAudio.push(audio);
      }
    } catch (error) {
      this.failStreamingTranscription(streaming, toError(error));
    }
  }

  private async consumeStreamingTranscription(
    turn: ActiveAudioTurn,
    streaming: ActiveStreamingTranscription,
    session: StreamingSTTSession
  ): Promise<void> {
    try {
      for await (const event of session) {
        if (
          streaming.controller.signal.aborted ||
          this.disposed ||
          this.session.audioTurns.get(turn.requestId) !== turn
        ) {
          return;
        }
        if (event.type === "delta") {
          streaming.transcript += event.delta;
          this.send({
            type: WS_EVENTS.TRANSCRIPT_PARTIAL,
            requestId: turn.requestId,
            text: streaming.transcript,
            sequence: turn.partialSequence++,
            isStable: false
          });
          continue;
        }
        if (event.type === "completed") {
          streaming.finalTranscript = event.transcript.trim();
          this.resolveStreamingWaiters(streaming);
          continue;
        }
        this.failStreamingTranscription(
          streaming,
          new Error(event.code ? `${event.code}: ${event.message}` : event.message)
        );
      }
    } catch (error) {
      if (!streaming.controller.signal.aborted) {
        this.failStreamingTranscription(streaming, toError(error));
      }
    }
  }

  private async finishStreamingTranscription(
    turn: ActiveAudioTurn
  ): Promise<string> {
    const streaming = turn.streaming;
    if (!streaming) {
      return "";
    }

    turn.state = "transcribing";
    await streaming.ready;
    if (streaming.error) {
      throw streaming.error;
    }
    const session = streaming.session;
    if (!session) {
      throw new Error("Realtime STT session did not become ready");
    }
    session.commit();

    try {
      return await this.waitForStreamingTranscript(streaming);
    } finally {
      session.close(1000, "turn transcription completed");
    }
  }

  private waitForStreamingTranscript(
    streaming: ActiveStreamingTranscription
  ): Promise<string> {
    if (streaming.controller.signal.aborted) {
      return Promise.reject(new Error("Realtime STT turn was cancelled"));
    }
    if (streaming.finalTranscript !== undefined) {
      return Promise.resolve(streaming.finalTranscript);
    }
    if (streaming.error) {
      return Promise.reject(streaming.error);
    }

    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        streaming.controller.signal.removeEventListener("abort", onAbort);
        const index = streaming.waiters.findIndex(
          (waiter) => waiter.resolve === wrappedResolve
        );
        if (index >= 0) {
          streaming.waiters.splice(index, 1);
        }
      };
      const wrappedResolve = (transcript: string): void => {
        cleanup();
        resolve(transcript);
      };
      const wrappedReject = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        wrappedReject(new Error("Realtime STT turn was cancelled"));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Realtime STT final transcript timed out"));
      }, this.config.streamingSttFinalTimeoutMs);
      streaming.controller.signal.addEventListener("abort", onAbort, {
        once: true
      });
      streaming.waiters.push({
        resolve: wrappedResolve,
        reject: wrappedReject
      });
    });
  }

  private resolveStreamingWaiters(streaming: ActiveStreamingTranscription): void {
    const transcript = streaming.finalTranscript ?? "";
    for (const waiter of streaming.waiters.splice(0)) {
      waiter.resolve(transcript);
    }
  }

  private failStreamingTranscription(
    streaming: ActiveStreamingTranscription,
    error: Error
  ): void {
    if (streaming.error) {
      return;
    }
    streaming.error = error;
    for (const waiter of streaming.waiters.splice(0)) {
      waiter.reject(error);
    }
    streaming.session?.close(1011, "realtime transcription failed");
  }

  private async finishAudioTurn(turn: ActiveAudioTurn): Promise<void> {
    if (turn.state !== "recording") {
      return;
    }

    turn.state = "transcribing";
    this.abortTurnControllers(turn, "final transcription started");
    const controller = new AbortController();
    turn.controllers.add(controller);

    try {
      const transcript = await this.transcribeAudio(
        turn,
        Buffer.concat(turn.chunks),
        controller.signal
      );
      if (
        controller.signal.aborted ||
        this.disposed ||
        this.session.audioTurns.get(turn.requestId) !== turn
      ) {
        return;
      }

      if (!transcript) {
        turn.state = "error";
        this.deleteAudioTurn(turn, "empty transcription");
        this.send({
          type: "error",
          requestId: turn.requestId,
          message: "Transcription returned empty text"
        });
        this.send({
          type: WS_EVENTS.LLM_DONE,
          requestId: turn.requestId,
          reason: "error"
        });
        return;
      }

      turn.state = "done";
      this.session.audioTurns.delete(turn.requestId);
      this.send({
        type: WS_EVENTS.TRANSCRIPT_FINAL,
        requestId: turn.requestId,
        text: transcript
      });
      await this.handleUserText(turn.requestId, transcript);
    } catch (error) {
      if (controller.signal.aborted || this.disposed) {
        return;
      }
      this.config.logger.error("stt.failed", {
        sessionId: this.session.sessionId,
        requestId: turn.requestId,
        error: toError(error).message
      });
      turn.state = "error";
      this.deleteAudioTurn(turn, "transcription error");
      this.send({
        type: "error",
        requestId: turn.requestId,
        message:
          error instanceof Error ? error.message : "Unknown transcription error"
      });
      this.send({
        type: WS_EVENTS.LLM_DONE,
        requestId: turn.requestId,
        reason: "error"
      });
    } finally {
      turn.controllers.delete(controller);
    }
  }

  private getOrCreateAudioTurn(message: AudioChunkMessage): ActiveAudioTurn {
    const existing = this.session.audioTurns.get(message.requestId);
    if (existing) {
      if (existing.byteLength === 0 || !existing.mimeType) {
        existing.mimeType = message.mimeType;
      }
      return existing;
    }

    const now = this.config.now();
    const turn: ActiveAudioTurn = {
      requestId: message.requestId,
      turnMode: message.turnMode ?? "ptt",
      state: "recording",
      mimeType: message.mimeType,
      chunks: [],
      byteLength: 0,
      lastSequence: -1,
      startedAt: now,
      partialSequence: 0,
      lastPartialAt: now,
      partialInFlight: false,
      controllers: new Set()
    };
    this.session.audioTurns.set(message.requestId, turn);
    return turn;
  }

  private maybeSchedulePartialTranscription(turn: ActiveAudioTurn): void {
    if (
      turn.turnMode !== "live" ||
      turn.state !== "recording" ||
      turn.partialInFlight ||
      (turn.streaming !== undefined && turn.streaming.error === undefined) ||
      turn.chunks.length === 0
    ) {
      return;
    }

    const now = this.config.now();
    const elapsed = now - turn.startedAt;
    const interval =
      elapsed > this.config.livePartialLongTurnAfterMs
        ? this.config.livePartialLongTurnIntervalMs
        : this.config.livePartialInitialIntervalMs;
    if (now - turn.lastPartialAt < interval) {
      return;
    }

    turn.lastPartialAt = now;
    turn.partialInFlight = true;
    const audio = Buffer.concat(turn.chunks);
    const partialSequence = turn.partialSequence++;
    const controller = new AbortController();
    turn.controllers.add(controller);

    void this.transcribeAudio(turn, audio, controller.signal)
      .then((text) => {
        if (
          text &&
          !controller.signal.aborted &&
          !this.disposed &&
          this.session.audioTurns.get(turn.requestId) === turn &&
          turn.state === "recording"
        ) {
          this.send({
            type: WS_EVENTS.TRANSCRIPT_PARTIAL,
            requestId: turn.requestId,
            text,
            sequence: partialSequence,
            isStable: false
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        turn.controllers.delete(controller);
        turn.partialInFlight = false;
      });
  }

  private async transcribeAudio(
    turn: ActiveAudioTurn,
    audio: Buffer,
    signal: AbortSignal
  ): Promise<string> {
    if (audio.byteLength === 0) {
      return "";
    }
    const normalized = normalizeAudioForBatchStt(turn.mimeType, audio);
    const result = await this.providers.stt.transcribe(
      {
        data: normalized.data,
        mimeType: normalized.mimeType,
        filename: filenameForMimeType(normalized.mimeType)
      },
      { signal }
    );
    return result.text.trim();
  }

  private async streamAssistantResponse(requestId: string): Promise<void> {
    const run: ActiveRun = {
      requestId,
      controller: new AbortController(),
      stage: "llm_streaming",
      text: "",
      interrupted: false,
      llmDoneSent: false,
      ttsStarted: false,
      ttsEnded: false,
      ttsSequence: 0,
      ttsSegmentIndex: 0
    };

    this.session.current = run;
    let pendingTtsText = "";
    let ttsQueue = Promise.resolve();
    let ttsError: unknown;

    const enqueueTtsSegment = (text: string, isFinalSegment: boolean): void => {
      ttsQueue = ttsQueue
        .then(async () => {
          if (
            ttsError ||
            run.interrupted ||
            run.controller.signal.aborted ||
            this.session.current !== run
          ) {
            return;
          }
          await this.streamTtsSegment(run, text, isFinalSegment);
        })
        .catch((error: unknown) => {
          ttsError ??= error;
          if (!run.interrupted && !run.controller.signal.aborted) {
            run.controller.abort("tts error");
          }
        });
    };

    try {
      for await (const chunk of this.providers.llm.streamText(
        this.session.history,
        { signal: run.controller.signal }
      )) {
        if (
          run.interrupted ||
          run.controller.signal.aborted ||
          run.llmDoneSent ||
          this.session.current !== run
        ) {
          break;
        }

        run.text += chunk.delta;
        pendingTtsText += chunk.delta;
        this.send({
          type: WS_EVENTS.LLM_DELTA,
          requestId,
          delta: chunk.delta
        });

        const ready = takeReadyTtsSegments(pendingTtsText, this.config);
        pendingTtsText = ready.remainder;
        for (const segment of ready.segments) {
          enqueueTtsSegment(segment, false);
        }
      }

      if (!run.interrupted && this.session.current === run) {
        if (ttsError) {
          throw ttsError;
        }
        if (run.text) {
          this.session.history.push({ role: "assistant", content: run.text });
        }
        this.sendLlmDone(run, "stop");
        if (pendingTtsText.trim()) {
          enqueueTtsSegment(pendingTtsText, true);
        }
        await ttsQueue;
        if (ttsError) {
          throw ttsError;
        }
        if (
          run.interrupted ||
          run.controller.signal.aborted ||
          this.session.current !== run
        ) {
          return;
        }
        this.sendTtsEnd(run, "stop");
        this.finishRun(run, "done");
      }
    } catch (error) {
      if (ttsError && !run.interrupted) {
        this.config.logger.error("tts.failed", {
          sessionId: this.session.sessionId,
          requestId,
          error: toError(ttsError).message
        });
        this.send({
          type: "error",
          requestId,
          message:
            ttsError instanceof Error
              ? ttsError.message
              : "Unknown TTS gateway error"
        });
        this.sendLlmDone(run, "error");
        this.sendTtsEnd(run, "error");
        this.finishRun(run, "error");
        return;
      }

      if (run.controller.signal.aborted || run.interrupted) {
        this.sendLlmDone(run, "interrupted");
        this.sendTtsEnd(run, "interrupted");
        this.finishRun(run, "interrupted");
        return;
      }

      this.config.logger.error("llm.failed", {
        sessionId: this.session.sessionId,
        requestId,
        error: toError(error).message
      });

      this.send({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : "Unknown gateway error"
      });
      this.sendLlmDone(run, "error");
      this.sendTtsEnd(run, "error");
      this.finishRun(run, "error");
    }
  }

  private interruptCurrentRun(reason: string, requestId?: string): void {
    const run = this.session.current;
    if (!run || (requestId !== undefined && run.requestId !== requestId)) {
      return;
    }
    run.interrupted = true;
    run.controller.abort(reason);
    this.sendLlmDone(run, "interrupted");
    this.sendTtsEnd(run, "interrupted");
    this.finishRun(run, "interrupted");
  }

  private async streamTtsSegment(
    run: ActiveRun,
    text: string,
    isFinalSegment: boolean
  ): Promise<void> {
    const segmentText = text.trim();
    if (
      !this.providers.tts ||
      !segmentText ||
      run.interrupted ||
      run.controller.signal.aborted
    ) {
      return;
    }

    if (!run.ttsStarted) {
      run.ttsStarted = true;
      this.send({
        type: WS_EVENTS.TTS_START,
        requestId: run.requestId,
        voice: this.config.ttsVoice,
        format: this.config.ttsFormat,
        mimeType: mimeTypeForAudioFormat(this.config.ttsFormat)
      });
    }

    run.stage = "tts_streaming";
    const segmentIndex = run.ttsSegmentIndex++;
    const audioParts: Buffer[] = [];
    let mimeType = mimeTypeForAudioFormat(this.config.ttsFormat);

    for await (const chunk of this.providers.tts.synthesize(
      {
        text: segmentText,
        voice: this.config.ttsVoice,
        format: this.config.ttsFormat
      },
      { signal: run.controller.signal }
    )) {
      if (run.interrupted || run.controller.signal.aborted) {
        return;
      }
      mimeType = chunk.mimeType;
      audioParts.push(Buffer.from(chunk.audio));
    }

    if (
      audioParts.length > 0 &&
      !run.interrupted &&
      !run.controller.signal.aborted
    ) {
      this.sendTtsChunk(
        run,
        { audio: Buffer.concat(audioParts), mimeType },
        segmentIndex,
        isFinalSegment
      );
    }
  }

  private sendTtsChunk(
    run: ActiveRun,
    chunk: { audio: Uint8Array; mimeType: string },
    segmentIndex: number,
    isFinal: boolean
  ): void {
    this.send({
      type: WS_EVENTS.TTS_CHUNK,
      requestId: run.requestId,
      sequence: run.ttsSequence++,
      chunk: Buffer.from(chunk.audio).toString("base64"),
      mimeType: chunk.mimeType,
      segmentIndex,
      isFinal
    });
  }

  private sendLlmDone(run: ActiveRun, reason: LlmDoneMessage["reason"]): void {
    if (run.llmDoneSent) {
      return;
    }
    run.llmDoneSent = true;
    this.send({
      type: WS_EVENTS.LLM_DONE,
      requestId: run.requestId,
      reason
    });
  }

  private sendTtsEnd(
    run: ActiveRun,
    reason: "stop" | "interrupted" | "error"
  ): void {
    if (run.ttsEnded || !run.ttsStarted) {
      return;
    }
    run.ttsEnded = true;
    this.send({
      type: WS_EVENTS.TTS_END,
      requestId: run.requestId,
      reason
    });
  }

  private finishRun(
    run: ActiveRun,
    stage: "done" | "interrupted" | "error"
  ): void {
    run.stage = stage;
    if (this.session.current === run) {
      this.session.current = undefined;
    }
    this.config.logger.info("request.finished", {
      sessionId: this.session.sessionId,
      requestId: run.requestId,
      stage
    });
  }

  private deleteAudioTurn(turn: ActiveAudioTurn, reason: string): void {
    this.abortTurnControllers(turn, reason);
    turn.streaming?.session?.close(1000, reason);
    if (this.session.audioTurns.get(turn.requestId) === turn) {
      this.session.audioTurns.delete(turn.requestId);
    }
  }

  private cancelAudioTurn(requestId: string, reason: string): void {
    const turn = this.session.audioTurns.get(requestId);
    if (!turn) {
      return;
    }
    this.deleteAudioTurn(turn, reason);
    this.config.logger.info("audio.cancelled", {
      sessionId: this.session.sessionId,
      requestId,
      reason
    });
  }

  private abortTurnControllers(turn: ActiveAudioTurn, reason: string): void {
    for (const controller of turn.controllers) {
      controller.abort(reason);
    }
    turn.controllers.clear();
    turn.partialInFlight = false;
  }

  private dispose(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.config.logger.info("session.disconnected", {
      sessionId: this.session.sessionId,
      reason
    });
    this.interruptCurrentRun(reason);
    for (const turn of this.session.audioTurns.values()) {
      this.abortTurnControllers(turn, reason);
    }
    this.session.audioTurns.clear();
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

function filenameForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) return "recording.webm";
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("mpeg")) return "recording.mp3";
  if (mimeType.includes("wav")) return "recording.wav";
  return "recording.webm";
}

function mimeTypeForAudioFormat(format: string): string {
  switch (format) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/ogg; codecs=opus";
    case "pcm":
      return "audio/pcm";
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

function normalizeAudioForBatchStt(
  mimeType: string,
  audio: Buffer
): { data: Buffer; mimeType: string } {
  if (!mimeType.toLowerCase().startsWith("audio/pcm")) {
    return { data: audio, mimeType };
  }

  const rateMatch = mimeType.match(/(?:^|;)\s*rate=(\d+)/i);
  const sampleRate = Number.parseInt(rateMatch?.[1] ?? "24000", 10);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("PCM audio rate must be a positive integer");
  }
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 audio must contain an even number of bytes");
  }

  return {
    data: pcm16MonoToWav(audio, sampleRate),
    mimeType: "audio/wav"
  };
}

function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function takeReadyTtsSegments(
  text: string,
  config: Pick<GatewayConfig, "ttsSegmentMinLength" | "ttsSegmentMaxLength">
): { segments: string[]; remainder: string } {
  const segments: string[] = [];
  let remainder = text;

  while (remainder.length >= config.ttsSegmentMinLength) {
    const boundary = findSegmentBoundary(remainder, config);
    const splitAt =
      boundary >= config.ttsSegmentMinLength
        ? boundary
        : remainder.length >= config.ttsSegmentMaxLength
          ? config.ttsSegmentMaxLength
          : -1;
    if (splitAt === -1) {
      break;
    }
    segments.push(remainder.slice(0, splitAt).trim());
    remainder = remainder.slice(splitAt).trimStart();
  }

  return { segments: segments.filter(Boolean), remainder };
}

function findSegmentBoundary(
  text: string,
  config: Pick<GatewayConfig, "ttsSegmentMinLength" | "ttsSegmentMaxLength">
): number {
  const boundaryPattern = /[.!?。！？；;，,]\s*/g;
  let match: RegExpExecArray | null;
  let lastBoundary = -1;
  while ((match = boundaryPattern.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    if (boundary >= config.ttsSegmentMinLength) {
      lastBoundary = boundary;
    }
    if (boundary >= config.ttsSegmentMaxLength) {
      break;
    }
  }
  return lastBoundary;
}

function validateConfig(config: GatewayConfig): void {
  const positiveValues: Array<[string, number]> = [
    ["maxAudioTurnBytes", config.maxAudioTurnBytes],
    ["livePartialInitialIntervalMs", config.livePartialInitialIntervalMs],
    ["livePartialLongTurnIntervalMs", config.livePartialLongTurnIntervalMs],
    ["livePartialLongTurnAfterMs", config.livePartialLongTurnAfterMs],
    ["streamingSttFinalTimeoutMs", config.streamingSttFinalTimeoutMs],
    ["ttsSegmentMinLength", config.ttsSegmentMinLength],
    ["ttsSegmentMaxLength", config.ttsSegmentMaxLength]
  ];
  for (const [name, value] of positiveValues) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be greater than zero`);
    }
  }
  if (config.ttsSegmentMaxLength < config.ttsSegmentMinLength) {
    throw new Error("ttsSegmentMaxLength must be at least ttsSegmentMinLength");
  }
}

function listenHttpServer(
  server: HttpServer,
  port: number,
  host?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

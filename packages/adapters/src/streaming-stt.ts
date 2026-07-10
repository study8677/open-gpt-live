export interface StreamingSTTAudioFormat {
  readonly encoding: string;
  readonly sampleRateHz: number;
  readonly channels: number;
}

export interface StreamingSTTSessionOptions {
  language?: string;
  signal?: AbortSignal;
}

export interface StreamingSTTDeltaEvent {
  type: "delta";
  itemId: string;
  contentIndex: number;
  delta: string;
  providerEventId?: string;
}

export interface StreamingSTTCompletedEvent {
  type: "completed";
  itemId: string;
  contentIndex: number;
  transcript: string;
  providerEventId?: string;
}

export interface StreamingSTTErrorEvent {
  type: "error";
  message: string;
  code?: string;
  providerEventId?: string;
}

export type StreamingSTTEvent =
  | StreamingSTTDeltaEvent
  | StreamingSTTCompletedEvent
  | StreamingSTTErrorEvent;

/**
 * A single bidirectional streaming speech-to-text connection.
 *
 * Audio passed to appendAudio must match inputFormat. Events can be consumed
 * with `for await`; iteration ends when the session closes.
 */
export interface StreamingSTTSession extends AsyncIterable<StreamingSTTEvent> {
  readonly inputFormat: StreamingSTTAudioFormat;
  appendAudio(audio: Uint8Array): void;
  commit(): void;
  close(code?: number, reason?: string): void;
}

export interface StreamingSTTProvider {
  createSession(
    options?: StreamingSTTSessionOptions
  ): Promise<StreamingSTTSession>;
}

/**
 * The small WebSocket surface used by the adapter. Keeping this structural
 * makes it possible to inject `ws` in Node.js and a fake socket in tests.
 */
export interface StreamingSTTWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(
    event: "close",
    listener: (code: number, reason: unknown) => void
  ): this;
}

export interface StreamingSTTWebSocketFactoryOptions {
  headers: Record<string, string>;
}

export type StreamingSTTWebSocketFactory = (
  url: string,
  options: StreamingSTTWebSocketFactoryOptions
) => StreamingSTTWebSocket;

export type OpenAIRealtimeTranscriptionDelay =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface OpenAIRealtimeSTTProviderConfig {
  webSocketFactory: StreamingSTTWebSocketFactory;
  apiKey?: string;
  url?: string;
  model?: string;
  language?: string;
  delay?: OpenAIRealtimeTranscriptionDelay;
}

interface OpenAIRealtimeServerEvent {
  type?: unknown;
  event_id?: unknown;
  item_id?: unknown;
  content_index?: unknown;
  delta?: unknown;
  transcript?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    type?: unknown;
  };
}

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const OPENAI_REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const OPENAI_REALTIME_MAX_APPEND_BYTES = 15 * 1024 * 1024;
const PCM16_24KHZ_MONO: StreamingSTTAudioFormat = {
  encoding: "pcm_s16le",
  sampleRateHz: 24000,
  channels: 1
};

export class OpenAIRealtimeSTTProvider implements StreamingSTTProvider {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly language?: string;
  private readonly delay?: OpenAIRealtimeTranscriptionDelay;
  private readonly webSocketFactory: StreamingSTTWebSocketFactory;

  constructor(config: OpenAIRealtimeSTTProviderConfig) {
    this.apiKey =
      firstNonEmpty(
        config.apiKey,
        process.env.STT_API_KEY,
        process.env.OPENAI_API_KEY
      ) ?? "";
    this.url =
      firstNonEmpty(config.url, process.env.STT_REALTIME_URL) ??
      OPENAI_REALTIME_URL;
    this.model =
      firstNonEmpty(config.model, process.env.STT_REALTIME_MODEL) ??
      OPENAI_REALTIME_TRANSCRIPTION_MODEL;
    this.language = firstNonEmpty(config.language);
    this.delay = config.delay;
    this.webSocketFactory = config.webSocketFactory;
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  async createSession(
    options: StreamingSTTSessionOptions = {}
  ): Promise<StreamingSTTSession> {
    if (!this.apiKey) {
      throw new Error("STT_API_KEY or OPENAI_API_KEY is required");
    }

    if (options.signal?.aborted) {
      throw abortError();
    }

    const socket = this.webSocketFactory(
      realtimeUrlWithModel(this.url, this.model),
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      }
    );
    const session = new OpenAIRealtimeSTTSession(socket, {
      model: this.model,
      language: firstNonEmpty(options.language, this.language),
      delay: this.delay,
      signal: options.signal
    });

    await session.initialize();
    return session;
  }
}

interface OpenAIRealtimeSTTSessionConfig {
  model: string;
  language?: string;
  delay?: OpenAIRealtimeTranscriptionDelay;
  signal?: AbortSignal;
}

class OpenAIRealtimeSTTSession implements StreamingSTTSession {
  readonly inputFormat = PCM16_24KHZ_MONO;

  private readonly events = new AsyncEventQueue<StreamingSTTEvent>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private opened = false;
  private initialized = false;
  private closed = false;
  private closeRequested = false;
  private transportErrorObserved = false;
  private hasUncommittedAudio = false;
  private abortHandler?: () => void;

  constructor(
    private readonly socket: StreamingSTTWebSocket,
    private readonly config: OpenAIRealtimeSTTSessionConfig
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    socket.on("open", () => this.handleOpen());
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("error", (error) => this.handleSocketError(error));
    socket.on("close", (code, reason) =>
      this.handleSocketClose(code, reason)
    );

    if (socket.readyState === 1) {
      queueMicrotask(() => this.handleOpen());
    }
  }

  async initialize(): Promise<void> {
    if (this.config.signal?.aborted) {
      this.close();
      throw abortError();
    }

    this.abortHandler = () => {
      this.rejectReady(abortError());
      this.close(1000, "aborted");
    };
    this.config.signal?.addEventListener("abort", this.abortHandler, {
      once: true
    });

    try {
      await this.ready;
      this.assertOpen();
      this.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: 24000
              },
              transcription: compactObject({
                model: this.config.model,
                language: this.config.language,
                delay: this.config.delay
              }),
              turn_detection: null
            }
          }
        }
      });
      this.initialized = true;
    } catch (error) {
      this.removeAbortHandler();
      this.close();
      throw error;
    }
  }

  appendAudio(audio: Uint8Array): void {
    this.assertActive();
    if (audio.byteLength === 0) {
      return;
    }
    if (audio.byteLength > OPENAI_REALTIME_MAX_APPEND_BYTES) {
      throw new Error(
        `Realtime STT audio chunks cannot exceed ${OPENAI_REALTIME_MAX_APPEND_BYTES} bytes`
      );
    }

    this.send({
      type: "input_audio_buffer.append",
      audio: Buffer.from(
        audio.buffer,
        audio.byteOffset,
        audio.byteLength
      ).toString("base64")
    });
    this.hasUncommittedAudio = true;
  }

  commit(): void {
    this.assertActive();
    if (!this.hasUncommittedAudio) {
      throw new Error("Cannot commit an empty realtime STT audio buffer");
    }

    this.send({ type: "input_audio_buffer.commit" });
    this.hasUncommittedAudio = false;
  }

  close(code = 1000, reason = "client closed"): void {
    if (this.closed) {
      return;
    }

    this.closeRequested = true;
    this.closed = true;
    this.removeAbortHandler();
    this.rejectReady(new Error("Realtime STT session closed before connecting"));
    this.events.end();

    try {
      this.socket.close(code, reason);
    } catch {
      // The socket may already be closed. Session close is intentionally idempotent.
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamingSTTEvent> {
    return this.events[Symbol.asyncIterator]();
  }

  private handleOpen(): void {
    if (this.opened || this.closed) {
      return;
    }
    this.opened = true;
    this.resolveReady();
  }

  private handleMessage(data: unknown): void {
    if (this.closed) {
      return;
    }

    let event: OpenAIRealtimeServerEvent;
    try {
      event = JSON.parse(webSocketMessageToText(data)) as OpenAIRealtimeServerEvent;
    } catch (error) {
      this.events.push({
        type: "error",
        code: "invalid_server_event",
        message: `OpenAI Realtime STT returned invalid JSON: ${errorMessage(error)}`
      });
      return;
    }

    const providerEventId = optionalString(event.event_id);
    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta": {
        if (
          typeof event.item_id !== "string" ||
          typeof event.content_index !== "number" ||
          typeof event.delta !== "string"
        ) {
          this.events.push(invalidTranscriptionEvent(event.type, providerEventId));
          return;
        }
        this.events.push({
          type: "delta",
          itemId: event.item_id,
          contentIndex: event.content_index,
          delta: event.delta,
          ...(providerEventId ? { providerEventId } : {})
        });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (
          typeof event.item_id !== "string" ||
          typeof event.content_index !== "number" ||
          typeof event.transcript !== "string"
        ) {
          this.events.push(invalidTranscriptionEvent(event.type, providerEventId));
          return;
        }
        this.events.push({
          type: "completed",
          itemId: event.item_id,
          contentIndex: event.content_index,
          transcript: event.transcript,
          ...(providerEventId ? { providerEventId } : {})
        });
        return;
      }
      case "error": {
        const code = optionalString(event.error?.code ?? event.error?.type);
        const message =
          optionalString(event.error?.message) ??
          "OpenAI Realtime STT returned an unknown error";
        this.events.push({
          type: "error",
          message,
          ...(code ? { code } : {}),
          ...(providerEventId ? { providerEventId } : {})
        });
      }
    }
  }

  private handleSocketError(error: unknown): void {
    if (!this.opened) {
      this.rejectReady(
        new Error(`Could not connect to OpenAI Realtime STT: ${errorMessage(error)}`)
      );
      return;
    }
    if (this.closed) {
      return;
    }

    this.transportErrorObserved = true;
    this.events.push({
      type: "error",
      code: "websocket_error",
      message: `OpenAI Realtime STT WebSocket error: ${errorMessage(error)}`
    });
  }

  private handleSocketClose(code: number, reason: unknown): void {
    if (!this.opened) {
      this.rejectReady(
        new Error(
          `OpenAI Realtime STT WebSocket closed before connecting (${code}): ${webSocketCloseReason(reason)}`
        )
      );
    }
    if (this.closed) {
      return;
    }

    if (!this.closeRequested && !this.transportErrorObserved) {
      this.events.push({
        type: "error",
        code: "websocket_closed",
        message: `OpenAI Realtime STT WebSocket closed (${code}): ${webSocketCloseReason(reason)}`
      });
    }
    this.closed = true;
    this.removeAbortHandler();
    this.events.end();
  }

  private assertOpen(): void {
    if (!this.opened || this.closed || this.socket.readyState !== 1) {
      throw new Error("OpenAI Realtime STT WebSocket is not open");
    }
  }

  private assertActive(): void {
    this.assertOpen();
    if (!this.initialized) {
      throw new Error("OpenAI Realtime STT session is not initialized");
    }
  }

  private send(event: object): void {
    this.assertOpen();
    this.socket.send(JSON.stringify(event));
  }

  private removeAbortHandler(): void {
    if (!this.abortHandler) {
      return;
    }
    this.config.signal?.removeEventListener("abort", this.abortHandler);
    this.abortHandler = undefined;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<T>) => void
  > = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}

function realtimeUrlWithModel(value: string, model: string): string {
  const url = new URL(value);
  url.searchParams.set("model", model);
  return url.toString();
}

function compactObject<T extends Record<string, unknown>>(
  value: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function invalidTranscriptionEvent(
  eventType: string,
  providerEventId?: string
): StreamingSTTErrorEvent {
  return {
    type: "error",
    code: "invalid_transcription_event",
    message: `OpenAI Realtime STT returned an invalid ${eventType} event`,
    ...(providerEventId ? { providerEventId } : {})
  };
}

function webSocketMessageToText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8"
    );
  }
  if (Array.isArray(data)) {
    return data.map(webSocketMessageToText).join("");
  }
  throw new Error("unsupported WebSocket message type");
}

function webSocketCloseReason(reason: unknown): string {
  try {
    const text = webSocketMessageToText(reason);
    return text.length > 0 ? text : "no reason provided";
  } catch {
    return "no reason provided";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error("Realtime STT session creation was aborted");
  error.name = "AbortError";
  return error;
}

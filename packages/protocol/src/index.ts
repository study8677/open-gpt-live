export const WS_EVENTS = {
  SESSION_START: "session.start",
  USER_TEXT: "user.text",
  LLM_DELTA: "llm.delta",
  LLM_DONE: "llm.done",
  INTERRUPT: "interrupt",
  AUDIO_CHUNK: "audio.chunk",
  VAD_SPEECH_START: "vad.speech_start",
  VAD_SPEECH_END: "vad.speech_end",
  TRANSCRIPT_PARTIAL: "transcript.partial",
  TRANSCRIPT_FINAL: "transcript.final",
  TTS_START: "tts.start",
  TTS_CHUNK: "tts.chunk",
  TTS_END: "tts.end",
  PLAYBACK_ACK: "playback.ack"
} as const;

export type WsEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

export interface ClientSessionStartMessage {
  type: typeof WS_EVENTS.SESSION_START;
  sessionId?: string;
}

export interface ServerSessionStartMessage {
  type: typeof WS_EVENTS.SESSION_START;
  sessionId: string;
  status: "ready";
}

export interface UserTextMessage {
  type: typeof WS_EVENTS.USER_TEXT;
  requestId?: string;
  text: string;
}

export interface AudioChunkMessage {
  type: typeof WS_EVENTS.AUDIO_CHUNK;
  requestId: string;
  chunk?: string;
  mimeType: string;
  sequence: number;
  isFinal?: boolean;
  turnMode?: "ptt" | "live";
}

export interface VadSpeechStartMessage {
  type: typeof WS_EVENTS.VAD_SPEECH_START;
  requestId: string;
  turnMode: "live";
  startedAt: number;
  rms?: number;
}

export interface VadSpeechEndMessage {
  type: typeof WS_EVENTS.VAD_SPEECH_END;
  requestId: string;
  endedAt: number;
  durationMs?: number;
  reason: "silence" | "manual" | "cancelled";
}

export interface InterruptMessage {
  type: typeof WS_EVENTS.INTERRUPT;
  requestId?: string;
  reason?: string;
}

export interface PlaybackAckMessage {
  type: typeof WS_EVENTS.PLAYBACK_ACK;
  requestId: string;
  sequence?: number;
}

export interface LlmDeltaMessage {
  type: typeof WS_EVENTS.LLM_DELTA;
  requestId: string;
  delta: string;
}

export interface LlmDoneMessage {
  type: typeof WS_EVENTS.LLM_DONE;
  requestId: string;
  reason: "stop" | "interrupted" | "error";
}

export interface TranscriptFinalMessage {
  type: typeof WS_EVENTS.TRANSCRIPT_FINAL;
  requestId: string;
  text: string;
}

export interface TranscriptPartialMessage {
  type: typeof WS_EVENTS.TRANSCRIPT_PARTIAL;
  requestId: string;
  text: string;
  sequence: number;
  isStable?: boolean;
}

export interface ErrorMessage {
  type: "error";
  requestId?: string;
  message: string;
}

export interface TtsStartMessage {
  type: typeof WS_EVENTS.TTS_START;
  requestId: string;
  voice?: string;
  format: string;
  mimeType: string;
}

export interface TtsChunkMessage {
  type: typeof WS_EVENTS.TTS_CHUNK;
  requestId: string;
  sequence: number;
  chunk: string;
  mimeType: string;
  segmentIndex?: number;
  isFinal?: boolean;
}

export interface TtsEndMessage {
  type: typeof WS_EVENTS.TTS_END;
  requestId: string;
  reason: "stop" | "interrupted" | "error";
}

export type ClientMessage =
  | ClientSessionStartMessage
  | UserTextMessage
  | AudioChunkMessage
  | VadSpeechStartMessage
  | VadSpeechEndMessage
  | InterruptMessage
  | PlaybackAckMessage;

export type ServerMessage =
  | ServerSessionStartMessage
  | LlmDeltaMessage
  | LlmDoneMessage
  | TranscriptPartialMessage
  | TranscriptFinalMessage
  | TtsStartMessage
  | TtsChunkMessage
  | TtsEndMessage
  | ErrorMessage;

export type ReservedMessage = never;

export type ClientMessageValidationResult =
  | { success: true; data: ClientMessage }
  | { success: false; error: string };

export type ServerMessageValidationResult =
  | { success: true; data: ServerMessage }
  | { success: false; error: string };

/**
 * Validate an untrusted value before it enters the gateway message handler.
 * TypeScript types disappear at runtime, so every WebSocket payload must pass
 * through this boundary instead of being cast directly to ClientMessage.
 */
export function parseClientMessage(input: unknown): ClientMessageValidationResult {
  if (!isRecord(input)) {
    return invalid("message must be a JSON object");
  }

  if (typeof input.type !== "string" || input.type.length === 0) {
    return invalid("type must be a non-empty string");
  }

  switch (input.type) {
    case WS_EVENTS.SESSION_START:
      if (!isOptionalNonEmptyString(input.sessionId)) {
        return invalid("session.start sessionId must be a non-empty string");
      }
      return valid({
        type: WS_EVENTS.SESSION_START,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
      });

    case WS_EVENTS.USER_TEXT:
      if (typeof input.text !== "string") {
        return invalid("user.text text must be a string");
      }
      if (!isOptionalNonEmptyString(input.requestId)) {
        return invalid("user.text requestId must be a non-empty string");
      }
      return valid({
        type: WS_EVENTS.USER_TEXT,
        text: input.text,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId })
      });

    case WS_EVENTS.AUDIO_CHUNK:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("audio.chunk requestId must be a non-empty string");
      }
      if (!isOptionalString(input.chunk)) {
        return invalid("audio.chunk chunk must be a string");
      }
      if (!isNonEmptyString(input.mimeType)) {
        return invalid("audio.chunk mimeType must be a non-empty string");
      }
      if (!isNonNegativeInteger(input.sequence)) {
        return invalid("audio.chunk sequence must be a non-negative integer");
      }
      if (!isOptionalBoolean(input.isFinal)) {
        return invalid("audio.chunk isFinal must be a boolean");
      }
      if (!isOptionalEnum(input.turnMode, ["ptt", "live"] as const)) {
        return invalid("audio.chunk turnMode must be ptt or live");
      }
      return valid({
        type: WS_EVENTS.AUDIO_CHUNK,
        requestId: input.requestId,
        mimeType: input.mimeType,
        sequence: input.sequence,
        ...(input.chunk === undefined ? {} : { chunk: input.chunk }),
        ...(input.isFinal === undefined ? {} : { isFinal: input.isFinal }),
        ...(input.turnMode === undefined ? {} : { turnMode: input.turnMode })
      });

    case WS_EVENTS.VAD_SPEECH_START:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("vad.speech_start requestId must be a non-empty string");
      }
      if (input.turnMode !== "live") {
        return invalid("vad.speech_start turnMode must be live");
      }
      if (!isFiniteNumber(input.startedAt)) {
        return invalid("vad.speech_start startedAt must be a finite number");
      }
      if (!isOptionalFiniteNumber(input.rms)) {
        return invalid("vad.speech_start rms must be a finite number");
      }
      return valid({
        type: WS_EVENTS.VAD_SPEECH_START,
        requestId: input.requestId,
        turnMode: "live",
        startedAt: input.startedAt,
        ...(input.rms === undefined ? {} : { rms: input.rms })
      });

    case WS_EVENTS.VAD_SPEECH_END:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("vad.speech_end requestId must be a non-empty string");
      }
      if (!isFiniteNumber(input.endedAt)) {
        return invalid("vad.speech_end endedAt must be a finite number");
      }
      if (!isOptionalFiniteNumber(input.durationMs)) {
        return invalid("vad.speech_end durationMs must be a finite number");
      }
      if (!isEnum(input.reason, ["silence", "manual", "cancelled"] as const)) {
        return invalid("vad.speech_end reason must be silence, manual, or cancelled");
      }
      return valid({
        type: WS_EVENTS.VAD_SPEECH_END,
        requestId: input.requestId,
        endedAt: input.endedAt,
        reason: input.reason,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
      });

    case WS_EVENTS.INTERRUPT:
      if (!isOptionalNonEmptyString(input.requestId)) {
        return invalid("interrupt requestId must be a non-empty string");
      }
      if (!isOptionalString(input.reason)) {
        return invalid("interrupt reason must be a string");
      }
      return valid({
        type: WS_EVENTS.INTERRUPT,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        ...(input.reason === undefined ? {} : { reason: input.reason })
      });

    case WS_EVENTS.PLAYBACK_ACK:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("playback.ack requestId must be a non-empty string");
      }
      if (input.sequence !== undefined && !isNonNegativeInteger(input.sequence)) {
        return invalid("playback.ack sequence must be a non-negative integer");
      }
      return valid({
        type: WS_EVENTS.PLAYBACK_ACK,
        requestId: input.requestId,
        ...(input.sequence === undefined ? {} : { sequence: input.sequence })
      });

    default:
      return invalid(`unsupported message type: ${input.type}`);
  }
}

/** Validate an untrusted Gateway payload before it enters browser state. */
export function parseServerMessage(input: unknown): ServerMessageValidationResult {
  if (!isRecord(input)) {
    return invalidServer("message must be a JSON object");
  }
  if (typeof input.type !== "string" || input.type.length === 0) {
    return invalidServer("type must be a non-empty string");
  }

  if (input.type === WS_EVENTS.SESSION_START) {
    if (!isNonEmptyString(input.sessionId) || input.status !== "ready") {
      return invalidServer("session.start requires sessionId and ready status");
    }
    return validServer({
      type: WS_EVENTS.SESSION_START,
      sessionId: input.sessionId,
      status: "ready"
    });
  }

  if (input.type === WS_EVENTS.LLM_DELTA) {
    if (!isNonEmptyString(input.requestId) || typeof input.delta !== "string") {
      return invalidServer("llm.delta requires requestId and string delta");
    }
    return validServer({
      type: WS_EVENTS.LLM_DELTA,
      requestId: input.requestId,
      delta: input.delta
    });
  }

  if (input.type === WS_EVENTS.LLM_DONE) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isEnum(input.reason, ["stop", "interrupted", "error"] as const)
    ) {
      return invalidServer("llm.done requires requestId and a valid reason");
    }
    return validServer({
      type: WS_EVENTS.LLM_DONE,
      requestId: input.requestId,
      reason: input.reason
    });
  }

  if (input.type === WS_EVENTS.TRANSCRIPT_PARTIAL) {
    if (
      !isNonEmptyString(input.requestId) ||
      typeof input.text !== "string" ||
      !isNonNegativeInteger(input.sequence) ||
      !isOptionalBoolean(input.isStable)
    ) {
      return invalidServer(
        "transcript.partial requires requestId, text, sequence, and optional isStable"
      );
    }
    return validServer({
      type: WS_EVENTS.TRANSCRIPT_PARTIAL,
      requestId: input.requestId,
      text: input.text,
      sequence: input.sequence,
      ...(input.isStable === undefined ? {} : { isStable: input.isStable })
    });
  }

  if (input.type === WS_EVENTS.TRANSCRIPT_FINAL) {
    if (!isNonEmptyString(input.requestId) || typeof input.text !== "string") {
      return invalidServer("transcript.final requires requestId and string text");
    }
    return validServer({
      type: WS_EVENTS.TRANSCRIPT_FINAL,
      requestId: input.requestId,
      text: input.text
    });
  }

  if (input.type === WS_EVENTS.TTS_START) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isOptionalNonEmptyString(input.voice) ||
      !isNonEmptyString(input.format) ||
      !isNonEmptyString(input.mimeType)
    ) {
      return invalidServer(
        "tts.start requires requestId, format, mimeType, and optional voice"
      );
    }
    return validServer({
      type: WS_EVENTS.TTS_START,
      requestId: input.requestId,
      format: input.format,
      mimeType: input.mimeType,
      ...(input.voice === undefined ? {} : { voice: input.voice })
    });
  }

  if (input.type === WS_EVENTS.TTS_CHUNK) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isNonNegativeInteger(input.sequence) ||
      typeof input.chunk !== "string" ||
      !isNonEmptyString(input.mimeType) ||
      (input.segmentIndex !== undefined &&
        !isNonNegativeInteger(input.segmentIndex)) ||
      !isOptionalBoolean(input.isFinal)
    ) {
      return invalidServer(
        "tts.chunk requires requestId, sequence, chunk, mimeType, and valid optional fields"
      );
    }
    return validServer({
      type: WS_EVENTS.TTS_CHUNK,
      requestId: input.requestId,
      sequence: input.sequence,
      chunk: input.chunk,
      mimeType: input.mimeType,
      ...(input.segmentIndex === undefined
        ? {}
        : { segmentIndex: input.segmentIndex }),
      ...(input.isFinal === undefined ? {} : { isFinal: input.isFinal })
    });
  }

  if (input.type === WS_EVENTS.TTS_END) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isEnum(input.reason, ["stop", "interrupted", "error"] as const)
    ) {
      return invalidServer("tts.end requires requestId and a valid reason");
    }
    return validServer({
      type: WS_EVENTS.TTS_END,
      requestId: input.requestId,
      reason: input.reason
    });
  }

  if (input.type === "error") {
    if (
      !isOptionalNonEmptyString(input.requestId) ||
      !isNonEmptyString(input.message)
    ) {
      return invalidServer("error requires message and optional requestId");
    }
    return validServer({
      type: "error",
      message: input.message,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId })
    });
  }

  return invalidServer(`unsupported message type: ${input.type}`);
}

function valid(data: ClientMessage): ClientMessageValidationResult {
  return { success: true, data };
}

function invalid(error: string): ClientMessageValidationResult {
  return { success: false, error };
}

function validServer(data: ServerMessage): ServerMessageValidationResult {
  return { success: true, data };
}

function invalidServer(error: string): ServerMessageValidationResult {
  return { success: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isEnum<const T extends readonly string[]>(
  value: unknown,
  choices: T
): value is T[number] {
  return typeof value === "string" && choices.includes(value);
}

function isOptionalEnum<const T extends readonly string[]>(
  value: unknown,
  choices: T
): value is T[number] | undefined {
  return value === undefined || isEnum(value, choices);
}

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

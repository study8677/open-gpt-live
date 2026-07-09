export const WS_EVENTS = {
  SESSION_START: "session.start",
  USER_TEXT: "user.text",
  LLM_DELTA: "llm.delta",
  LLM_DONE: "llm.done",
  INTERRUPT: "interrupt",
  AUDIO_CHUNK: "audio.chunk",
  TRANSCRIPT_PARTIAL: "transcript.partial",
  TRANSCRIPT_FINAL: "transcript.final",
  TTS_CHUNK: "tts.chunk"
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
}

export interface InterruptMessage {
  type: typeof WS_EVENTS.INTERRUPT;
  requestId?: string;
  reason?: string;
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

export interface ErrorMessage {
  type: "error";
  requestId?: string;
  message: string;
}

export interface ReservedTranscriptPartialMessage {
  type: typeof WS_EVENTS.TRANSCRIPT_PARTIAL;
  requestId: string;
  text: string;
}

export interface ReservedTtsChunkMessage {
  type: typeof WS_EVENTS.TTS_CHUNK;
  requestId: string;
  chunk: string;
  encoding: string;
}

export type ClientMessage =
  | ClientSessionStartMessage
  | UserTextMessage
  | AudioChunkMessage
  | InterruptMessage;

export type ServerMessage =
  | ServerSessionStartMessage
  | LlmDeltaMessage
  | LlmDoneMessage
  | TranscriptFinalMessage
  | ErrorMessage;

export type ReservedMessage =
  | ReservedTranscriptPartialMessage
  | ReservedTtsChunkMessage;

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

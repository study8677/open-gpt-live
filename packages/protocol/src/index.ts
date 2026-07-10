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

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

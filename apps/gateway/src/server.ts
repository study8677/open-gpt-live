import "dotenv/config";

import { randomUUID } from "node:crypto";
import {
  OpenAILLMProvider,
  OpenAITTSProvider,
  OpenAIWhisperProvider,
  type LLMMessage,
  type STTProvider,
  type TTSProvider
} from "@open-gpt-live/adapters";
import {
  WS_EVENTS,
  type AudioChunkMessage,
  type ClientMessage,
  type LlmDoneMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { WebSocket, WebSocketServer } from "ws";

const port = Number.parseInt(process.env.GATEWAY_PORT ?? "8787", 10);
const maxAudioTurnBytes = 25 * 1024 * 1024;
const ttsSegmentMinLength = 24;
const ttsSegmentMaxLength = 240;
const ttsFormat = process.env.TTS_FORMAT ?? "mp3";
const ttsVoice = process.env.TTS_VOICE || undefined;
const llmProvider = new OpenAILLMProvider();
const sttProvider = new OpenAIWhisperProvider();
const configuredTtsProvider = createTtsProvider();

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
  audioTurns: Map<string, AudioTurn>;
}

interface AudioTurn {
  requestId: string;
  mimeType: string;
  chunks: Buffer[];
  byteLength: number;
  lastSequence: number;
}

const wss = new WebSocketServer({ port });

wss.on("connection", (socket) => {
  const session: SessionState = {
    sessionId: randomUUID(),
    audioTurns: new Map(),
    history: [
      {
        role: "system",
        content:
          "You are OpenGPT Live, a concise realtime AI assistant. Answer clearly and keep context from the conversation."
      }
    ]
  };

  send(socket, {
    type: WS_EVENTS.SESSION_START,
    sessionId: session.sessionId,
    status: "ready"
  });

  socket.on("message", (raw) => {
    void handleMessage(socket, session, raw.toString());
  });

  socket.on("close", () => {
    interruptCurrentRun(socket, session, "socket closed");
  });
});

console.log(`OpenGPT Live gateway listening on ws://localhost:${port}`);

async function handleMessage(
  socket: WebSocket,
  session: SessionState,
  raw: string
): Promise<void> {
  let message: ClientMessage;

  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    send(socket, { type: "error", message: "Invalid JSON message" });
    return;
  }

  if (message.type === WS_EVENTS.SESSION_START) {
    if (message.sessionId) {
      session.sessionId = message.sessionId;
    }

    send(socket, {
      type: WS_EVENTS.SESSION_START,
      sessionId: session.sessionId,
      status: "ready"
    });
    return;
  }

  if (message.type === WS_EVENTS.INTERRUPT) {
    interruptCurrentRun(socket, session, message.reason ?? "user interrupt");
    return;
  }

  if (message.type === WS_EVENTS.PLAYBACK_ACK) {
    return;
  }

  if (message.type === WS_EVENTS.USER_TEXT) {
    const text = message.text.trim();
    if (!text) {
      send(socket, { type: "error", message: "user.text requires non-empty text" });
      return;
    }

    const requestId = message.requestId ?? randomUUID();
    await handleUserText(socket, session, requestId, text);
    return;
  }

  if (message.type === WS_EVENTS.AUDIO_CHUNK) {
    await handleAudioChunk(socket, session, message);
    return;
  }

  const unsupported = (message as { type?: string }).type ?? "unknown";
  send(socket, { type: "error", message: `Unsupported message type: ${unsupported}` });
}

async function handleUserText(
  socket: WebSocket,
  session: SessionState,
  requestId: string,
  text: string
): Promise<void> {
  if (session.current) {
    interruptCurrentRun(socket, session, "new user message");
  }

  session.history.push({ role: "user", content: text });
  await streamAssistantResponse(socket, session, requestId);
}

async function handleAudioChunk(
  socket: WebSocket,
  session: SessionState,
  message: AudioChunkMessage
): Promise<void> {
  const turn = getOrCreateAudioTurn(session, message);

  if (message.chunk) {
    const chunk = Buffer.from(message.chunk, "base64");
    if (turn.byteLength + chunk.byteLength > maxAudioTurnBytes) {
      session.audioTurns.delete(message.requestId);
      send(socket, {
        type: "error",
        requestId: message.requestId,
        message: "Audio turn is too large to transcribe"
      });
      send(socket, {
        type: WS_EVENTS.LLM_DONE,
        requestId: message.requestId,
        reason: "error"
      });
      return;
    }

    turn.chunks.push(chunk);
    turn.byteLength += chunk.byteLength;
    turn.lastSequence = Math.max(turn.lastSequence, message.sequence);
  }

  if (!message.isFinal) {
    return;
  }

  session.audioTurns.delete(message.requestId);

  try {
    const transcript = await transcribeAudioTurn(sttProvider, turn);
    if (!transcript) {
      send(socket, {
        type: "error",
        requestId: message.requestId,
        message: "Transcription returned empty text"
      });
      send(socket, {
        type: WS_EVENTS.LLM_DONE,
        requestId: message.requestId,
        reason: "error"
      });
      return;
    }

    send(socket, {
      type: WS_EVENTS.TRANSCRIPT_FINAL,
      requestId: message.requestId,
      text: transcript
    });

    await handleUserText(socket, session, message.requestId, transcript);
  } catch (error) {
    send(socket, {
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Unknown transcription error"
    });
    send(socket, {
      type: WS_EVENTS.LLM_DONE,
      requestId: message.requestId,
      reason: "error"
    });
  }
}

function getOrCreateAudioTurn(
  session: SessionState,
  message: AudioChunkMessage
): AudioTurn {
  const existing = session.audioTurns.get(message.requestId);
  if (existing) {
    return existing;
  }

  const turn: AudioTurn = {
    requestId: message.requestId,
    mimeType: message.mimeType,
    chunks: [],
    byteLength: 0,
    lastSequence: -1
  };
  session.audioTurns.set(message.requestId, turn);
  return turn;
}

async function transcribeAudioTurn(
  provider: STTProvider,
  turn: AudioTurn
): Promise<string> {
  const audio = Buffer.concat(turn.chunks);
  if (audio.byteLength === 0) {
    return "";
  }

  const result = await provider.transcribe({
    data: audio,
    mimeType: turn.mimeType,
    filename: filenameForMimeType(turn.mimeType)
  });

  return result.text.trim();
}

async function streamAssistantResponse(
  socket: WebSocket,
  session: SessionState,
  requestId: string
): Promise<void> {
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

  session.current = run;
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
          session.current !== run
        ) {
          return;
        }

        await streamTtsSegment(
          socket,
          run,
          configuredTtsProvider,
          text,
          isFinalSegment
        );
      })
      .catch((error: unknown) => {
        ttsError ??= error;
        if (!run.interrupted && !run.controller.signal.aborted) {
          run.controller.abort("tts error");
        }
      });
  };

  try {
    for await (const chunk of llmProvider.streamText(session.history, {
      signal: run.controller.signal
    })) {
      if (run.interrupted || run.llmDoneSent || session.current !== run) {
        break;
      }

      run.text += chunk.delta;
      pendingTtsText += chunk.delta;
      send(socket, {
        type: WS_EVENTS.LLM_DELTA,
        requestId,
        delta: chunk.delta
      });

      const readySegments = takeReadyTtsSegments(pendingTtsText);
      pendingTtsText = readySegments.remainder;
      for (const segment of readySegments.segments) {
        enqueueTtsSegment(segment, false);
      }
    }

    if (!run.interrupted && session.current === run) {
      if (ttsError) {
        throw ttsError;
      }
      if (run.text) {
        session.history.push({ role: "assistant", content: run.text });
      }
      sendLlmDone(socket, run, "stop");
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
        session.current !== run
      ) {
        return;
      }
      sendTtsEnd(socket, run, "stop");
      finishRun(session, run, "done");
    }
  } catch (error) {
    if (ttsError && !run.interrupted) {
      send(socket, {
        type: "error",
        requestId,
        message:
          ttsError instanceof Error ? ttsError.message : "Unknown TTS gateway error"
      });
      sendLlmDone(socket, run, "error");
      sendTtsEnd(socket, run, "error");
      finishRun(session, run, "error");
      return;
    }

    if (run.controller.signal.aborted || run.interrupted) {
      sendLlmDone(socket, run, "interrupted");
      sendTtsEnd(socket, run, "interrupted");
      finishRun(session, run, "interrupted");
      return;
    }

    send(socket, {
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : "Unknown gateway error"
    });
    sendLlmDone(socket, run, "error");
    sendTtsEnd(socket, run, "error");
    finishRun(session, run, "error");
  }
}

function interruptCurrentRun(socket: WebSocket, session: SessionState, reason: string): void {
  const run = session.current;
  if (!run) {
    return;
  }

  run.interrupted = true;
  run.controller.abort(reason);
  sendLlmDone(socket, run, "interrupted");
  sendTtsEnd(socket, run, "interrupted");
  finishRun(session, run, "interrupted");
}

async function streamTtsSegment(
  socket: WebSocket,
  run: ActiveRun,
  provider: TTSProvider | undefined,
  text: string,
  isFinalSegment: boolean
): Promise<void> {
  const segmentText = text.trim();
  if (!provider || !segmentText || run.interrupted || run.controller.signal.aborted) {
    return;
  }

  if (!run.ttsStarted) {
    run.ttsStarted = true;
    send(socket, {
      type: WS_EVENTS.TTS_START,
      requestId: run.requestId,
      voice: ttsVoice,
      format: ttsFormat,
      mimeType: "audio/mpeg"
    });
  }

  run.stage = "tts_streaming";
  const segmentIndex = run.ttsSegmentIndex++;
  let pendingChunk:
    | {
        audio: Uint8Array;
        mimeType: string;
      }
    | undefined;

  for await (const chunk of provider.synthesize(
    {
      text: segmentText,
      voice: ttsVoice,
      format: ttsFormat
    },
    { signal: run.controller.signal }
  )) {
    if (run.interrupted || run.controller.signal.aborted) {
      return;
    }

    if (pendingChunk) {
      sendTtsChunk(socket, run, pendingChunk, segmentIndex, false);
    }

    pendingChunk = {
      audio: chunk.audio,
      mimeType: chunk.mimeType
    };
  }

  if (pendingChunk && !run.interrupted && !run.controller.signal.aborted) {
    sendTtsChunk(socket, run, pendingChunk, segmentIndex, isFinalSegment);
  }
}

function sendTtsChunk(
  socket: WebSocket,
  run: ActiveRun,
  chunk: { audio: Uint8Array; mimeType: string },
  segmentIndex: number,
  isFinal: boolean
): void {
  send(socket, {
    type: WS_EVENTS.TTS_CHUNK,
    requestId: run.requestId,
    sequence: run.ttsSequence++,
    chunk: Buffer.from(chunk.audio).toString("base64"),
    mimeType: chunk.mimeType,
    segmentIndex,
    isFinal
  });
}

function sendLlmDone(
  socket: WebSocket,
  run: ActiveRun,
  reason: LlmDoneMessage["reason"]
): void {
  if (run.llmDoneSent) {
    return;
  }

  run.llmDoneSent = true;
  send(socket, {
    type: WS_EVENTS.LLM_DONE,
    requestId: run.requestId,
    reason
  });
}

function sendTtsEnd(
  socket: WebSocket,
  run: ActiveRun,
  reason: "stop" | "interrupted" | "error"
): void {
  if (run.ttsEnded || !run.ttsStarted) {
    return;
  }

  run.ttsEnded = true;
  send(socket, {
    type: WS_EVENTS.TTS_END,
    requestId: run.requestId,
    reason
  });
}

function finishRun(
  session: SessionState,
  run: ActiveRun,
  stage: "done" | "interrupted" | "error"
): void {
  run.stage = stage;
  if (session.current === run) {
    session.current = undefined;
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function filenameForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) {
    return "recording.webm";
  }
  if (mimeType.includes("mp4")) {
    return "recording.mp4";
  }
  if (mimeType.includes("mpeg")) {
    return "recording.mp3";
  }
  if (mimeType.includes("wav")) {
    return "recording.wav";
  }
  return "recording.webm";
}

function createTtsProvider(): TTSProvider | undefined {
  if (!process.env.TTS_API_KEY && !process.env.OPENAI_API_KEY) {
    return undefined;
  }

  return new OpenAITTSProvider();
}

function takeReadyTtsSegments(text: string): {
  segments: string[];
  remainder: string;
} {
  const segments: string[] = [];
  let remainder = text;

  while (remainder.length >= ttsSegmentMinLength) {
    const boundary = findSegmentBoundary(remainder);
    const splitAt =
      boundary >= ttsSegmentMinLength
        ? boundary
        : remainder.length >= ttsSegmentMaxLength
          ? ttsSegmentMaxLength
          : -1;

    if (splitAt === -1) {
      break;
    }

    segments.push(remainder.slice(0, splitAt).trim());
    remainder = remainder.slice(splitAt).trimStart();
  }

  return {
    segments: segments.filter(Boolean),
    remainder
  };
}

function findSegmentBoundary(text: string): number {
  const boundaryPattern = /[.!?。！？；;，,]\s*/g;
  let match: RegExpExecArray | null;
  let lastBoundary = -1;

  while ((match = boundaryPattern.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    if (boundary >= ttsSegmentMinLength) {
      lastBoundary = boundary;
    }
    if (boundary >= ttsSegmentMaxLength) {
      break;
    }
  }

  return lastBoundary;
}

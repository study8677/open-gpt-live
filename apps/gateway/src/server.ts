import "dotenv/config";

import { randomUUID } from "node:crypto";
import {
  OpenAILLMProvider,
  OpenAIWhisperProvider,
  type LLMMessage,
  type STTProvider
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
const llmProvider = new OpenAILLMProvider();
const sttProvider = new OpenAIWhisperProvider();

interface ActiveRun {
  requestId: string;
  controller: AbortController;
  text: string;
  interrupted: boolean;
  doneSent: boolean;
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
    text: "",
    interrupted: false,
    doneSent: false
  };

  session.current = run;

  try {
    for await (const chunk of llmProvider.streamText(session.history, {
      signal: run.controller.signal
    })) {
      if (run.interrupted || run.doneSent || session.current !== run) {
        break;
      }

      run.text += chunk.delta;
      send(socket, {
        type: WS_EVENTS.LLM_DELTA,
        requestId,
        delta: chunk.delta
      });
    }

    if (!run.interrupted && session.current === run) {
      if (run.text) {
        session.history.push({ role: "assistant", content: run.text });
      }
      sendDone(socket, session, run, "stop");
    }
  } catch (error) {
    if (run.controller.signal.aborted || run.interrupted) {
      sendDone(socket, session, run, "interrupted");
      return;
    }

    send(socket, {
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : "Unknown gateway error"
    });
    sendDone(socket, session, run, "error");
  }
}

function interruptCurrentRun(socket: WebSocket, session: SessionState, reason: string): void {
  const run = session.current;
  if (!run) {
    return;
  }

  run.interrupted = true;
  run.controller.abort(reason);
  sendDone(socket, session, run, "interrupted");
}

function sendDone(
  socket: WebSocket,
  session: SessionState,
  run: ActiveRun,
  reason: LlmDoneMessage["reason"]
): void {
  if (run.doneSent) {
    return;
  }

  run.doneSent = true;
  send(socket, {
    type: WS_EVENTS.LLM_DONE,
    requestId: run.requestId,
    reason
  });

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

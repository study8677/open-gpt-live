import "dotenv/config";

import { randomUUID } from "node:crypto";
import { OpenAILLMProvider, type LLMMessage } from "@open-gpt-live/adapters";
import {
  WS_EVENTS,
  type ClientMessage,
  type LlmDoneMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { WebSocket, WebSocketServer } from "ws";

const port = Number.parseInt(process.env.GATEWAY_PORT ?? "8787", 10);
const provider = new OpenAILLMProvider();

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
}

const wss = new WebSocketServer({ port });

wss.on("connection", (socket) => {
  const session: SessionState = {
    sessionId: randomUUID(),
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

    if (session.current) {
      interruptCurrentRun(socket, session, "new user message");
    }

    const requestId = message.requestId ?? randomUUID();
    session.history.push({ role: "user", content: text });
    await streamAssistantResponse(socket, session, requestId);
    return;
  }

  const unsupported = (message as { type?: string }).type ?? "unknown";
  send(socket, { type: "error", message: `Unsupported message type: ${unsupported}` });
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
    for await (const chunk of provider.streamText(session.history, {
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

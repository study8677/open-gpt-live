"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  WS_EVENTS,
  createRequestId,
  type ClientMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  requestId: string;
}

const gatewayUrl =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787";

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSend = useMemo(
    () => connected && input.trim().length > 0 && !activeRequestId,
    [activeRequestId, connected, input]
  );

  useEffect(() => {
    const socket = new WebSocket(gatewayUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      sendRaw(socket, { type: WS_EVENTS.SESSION_START });
    });

    socket.addEventListener("close", () => {
      setConnected(false);
      setActiveRequestId(null);
    });

    socket.addEventListener("error", () => {
      setError("WebSocket connection error");
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      handleServerMessage(message);
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  function handleServerMessage(message: ServerMessage): void {
    if (message.type === WS_EVENTS.SESSION_START) {
      setSessionId(message.sessionId);
      return;
    }

    if (message.type === WS_EVENTS.LLM_DELTA) {
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.role === "assistant"
            ? { ...item, content: item.content + message.delta }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.LLM_DONE) {
      setActiveRequestId((current) =>
        current === message.requestId ? null : current
      );
      return;
    }

    if (message.type === "error") {
      setError(message.message);
      if (message.requestId) {
        setActiveRequestId((current) =>
          current === message.requestId ? null : current
        );
      }
    }
  }

  function sendMessage(): void {
    const text = input.trim();
    const socket = socketRef.current;
    if (!socket || !canSend || !text) {
      return;
    }

    const requestId = createRequestId();
    setError(null);
    setInput("");
    setActiveRequestId(requestId);
    setMessages((current) => [
      ...current,
      {
        id: createRequestId(),
        role: "user",
        content: text,
        requestId
      },
      {
        id: createRequestId(),
        role: "assistant",
        content: "",
        requestId
      }
    ]);

    sendRaw(socket, {
      type: WS_EVENTS.USER_TEXT,
      requestId,
      text
    });
  }

  function stopResponse(): void {
    const socket = socketRef.current;
    if (!socket || !activeRequestId) {
      return;
    }

    sendRaw(socket, {
      type: WS_EVENTS.INTERRUPT,
      requestId: activeRequestId,
      reason: "user clicked stop"
    });
  }

  return (
    <main className="shell">
      <header className="header">
        <div>
          <h1>OpenGPT Live</h1>
          <p>Text-loop MVP over WebSocket</p>
        </div>
        <div className={connected ? "status connected" : "status"}>
          {connected ? "Connected" : "Disconnected"}
        </div>
      </header>

      <section className="meta">
        <span>Gateway: {gatewayUrl}</span>
        <span>Session: {sessionId ?? "pending"}</span>
      </section>

      <section className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <p className="empty">Send a text message to start the session.</p>
        ) : (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
              <p>{message.content || "..."}</p>
            </article>
          ))
        )}
      </section>

      {error ? <p className="error">{error}</p> : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendMessage();
        }}
      >
        <input
          aria-label="Message"
          placeholder="Type a message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
        <button
          className="secondary"
          type="button"
          disabled={!activeRequestId}
          onClick={stopResponse}
        >
          Stop
        </button>
      </form>
    </main>
  );
}

function sendRaw(socket: WebSocket, message: ClientMessage): void {
  socket.send(JSON.stringify(message));
}

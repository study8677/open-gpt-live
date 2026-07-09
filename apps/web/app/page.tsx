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
  source?: "text" | "audio";
}

const gatewayUrl =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787";

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRequestRef = useRef<string | null>(null);
  const audioMimeTypeRef = useRef<string>("audio/webm");
  const audioSequenceRef = useRef(0);
  const pendingChunkSendsRef = useRef<Array<Promise<void>>>([]);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
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
      setError(null);
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

    if (message.type === WS_EVENTS.TRANSCRIPT_FINAL) {
      setRecordingStatus(null);
      setMessages((current) => [
        ...current,
        {
          id: createRequestId(),
          role: "user",
          content: message.text,
          requestId: message.requestId,
          source: "audio"
        },
        {
          id: createRequestId(),
          role: "assistant",
          content: "",
          requestId: message.requestId
        }
      ]);
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
        requestId,
        source: "text"
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

  async function startRecording(): Promise<void> {
    const socket = socketRef.current;
    if (!socket || !connected || activeRequestId || recording) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicError("This browser does not support microphone recording.");
      return;
    }

    try {
      setError(null);
      setMicError(null);
      setRecordingStatus("Requesting microphone permission...");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = selectAudioMimeType();
      const requestId = createRequestId();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );

      recorderRef.current = recorder;
      streamRef.current = stream;
      audioRequestRef.current = requestId;
      audioMimeTypeRef.current = recorder.mimeType || mimeType || "audio/webm";
      audioSequenceRef.current = 0;
      pendingChunkSendsRef.current = [];
      setActiveRequestId(requestId);
      setRecording(true);
      setRecordingStatus("Recording...");

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size === 0) {
          return;
        }

        const sendPromise = sendAudioBlob(event.data);
        pendingChunkSendsRef.current.push(sendPromise);
      });

      recorder.addEventListener("stop", () => {
        void finalizeRecording();
      });

      recorder.start(250);
    } catch (reason) {
      cleanupRecording();
      setMicError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "Microphone permission was denied. Text input is still available."
          : "Could not start microphone recording. Text input is still available."
      );
      setRecordingStatus(null);
      setActiveRequestId(null);
    }
  }

  function stopRecording(): void {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    setRecording(false);
    setRecordingStatus("Transcribing...");
    recorder.stop();
  }

  async function sendAudioBlob(blob: Blob): Promise<void> {
    const socket = socketRef.current;
    const requestId = audioRequestRef.current;
    if (!socket || !requestId) {
      return;
    }

    const chunk = await blobToBase64(blob);
    sendRaw(socket, {
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId,
      chunk,
      mimeType: audioMimeTypeRef.current,
      sequence: audioSequenceRef.current++,
      isFinal: false
    });
  }

  async function finalizeRecording(): Promise<void> {
    const socket = socketRef.current;
    const requestId = audioRequestRef.current;
    const pending = pendingChunkSendsRef.current;

    try {
      await Promise.all(pending);
      if (socket && requestId) {
        sendRaw(socket, {
          type: WS_EVENTS.AUDIO_CHUNK,
          requestId,
          mimeType: audioMimeTypeRef.current,
          sequence: audioSequenceRef.current,
          isFinal: true
        });
      }
    } catch {
      setError("Could not send recorded audio.");
      setActiveRequestId(null);
      setRecordingStatus(null);
    } finally {
      cleanupRecording();
    }
  }

  function cleanupRecording(): void {
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioRequestRef.current = null;
    pendingChunkSendsRef.current = [];
    setRecording(false);
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
          <p>Text and push-to-talk loop over WebSocket</p>
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
              {message.source === "audio" ? <span>transcribed speech</span> : null}
              <p>{message.content || "..."}</p>
            </article>
          ))
        )}
      </section>

      {recordingStatus ? <p className="notice">{recordingStatus}</p> : null}
      {micError ? <p className="error">{micError}</p> : null}
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
          className={recording ? "recording" : "secondary"}
          type="button"
          disabled={!connected || (Boolean(activeRequestId) && !recording)}
          onPointerDown={(event) => {
            event.preventDefault();
            void startRecording();
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            stopRecording();
          }}
          onPointerCancel={stopRecording}
          onPointerLeave={() => {
            if (recording) {
              stopRecording();
            }
          }}
        >
          {recording ? "Release" : "Hold to Talk"}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={!activeRequestId || Boolean(recordingStatus)}
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

function selectAudioMimeType(): string {
  const preferred = ["audio/webm;codecs=opus", "audio/webm"];
  return preferred.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

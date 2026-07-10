"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  WS_EVENTS,
  createRequestId,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import {
  LIVE_PCM_MIME_TYPE,
  LIVE_PCM_SAMPLE_RATE,
  Pcm16FrameBuffer,
  StreamingPcm16Resampler
} from "../lib/audio-pcm";
import { resolveVadConfig } from "../lib/live-config";
import {
  beginRequest,
  canAcceptRequestEvent,
  cancelActiveRequests,
  settleRequest,
  transitionRequest,
  type RequestLifecycleRegistry
} from "../lib/request-lifecycle";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  requestId: string;
  source?: "text" | "audio";
  transient?: boolean;
}

interface QueuedAudioChunk {
  sequence: number;
  bytes: Uint8Array;
  mimeType: string;
}

interface PlaybackQueue {
  requestId: string;
  chunks: Map<number, QueuedAudioChunk>;
  nextSequence: number;
  ended: boolean;
  playing: boolean;
}

interface BlockedPlayback {
  requestId: string;
  sequence: number;
  audio: HTMLAudioElement;
  objectUrl: string;
}

interface PushToTalkRecording {
  requestId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  mimeType: string;
  sequence: number;
  pendingSends: Array<Promise<void>>;
  cancelled: boolean;
  finalizing: boolean;
}

interface LivePcmFrame {
  samples: Int16Array;
  durationMs: number;
}

interface LivePcmTurn {
  requestId: string;
  sequence: number;
  startedAt: number;
  cancelled: boolean;
}

interface VadWorkletFrame {
  rms?: number;
  pcm?: ArrayBuffer;
  sampleRate?: number;
}

type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

const gatewayUrl =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787";

const vadConfig = resolveVadConfig({
  speechThreshold: process.env.NEXT_PUBLIC_VAD_SPEECH_THRESHOLD,
  silenceThreshold: process.env.NEXT_PUBLIC_VAD_SILENCE_THRESHOLD,
  startDebounceMs: process.env.NEXT_PUBLIC_VAD_START_DEBOUNCE_MS,
  hangoverMs: process.env.NEXT_PUBLIC_VAD_HANGOVER_MS,
  maxTurnMs: process.env.NEXT_PUBLIC_VAD_MAX_TURN_MS,
  preRollMs: process.env.NEXT_PUBLIC_VAD_PRE_ROLL_MS,
  playbackThresholdMultiplier:
    process.env.NEXT_PUBLIC_VAD_PLAYBACK_THRESHOLD_MULTIPLIER,
  playbackSuppressAfterEndMs:
    process.env.NEXT_PUBLIC_VAD_PLAYBACK_SUPPRESS_AFTER_END_MS
});

// MediaRecorder is retained for push-to-talk; live mode sends PCM from the worklet.
const recorderTimesliceMs = 250;
const reconnectBaseDelayMs = 500;
const reconnectMaximumDelayMs = 8_000;

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const pttRecordingRef = useRef<PushToTalkRecording | null>(null);
  const pttPermissionPendingRef = useRef(false);
  const pttStartCancelledRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const liveModeGenerationRef = useRef(0);
  const livePcmTurnRef = useRef<LivePcmTurn | null>(null);
  const preRollFramesRef = useRef<LivePcmFrame[]>([]);
  const requestLifecyclesRef = useRef<RequestLifecycleRegistry>(new Map());
  const activeRequestIdRef = useRef<string | null>(null);
  const playbackQueuesRef = useRef<Map<string, PlaybackQueue>>(new Map());
  const ignoredPlaybackRequestsRef = useRef<Set<string>>(new Set());
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioObjectUrlRef = useRef<string | null>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const blockedPlaybackRef = useRef<BlockedPlayback | null>(null);
  const playbackVadSuppressedUntilRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const vadWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const vadScriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const vadMuteGainRef = useRef<GainNode | null>(null);
  const fallbackResamplerRef = useRef<StreamingPcm16Resampler | null>(null);
  const fallbackFrameBufferRef = useRef<Pcm16FrameBuffer | null>(null);
  const vadStateRef = useRef<"idle" | "speech_candidate" | "speaking">("idle");
  const vadCandidateStartedAtRef = useRef(0);
  const vadSilenceStartedAtRef = useRef(0);
  const liveTurnStartedAtRef = useRef(0);
  const liveModeRef = useRef(false);
  const liveListeningRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualPlaybackRequestId, setManualPlaybackRequestId] = useState<
    string | null
  >(null);

  const canSend = useMemo(
    () => connected && input.trim().length > 0 && !activeRequestId,
    [activeRequestId, connected, input]
  );

  useEffect(() => {
    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return;
      }

      const delay = Math.min(
        reconnectMaximumDelayMs,
        reconnectBaseDelayMs * 2 ** reconnectAttempt
      );
      reconnectAttempt += 1;
      setConnectionStatus("reconnecting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      const currentSocket = socketRef.current;
      if (
        currentSocket &&
        (currentSocket.readyState === WebSocket.CONNECTING ||
          currentSocket.readyState === WebSocket.OPEN)
      ) {
        return;
      }

      setConnectionStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");

      let socket: WebSocket;
      try {
        socket = new WebSocket(gatewayUrl);
      } catch {
        setConnected(false);
        setConnectionStatus("disconnected");
        setError("Could not connect to the gateway. Retrying automatically...");
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) {
          socket.close();
          return;
        }
        const restoredConnection = reconnectAttempt > 0;
        reconnectAttempt = 0;
        setConnected(true);
        setConnectionStatus("connected");
        setError(
          restoredConnection
            ? "Gateway reconnected. A new session has started."
            : null
        );
      });

      socket.addEventListener("close", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }

        socketRef.current = null;
        setConnected(false);
        setSessionId(null);
        setConnectionStatus("disconnected");
        cancelRequestsAfterDisconnect();
        setError(
          "Gateway disconnected. Reconnecting automatically; the next connection starts a new session."
        );
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        if (socketRef.current === socket) {
          setError("Gateway connection failed. Waiting to reconnect...");
        }
      });

      socket.addEventListener("message", (event) => {
        if (disposed || socketRef.current !== socket) {
          return;
        }

        try {
          const result = parseServerMessage(JSON.parse(event.data as string));
          if (!result.success) {
            setError(`Received an invalid gateway message: ${result.error}`);
            return;
          }
          handleServerMessage(result.data);
        } catch {
          setError("Received an invalid gateway message.");
        }
      });
    };

    reconnectNowRef.current = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    };

    connect();

    return () => {
      disposed = true;
      reconnectNowRef.current = null;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      cleanupAllPlayback(false);
      cleanupLiveMode(false, false);
      cancelPushToTalkRecording(false);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  function handleServerMessage(message: ServerMessage): void {
    if (message.type === WS_EVENTS.SESSION_START) {
      setSessionId(message.sessionId);
      return;
    }

    if (message.type === WS_EVENTS.LLM_DELTA) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId, [
          "responding",
          "playing"
        ])
      ) {
        return;
      }
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.role === "assistant"
            ? { ...item, content: item.content + message.delta }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.TRANSCRIPT_PARTIAL) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId, [
          "recording",
          "finalizing",
          "transcribing"
        ])
      ) {
        return;
      }
      setRecordingStatus("Listening...");
      setMessages((current) => {
        const existing = current.find(
          (item) => item.requestId === message.requestId && item.role === "user"
        );
        if (existing) {
          return current.map((item) =>
            item.id === existing.id
              ? { ...item, content: message.text, transient: true }
              : item
          );
        }

        return [
          ...current,
          {
            id: createRequestId(),
            role: "user",
            content: message.text,
            requestId: message.requestId,
            source: "audio",
            transient: true
          }
        ];
      });
      return;
    }

    if (message.type === WS_EVENTS.TRANSCRIPT_FINAL) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId, [
          "recording",
          "finalizing",
          "transcribing"
        ])
      ) {
        return;
      }
      transitionRequest(
        requestLifecyclesRef.current,
        message.requestId,
        "responding"
      );
      setRecordingStatus(null);
      setMessages((current) => {
        const hasUser = current.some(
          (item) => item.requestId === message.requestId && item.role === "user"
        );
        const hasAssistant = current.some(
          (item) =>
            item.requestId === message.requestId && item.role === "assistant"
        );
        const next = hasUser
          ? current.map((item) =>
              item.requestId === message.requestId && item.role === "user"
                ? { ...item, content: message.text, transient: false }
                : item
            )
          : [
              ...current,
              {
                id: createRequestId(),
                role: "user" as const,
                content: message.text,
                requestId: message.requestId,
                source: "audio" as const
              }
            ];

        return hasAssistant
          ? next
          : [
              ...next,
              {
                id: createRequestId(),
                role: "assistant",
                content: "",
                requestId: message.requestId
              }
            ];
      });
      return;
    }

    if (message.type === WS_EVENTS.LLM_DONE) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId)
      ) {
        return;
      }
      if (message.reason === "interrupted" || message.reason === "error") {
        cancelRequest(message.requestId);
      } else {
        window.setTimeout(() => {
          if (
            canAcceptRequestEvent(
              requestLifecyclesRef.current,
              message.requestId
            ) &&
            !playbackQueuesRef.current.has(message.requestId)
          ) {
            completeRequest(message.requestId);
          }
        }, 250);
      }
      return;
    }

    if (message.type === WS_EVENTS.TTS_START) {
      if (
        ignoredPlaybackRequestsRef.current.has(message.requestId) ||
        !transitionRequest(
          requestLifecyclesRef.current,
          message.requestId,
          "playing"
        )
      ) {
        return;
      }
      setCurrentRequest(message.requestId);
      playbackQueuesRef.current.set(message.requestId, {
        requestId: message.requestId,
        chunks: new Map(),
        nextSequence: 0,
        ended: false,
        playing: false
      });
      return;
    }

    if (message.type === WS_EVENTS.TTS_CHUNK) {
      if (
        ignoredPlaybackRequestsRef.current.has(message.requestId) ||
        !canAcceptRequestEvent(
          requestLifecyclesRef.current,
          message.requestId,
          ["playing"]
        )
      ) {
        return;
      }

      const queue = getOrCreatePlaybackQueue(message.requestId);
      queue.chunks.set(message.sequence, {
        sequence: message.sequence,
        bytes: base64ToUint8Array(message.chunk),
        mimeType: message.mimeType
      });
      void drainPlaybackQueue(message.requestId);
      return;
    }

    if (message.type === WS_EVENTS.TTS_END) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId)
      ) {
        return;
      }
      const queue = playbackQueuesRef.current.get(message.requestId);
      if (queue) {
        queue.ended = true;
      }
      if (message.reason !== "stop") {
        cancelRequest(message.requestId);
      } else if (!queue) {
        completeRequest(message.requestId);
      } else {
        void drainPlaybackQueue(message.requestId);
      }
      return;
    }

    if (message.type === "error") {
      if (
        message.requestId &&
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId)
      ) {
        return;
      }
      setError(message.message);
      if (message.requestId) {
        cancelRequest(message.requestId);
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
    beginRequest(requestLifecyclesRef.current, requestId, "responding");
    setError(null);
    setInput("");
    setCurrentRequest(requestId);
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

    if (!sendRaw(socket, {
      type: WS_EVENTS.USER_TEXT,
      requestId,
      text
    })) {
      cancelRequest(requestId);
      setError("The message was not sent because the gateway disconnected.");
    }
  }

  async function startRecording(): Promise<void> {
    const socket = socketRef.current;
    let requestedStream: MediaStream | null = null;
    if (!socket || !connected || activeRequestId || recording) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicError("This browser does not support microphone recording.");
      return;
    }

    try {
      pttPermissionPendingRef.current = true;
      pttStartCancelledRef.current = false;
      setError(null);
      setMicError(null);
      setRecordingStatus("Requesting microphone permission...");

      const stream = await getAudioInputStream();
      requestedStream = stream;
      const mimeType = selectAudioMimeType();
      const requestId = createRequestId();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
      const context: PushToTalkRecording = {
        requestId,
        recorder,
        stream,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        sequence: 0,
        pendingSends: [],
        cancelled: false,
        finalizing: false
      };

      pttPermissionPendingRef.current = false;
      if (
        pttStartCancelledRef.current ||
        !connected ||
        socketRef.current !== socket
      ) {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingStatus(null);
        return;
      }

      pttRecordingRef.current = context;
      requestedStream = null;
      beginRequest(requestLifecyclesRef.current, requestId, "recording");
      setCurrentRequest(requestId);
      setRecording(true);
      setRecordingStatus("Recording...");

      recorder.addEventListener("dataavailable", (event) => {
        if (
          context.cancelled ||
          pttRecordingRef.current !== context ||
          event.data.size === 0
        ) {
          return;
        }

        const sequence = context.sequence++;
        const sendPromise = sendAudioBlob(context, event.data, sequence);
        context.pendingSends.push(sendPromise);
      });

      recorder.addEventListener("stop", () => {
        void finalizePushToTalkRecording(context);
      });

      recorder.start(recorderTimesliceMs);
    } catch (reason) {
      pttPermissionPendingRef.current = false;
      requestedStream?.getTracks().forEach((track) => track.stop());
      cancelPushToTalkRecording();
      setMicError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "Microphone permission was denied. Text input is still available."
          : "Could not start microphone recording. Text input is still available."
      );
      setRecordingStatus(null);
      clearCurrentRequest();
    }
  }

  function stopRecording(): void {
    if (pttPermissionPendingRef.current) {
      pttStartCancelledRef.current = true;
      setRecordingStatus(null);
      return;
    }

    const context = pttRecordingRef.current;
    if (!context || context.recorder.state === "inactive" || context.finalizing) {
      return;
    }

    context.finalizing = true;
    transitionRequest(
      requestLifecyclesRef.current,
      context.requestId,
      "finalizing"
    );
    setRecording(false);
    setRecordingStatus("Transcribing...");
    context.recorder.stop();
  }

  async function sendAudioBlob(
    context: PushToTalkRecording,
    blob: Blob,
    sequence: number
  ): Promise<void> {
    const chunk = await blobToBase64(blob);
    const socket = socketRef.current;
    if (
      context.cancelled ||
      !socket ||
      !canAcceptRequestEvent(requestLifecyclesRef.current, context.requestId)
    ) {
      return;
    }

    if (!sendRaw(socket, {
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: context.requestId,
      chunk,
      mimeType: context.mimeType,
      sequence,
      turnMode: "ptt",
      isFinal: false
    })) {
      throw new Error("gateway disconnected");
    }
  }

  async function finalizePushToTalkRecording(
    context: PushToTalkRecording
  ): Promise<void> {
    try {
      await Promise.all(context.pendingSends);
      const socket = socketRef.current;
      if (
        context.cancelled ||
        !socket ||
        !canAcceptRequestEvent(requestLifecyclesRef.current, context.requestId)
      ) {
        return;
      }

      if (!sendRaw(socket, {
        type: WS_EVENTS.AUDIO_CHUNK,
        requestId: context.requestId,
        mimeType: context.mimeType,
        sequence: context.sequence,
        turnMode: "ptt",
        isFinal: true
      })) {
        throw new Error("gateway disconnected");
      }

      transitionRequest(
        requestLifecyclesRef.current,
        context.requestId,
        "transcribing"
      );
    } catch {
      if (!context.cancelled) {
        setError("Could not send recorded audio.");
        cancelRequest(context.requestId);
        setRecordingStatus(null);
      }
    } finally {
      cleanupPushToTalkRecording(context);
    }
  }

  function cancelPushToTalkRecording(updateUi = true): void {
    pttStartCancelledRef.current = true;
    const context = pttRecordingRef.current;
    if (!context) {
      return;
    }

    context.cancelled = true;
    settleRequest(
      requestLifecyclesRef.current,
      context.requestId,
      "cancelled"
    );
    if (context.recorder.state !== "inactive") {
      context.recorder.stop();
    }
    cleanupPushToTalkRecording(context, updateUi);
  }

  function cleanupPushToTalkRecording(
    context: PushToTalkRecording,
    updateUi = true
  ): void {
    context.stream.getTracks().forEach((track) => track.stop());
    if (pttRecordingRef.current === context) {
      pttRecordingRef.current = null;
    }
    if (updateUi) {
      setRecording(false);
    }
  }

  function stopResponse(): void {
    const socket = socketRef.current;
    const requestId = activeRequestIdRef.current;
    if (!requestId) {
      return;
    }

    if (livePcmTurnRef.current?.requestId === requestId) {
      cancelLivePcmTurn(true);
    } else {
      cancelRequest(requestId);
    }
    setRecordingStatus(null);
    if (socket) {
      sendRaw(socket, {
        type: WS_EVENTS.INTERRUPT,
        requestId,
        reason: "user clicked stop"
      });
    }
  }

  async function toggleLiveMode(): Promise<void> {
    if (liveModeRef.current) {
      cleanupLiveMode(true);
      return;
    }

    if (!connected || !navigator.mediaDevices?.getUserMedia) {
      setMicError("This browser does not support microphone recording.");
      return;
    }

    try {
      const generation = ++liveModeGenerationRef.current;
      setError(null);
      setMicError(null);
      setRecordingStatus("Starting live mode...");
      const stream = await getAudioInputStream();
      if (
        generation !== liveModeGenerationRef.current ||
        !socketRef.current ||
        socketRef.current.readyState !== WebSocket.OPEN
      ) {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingStatus(null);
        return;
      }
      streamRef.current = stream;
      liveModeRef.current = true;
      liveListeningRef.current = true;
      await setupVadPipeline(stream);
      setLiveMode(true);
      setRecordingStatus("Live mode listening...");
    } catch {
      cleanupLiveMode(false);
      setMicError("Could not start live mode. Text input is still available.");
    }
  }

  async function setupVadPipeline(stream: MediaStream): Promise<void> {
    cleanupVadPipeline();
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    const audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;

    audioContextRef.current = audioContext;
    vadSourceRef.current = source;
    vadMuteGainRef.current = muteGain;

    try {
      await audioContext.audioWorklet.addModule("/vad-worklet.js");
      if (!liveModeRef.current || streamRef.current !== stream) {
        throw new Error("live mode stopped while audio worklet was loading");
      }
      const node = new AudioWorkletNode(audioContext, "open-gpt-live-vad");
      node.port.onmessage = (event: MessageEvent<VadWorkletFrame>) => {
        if (
          typeof event.data.rms === "number" &&
          event.data.pcm instanceof ArrayBuffer &&
          event.data.sampleRate === LIVE_PCM_SAMPLE_RATE
        ) {
          handleVadFrame(event.data.rms, new Int16Array(event.data.pcm));
        }
      };
      source.connect(node);
      node.connect(muteGain);
      muteGain.connect(audioContext.destination);
      vadWorkletNodeRef.current = node;
    } catch {
      if (!liveModeRef.current || streamRef.current !== stream) {
        throw new Error("live mode stopped while audio worklet was loading");
      }
      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      const resampler = new StreamingPcm16Resampler(audioContext.sampleRate);
      const frameBuffer = new Pcm16FrameBuffer();
      fallbackResamplerRef.current = resampler;
      fallbackFrameBufferRef.current = frameBuffer;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const resampled = resampler.push(input);
        for (const frame of frameBuffer.push(resampled)) {
          handleVadFrame(calculatePcm16Rms(frame), frame);
        }
      };
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(audioContext.destination);
      vadScriptProcessorRef.current = processor;
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  function handleVadFrame(rms: number, samples: Int16Array): void {
    if (!liveModeRef.current || !liveListeningRef.current) {
      return;
    }

    const now = Date.now();
    const frame: LivePcmFrame = {
      samples,
      durationMs: (samples.length / LIVE_PCM_SAMPLE_RATE) * 1_000
    };
    if (vadStateRef.current === "speaking") {
      sendLivePcmFrame(frame);
    } else {
      appendPreRollFrame(frame);
    }

    const playbackActive = isPlaybackActive();
    const speechThreshold =
      vadConfig.speechThreshold *
      (playbackActive ? vadConfig.playbackThresholdMultiplier : 1);

    if (
      now < playbackVadSuppressedUntilRef.current &&
      vadStateRef.current !== "speaking"
    ) {
      vadStateRef.current = "idle";
      vadCandidateStartedAtRef.current = 0;
      clearPreRoll();
      return;
    }

    if (vadStateRef.current === "idle") {
      if (rms >= speechThreshold) {
        vadStateRef.current = "speech_candidate";
        vadCandidateStartedAtRef.current = now;
      }
      return;
    }

    if (vadStateRef.current === "speech_candidate") {
      if (rms < vadConfig.silenceThreshold) {
        vadStateRef.current = "idle";
        vadCandidateStartedAtRef.current = 0;
        return;
      }

      if (
        rms >= speechThreshold &&
        now - vadCandidateStartedAtRef.current >= vadConfig.startDebounceMs
      ) {
        vadStateRef.current = "speaking";
        vadSilenceStartedAtRef.current = 0;
        startLiveSpeechTurn(rms);
      }
      return;
    }

    if (now - liveTurnStartedAtRef.current >= vadConfig.maxTurnMs) {
      endLiveSpeechTurn("manual");
      return;
    }

    if (rms >= vadConfig.silenceThreshold) {
      vadSilenceStartedAtRef.current = 0;
      return;
    }

    if (vadSilenceStartedAtRef.current === 0) {
      vadSilenceStartedAtRef.current = now;
      return;
    }

    if (now - vadSilenceStartedAtRef.current >= vadConfig.hangoverMs) {
      endLiveSpeechTurn("silence");
    }
  }

  function startLiveSpeechTurn(rms: number): void {
    const socket = socketRef.current;
    if (!socket || livePcmTurnRef.current) {
      vadStateRef.current = "idle";
      return;
    }

    const interruptedRequestId =
      activeRequestIdRef.current ?? getActivePlaybackRequestId();
    if (interruptedRequestId) {
      cancelRequest(interruptedRequestId);
      sendRaw(socket, {
        type: WS_EVENTS.INTERRUPT,
        requestId: interruptedRequestId,
        reason: "live mode barge-in"
      });
    }

    const requestId = createRequestId();
    const detectedAt = vadCandidateStartedAtRef.current || Date.now();
    liveTurnStartedAtRef.current = detectedAt;
    const turn: LivePcmTurn = {
      requestId,
      sequence: 0,
      startedAt: detectedAt,
      cancelled: false
    };
    livePcmTurnRef.current = turn;
    beginRequest(requestLifecyclesRef.current, requestId, "recording");
    setCurrentRequest(requestId);
    setRecording(true);
    setRecordingStatus("Listening...");

    if (!sendRaw(socket, {
      type: WS_EVENTS.VAD_SPEECH_START,
      requestId,
      turnMode: "live",
      startedAt: detectedAt,
      rms
    })) {
      cancelLivePcmTurn(false);
      setError("Could not start the live speech turn because the gateway disconnected.");
      return;
    }

    const preRollFrames = preRollFramesRef.current;
    preRollFramesRef.current = [];
    for (const preRollFrame of preRollFrames) {
      if (livePcmTurnRef.current !== turn) {
        break;
      }
      sendLivePcmFrame(preRollFrame);
    }
  }

  function sendLivePcmFrame(frame: LivePcmFrame): void {
    const turn = livePcmTurnRef.current;
    const socket = socketRef.current;
    if (
      !turn ||
      turn.cancelled ||
      !socket ||
      !canAcceptRequestEvent(requestLifecyclesRef.current, turn.requestId, [
        "recording"
      ])
    ) {
      return;
    }

    const bytes = new Uint8Array(
      frame.samples.buffer,
      frame.samples.byteOffset,
      frame.samples.byteLength
    );
    const sent = sendRaw(socket, {
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: turn.requestId,
      chunk: uint8ArrayToBase64(bytes),
      mimeType: LIVE_PCM_MIME_TYPE,
      sequence: turn.sequence++,
      turnMode: "live",
      isFinal: false
    });

    if (!sent) {
      cancelLivePcmTurn(false);
      setError("Live audio stopped because the gateway disconnected.");
    }
  }

  function endLiveSpeechTurn(reason: "silence" | "manual"): void {
    if (vadStateRef.current !== "speaking") {
      return;
    }

    const turn = livePcmTurnRef.current;
    vadStateRef.current = "idle";
    vadCandidateStartedAtRef.current = 0;
    vadSilenceStartedAtRef.current = 0;
    livePcmTurnRef.current = null;
    clearPreRoll();
    setRecording(false);
    setRecordingStatus("Transcribing...");

    if (!turn || turn.cancelled) {
      return;
    }

    const socket = socketRef.current;
    const endedAt = Date.now();
    if (
      !socket ||
      !sendRaw(socket, {
        type: WS_EVENTS.AUDIO_CHUNK,
        requestId: turn.requestId,
        mimeType: LIVE_PCM_MIME_TYPE,
        sequence: turn.sequence,
        turnMode: "live",
        isFinal: true
      })
    ) {
      cancelRequest(turn.requestId);
      setError("Could not finalize live audio after the gateway disconnected.");
      return;
    }

    sendRaw(socket, {
      type: WS_EVENTS.VAD_SPEECH_END,
      requestId: turn.requestId,
      endedAt,
      durationMs: endedAt - turn.startedAt,
      reason
    });
    transitionRequest(
      requestLifecyclesRef.current,
      turn.requestId,
      "transcribing"
    );
  }

  function appendPreRollFrame(frame: LivePcmFrame): void {
    const frames = preRollFramesRef.current;
    frames.push(frame);
    let durationMs = frames.reduce((sum, item) => sum + item.durationMs, 0);
    while (frames.length > 0 && durationMs > vadConfig.preRollMs) {
      durationMs -= frames.shift()?.durationMs ?? 0;
    }
  }

  function clearPreRoll(): void {
    preRollFramesRef.current = [];
  }

  async function getAudioInputStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  }

  function cleanupLiveMode(notifyGateway = true, updateUi = true): void {
    liveModeGenerationRef.current += 1;
    liveModeRef.current = false;
    liveListeningRef.current = false;
    cancelLivePcmTurn(notifyGateway);
    cleanupVadPipeline();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    clearPreRoll();
    vadStateRef.current = "idle";
    vadCandidateStartedAtRef.current = 0;
    vadSilenceStartedAtRef.current = 0;
    liveTurnStartedAtRef.current = 0;
    if (updateUi) {
      setLiveMode(false);
      setRecording(false);
      setRecordingStatus(null);
    }
  }

  function cancelLivePcmTurn(notifyGateway: boolean): void {
    const turn = livePcmTurnRef.current;
    if (!turn) {
      return;
    }

    turn.cancelled = true;
    const socket = socketRef.current;
    if (notifyGateway && socket) {
      sendRaw(socket, {
        type: WS_EVENTS.VAD_SPEECH_END,
        requestId: turn.requestId,
        endedAt: Date.now(),
        durationMs: Date.now() - turn.startedAt,
        reason: "cancelled"
      });
      sendRaw(socket, {
        type: WS_EVENTS.INTERRUPT,
        requestId: turn.requestId,
        reason: "live mode stopped"
      });
    }
    cancelRequest(turn.requestId);
    setRecordingStatus(null);
  }

  function cleanupVadPipeline(): void {
    vadWorkletNodeRef.current?.port.close();
    vadWorkletNodeRef.current?.disconnect();
    vadWorkletNodeRef.current = null;
    if (vadScriptProcessorRef.current) {
      vadScriptProcessorRef.current.onaudioprocess = null;
      vadScriptProcessorRef.current.disconnect();
      vadScriptProcessorRef.current = null;
    }
    vadSourceRef.current?.disconnect();
    vadSourceRef.current = null;
    vadMuteGainRef.current?.disconnect();
    vadMuteGainRef.current = null;
    fallbackResamplerRef.current = null;
    fallbackFrameBufferRef.current?.clear();
    fallbackFrameBufferRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }

  function isPlaybackActive(): boolean {
    const audio = currentAudioRef.current;
    if (audio && !audio.paused && !audio.ended) {
      return true;
    }

    for (const queue of playbackQueuesRef.current.values()) {
      if (queue.playing) {
        return true;
      }
    }

    return false;
  }

  function getActivePlaybackRequestId(): string | null {
    for (const queue of playbackQueuesRef.current.values()) {
      if (queue.playing) {
        return queue.requestId;
      }
    }

    return null;
  }

  function getOrCreatePlaybackQueue(requestId: string): PlaybackQueue {
    const existing = playbackQueuesRef.current.get(requestId);
    if (existing) {
      return existing;
    }

    const queue: PlaybackQueue = {
      requestId,
      chunks: new Map(),
      nextSequence: 0,
      ended: false,
      playing: false
    };
    playbackQueuesRef.current.set(requestId, queue);
    return queue;
  }

  async function drainPlaybackQueue(requestId: string): Promise<void> {
    const queue = playbackQueuesRef.current.get(requestId);
    if (!queue || queue.playing || ignoredPlaybackRequestsRef.current.has(requestId)) {
      return;
    }

    const chunk = queue.chunks.get(queue.nextSequence);
    if (!chunk) {
      if (queue.ended && queue.chunks.size === 0) {
        playbackQueuesRef.current.delete(requestId);
        completeRequest(requestId);
      }
      return;
    }

    queue.chunks.delete(queue.nextSequence);
    queue.playing = true;
    const objectUrl = URL.createObjectURL(
      new Blob([chunk.bytes], { type: chunk.mimeType })
    );
    objectUrlsRef.current.add(objectUrl);
    const audio = new Audio(objectUrl);
    currentAudioRef.current = audio;
    currentAudioObjectUrlRef.current = objectUrl;

    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      cleanupAudioObjectUrl(objectUrl);
      playbackVadSuppressedUntilRef.current =
        Date.now() + vadConfig.playbackSuppressAfterEndMs;
      if (currentAudioRef.current === audio) {
        currentAudioRef.current = null;
        currentAudioObjectUrlRef.current = null;
      }
      const currentQueue = playbackQueuesRef.current.get(requestId);
      if (currentQueue) {
        currentQueue.nextSequence = chunk.sequence + 1;
        currentQueue.playing = false;
      }
      if (
        !ignoredPlaybackRequestsRef.current.has(requestId) &&
        canAcceptRequestEvent(requestLifecyclesRef.current, requestId)
      ) {
        sendPlaybackAck(requestId, chunk.sequence);
        void drainPlaybackQueue(requestId);
      }
    };

    audio.addEventListener("ended", finish, { once: true });
    audio.addEventListener("error", finish, { once: true });

    try {
      await audio.play();
    } catch {
      blockedPlaybackRef.current = {
        requestId,
        sequence: chunk.sequence,
        audio,
        objectUrl
      };
      setManualPlaybackRequestId(requestId);
    }
  }

  async function playBlockedAudio(): Promise<void> {
    const blocked = blockedPlaybackRef.current;
    if (!blocked) {
      return;
    }

    try {
      setManualPlaybackRequestId(null);
      await blocked.audio.play();
      blockedPlaybackRef.current = null;
    } catch {
      setManualPlaybackRequestId(blocked.requestId);
    }
  }

  function ignorePlaybackRequest(requestId: string): void {
    ignoredPlaybackRequestsRef.current.add(requestId);
    if (ignoredPlaybackRequestsRef.current.size > 400) {
      const oldest = ignoredPlaybackRequestsRef.current.values().next().value as
        | string
        | undefined;
      if (oldest) {
        ignoredPlaybackRequestsRef.current.delete(oldest);
      }
    }
    cleanupPlaybackQueue(requestId);
  }

  function cleanupPlaybackQueue(requestId: string): void {
    const blocked = blockedPlaybackRef.current;
    if (blocked?.requestId === requestId) {
      blocked.audio.pause();
      cleanupAudioObjectUrl(blocked.objectUrl);
      blockedPlaybackRef.current = null;
      setManualPlaybackRequestId(null);
    }

    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      currentAudioRef.current = null;
    }
    if (currentAudioObjectUrlRef.current) {
      cleanupAudioObjectUrl(currentAudioObjectUrlRef.current);
      currentAudioObjectUrlRef.current = null;
    }

    playbackQueuesRef.current.delete(requestId);
  }

  function cleanupAllPlayback(updateUi = true): void {
    currentAudioRef.current?.pause();
    currentAudioRef.current = null;
    currentAudioObjectUrlRef.current = null;
    playbackQueuesRef.current.clear();
    blockedPlaybackRef.current = null;
    objectUrlsRef.current.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
    objectUrlsRef.current.clear();
    if (updateUi) {
      setManualPlaybackRequestId(null);
    }
  }

  function cleanupAudioObjectUrl(objectUrl: string): void {
    URL.revokeObjectURL(objectUrl);
    objectUrlsRef.current.delete(objectUrl);
  }

  function sendPlaybackAck(requestId: string, sequence: number): void {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendRaw(socket, {
      type: WS_EVENTS.PLAYBACK_ACK,
      requestId,
      sequence
    });
  }

  function setCurrentRequest(requestId: string): void {
    activeRequestIdRef.current = requestId;
    setActiveRequestId(requestId);
  }

  function clearCurrentRequest(requestId?: string): void {
    if (requestId && activeRequestIdRef.current !== requestId) {
      return;
    }
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
  }

  function completeRequest(requestId: string): void {
    settleRequest(requestLifecyclesRef.current, requestId, "completed");
    playbackQueuesRef.current.delete(requestId);
    clearCurrentRequest(requestId);
  }

  function cancelRequest(requestId: string): void {
    settleRequest(requestLifecyclesRef.current, requestId, "cancelled");
    ignorePlaybackRequest(requestId);

    const pttContext = pttRecordingRef.current;
    if (pttContext?.requestId === requestId && !pttContext.cancelled) {
      pttContext.cancelled = true;
      if (pttContext.recorder.state !== "inactive") {
        pttContext.recorder.stop();
      }
      cleanupPushToTalkRecording(pttContext);
    }

    const liveTurn = livePcmTurnRef.current;
    if (liveTurn?.requestId === requestId) {
      liveTurn.cancelled = true;
      livePcmTurnRef.current = null;
      vadStateRef.current = "idle";
      vadCandidateStartedAtRef.current = 0;
      vadSilenceStartedAtRef.current = 0;
      clearPreRoll();
      setRecording(false);
    }

    clearCurrentRequest(requestId);
  }

  function cancelRequestsAfterDisconnect(): void {
    for (const requestId of cancelActiveRequests(requestLifecyclesRef.current)) {
      ignorePlaybackRequest(requestId);
    }
    cleanupAllPlayback();
    cancelPushToTalkRecording(false);
    cleanupLiveMode(false);
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
    setRecording(false);
    setRecordingStatus(null);
  }

  return (
    <main className="shell">
      <header className="header">
        <div>
          <h1>OpenGPT Live</h1>
          <p>Live voice, streaming transcripts, and barge-in over WebSocket</p>
        </div>
        <div className={connected ? "status connected" : "status"}>
          {connectionStatus === "connected"
            ? "Connected"
            : connectionStatus === "reconnecting"
              ? "Reconnecting"
              : connectionStatus === "connecting"
                ? "Connecting"
                : "Disconnected"}
        </div>
      </header>

      <section className="meta">
        <span>Gateway: {gatewayUrl}</span>
        <span>Session: {sessionId ?? "pending"}</span>
        {!connected ? (
          <button
            className="secondary"
            type="button"
            onClick={() => reconnectNowRef.current?.()}
          >
            Reconnect now
          </button>
        ) : null}
      </section>

      <section className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <p className="empty">
            Type a message, hold to talk, or turn on Live mode.
          </p>
        ) : (
          messages.map((message) => (
            <article
              className={`message ${message.role}${message.transient ? " transient" : ""}`}
              key={message.id}
            >
              <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
              {message.source === "audio" ? <span>transcribed speech</span> : null}
              <p>{message.content || "..."}</p>
            </article>
          ))
        )}
      </section>

      {recordingStatus ? <p className="notice">{recordingStatus}</p> : null}
      {manualPlaybackRequestId ? (
        <button className="playbackButton" type="button" onClick={playBlockedAudio}>
          播放语音回复
        </button>
      ) : null}
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
          className={liveMode ? "recording" : "secondary"}
          type="button"
          disabled={!connected || (!liveMode && recording)}
          onClick={() => {
            void toggleLiveMode();
          }}
        >
          {liveMode ? "Live on" : "Live experimental"}
        </button>
        <button
          className={recording ? "recording" : "secondary"}
          type="button"
          disabled={
            liveMode || !connected || (Boolean(activeRequestId) && !recording)
          }
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
            stopRecording();
          }}
        >
          {recording && !liveMode ? "Release" : "Hold to Talk"}
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

function sendRaw(socket: WebSocket, message: ClientMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function selectAudioMimeType(): string {
  const preferred = ["audio/webm;codecs=opus", "audio/webm"];
  return preferred.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return uint8ArrayToBase64(bytes);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function calculatePcm16Rms(samples: Int16Array): number {
  let sumSquares = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const normalized = samples[index] / 0x8000;
    sumSquares += normalized * normalized;
  }

  return samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
}

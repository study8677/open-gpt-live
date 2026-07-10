# WebSocket Protocol

OpenGPT Live uses a JSON WebSocket protocol between the browser client and the Voice Session Gateway.

This MVP implements text input, push-to-talk audio input, experimental live voice input, and TTS audio output:

```text
browser text input -> WebSocket -> gateway -> LLM stream -> WebSocket -> browser token display
browser audio chunks -> WebSocket -> gateway -> STT -> user text -> LLM stream
browser VAD -> WebSocket -> gateway -> partial/final STT -> LLM stream
LLM text -> gateway TTS -> WebSocket -> browser audio playback
```

The push-to-talk path records a whole turn, aggregates MediaRecorder chunks in the gateway, transcribes the complete audio file once, and then submits the transcript into the same user text flow.
Live Mode uses browser-side VAD to mark speech boundaries while reusing the same `audio.chunk` channel. The AudioWorklet continuously produces 24 kHz mono PCM16 frames and the browser keeps a short pre-roll before VAD confirmation. When Realtime STT is enabled, the Gateway forwards those frames incrementally and maps provider deltas to `transcript.partial`. If Realtime STT is disabled or fails, the Gateway can periodically transcribe the accumulated audio and always uses batch STT as the final fallback.
The TTS output path segments the assistant text and streams MP3 chunks back to the browser for queued playback.

## Latency measurements

The Web app keeps first-observation milestones per `requestId` with the browser's monotonic `performance.now()` clock. The panel shows a dash when a milestone does not apply or has not happened yet. Completed measurements remain visible when a request is interrupted or fails.

| Panel metric | Definition | 中文口径 |
|---|---|---|
| `STT first partial` | speech start -> first `transcript.partial` received | 开始说话到首个临时转写 |
| `Final transcript` | speech end -> `transcript.final` received | 停止说话到最终转写 |
| `LLM first token` | final transcript (or text request start) -> first `llm.delta` received | 最终转写到模型首字；文字请求则从发送开始 |
| `TTS first audio` | first `llm.delta` -> the browser audio element's first `playing` event | 模型首字到浏览器真正开始播放 |
| `Speech end -> audio` | speech end -> first browser `playing` event | 停止说话到听见首音的端到端等待 |

The Gateway separately measures provider-side stages using its own injected monotonic clock. Browser and Gateway timestamps are never subtracted from each other, because their time origins are unrelated. Text turns therefore show dashes for STT metrics; push-to-talk commonly has no partial transcript; requests without TTS show dashes for audio metrics.

## Connection

Default gateway URL:

```text
ws://localhost:8787
```

The web app reads the URL from:

```text
NEXT_PUBLIC_GATEWAY_WS_URL
```

## Message Envelope

Every message is a JSON object with a `type` field.

```json
{
  "type": "event.name"
}
```

Request-scoped messages should include a `requestId`. The browser generates this ID for `user.text`, and the gateway echoes it in `llm.delta` and `llm.done`.

## Implemented Events

### `session.start`

Direction: client -> gateway

Starts or identifies a connection-local session. The client may provide a `sessionId`, but the Gateway can also create one. The current in-memory implementation does not restore history from a previous connection merely because the same ID is supplied.

```json
{
  "type": "session.start",
  "sessionId": "optional-existing-session-id"
}
```

Direction: gateway -> client

Confirms the active session.

```json
{
  "type": "session.start",
  "sessionId": "generated-session-id",
  "status": "ready"
}
```

### `user.text`

Direction: client -> gateway

Sends a text message to the gateway.

```json
{
  "type": "user.text",
  "requestId": "request-uuid",
  "text": "Explain the architecture of OpenGPT Live."
}
```

Gateway behavior:

- Appends the user text to in-memory session history.
- Sends the full session history to the configured LLM provider.
- Streams response chunks back as `llm.delta`.
- Segments assistant text and streams speech back as `tts.chunk` when TTS is configured.
- Appends the complete assistant response to session history after normal completion.

### `audio.chunk`

Direction: client -> gateway

Sends one MediaRecorder chunk for the current push-to-talk turn. The browser should send chunks as base64 strings and mark the turn complete with a final message after `MediaRecorder.stop()` has emitted its last `dataavailable` event.

```json
{
  "type": "audio.chunk",
  "requestId": "request-uuid",
  "chunk": "base64-encoded-webm-opus-data",
  "mimeType": "audio/webm;codecs=opus",
  "sequence": 0,
  "turnMode": "ptt",
  "isFinal": false
}
```

Final message:

```json
{
  "type": "audio.chunk",
  "requestId": "request-uuid",
  "mimeType": "audio/webm;codecs=opus",
  "sequence": 5,
  "turnMode": "ptt",
  "isFinal": true
}
```

Gateway behavior:

- Aggregates chunks by `requestId`.
- Rejects turns larger than 25 MB before calling STT.
- Transcribes the full turn with the configured STT provider after `isFinal: true`.
- Sends `transcript.final`.
- Appends the transcript to in-memory session history as a user message.
- Streams the assistant response through `llm.delta`.
- Streams generated speech through `tts.start`, `tts.chunk`, and `tts.end` when TTS is configured.

In Live Mode, `audio.chunk` uses `turnMode: "live"`, `mimeType: "audio/pcm;rate=24000"`, and is scoped by `vad.speech_start` / `vad.speech_end`:

```json
{
  "type": "audio.chunk",
  "requestId": "request-uuid",
  "chunk": "base64-encoded-pcm16-frame",
  "mimeType": "audio/pcm;rate=24000",
  "sequence": 0,
  "turnMode": "live",
  "isFinal": false
}
```

The Gateway forwards these frames to Streaming STT when configured. Only `transcript.final` is submitted to the LLM. For batch fallback, PCM16 frames are wrapped in a valid mono WAV container before they are sent to the batch STT adapter.

### `vad.speech_start`

Direction: client -> gateway

Marks the start of a live-mode speech turn detected by client-side VAD.

```json
{
  "type": "vad.speech_start",
  "requestId": "request-uuid",
  "turnMode": "live",
  "startedAt": 1710000000000,
  "rms": 0.031
}
```

### `vad.speech_end`

Direction: client -> gateway

Marks the end of a live-mode speech turn. The client should send this after the final `audio.chunk` for the same `requestId`.

```json
{
  "type": "vad.speech_end",
  "requestId": "request-uuid",
  "endedAt": 1710000002400,
  "durationMs": 2400,
  "reason": "silence"
}
```

### `transcript.partial`

Direction: gateway -> client

Sends an interim transcript for an active live-mode turn. It is not appended to gateway conversation history.

```json
{
  "type": "transcript.partial",
  "requestId": "request-uuid",
  "text": "What is the weather",
  "sequence": 0,
  "isStable": false
}
```

### `transcript.final`

Direction: gateway -> client

Sends the final speech-to-text result for an audio turn.

```json
{
  "type": "transcript.final",
  "requestId": "request-uuid",
  "text": "What time is it now?"
}
```

The client should render this as the user message for the same `requestId`.

### `llm.delta`

Direction: gateway -> client

Streams one chunk of assistant text.

```json
{
  "type": "llm.delta",
  "requestId": "request-uuid",
  "delta": "OpenGPT"
}
```

The client should append `delta` to the assistant message with the same `requestId`.

### `llm.done`

Direction: gateway -> client

Marks the end of a streamed response.

```json
{
  "type": "llm.done",
  "requestId": "request-uuid",
  "reason": "stop"
}
```

Supported reasons:

- `stop`: normal completion.
- `interrupted`: user or gateway interrupted the active stream.
- `error`: provider or gateway error.

`llm.done` marks the end of the text stream. If TTS is configured, the request can remain active until the gateway sends `tts.end`.

### `tts.start`

Direction: gateway -> client

Starts the speech stream for a request.

```json
{
  "type": "tts.start",
  "requestId": "request-uuid",
  "voice": "alloy",
  "format": "mp3",
  "mimeType": "audio/mpeg"
}
```

### `tts.chunk`

Direction: gateway -> client

Sends one base64-encoded generated speech chunk. Chunks are ordered by `sequence`; the browser should buffer out-of-order chunks and play them sequentially.

```json
{
  "type": "tts.chunk",
  "requestId": "request-uuid",
  "sequence": 0,
  "chunk": "base64-encoded-mp3-audio",
  "mimeType": "audio/mpeg",
  "segmentIndex": 0,
  "isFinal": false
}
```

### `tts.end`

Direction: gateway -> client

Marks the end of speech output for a request.

```json
{
  "type": "tts.end",
  "requestId": "request-uuid",
  "reason": "stop"
}
```

Supported reasons:

- `stop`: normal completion.
- `interrupted`: user or gateway interrupted the active stream.
- `error`: provider or gateway error.

### `playback.ack`

Direction: client -> gateway

Acknowledges that the browser finished playing a TTS chunk. The current gateway accepts this message for protocol completeness; it does not yet use it for flow control.

```json
{
  "type": "playback.ack",
  "requestId": "request-uuid",
  "sequence": 0
}
```

### `interrupt`

Direction: client -> gateway

Requests cancellation of the active stream.

```json
{
  "type": "interrupt",
  "requestId": "request-uuid",
  "reason": "user clicked stop"
}
```

Gateway behavior:

- Calls `AbortController.abort()` on the active LLM/TTS request.
- Stops forwarding late LLM or TTS chunks for that request.
- Sends `llm.done` with `reason: "interrupted"`.
- Sends `tts.end` with `reason: "interrupted"` if TTS had started.
- Does not append the partial assistant response to session history.

## Error Message

Direction: gateway -> client

```json
{
  "type": "error",
  "requestId": "optional-request-id",
  "message": "Human-readable error"
}
```

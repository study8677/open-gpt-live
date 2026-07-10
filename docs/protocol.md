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
The experimental live mode uses browser-side VAD to mark speech boundaries while reusing the same `audio.chunk` channel. During a live turn, the gateway periodically retranscribes the accumulated WebM/Opus prefix and sends `transcript.partial`; after VAD marks the turn complete, it sends `transcript.final`.
The TTS output path segments the assistant text and streams MP3 chunks back to the browser for queued playback.

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

Starts or resumes a session. The client may provide a `sessionId`, but the gateway can also create one.

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

In live mode, `audio.chunk` uses `turnMode: "live"` and is scoped by `vad.speech_start` / `vad.speech_end`. The gateway may run partial STT while chunks are arriving, but only `transcript.final` is submitted to the LLM.

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

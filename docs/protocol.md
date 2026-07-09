# WebSocket Protocol

OpenGPT Live uses a JSON WebSocket protocol between the browser client and the Voice Session Gateway.

This MVP implements text input, push-to-talk audio input, and TTS audio output:

```text
browser text input -> WebSocket -> gateway -> LLM stream -> WebSocket -> browser token display
browser audio chunks -> WebSocket -> gateway -> STT -> user text -> LLM stream
LLM text -> gateway TTS -> WebSocket -> browser audio playback
```

The current audio input path records a whole push-to-talk turn, aggregates MediaRecorder chunks in the gateway, transcribes the complete audio file once, and then submits the transcript into the same user text flow. It does not implement VAD or realtime transcription.
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

## Reserved Events

These events are part of the protocol namespace but are not implemented in this MVP.

### `transcript.partial`

Reserved for partial speech-to-text results.

```json
{
  "type": "transcript.partial",
  "requestId": "request-uuid",
  "text": "partial transcript"
}
```

## Error Message

Direction: gateway -> client

```json
{
  "type": "error",
  "requestId": "optional-request-id",
  "message": "Human-readable error"
}
```

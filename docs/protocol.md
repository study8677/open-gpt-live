# WebSocket Protocol

OpenGPT Live uses a JSON WebSocket protocol between the browser client and the Voice Session Gateway.

This MVP implements text input plus push-to-talk audio input:

```text
browser text input -> WebSocket -> gateway -> LLM stream -> WebSocket -> browser token display
browser audio chunks -> WebSocket -> gateway -> STT -> user text -> LLM stream
```

The current audio path records a whole push-to-talk turn, aggregates MediaRecorder chunks in the gateway, transcribes the complete audio file once, and then submits the transcript into the same user text flow. It does not implement VAD, realtime transcription, TTS, or audio playback.

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

- Calls `AbortController.abort()` on the active LLM request.
- Stops forwarding late chunks for that request.
- Sends `llm.done` with `reason: "interrupted"`.
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

### `tts.chunk`

Reserved for generated speech chunks.

```json
{
  "type": "tts.chunk",
  "requestId": "request-uuid",
  "chunk": "base64-encoded-audio",
  "encoding": "pcm16"
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

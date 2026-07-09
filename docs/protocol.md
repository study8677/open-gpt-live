# WebSocket Protocol

OpenGPT Live uses a JSON WebSocket protocol between the browser client and the Voice Session Gateway.

This MVP implements a text-only loop:

```text
browser text input -> WebSocket -> gateway -> LLM stream -> WebSocket -> browser token display
```

No audio, microphone, transcription, or text-to-speech runtime is implemented in this milestone. Audio-related events are reserved so future versions can extend the protocol without changing the text loop.

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

These events are part of the protocol namespace but are not implemented in the text-loop MVP.

### `audio.chunk`

Reserved for browser or gateway audio chunks.

```json
{
  "type": "audio.chunk",
  "sessionId": "session-id",
  "chunk": "base64-encoded-audio",
  "encoding": "pcm16"
}
```

### `transcript.partial`

Reserved for partial speech-to-text results.

```json
{
  "type": "transcript.partial",
  "text": "partial transcript"
}
```

### `transcript.final`

Reserved for final speech-to-text results.

```json
{
  "type": "transcript.final",
  "text": "final transcript"
}
```

### `tts.chunk`

Reserved for generated speech chunks.

```json
{
  "type": "tts.chunk",
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

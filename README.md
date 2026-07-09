# OpenGPT Live

OpenGPT Live is an open-source realtime interface framework for GPT-style AI assistants backed by large language models.

This repository currently contains the first MVP: a text and push-to-talk WebSocket loop that proves the browser can talk to a gateway, the gateway can transcribe recorded audio with an OpenAI-compatible Whisper API, stream from an OpenAI-compatible LLM, and the browser can render the transcript and response incrementally.

Text-to-speech, voice playback, VAD, automatic sentence detection, and realtime streaming transcription are intentionally not implemented in this milestone.

## Architecture

```text
apps/web
  Next.js App Router client
  text input or push-to-talk audio -> WebSocket -> transcript/streaming display

apps/gateway
  Node.js ws server
  audio aggregation -> STT -> session history -> OpenAI-compatible LLM -> streamed deltas

packages/protocol
  shared WebSocket message types

packages/adapters
  provider interfaces and OpenAI-compatible LLM adapter
```

## Requirements

- Node.js 20+
- pnpm 11+
- OpenAI-compatible API key

## Local Setup

Install dependencies:

```bash
pnpm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
STT_API_KEY=
STT_BASE_URL=
STT_MODEL=whisper-1
GATEWAY_PORT=8787
NEXT_PUBLIC_GATEWAY_WS_URL=ws://localhost:8787
```

`STT_API_KEY` and `STT_BASE_URL` are optional. If they are empty, the gateway reuses `OPENAI_API_KEY` and `OPENAI_BASE_URL`. `STT_MODEL` defaults to `whisper-1`.

Start the web app and gateway together:

```bash
pnpm dev
```

Open:

```text
http://localhost:3000
```

## Smoke Test

1. Open `http://localhost:3000`.
2. Confirm the page shows `Connected`.
3. Type a message and click `Send`.
4. Confirm the assistant response appears incrementally.
5. Send a second text message and confirm the answer can refer to the previous turn.
6. Hold `Hold to Talk`, say a short phrase, then release.
7. Confirm the transcript appears as a user message, then the assistant streams a reply.
8. Deny microphone permission in the browser and confirm text input still works.
9. While a response is streaming, click `Stop`.
10. Confirm streaming stops immediately.

## Protocol

The WebSocket protocol is documented in [docs/protocol.md](docs/protocol.md).

Implemented events:

- `session.start`
- `user.text`
- `audio.chunk`
- `llm.delta`
- `llm.done`
- `interrupt`
- `transcript.final`

Reserved future events:

- `transcript.partial`
- `tts.chunk`

## Development Commands

Run both apps:

```bash
pnpm dev
```

Typecheck all workspaces:

```bash
pnpm typecheck
```

## Project Direction

The long-term goal is a voice-first AI assistant framework:

```text
realtime voice layer
  -> gateway session orchestration
  -> OpenAI-compatible or local LLM providers
  -> tools, memory, search, and agent workflows
```

The current milestone keeps the surface deliberately small so the protocol, whole-turn transcription, streaming, context handling, and interruption semantics are correct before TTS and realtime audio features are added.

## License

License to be decided.

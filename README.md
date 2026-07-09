# OpenGPT Live

OpenGPT Live is an open-source realtime interface framework for GPT-style AI assistants backed by large language models.

This repository currently contains the first MVP: a text-only WebSocket loop that proves the browser can talk to a gateway, the gateway can stream from an OpenAI-compatible LLM, and the browser can render the response incrementally.

Audio, microphone capture, transcription, and text-to-speech are intentionally not implemented in this milestone.

## Architecture

```text
apps/web
  Next.js App Router client
  text input -> WebSocket -> streaming display

apps/gateway
  Node.js ws server
  session history -> OpenAI-compatible LLM -> streamed deltas

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
GATEWAY_PORT=8787
NEXT_PUBLIC_GATEWAY_WS_URL=ws://localhost:8787
```

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
5. Send a second message and confirm the answer can refer to the previous turn.
6. While a response is streaming, click `Stop`.
7. Confirm streaming stops immediately.

## Protocol

The WebSocket protocol is documented in [docs/protocol.md](docs/protocol.md).

Implemented events:

- `session.start`
- `user.text`
- `llm.delta`
- `llm.done`
- `interrupt`

Reserved future events:

- `audio.chunk`
- `transcript.partial`
- `transcript.final`
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

The current milestone keeps the surface deliberately small so the protocol, streaming, context handling, and interruption semantics are correct before audio is added.

## License

License to be decided.

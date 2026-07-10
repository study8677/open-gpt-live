# Contributing to OpenGPT Live

Thank you for helping make open voice AI easier to inspect, run, and improve.
Bug fixes, voice-quality measurements, provider adapters, tests, and focused
documentation improvements are all welcome.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before a large protocol, architecture, or provider change so the
  compatibility and testing approach can be agreed first.
- Keep pull requests focused. Unrelated cleanup makes realtime regressions harder
  to review.
- Report vulnerabilities privately by following [SECURITY.md](SECURITY.md).

## Local setup

Requirements:

- Node.js 22.13 or newer
- pnpm 11

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The Web app runs at `http://localhost:3000` and the Gateway health endpoint is
`http://localhost:8787/healthz`. Automated tests use fakes and do not require a
paid provider key.

Run the complete quality gate before opening a pull request:

```bash
pnpm check
```

You can also run its parts independently:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | Browser audio capture, VAD, request lifecycle, playback, and reconnect behavior |
| `apps/gateway` | WebSocket sessions, validation, turn orchestration, cancellation, and provider wiring |
| `packages/protocol` | Shared client/server message types and runtime validation |
| `packages/adapters` | Replaceable LLM, batch STT, streaming STT, and TTS provider interfaces |
| `docs` | Protocol, configuration, browser support, and deployment references |

## Making a change

1. Create a short branch from the current default branch.
2. Add or update tests with the implementation.
3. Update user-facing documentation when behavior or configuration changes.
4. Run `pnpm check` and record any additional manual verification in the pull
   request.
5. Open a pull request that explains the user problem, the chosen boundary, and
   any known tradeoffs.

### Change expectations

| Area | Expected evidence |
| --- | --- |
| Protocol | Shared types, runtime validation, event-order documentation, and a Gateway regression test |
| Gateway | Request-scoped behavior, abort/close cleanup, late-event handling, and integration tests |
| Web voice flow | Lifecycle cleanup, reconnect/interrupt behavior, and the verified browser or device |
| VAD or latency | Before/after measurements, test audio or reproducible conditions, and safe defaults |
| Provider adapter | Interface compliance, cancellation support, normalized errors, fake-transport tests, and configuration docs |

Do not weaken validation or silently change an existing event's meaning. Prefer a
small explicit protocol extension when the browser and Gateway need new data.

## Adding a provider integration

Provider-specific behavior belongs behind the interfaces in
`packages/adapters`:

- `LLMProvider` for streamed text generation
- `STTProvider` for complete-turn transcription
- `StreamingSTTProvider` for bidirectional realtime transcription
- `TTSProvider` for speech synthesis

A provider contribution should:

1. Keep vendor branching out of the core session lifecycle.
2. Honor `AbortSignal` and close network or stream resources on cancellation.
3. Document accepted audio formats, sample rates, and streaming semantics.
4. Read credentials from environment variables and never log secrets.
5. Include deterministic tests that run without network access or paid keys.
6. Map provider output to the existing protocol semantics instead of exposing
   vendor events directly to the browser.
7. Document setup, licensing, data-flow, and any cloud-only or local-only limits.

Use the **Provider integration** issue form before starting a substantial adapter.

## Pull request checklist

- The change has a focused purpose and no unrelated generated files.
- New behavior has automated coverage or a documented reason why it cannot.
- `pnpm check` passes locally.
- Configuration and protocol docs match the implementation.
- Logs and fixtures contain no API keys, tokens, recordings, or personal data.
- Browser-facing changes include a screenshot or a short manual test note when
  useful.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

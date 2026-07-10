# Changelog

Notable user-facing and contributor-facing changes to OpenGPT Live are recorded
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses semantic versioning while it remains pre-1.0.

## Unreleased

### Added

- Contribution, security, conduct, issue, and pull request guidance for the
  community.
- Request-scoped browser and Gateway latency telemetry for STT, LLM, TTS, and
  actual first-audio playback, including request mode and STT path context.

## 0.2.0 - 2026-07-10

### Added

- Typed WebSocket protocol with runtime validation for text, push-to-talk, Live
  Mode, streaming model output, speech playback, and interruption.
- Experimental OpenAI Realtime transcription with incremental transcript events
  and complete-turn STT fallback.
- Browser PCM capture, VAD, 400 ms pre-roll, reconnect cleanup, and request
  lifecycle handling.
- Replaceable LLM, batch STT, streaming STT, and TTS provider interfaces.
- Gateway health endpoint, structured logs, origin controls, graceful shutdown,
  Docker images, and deployment documentation.
- Automated protocol, Gateway, adapter, and browser-state tests plus CI production
  builds.

### Changed

- TTS output is sentence-segmented and emitted as complete playable chunks.
- Production images run application processes as a non-root user.

### Security

- Malformed WebSocket frames are isolated to their connection instead of
  terminating the Gateway process.

# Configuration

OpenGPT Live keeps every model credential in the Gateway process. Variables whose names start with `NEXT_PUBLIC_` are compiled into the browser bundle and must never contain secrets.

Start from the checked-in example:

```bash
cp .env.example .env
```

## Common profiles

### Text only

```dotenv
OPENAI_API_KEY=sk-...
TTS_ENABLED=false
STT_REALTIME_ENABLED=false
```

The browser still shows microphone controls, but text chat is the only path that does not require STT.

### Push-to-talk with spoken replies

```dotenv
OPENAI_API_KEY=sk-...
STT_MODEL=whisper-1
TTS_ENABLED=true
TTS_MODEL=tts-1
TTS_VOICE=alloy
```

Push-to-talk sends one completed recording to the batch STT adapter.

### Live streaming transcription

```dotenv
OPENAI_API_KEY=sk-...
STT_REALTIME_ENABLED=true
STT_REALTIME_MODEL=gpt-realtime-whisper
STT_REALTIME_DELAY=low
TTS_ENABLED=true
```

Live Mode sends 24 kHz mono PCM16 frames through the Gateway. The default Realtime adapter follows OpenAI's official [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription). If the Realtime connection fails, the Gateway wraps the accumulated PCM in a WAV container and falls back to the batch STT adapter for the final transcript.

## Gateway

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_HOST` | `0.0.0.0` | Interface used by the HTTP/WebSocket server. |
| `GATEWAY_PORT` | `8787` | Shared port for WebSocket sessions and `/healthz`. |
| `ALLOWED_ORIGINS` | empty | Comma-separated exact HTTP(S) browser origins allowed to open WebSockets. Empty allows all origins for local development. |
| `LOG_LEVEL` | `info` | Minimum structured log level: `debug`, `info`, `warn`, or `error`. |
| `OPENAI_API_KEY` | none | Required LLM credential. Required at startup when `NODE_ENV=production`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible HTTP base URL used by the LLM and fallback providers. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat Completions model. |

## Batch STT

| Variable | Default | Purpose |
| --- | --- | --- |
| `STT_API_KEY` | `OPENAI_API_KEY` | Optional STT-specific credential. |
| `STT_BASE_URL` | `OPENAI_BASE_URL` | Batch transcription API base URL. |
| `STT_MODEL` | `whisper-1` | Batch transcription model used for push-to-talk and fallback. |

## Realtime STT

| Variable | Default | Purpose |
| --- | --- | --- |
| `STT_REALTIME_ENABLED` | `false` | Enables the OpenAI Realtime transcription adapter for Live Mode. |
| `STT_REALTIME_URL` | `wss://api.openai.com/v1/realtime` | Realtime WebSocket endpoint. |
| `STT_REALTIME_MODEL` | `gpt-realtime-whisper` | Natively streaming transcription model. |
| `STT_REALTIME_LANGUAGE` | empty | Optional language hint, such as `en` or `zh`. |
| `STT_REALTIME_DELAY` | empty | Latency/accuracy tradeoff: `minimal`, `low`, `medium`, `high`, or `xhigh`. |

Realtime STT expects PCM16, mono, 24 kHz input. It is an explicit opt-in because an arbitrary OpenAI-compatible HTTP provider may not implement the Realtime WebSocket protocol.

## TTS

| Variable | Default | Purpose |
| --- | --- | --- |
| `TTS_ENABLED` | enabled when a key exists | Explicitly enable or disable spoken replies. Set `false` for text-only replies while keeping the LLM active. |
| `TTS_API_KEY` | `OPENAI_API_KEY` | Optional TTS-specific credential. |
| `TTS_BASE_URL` | `OPENAI_BASE_URL` | Speech API base URL. |
| `TTS_MODEL` | `tts-1` | Speech model. |
| `TTS_VOICE` | `alloy` | Voice sent to the provider. |
| `TTS_FORMAT` | `mp3` | Requested audio format. `mp3` is the recommended browser path. |

## Browser and VAD

`NEXT_PUBLIC_GATEWAY_WS_URL` defaults to `ws://localhost:8787`. Production pages served over HTTPS must use a `wss://` URL.

Live Mode calibrates the room for one second, then derives separate speech and silence thresholds from an idle-only moving noise floor. The noise floor is frozen while a turn is active, so the user's voice cannot teach the detector that speech is background noise. Set `NEXT_PUBLIC_VAD_ADAPTIVE_ENABLED=false` to use the original fixed thresholds.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_VAD_ADAPTIVE_ENABLED` | `true` | Enables initial noise calibration and idle noise-floor tracking. |
| `NEXT_PUBLIC_VAD_CALIBRATION_MS` | `1000` | Quiet-room sampling window when Live Mode starts. |
| `NEXT_PUBLIC_VAD_NOISE_FLOOR_SMOOTHING` | `0.08` | Idle noise-floor EWMA weight; higher values adapt faster. |
| `NEXT_PUBLIC_VAD_SPEECH_NOISE_MULTIPLIER` | `3` | Noise-floor multiplier used for the dynamic speech-start threshold. |
| `NEXT_PUBLIC_VAD_SILENCE_NOISE_MULTIPLIER` | `1.8` | Noise-floor multiplier used for the lower silence threshold. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SPEECH_MIN` | `0.012` | Lower clamp for the adaptive speech threshold. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SPEECH_MAX` | `0.12` | Upper clamp for the adaptive speech threshold. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SILENCE_MIN` | `0.006` | Lower clamp for the adaptive silence threshold. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SILENCE_MAX` | `0.08` | Upper clamp for the adaptive silence threshold; also kept below speech start. |
| `NEXT_PUBLIC_VAD_SPEECH_THRESHOLD` | `0.02` | Fixed speech threshold used only when adaptive mode is disabled. |
| `NEXT_PUBLIC_VAD_SILENCE_THRESHOLD` | `0.012` | Fixed silence threshold used only when adaptive mode is disabled. |
| `NEXT_PUBLIC_VAD_START_DEBOUNCE_MS` | `160` | Required speech duration before a live turn starts. |
| `NEXT_PUBLIC_VAD_MIN_SPEECH_MS` | `200` | Minimum accumulated voiced duration; short phrases remain usable while briefer sounds are cancelled rather than transcribed. |
| `NEXT_PUBLIC_VAD_HANGOVER_MS` | `750` | Pause grace before a live turn ends. A paused turn resumes only after crossing the speech threshold, intentionally rejecting low-level noise. |
| `NEXT_PUBLIC_VAD_MAX_TURN_MS` | `30000` | Maximum duration of one live turn. |
| `NEXT_PUBLIC_VAD_PRE_ROLL_MS` | `400` | Audio retained before VAD confirmation so the first syllable is preserved. |
| `NEXT_PUBLIC_VAD_PLAYBACK_THRESHOLD_MULTIPLIER` | `2.5` | Raises the speech threshold while TTS is playing. |
| `NEXT_PUBLIC_VAD_PLAYBACK_SUPPRESS_AFTER_END_MS` | `300` | Prevents immediate self-triggering after playback. |

These values are build-time browser configuration. Rebuild the Web app after changing them.

The current `SpeechDetector` implementation deliberately remains lightweight RMS logic. It is behind a small interface so a WebRTC VAD or model-backed detector can be substituted later without changing audio capture or turn transport.

## Startup validation

When `NODE_ENV=production`, the Gateway fails fast if `OPENAI_API_KEY` is absent. It also rejects invalid ports, booleans, log levels, HTTP(S) origin syntax, and Realtime delay values before accepting traffic.

`ALLOWED_ORIGINS` is a browser-origin allowlist, not an authentication mechanism. WebSocket clients that do not send an `Origin` header are allowed so CLI and native clients still work.

Do not place credentials in `NEXT_PUBLIC_*`, commit `.env`, or expose a provider key directly to the browser.

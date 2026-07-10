# Local AI profile

The experimental `local-ai` profile runs the complete HTTP provider path without an OpenAI key:

```text
browser -> Gateway -> Speaches/faster-whisper -> Ollama -> Speaches/Kokoro -> browser
```

The profile is configuration- and contract-tested. It has not yet been accepted on real local models and microphones in this repository, so complete the checklist below before treating it as a verified deployment.

## Pinned baseline

| Layer | Runtime and model | Approximate model download | Why this default |
| --- | --- | ---: | --- |
| LLM | Ollama `0.30.8`, `qwen2.5:1.5b` | 986 MB | Multilingual small model with an OpenAI-compatible streaming Chat Completions endpoint. |
| Batch STT | Speaches `0.8.3-cpu`, `Systran/faster-whisper-small` | 486 MB | Multilingual faster-whisper model exposed through `/v1/audio/transcriptions`. |
| TTS | Speaches `0.8.3-cpu`, `speaches-ai/Kokoro-82M-v1.0-ONNX` | 354 MB | Multilingual speech through `/v1/audio/speech`, with browser-playable MP3 output. |

The downloads above total about 1.8 GB. Container images, model caches, generated layers, and runtime working space require additional disk. Runtime memory and latency depend heavily on CPU architecture; leave several additional gigabytes free and prefer a machine with at least 8 GB of RAM. The checked-in profile intentionally uses portable CPU images and does not claim GPU performance.

The selected model licenses are separate from this repository's MIT license. Review each model page before redistribution or commercial use.

## Start with one profile

Requirements: a current Docker Desktop or Docker Engine with Compose v2.

```bash
cp .env.local-ai.example .env
docker compose --profile local-ai up --build
```

The first start pulls the pinned provider images and runs two one-shot model installers. When the `local-ai` profile is active, the Gateway waits for those jobs on the normal success path; the dependencies are optional only so the default cloud profile can still start without local services. Keep this terminal open and treat any init-job warning as a failed setup. Later starts reuse the named `ollama-data` and `speaches-cache` volumes.

The provider services do not require API keys. OpenGPT Live omits the `Authorization` header for explicit non-OpenAI HTTP base URLs, while `api.openai.com` still requires a real key.

### Data boundary

During a conversation, browser audio goes to the local Gateway and then to the local Speaches container; transcripts and prompts go to the local Ollama container. The profile does not configure a cloud inference endpoint. The first installation still contacts Docker Hub, GitHub Container Registry, the Ollama model registry, and Hugging Face to download images and model files. Review Docker and host networking separately before using sensitive data, especially on a shared machine.

## Verify providers before opening the microphone

In another terminal:

```bash
docker compose --profile local-ai ps
pnpm local-ai:check
```

The smoke script requires the repository's Node.js 22.13+ and pnpm baseline. It checks provider health and installed models, receives a streamed Chat Completions response, synthesizes a short Mandarin MP3, and submits that generated audio to the transcription endpoint. It is a provider-contract check, not a browser, microphone, voice-quality, or latency acceptance test.

Individual health endpoints are also available:

```bash
curl http://localhost:11434/api/tags
curl http://localhost:8000/health
curl http://localhost:8000/v1/models
curl http://localhost:8787/healthz
```

If an init job failed or a model was removed, rerun it explicitly:

```bash
docker compose --profile local-ai run --rm ollama-model
docker compose --profile local-ai run --rm speaches-models
```

## Browser acceptance checklist

Open [http://localhost:3000](http://localhost:3000), then test in this order:

1. Send a text turn and confirm streamed local model output.
2. Hold the push-to-talk control, speak one short English sentence, and confirm transcription plus MP3 playback.
3. Repeat with a short Mandarin sentence.
4. Enable Live Mode, wait for VAD calibration, and complete one turn.
5. Speak while TTS is playing and confirm the active response is interrupted.
6. Restart `ollama` or `speaches`, confirm one request fails visibly, then confirm recovery after the service is healthy.

`STT_REALTIME_ENABLED=false` is intentional. The current local profile uses batch transcription for push-to-talk and Live Mode's final WAV fallback; it does not claim OpenAI Realtime WebSocket compatibility or local partial transcripts.

## Common adjustments

- For an English TTS voice, set `TTS_VOICE=af_heart`; the default `zf_xiaobei` is Mandarin.
- To trade answer quality for a smaller download, change both `OPENAI_MODEL` and `OLLAMA_MODEL`. They must name the same installed Ollama model.
- The first answer after Ollama loads a model can be much slower than warm turns. `OLLAMA_KEEP_ALIVE=15m` is the profile default; tune it against available memory instead of treating a cold-start result as steady-state latency.
- If native Ollama or another service already uses a host port, change `LOCAL_AI_OLLAMA_PORT` or `LOCAL_AI_SPEACHES_PORT` and update the matching `LOCAL_AI_*_URL` used by the smoke script. Container-to-container Provider URLs do not change.
- When running the Gateway directly on the host instead of in Compose, change provider hosts from `ollama` and `speaches` to `localhost`.
- The profile binds unauthenticated provider ports to `127.0.0.1`. Do not expose them publicly without network controls and authentication.

Stop the stack while retaining models:

```bash
docker compose --profile local-ai down
```

Delete the downloaded model volumes only when you intend to download them again:

```bash
docker compose --profile local-ai down --volumes
```

## Official references

- [Ollama Docker](https://docs.ollama.com/docker)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama Qwen2.5 model library](https://ollama.com/library/qwen2.5)
- [Speaches repository](https://github.com/speaches-ai/speaches)
- [Speaches installation](https://speaches.ai/installation/)
- [Speaches speech-to-text](https://speaches.ai/usage/speech-to-text/)
- [Speaches text-to-speech](https://speaches.ai/usage/text-to-speech/)
- [SYSTRAN faster-whisper small model](https://huggingface.co/Systran/faster-whisper-small)
- [Speaches Kokoro ONNX model](https://huggingface.co/speaches-ai/Kokoro-82M-v1.0-ONNX)

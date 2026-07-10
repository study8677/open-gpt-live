# Voice quality benchmark report template

Use this template so STT / LLM / TTS latency numbers are comparable across runs.
Fill every field; mark unknowns as `n/a` rather than omitting them.

## Run metadata

| Field | Value |
| --- | --- |
| Commit SHA | ` ` |
| Date (UTC) | ` ` |
| Operator | ` ` |
| Operating system | ` ` |
| Browser + version | ` ` |
| CPU | ` ` |
| GPU | ` ` / n/a |
| Microphone | ` ` |

## Models / providers

| Stage | Provider | Model / voice | Notes |
| --- | --- | --- | --- |
| STT |  |  |  |
| LLM |  |  |  |
| TTS |  |  |  |

## Conditions

- Network / local runtime:
- Warm-up policy (e.g. discard first N turns):
- Sample count (N):
- Prompt / utterance set reference:

## Latency results (ms)

Report **median** and **p95** for each stage.

| Metric | Median | p95 | Notes |
| --- | ---: | ---: | --- |
| STT first partial |  |  |  |
| STT final transcript |  |  |  |
| LLM first token |  |  |  |
| TTS first audio |  |  |  |

## Qualitative notes

- Interrupt / barge-in behavior:
- Reconnect behavior:
- Audio artifacts (ticking, clipping, language mix):
- Failures / retries:

## Raw data (optional)

Attach CSV/JSON with per-sample timings or link to the artifact path.

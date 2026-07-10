# Browser Support

## Verified baseline

The current local browser smoke test targets Chromium. The production build, WebSocket connection, text input, reconnect UI, and responsive layout were manually exercised there; the repository does not yet include a committed end-to-end browser test suite.

The audio paths depend on browser APIs:

| Capability | Primary path | Fallback |
| --- | --- | --- |
| Live PCM capture | `AudioWorklet` | `ScriptProcessorNode` |
| Push-to-talk | `MediaRecorder` with WebM/Opus | Browser-selected MediaRecorder MIME type |
| Playback | `HTMLAudioElement` and Object URLs | Manual play button when autoplay is blocked |
| Microphone | `navigator.mediaDevices.getUserMedia` | Text input remains available |

## Browser expectations

- Chrome: recommended and used for the current local verification.
- Edge: expected to follow the Chromium path, but should be included in release smoke testing.
- Safari: requires manual verification of MediaRecorder MIME support, AudioWorklet behavior, autoplay, and microphone permissions before claiming support.
- Firefox: requires manual verification of PCM worklet timing and WebM/Opus transcription compatibility before claiming support.

The UI automatically falls back to text input when microphone capture is unavailable. Unsupported or unverified browsers are not advertised as fully supported.

## Known audio limitations

- Adaptive RMS VAD calibrates and follows gradual room-noise changes, but it cannot classify human voice as accurately as a model-backed detector.
- A 400 ms PCM pre-roll reduces clipped first syllables but does not replace acoustic echo cancellation.
- TTS playback raises the VAD threshold and briefly suppresses new starts after playback; loud speakers can still cause false barge-in.
- Browser autoplay rules may require one explicit click before spoken replies can play.

Wait for the one-second calibration state to finish before speaking. Use headphones when evaluating turn detection separately from echo behavior.

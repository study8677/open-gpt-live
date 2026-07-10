# Live Mode Smoke Test

Use this checklist after `pnpm dev` with the gateway and web app connected.

## Push-To-Talk Regression

1. Keep `Live experimental` off.
2. Hold `Hold to Talk`, say one short sentence, then release.
3. Confirm the user transcript appears once as a normal message.
4. Confirm the assistant streams text and, when TTS is configured, plays audio.

## Live Mode Turn Detection

1. Click `Live experimental`.
2. Speak without holding `Hold to Talk`.
3. Confirm the page shows a gray italic partial transcript while you are speaking.
4. Stop speaking and wait for the hangover window.
5. Confirm the partial transcript is replaced by a normal final user message.
6. Confirm the assistant responds through the existing LLM/TTS path.

## Partial Transcript Cost Guard

1. Stay in live mode and speak continuously for more than 30 seconds.
2. Confirm partial transcript updates continue but do not arrive faster than the configured cadence.
3. Confirm the final transcript still arrives after you stop speaking.

## Barge-In

1. Ask for a response long enough to trigger TTS playback.
2. While TTS is playing, start speaking in live mode.
3. Confirm playback stops immediately.
4. Confirm a new live turn starts and sends audio for the new request.
5. Confirm late TTS chunks from the interrupted request are ignored.

## Echo Mitigation

1. Use speakers instead of headphones.
2. Trigger a TTS response at a moderate volume.
3. Confirm live mode does not immediately start a new turn from the assistant voice.
4. Increase volume and repeat; note any false barge-in as a known limitation of RMS-only VAD.

## Permission And Fallbacks

1. Deny microphone permission and confirm text input still works.
2. Test in a browser without AudioWorklet support if available.
3. Confirm ScriptProcessor fallback still detects speech starts and ends.

# Live Mode Smoke Test

Use this checklist after `pnpm dev` with the gateway and web app connected.

Before starting, confirm `curl http://127.0.0.1:8787/healthz` returns `status: ok`. Set `STT_REALTIME_ENABLED=true` to verify native streaming transcription; repeat once with it disabled to verify the batch WAV fallback.

## Push-To-Talk Regression

1. Keep `Live experimental` off.
2. Hold `Hold to Talk`, say one short sentence, then release.
3. Confirm the user transcript appears once as a normal message.
4. Confirm the assistant streams text and, when TTS is configured, plays audio.

## Live Mode Turn Detection

1. Click `Live experimental`.
2. Stay quiet while the Voice activity panel advances from `calibrating` to `idle`.
3. Speak without holding `Hold to Talk`.
4. Confirm the panel moves through `speech_candidate` to `speaking` and the page shows a gray italic partial transcript.
5. Pause for less than the configured hangover, resume speaking, and confirm this remains one turn. Pause again past the hangover.
6. Confirm the partial transcript is replaced by a normal final user message.
7. Confirm the assistant responds through the existing LLM/TTS path.

## Adaptive Noise And Short-Sound Rejection

1. Start Live Mode in steady fan or air-conditioner noise and remain quiet during calibration.
2. Confirm the displayed noise floor settles below the speech threshold and ambient noise does not open a turn.
3. Tap once or make a sound shorter than `NEXT_PUBLIC_VAD_MIN_SPEECH_MS`; confirm it returns to listening without producing a transcript.
4. Change microphone gain or fan speed gradually and confirm the idle noise floor follows without entering `speaking`.
5. Speak normally and confirm the noise floor stays stable while the panel is `speaking` or `pause`.
6. Set `NEXT_PUBLIC_VAD_ADAPTIVE_ENABLED=false`, rebuild, and confirm the panel reports `fixed fallback` with the configured legacy thresholds.

## Pre-Roll

1. Start Live Mode in a quiet room.
2. Say three short phrases that begin immediately and with a hard consonant.
3. Confirm the first word is present in each final transcript.
4. Confirm the first word is not duplicated.

## Latency Panel

1. Complete one Live Mode turn with TTS enabled.
2. Confirm `STT first partial`, `Final transcript`, `LLM first token`, `TTS first audio`, and `Speech end → audio` show non-negative values.
3. Repeat with push-to-talk and confirm `STT first partial` may remain `—` while the applicable final, LLM, and TTS metrics appear.
4. Interrupt a reply and confirm already measured values remain visible while unfinished stages stay `—`.
5. Compare the browser panel only within the browser clock domain; use Gateway structured logs for provider-stage aggregation.

## Partial Transcript And Fallback Guard

1. With Realtime STT enabled, speak for about 10 seconds and confirm provider transcript deltas appear while speaking.
2. Confirm the final transcript still arrives after you stop and the successful turn does not call batch STT.
3. Disable Realtime STT, set `NEXT_PUBLIC_VAD_MAX_TURN_MS=45000`, rebuild/restart the Web app, and speak for about 32 seconds.
4. Confirm batch partial updates arrive no more often than the built-in 2 second cadence before 30 seconds and 5 second cadence afterward.
5. Stop speaking and confirm the final PCM turn is accepted through the WAV fallback.

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
4. Increase volume and repeat; confirm the displayed speech threshold rises during playback and returns after it ends.
5. Note any false barge-in as a known limitation of RMS-based VAD.

## Permission And Fallbacks

1. Deny microphone permission and confirm text input still works.
2. Test in a browser without AudioWorklet support if available.
3. Confirm ScriptProcessor fallback still detects speech starts and ends.

## Reconnect And Cleanup

1. Start Live Mode, then stop the Gateway.
2. Confirm the page shows a reconnecting state and releases the microphone.
3. Restart the Gateway and confirm the page connects with a new session.
4. Start Live Mode again and complete a new turn.
5. Toggle Live Mode on and off three times and confirm the browser shows only one active microphone capture.

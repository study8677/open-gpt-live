import type { VadConfig } from "./live-config";

export type VadState =
  | "calibrating"
  | "idle"
  | "speech_candidate"
  | "speaking"
  | "pause";

export interface SpeechDetectorFrame {
  rms: number;
  now: number;
  playbackActive: boolean;
  suppressStartsUntil: number;
}

export type SpeechDetectorEvent =
  | { type: "speech_start"; startedAt: number }
  | { type: "speech_end"; endedAt: number; reason: "silence" | "max_duration" }
  | { type: "speech_cancel"; endedAt: number; reason: "too_short" };

export interface VadSnapshot {
  state: VadState;
  rms: number;
  noiseFloor: number;
  speechThreshold: number;
  silenceThreshold: number;
  adaptive: boolean;
  calibrationProgress: number;
}

export interface SpeechDetectorResult {
  event?: SpeechDetectorEvent;
  snapshot: VadSnapshot;
}

/**
 * The browser currently uses an RMS detector, but the page only depends on this
 * interface so a WebRTC/ML voice classifier can replace it later.
 */
export interface SpeechDetector {
  processFrame(frame: SpeechDetectorFrame): SpeechDetectorResult;
  reset(now: number): VadSnapshot;
  cancelTurn(now: number): VadSnapshot;
  getSnapshot(): VadSnapshot;
  isTurnActive(): boolean;
}

export class AdaptiveVadEngine implements SpeechDetector {
  private state: VadState;
  private noiseFloor: number;
  private calibrationStartedAt = 0;
  private calibrationSamples: number[] = [];
  private candidateStartedAt = 0;
  private turnStartedAt = 0;
  private silenceStartedAt = 0;
  private voicedDurationMs = 0;
  private lastFrameAt = 0;
  private snapshot: VadSnapshot;

  constructor(private readonly config: VadConfig) {
    this.state = config.adaptiveEnabled ? "calibrating" : "idle";
    this.noiseFloor = config.dynamicSpeechMin / config.speechNoiseMultiplier;
    this.snapshot = this.createSnapshot(0, 0, false);
  }

  reset(now: number): VadSnapshot {
    this.state = this.config.adaptiveEnabled ? "calibrating" : "idle";
    this.noiseFloor =
      this.config.dynamicSpeechMin / this.config.speechNoiseMultiplier;
    this.calibrationStartedAt = now;
    this.calibrationSamples = [];
    this.candidateStartedAt = 0;
    this.turnStartedAt = 0;
    this.silenceStartedAt = 0;
    this.voicedDurationMs = 0;
    this.lastFrameAt = now;
    this.snapshot = this.createSnapshot(0, now, false);
    return this.snapshot;
  }

  processFrame(frame: SpeechDetectorFrame): SpeechDetectorResult {
    const rms = clamp(Number.isFinite(frame.rms) ? frame.rms : 0, 0, 1);
    const now = Math.max(frame.now, this.lastFrameAt);
    const frameDurationMs = clamp(now - this.lastFrameAt, 0, 250);
    this.lastFrameAt = now;

    if (this.state === "calibrating") {
      if (frame.playbackActive || now < frame.suppressStartsUntil) {
        this.calibrationStartedAt = now;
        this.calibrationSamples = [];
      } else {
        this.calibrationSamples.push(rms);
        if (this.calibrationSamples.length > 240) {
          this.calibrationSamples.shift();
        }
      }

      if (
        !frame.playbackActive &&
        now >= frame.suppressStartsUntil &&
        now - this.calibrationStartedAt >= this.config.calibrationMs &&
        this.calibrationSamples.length > 0
      ) {
        this.noiseFloor = clamp(
          percentile(this.calibrationSamples, 0.3),
          0.0001,
          this.config.dynamicSpeechMax / this.config.speechNoiseMultiplier
        );
        this.state = "idle";
      }

      return this.result(rms, now, frame.playbackActive);
    }

    if (
      !this.isTurnActive() &&
      now < frame.suppressStartsUntil
    ) {
      this.resetCandidate();
      return this.result(rms, now, frame.playbackActive);
    }

    if (this.state === "idle") {
      const { speechThreshold } = this.thresholds(frame.playbackActive);
      if (rms >= speechThreshold) {
        this.state = "speech_candidate";
        this.candidateStartedAt = now;
      } else if (this.config.adaptiveEnabled && !frame.playbackActive) {
        this.updateNoiseFloor(rms);
      }
      return this.result(rms, now, frame.playbackActive);
    }

    if (this.state === "speech_candidate") {
      const { speechThreshold } = this.thresholds(frame.playbackActive);
      if (rms < speechThreshold) {
        this.resetCandidate();
        return this.result(rms, now, frame.playbackActive);
      }

      if (now - this.candidateStartedAt >= this.config.startDebounceMs) {
        const startedAt = this.candidateStartedAt;
        this.state = "speaking";
        this.turnStartedAt = startedAt;
        this.silenceStartedAt = 0;
        this.voicedDurationMs = now - startedAt;
        return this.result(rms, now, false, {
          type: "speech_start",
          startedAt
        });
      }
      return this.result(rms, now, frame.playbackActive);
    }

    if (now - this.turnStartedAt >= this.config.maxTurnMs) {
      this.resetTurn();
      return this.result(rms, now, false, {
        type: "speech_end",
        endedAt: now,
        reason: "max_duration"
      });
    }

    const { silenceThreshold, speechThreshold } = this.thresholds(false);
    if (this.state === "speaking") {
      if (rms >= silenceThreshold) {
        this.voicedDurationMs += frameDurationMs;
        return this.result(rms, now, false);
      }

      this.state = "pause";
      this.silenceStartedAt = now;
      return this.result(rms, now, false);
    }

    if (rms >= speechThreshold) {
      this.state = "speaking";
      this.silenceStartedAt = 0;
      this.voicedDurationMs += frameDurationMs;
      return this.result(rms, now, false);
    }

    if (now - this.silenceStartedAt < this.config.hangoverMs) {
      return this.result(rms, now, false);
    }

    const event: SpeechDetectorEvent =
      this.voicedDurationMs < this.config.minimumSpeechMs
        ? { type: "speech_cancel", endedAt: now, reason: "too_short" }
        : { type: "speech_end", endedAt: now, reason: "silence" };
    this.resetTurn();
    return this.result(rms, now, false, event);
  }

  cancelTurn(now: number): VadSnapshot {
    this.resetTurn();
    this.lastFrameAt = now;
    this.snapshot = this.createSnapshot(0, now, false);
    return this.snapshot;
  }

  getSnapshot(): VadSnapshot {
    return this.snapshot;
  }

  isTurnActive(): boolean {
    return this.state === "speaking" || this.state === "pause";
  }

  private updateNoiseFloor(rms: number): void {
    // Limit how much one idle frame can move the baseline. This lets a fan or
    // microphone gain change settle gradually without teaching a key tap as noise.
    const cappedSample = Math.min(
      rms,
      Math.max(this.noiseFloor * 1.5, this.noiseFloor + 0.001)
    );
    this.noiseFloor +=
      this.config.noiseFloorSmoothing * (cappedSample - this.noiseFloor);
    this.noiseFloor = clamp(
      this.noiseFloor,
      0.0001,
      this.config.dynamicSpeechMax / this.config.speechNoiseMultiplier
    );
  }

  private thresholds(playbackActive: boolean): {
    speechThreshold: number;
    silenceThreshold: number;
  } {
    if (!this.config.adaptiveEnabled) {
      return {
        speechThreshold: clamp(
          this.config.speechThreshold *
            (playbackActive ? this.config.playbackThresholdMultiplier : 1),
          0,
          1
        ),
        silenceThreshold: this.config.silenceThreshold
      };
    }

    const baseSpeech = clamp(
      this.noiseFloor * this.config.speechNoiseMultiplier,
      this.config.dynamicSpeechMin,
      this.config.dynamicSpeechMax
    );
    const speechThreshold = clamp(
      baseSpeech *
        (playbackActive ? this.config.playbackThresholdMultiplier : 1),
      this.config.dynamicSpeechMin,
      Math.min(1, this.config.dynamicSpeechMax * this.config.playbackThresholdMultiplier)
    );
    const silenceThreshold = Math.min(
      clamp(
        this.noiseFloor * this.config.silenceNoiseMultiplier,
        this.config.dynamicSilenceMin,
        this.config.dynamicSilenceMax
      ),
      baseSpeech * 0.9
    );
    return { speechThreshold, silenceThreshold };
  }

  private result(
    rms: number,
    now: number,
    playbackActive: boolean,
    event?: SpeechDetectorEvent
  ): SpeechDetectorResult {
    this.snapshot = this.createSnapshot(rms, now, playbackActive);
    return event ? { event, snapshot: this.snapshot } : { snapshot: this.snapshot };
  }

  private createSnapshot(
    rms: number,
    now: number,
    playbackActive: boolean
  ): VadSnapshot {
    const thresholds = this.thresholds(playbackActive);
    return {
      state: this.state,
      rms,
      noiseFloor: this.noiseFloor,
      speechThreshold: thresholds.speechThreshold,
      silenceThreshold: thresholds.silenceThreshold,
      adaptive: this.config.adaptiveEnabled,
      calibrationProgress:
        this.state === "calibrating"
          ? clamp((now - this.calibrationStartedAt) / this.config.calibrationMs, 0, 1)
          : 1
    };
  }

  private resetCandidate(): void {
    this.state = "idle";
    this.candidateStartedAt = 0;
  }

  private resetTurn(): void {
    this.state = "idle";
    this.candidateStartedAt = 0;
    this.turnStartedAt = 0;
    this.silenceStartedAt = 0;
    this.voicedDurationMs = 0;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * quantile))
  );
  return sorted[index] ?? 0;
}

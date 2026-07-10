import { describe, expect, it } from "vitest";
import { DEFAULT_VAD_CONFIG, type VadConfig } from "./live-config";
import {
  AdaptiveVadEngine,
  type SpeechDetectorEvent,
  type SpeechDetectorResult
} from "./vad-engine";

const testConfig: VadConfig = {
  ...DEFAULT_VAD_CONFIG,
  calibrationMs: 200,
  startDebounceMs: 150,
  minimumSpeechMs: 300,
  hangoverMs: 500,
  maxTurnMs: 2_000,
  noiseFloorSmoothing: 0.2
};

function createHarness(overrides: Partial<VadConfig> = {}) {
  const engine = new AdaptiveVadEngine({ ...testConfig, ...overrides });
  let now = 0;
  engine.reset(now);

  const frame = (
    rms: number,
    options: {
      advanceMs?: number;
      playbackActive?: boolean;
      suppressStartsUntil?: number;
    } = {}
  ): SpeechDetectorResult => {
    now += options.advanceMs ?? 50;
    return engine.processFrame({
      rms,
      now,
      playbackActive: options.playbackActive ?? false,
      suppressStartsUntil: options.suppressStartsUntil ?? 0
    });
  };

  const repeat = (
    rms: number,
    count: number,
    options: Parameters<typeof frame>[1] = {}
  ): SpeechDetectorEvent[] => {
    const events: SpeechDetectorEvent[] = [];
    for (let index = 0; index < count; index += 1) {
      const result = frame(rms, options);
      if (result.event) events.push(result.event);
    }
    return events;
  };

  return { engine, frame, repeat, get now() { return now; } };
}

function calibrate(harness: ReturnType<typeof createHarness>, rms = 0.004) {
  harness.repeat(rms, 5);
  expect(harness.engine.getSnapshot().state).toBe("idle");
}

describe("AdaptiveVadEngine", () => {
  it("calibrates against continuous ambient noise without opening a turn", () => {
    const harness = createHarness();
    const events = harness.repeat(0.006, 20);

    expect(events).toEqual([]);
    expect(harness.engine.getSnapshot()).toMatchObject({
      state: "idle",
      adaptive: true
    });
    expect(harness.engine.getSnapshot().noiseFloor).toBeCloseTo(0.006, 3);
    expect(harness.engine.getSnapshot().speechThreshold).toBeGreaterThan(0.006);
  });

  it("rejects a one-frame noise spike during idle", () => {
    const harness = createHarness();
    calibrate(harness);

    expect(harness.frame(0.08).snapshot.state).toBe("speech_candidate");
    const quiet = harness.frame(0.004);
    expect(quiet.event).toBeUndefined();
    expect(quiet.snapshot.state).toBe("idle");
  });

  it("keeps one turn across a short pause and ends after the grace window", () => {
    const harness = createHarness();
    calibrate(harness);

    const starts = harness.repeat(0.05, 5);
    expect(starts).toEqual([
      expect.objectContaining({ type: "speech_start" })
    ]);
    expect(harness.engine.isTurnActive()).toBe(true);

    expect(harness.repeat(0.001, 6)).toEqual([]);
    expect(harness.engine.getSnapshot().state).toBe("pause");
    expect(harness.repeat(0.05, 4)).toEqual([]);
    expect(harness.engine.getSnapshot().state).toBe("speaking");

    const endings = harness.repeat(0.001, 12);
    expect(endings).toEqual([
      expect.objectContaining({ type: "speech_end", reason: "silence" })
    ]);
    expect(harness.engine.getSnapshot().state).toBe("idle");
  });

  it("cancels a turn that never reaches the minimum voiced duration", () => {
    const harness = createHarness({
      startDebounceMs: 100,
      minimumSpeechMs: 450,
      hangoverMs: 300
    });
    calibrate(harness);

    expect(harness.repeat(0.05, 4)).toEqual([
      expect.objectContaining({ type: "speech_start" })
    ]);
    expect(harness.repeat(0.001, 8)).toEqual([
      expect.objectContaining({ type: "speech_cancel", reason: "too_short" })
    ]);
  });

  it("uses playback boost and post-playback suppression for new starts", () => {
    const harness = createHarness();
    calibrate(harness);

    const playback = harness.frame(0.02, { playbackActive: true });
    expect(playback.snapshot.state).toBe("idle");
    expect(playback.snapshot.speechThreshold).toBeGreaterThan(0.02);

    const suppressedUntil = harness.now + 300;
    harness.repeat(0.05, 5, { suppressStartsUntil: suppressedUntil });
    expect(harness.engine.getSnapshot().state).toBe("idle");

    const starts = harness.repeat(0.05, 5);
    expect(starts).toEqual([
      expect.objectContaining({ type: "speech_start" })
    ]);

    const bargeIn = createHarness();
    calibrate(bargeIn);
    expect(bargeIn.repeat(0.05, 5, { playbackActive: true })).toEqual([
      expect.objectContaining({ type: "speech_start" })
    ]);
  });

  it("recovers from a gradual device noise change without polluting the baseline during speech", () => {
    const harness = createHarness();
    calibrate(harness, 0.003);
    const initialFloor = harness.engine.getSnapshot().noiseFloor;

    for (const level of [0.004, 0.005, 0.006, 0.007, 0.008, 0.009]) {
      expect(harness.repeat(level, 8)).toEqual([]);
    }
    const settledFloor = harness.engine.getSnapshot().noiseFloor;
    expect(settledFloor).toBeGreaterThan(initialFloor);
    expect(harness.engine.getSnapshot().state).toBe("idle");

    harness.repeat(0.08, 5);
    expect(harness.engine.isTurnActive()).toBe(true);
    expect(harness.engine.getSnapshot().noiseFloor).toBeCloseTo(settledFloor, 8);
  });

  it("enforces the maximum turn duration", () => {
    const harness = createHarness({ maxTurnMs: 1_000 });
    calibrate(harness);

    const events = harness.repeat(0.05, 30);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "speech_end", reason: "max_duration" })
    );
  });

  it("falls back to the fixed thresholds when adaptive mode is disabled", () => {
    const harness = createHarness({ adaptiveEnabled: false });
    const snapshot = harness.engine.getSnapshot();

    expect(snapshot.state).toBe("idle");
    expect(snapshot.speechThreshold).toBe(testConfig.speechThreshold);
    expect(snapshot.silenceThreshold).toBe(testConfig.silenceThreshold);
  });
});

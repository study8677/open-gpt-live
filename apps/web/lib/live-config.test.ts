import { describe, expect, it } from "vitest";
import { DEFAULT_VAD_CONFIG, resolveVadConfig } from "./live-config";

describe("resolveVadConfig", () => {
  it("uses the verified defaults when public values are absent", () => {
    expect(resolveVadConfig({})).toEqual(DEFAULT_VAD_CONFIG);
  });

  it("accepts valid public values and preserves VAD hysteresis", () => {
    expect(
      resolveVadConfig({
        speechThreshold: "0.03",
        silenceThreshold: "0.02",
        startDebounceMs: "200",
        hangoverMs: "900",
        maxTurnMs: "45000",
        preRollMs: "500",
        playbackThresholdMultiplier: "3",
        playbackSuppressAfterEndMs: "400"
      })
    ).toMatchObject({
      speechThreshold: 0.03,
      silenceThreshold: 0.02,
      startDebounceMs: 200,
      hangoverMs: 900,
      maxTurnMs: 45_000,
      preRollMs: 500,
      playbackThresholdMultiplier: 3,
      playbackSuppressAfterEndMs: 400
    });
  });

  it("resolves adaptive controls and clamps the dynamic hysteresis range", () => {
    const config = resolveVadConfig({
      adaptiveEnabled: "0",
      calibrationMs: "1500",
      noiseFloorSmoothing: "0.15",
      speechNoiseMultiplier: "4",
      silenceNoiseMultiplier: "2",
      dynamicSpeechMin: "0.02",
      dynamicSpeechMax: "0.1",
      dynamicSilenceMin: "0.01",
      dynamicSilenceMax: "0.2",
      minimumSpeechMs: "450"
    });

    expect(config).toMatchObject({
      adaptiveEnabled: false,
      calibrationMs: 1_500,
      noiseFloorSmoothing: 0.15,
      speechNoiseMultiplier: 4,
      silenceNoiseMultiplier: 2,
      dynamicSpeechMin: 0.02,
      dynamicSpeechMax: 0.1,
      dynamicSilenceMin: 0.01,
      minimumSpeechMs: 450
    });
    expect(config.dynamicSilenceMax).toBeCloseTo(0.09);
  });

  it("falls back for unsafe values and never lets pre-roll exceed hangover", () => {
    const config = resolveVadConfig({
      speechThreshold: "not-a-number",
      silenceThreshold: "0.5",
      hangoverMs: "300",
      preRollMs: "900"
    });

    expect(config.speechThreshold).toBe(DEFAULT_VAD_CONFIG.speechThreshold);
    expect(config.silenceThreshold).toBeLessThan(config.speechThreshold);
    expect(config.preRollMs).toBe(300);
  });
});

import { describe, expect, it } from "vitest";
import {
  beginLatencyRequest,
  markLatency,
  settleLatencyRequest,
  type LatencyRegistry
} from "./latency-metrics";

describe("latency metrics", () => {
  it("calculates voice milestones from one browser monotonic clock", () => {
    const registry: LatencyRegistry = new Map();
    beginLatencyRequest(registry, "voice-1", "live", 100);
    markLatency(registry, "voice-1", "speechStartedAt", 100);
    markLatency(registry, "voice-1", "firstPartialAt", 420);
    markLatency(registry, "voice-1", "speechEndedAt", 1_000);
    markLatency(registry, "voice-1", "finalTranscriptAt", 1_610);
    markLatency(registry, "voice-1", "firstLlmDeltaAt", 2_090);
    const result = markLatency(
      registry,
      "voice-1",
      "firstAudioPlaybackAt",
      2_810
    );

    expect(result).toMatchObject({
      sttFirstPartialMs: 320,
      sttFinalMs: 610,
      llmFirstDeltaMs: 480,
      ttsFirstAudioMs: 720,
      speechEndToFirstAudioMs: 1_810
    });
  });

  it("keeps completed milestones after interruption and ignores duplicates", () => {
    const registry: LatencyRegistry = new Map();
    beginLatencyRequest(registry, "voice-1", "ptt", 10);
    markLatency(registry, "voice-1", "speechStartedAt", 10);
    markLatency(registry, "voice-1", "firstPartialAt", 30);
    markLatency(registry, "voice-1", "firstPartialAt", 90);

    expect(settleLatencyRequest(registry, "voice-1", "interrupted")).toMatchObject({
      status: "interrupted",
      sttFirstPartialMs: 20
    });
  });

  it("uses request start as the LLM baseline for text requests", () => {
    const registry: LatencyRegistry = new Map();
    beginLatencyRequest(registry, "text-1", "text", 50);
    const result = markLatency(registry, "text-1", "firstLlmDeltaAt", 175);

    expect(result?.llmFirstDeltaMs).toBe(125);
    expect(result?.sttFinalMs).toBeUndefined();
  });

  it("retains completed values when a provider error settles the request", () => {
    const registry: LatencyRegistry = new Map();
    beginLatencyRequest(registry, "voice-error", "live", 0);
    markLatency(registry, "voice-error", "speechEndedAt", 100);
    markLatency(registry, "voice-error", "finalTranscriptAt", 180);

    expect(settleLatencyRequest(registry, "voice-error", "error")).toMatchObject({
      status: "error",
      sttFinalMs: 80
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  Pcm16FrameBuffer,
  StreamingPcm16Resampler
} from "./audio-pcm";

describe("StreamingPcm16Resampler", () => {
  it("converts 48 kHz float audio to 24 kHz PCM16", () => {
    const input = Float32Array.from(
      { length: 48_000 },
      (_, index) => Math.sin((index / 48_000) * Math.PI * 2 * 440) * 0.5
    );
    const output = new StreamingPcm16Resampler(48_000).push(input);

    expect(output.length).toBe(24_000);
    expect(Math.max(...output.subarray(0, 1_000))).toBeGreaterThan(15_000);
    expect(Math.min(...output.subarray(0, 1_000))).toBeLessThan(-15_000);
  });

  it("keeps fractional resampling state across input batches", () => {
    const resampler = new StreamingPcm16Resampler(44_100);
    const first = resampler.push(new Float32Array(22_050).fill(0.25));
    const second = resampler.push(new Float32Array(22_050).fill(0.25));

    expect(first.length + second.length).toBeGreaterThanOrEqual(23_999);
    expect(first.length + second.length).toBeLessThanOrEqual(24_000);
  });
});

describe("Pcm16FrameBuffer", () => {
  it("emits exact 50 ms frames without duplicating samples", () => {
    const buffer = new Pcm16FrameBuffer();
    expect(buffer.push(new Int16Array(600).fill(1))).toHaveLength(0);

    const frames = buffer.push(new Int16Array(1_800).fill(2));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(1_200);
    expect(frames[0][599]).toBe(1);
    expect(frames[0][600]).toBe(2);
    expect(frames[1].every((sample) => sample === 2)).toBe(true);
  });
});

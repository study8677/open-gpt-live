export const LIVE_PCM_SAMPLE_RATE = 24_000;
export const LIVE_PCM_MIME_TYPE = "audio/pcm;rate=24000";
export const LIVE_PCM_FRAME_MS = 50;

/** Stateful linear resampler for the ScriptProcessor fallback path. */
export class StreamingPcm16Resampler {
  private readonly ratio: number;
  private pending: number[] = [];
  private position = 0;

  constructor(
    inputSampleRate: number,
    private readonly outputSampleRate = LIVE_PCM_SAMPLE_RATE
  ) {
    this.ratio = inputSampleRate / outputSampleRate;
  }

  push(samples: Float32Array): Int16Array {
    for (const sample of samples) {
      this.pending.push(sample);
    }

    const output: number[] = [];
    while (this.position + 1 < this.pending.length) {
      const leftIndex = Math.floor(this.position);
      const fraction = this.position - leftIndex;
      const left = this.pending[leftIndex] ?? 0;
      const right = this.pending[leftIndex + 1] ?? left;
      const sample = left + (right - left) * fraction;
      output.push(floatToPcm16(sample));
      this.position += this.ratio;
    }

    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.pending = this.pending.slice(consumed);
      this.position -= consumed;
    }

    return Int16Array.from(output);
  }
}

/** Collect arbitrary PCM batches into stable, provider-friendly frame sizes. */
export class Pcm16FrameBuffer {
  private pending: number[] = [];
  private readonly samplesPerFrame: number;

  constructor(
    frameDurationMs = LIVE_PCM_FRAME_MS,
    sampleRate = LIVE_PCM_SAMPLE_RATE
  ) {
    this.samplesPerFrame = Math.round((frameDurationMs / 1_000) * sampleRate);
  }

  push(samples: Int16Array): Int16Array[] {
    for (const sample of samples) {
      this.pending.push(sample);
    }

    const frames: Int16Array[] = [];
    while (this.pending.length >= this.samplesPerFrame) {
      frames.push(Int16Array.from(this.pending.slice(0, this.samplesPerFrame)));
      this.pending = this.pending.slice(this.samplesPerFrame);
    }
    return frames;
  }

  clear(): void {
    this.pending = [];
  }
}

function floatToPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0
    ? Math.round(clamped * 0x8000)
    : Math.round(clamped * 0x7fff);
}

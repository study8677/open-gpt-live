class OpenGptLiveVadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 24000;
    this.frameSamples = this.targetSampleRate * 0.05;
    this.resampleRatio = sampleRate / this.targetSampleRate;
    this.resamplePosition = 0;
    this.pendingInput = [];
    this.pendingOutput = [];
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) {
      return true;
    }

    for (const sample of input) {
      this.pendingInput.push(sample);
    }

    while (this.resamplePosition + 1 < this.pendingInput.length) {
      const leftIndex = Math.floor(this.resamplePosition);
      const fraction = this.resamplePosition - leftIndex;
      const left = this.pendingInput[leftIndex] ?? 0;
      const right = this.pendingInput[leftIndex + 1] ?? left;
      this.pendingOutput.push(left + (right - left) * fraction);
      this.resamplePosition += this.resampleRatio;
    }

    const consumed = Math.floor(this.resamplePosition);
    if (consumed > 0) {
      this.pendingInput = this.pendingInput.slice(consumed);
      this.resamplePosition -= consumed;
    }

    while (this.pendingOutput.length >= this.frameSamples) {
      const frame = this.pendingOutput.splice(0, this.frameSamples);
      const pcm = new Int16Array(frame.length);
      let sumSquares = 0;

      for (let index = 0; index < frame.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, frame[index]));
        sumSquares += sample * sample;
        pcm[index] = sample < 0
          ? Math.round(sample * 0x8000)
          : Math.round(sample * 0x7fff);
      }

      this.port.postMessage({
        rms: Math.sqrt(sumSquares / frame.length),
        pcm: pcm.buffer,
        sampleRate: this.targetSampleRate
      }, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("open-gpt-live-vad", OpenGptLiveVadProcessor);

class OpenGptLiveVadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameCount = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) {
      return true;
    }

    for (let index = 0; index < input.length; index += 1) {
      this.sumSquares += input[index] * input[index];
    }
    this.frameCount += input.length;

    if (this.frameCount >= sampleRate * 0.05) {
      this.port.postMessage({
        rms: Math.sqrt(this.sumSquares / this.frameCount)
      });
      this.frameCount = 0;
      this.sumSquares = 0;
    }

    return true;
  }
}

registerProcessor("open-gpt-live-vad", OpenGptLiveVadProcessor);

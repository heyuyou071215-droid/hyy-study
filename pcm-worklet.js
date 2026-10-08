class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.chunk = new Int16Array(3200); // 200 ms, 16 kHz mono PCM16.
    this.cursor = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const input = channels[0];
    const ratio = 16000 / sampleRate;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.phase += ratio;
      if (this.phase < 1) continue;
      this.phase -= 1;
      const sample = Math.max(-1, Math.min(1, this.sum / this.count));
      this.chunk[this.cursor++] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      this.sum = 0;
      this.count = 0;
      if (this.cursor === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(3200);
        this.cursor = 0;
      }
    }
    return true;
  }
}
registerProcessor("hyy-pcm-capture", PcmCapture);

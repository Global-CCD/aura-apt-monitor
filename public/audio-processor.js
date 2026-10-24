/**
 * AudioWorkletProcessor: 16 kHz Continuous Audio Capture
 * Eliminates main-thread UI blocking and guarantees zero blind spots.
 */
class ContinuousAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 8000; // 500ms chunk at 16 kHz
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    const inputLength = channelData.length;

    for (let i = 0; i < inputLength; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];

      // Dispatch 500ms frame (HOP_SAMPLES = 8000)
      if (this.bufferIndex >= this.bufferSize) {
        this.port.postMessage({
          audioChunk: this.buffer.slice(0, this.bufferSize)
        });
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('continuous-audio-processor', ContinuousAudioProcessor);
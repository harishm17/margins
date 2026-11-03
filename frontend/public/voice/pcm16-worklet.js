/**
 * Microphone audio to 16 kHz mono PCM16 in 100 ms frames, for cloud speech recognition (spec 19.12).
 *
 * The AudioContext runs at the device's rate (Firefox refuses a microphone source at another rate), so this resamples:
 * each output sample is the average of the input samples it covers, which also filters out what 16 kHz cannot carry.
 * Frames go to the main thread as transferred ArrayBuffers.
 */
const TARGET_RATE = 16000
const FRAME_SAMPLES = 1600 // 100 ms at 16 kHz

class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.step = sampleRate / TARGET_RATE
    this.position = 0
    this.sum = 0
    this.count = 0
    this.frame = new Int16Array(FRAME_SAMPLES)
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i += 1) {
      this.sum += channel[i]
      this.count += 1
      this.position += 1
      if (this.position >= this.step) {
        this.position -= this.step
        const value = Math.max(-1, Math.min(1, this.sum / this.count))
        this.frame[this.filled] = value < 0 ? value * 0x8000 : value * 0x7fff
        this.filled += 1
        this.sum = 0
        this.count = 0
        if (this.filled === FRAME_SAMPLES) {
          const buffer = this.frame.buffer
          this.port.postMessage(buffer, [buffer])
          this.frame = new Int16Array(FRAME_SAMPLES)
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('margins-pcm16', Pcm16Processor)

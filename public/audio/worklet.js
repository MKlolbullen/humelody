import { PitchTracker } from './tracker.js';

class HumlineCapture extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.stopped = false; this.lastFrame = 0;
    this.tracker = new PitchTracker(sampleRate, event => this.port.postMessage({ kind: 'note', event }));
    this.tracker.configure(options.processorOptions.settings);
    this.port.onmessage = ({ data }) => {
      if (data.kind === 'settings') this.tracker.configure(data.settings);
      if (data.kind === 'stop') {
        this.tracker.flush(); this.stopped = true;
        this.port.postMessage({ kind: 'stopped', sample: this.tracker.sample });
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (input) this.tracker.process(input);
    if (this.tracker.sample - this.lastFrame > sampleRate / 20) {
      this.lastFrame = this.tracker.sample;
      this.port.postMessage({ kind: 'frame', ...this.tracker.telemetry,
        sample: this.tracker.sample, wave: input ? Array.from(input) : [] });
    }
    return true;
  }
}
registerProcessor('humline-capture', HumlineCapture);

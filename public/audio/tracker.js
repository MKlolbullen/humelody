// Dependency-free monophonic detector. Runs in an AudioWorklet and in offline tests.
export const DEFAULT_SETTINGS = Object.freeze({ gateDb: -45, minHz: 65, maxHz: 1000,
  confidence: 0.8, stableMs: 40, releaseMs: 70, hysteresis: 0.25, onsetDb: 7,
  retrigger: true, gainDb: 0 });

export class PitchTracker {
  constructor(rate, emit = () => {}) {
    this.rate = rate; this.emit = emit; this.settings = { ...DEFAULT_SETTINGS };
    this.factor = Math.max(1, Math.round(rate / 12000)); this.analysisRate = rate / this.factor;
    this.window = new Float32Array(1024); this.frame = new Float32Array(1024);
    this.cmnd = new Float32Array(514); this.diff = new Float32Array(514);
    this.attack = Math.exp(-1 / (rate * 0.008)); this.release = Math.exp(-1 / (rate * 0.035));
    this.reset();
  }
  reset() {
    this.window.fill(0); this.write = this.fill = this.hop = this.decCount = this.sample = 0;
    this.decSum = this.power = 0; this.active = this.candidate = -1;
    this.candidateFrames = this.invalidFrames = 0; this.lastOn = -Infinity; this.lastDb = -100;
    this.telemetry = { db: -100, hz: 0, confidence: 0, note: -1, sample: 0 };
  }
  configure(settings) {
    const finite = (v, fallback, lo, hi) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    const s = { ...this.settings, ...settings };
    s.gateDb = finite(s.gateDb, -45, -80, -6); s.minHz = finite(s.minHz, 65, 40, 500);
    s.maxHz = finite(s.maxHz, 1000, s.minHz + 20, 2000); s.confidence = finite(s.confidence, .8, .5, .99);
    s.stableMs = finite(s.stableMs, 30, 10, 150); s.releaseMs = finite(s.releaseMs, 70, 20, 250);
    s.hysteresis = finite(s.hysteresis, .25, 0, .45); s.onsetDb = finite(s.onsetDb, 7, 3, 20);
    s.gainDb = finite(s.gainDb, 0, -24, 24); this.settings = s;
  }
  process(samples) {
    const gain = Math.pow(10, this.settings.gainDb / 20);
    for (let i = 0; i < samples.length; i++) {
      const x = Number.isFinite(samples[i]) ? samples[i] * gain : 0;
      const p = x * x, c = p > this.power ? this.attack : this.release;
      this.power = c * this.power + (1 - c) * p; this.sample++;
      this.decSum += x;
      if (++this.decCount < this.factor) continue;
      this.window[this.write] = this.decSum / this.factor;
      this.write = (this.write + 1) % 1024; this.fill = Math.min(1024, this.fill + 1);
      this.decSum = this.decCount = 0;
      if (++this.hop >= 128 && this.fill === 1024) { this.hop = 0; this.analyse(); }
    }
  }
  analyse() {
    const s = this.settings, db = Math.max(-100, 10 * Math.log10(this.power + 1e-12));
    const minTau = Math.max(2, Math.floor(this.analysisRate / s.maxHz));
    const maxTau = Math.min(510, Math.ceil(this.analysisRate / s.minHz));
    let hz = 0, confidence = 0;
    if (db >= s.gateDb - 4) {
      for (let i = 0; i < 1024; i++) this.frame[i] = this.window[(this.write + i) % 1024];
      let cumulative = 0; this.cmnd[0] = 1;
      for (let tau = 1; tau <= maxTau; tau++) {
        let d = 0;
        for (let i = 0; i < 1024 - maxTau; i++) { const delta = this.frame[i] - this.frame[i + tau]; d += delta * delta; }
        this.diff[tau] = d; cumulative += d; this.cmnd[tau] = cumulative > 1e-20 ? d * tau / cumulative : 1;
      }
      let best = minTau, found = false;
      for (let tau = minTau; tau <= maxTau; tau++) {
        if (this.cmnd[tau] < 1 - s.confidence) {
          while (tau < maxTau && this.cmnd[tau + 1] < this.cmnd[tau]) tau++;
          best = tau; found = true; break;
        }
      }
      if (!found) for (let tau = minTau + 1; tau <= maxTau; tau++) if (this.cmnd[tau] < this.cmnd[best]) best = tau;
      let refined = best;
      if (best > minTau && best < maxTau) {
        const a = this.cmnd[best - 1], b = this.cmnd[best], c = this.cmnd[best + 1], den = a - 2 * b + c;
        if (Math.abs(den) > 1e-12) refined += Math.max(-.5, Math.min(.5, .5 * (a - c) / den));
      }
      hz = this.analysisRate / refined; confidence = Math.max(0, 1 - this.cmnd[best]);
    }
    const valid = db >= s.gateDb - (this.active >= 0 ? 4 : 0) && hz >= s.minHz && hz <= s.maxHz &&
      confidence >= s.confidence - (this.active >= 0 ? .05 : 0);
    const onset = db - this.lastDb; this.lastDb = db;
    this.telemetry = { db, hz: valid ? hz : 0, confidence, note: this.active, sample: this.sample };
    const hopMs = 128 / this.analysisRate * 1000;
    if (!valid) {
      this.candidate = -1; this.candidateFrames = 0;
      if (++this.invalidFrames * hopMs >= s.releaseMs) this.close();
      this.telemetry.note = this.active; return;
    }
    this.invalidFrames = 0;
    const pitch = 69 + 12 * Math.log2(hz / 440);
    const note = this.active >= 0 && Math.abs(pitch - this.active) <= .5 + s.hysteresis
      ? this.active : Math.min(127, Math.max(0, Math.round(pitch)));
    if (note !== this.candidate) { this.candidate = note; this.candidateFrames = 1; } else this.candidateFrames++;
    if (this.candidateFrames * hopMs < s.stableMs) return;
    const reattack = s.retrigger && onset >= s.onsetDb && (this.sample - this.lastOn) / this.rate > .12;
    if (note !== this.active || reattack) {
      this.close(); this.active = note; this.lastOn = this.sample;
      const dynamic = Math.max(0, Math.min(1, (db - s.gateDb) / (-9 - s.gateDb)));
      this.emit({ type: 'on', note, velocity: Math.round(20 + 107 * Math.pow(dynamic, .7)), sample: this.sample });
    }
    this.telemetry.note = this.active;
  }
  close() {
    if (this.active >= 0) this.emit({ type: 'off', note: this.active, sample: this.sample });
    this.active = -1;
  }
  flush() { this.close(); }
}

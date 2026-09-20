import { secondsAtBeat, type Clip } from './midi';
export type Detection = { type: 'on' | 'off'; note: number; velocity?: number; sample: number };
export type Frame = { db: number; hz: number; confidence: number; note: number; sample: number; wave: number[] };
export type Settings = { gateDb: number; stableMs: number; releaseMs: number; gainDb: number; minHz: number; maxHz: number; retrigger: boolean };

export class Capture {
  context?: AudioContext; stream?: MediaStream; source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode; stopped = false; ack?: () => void;
  async start(settings: Settings, onNote: (e: Detection, rate: number) => void, onFrame: (f: Frame, rate: number) => void, onEnded: () => void) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture needs HTTPS and a browser with microphone support. You can still import MIDI.');
    this.context = new AudioContext(); await this.context.resume();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (this.stopped) throw new Error('Recording cancelled.');
      await this.context.audioWorklet.addModule('/audio/worklet.js');
      if (this.stopped) throw new Error('Recording cancelled.');
      const rate = this.context.sampleRate;
      this.node = new AudioWorkletNode(this.context, 'humline-capture', { processorOptions: { settings } });
      this.node.port.onmessage = ({ data }) => {
        if (data.kind === 'note') onNote(data.event, rate);
        if (data.kind === 'frame') onFrame(data, rate);
        if (data.kind === 'stopped') this.ack?.();
      };
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.node); this.node.connect(this.context.destination); // Worklet outputs silence.
      this.stream.getAudioTracks().forEach(t => { t.onended = onEnded; });
    } catch (error) { this.cleanup(); throw error; }
  }
  configure(settings: Settings) { this.node?.port.postMessage({ kind: 'settings', settings }); }
  async stop() {
    if (this.stopped) return; this.stopped = true;
    if (this.node) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500); this.ack = () => { clearTimeout(timer); resolve(); };
      this.node!.port.postMessage({ kind: 'stop' });
    });
    this.cleanup();
  }
  cleanup() {
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    this.source?.disconnect(); this.node?.disconnect(); this.node?.port.close();
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }
}

export class PreviewSynth {
  context?: AudioContext; timer?: ReturnType<typeof setInterval>;
  voices = new Set<OscillatorNode>(); startedAt = 0; duration = 0;
  async play(clip: Clip, wave: OscillatorType, onPosition: (beat: number) => void, onEnd: () => void) {
    this.stop(); const context = new AudioContext(); this.context = context; await context.resume();
    if (this.context !== context) return;
    const output = context.createGain(); output.gain.value = .25; output.connect(context.destination);
    const sequence = clip.notes.map(n => ({ ...n, time: secondsAtBeat(n.start, clip.tempos), end: secondsAtBeat(n.start + n.duration, clip.tempos) })).sort((a,b) => a.time - b.time);
    const end = Math.max(0, ...sequence.map(n => n.end)); this.duration = end; this.startedAt = context.currentTime + .06;
    let index = 0;
    this.timer = setInterval(() => {
      const now = context.currentTime - this.startedAt;
      while (index < sequence.length && sequence[index].time < now + .15) {
        const n = sequence[index++], oscillator = context.createOscillator(), envelope = context.createGain();
        oscillator.type = wave; oscillator.frequency.value = 440 * Math.pow(2, (n.pitch - 69) / 12);
        const start = this.startedAt + n.time, stop = this.startedAt + n.end, level = n.velocity / 127 * .28;
        envelope.gain.setValueAtTime(0, start); envelope.gain.linearRampToValueAtTime(level, Math.min(start + .008, stop));
        envelope.gain.setValueAtTime(level, stop); envelope.gain.linearRampToValueAtTime(0, stop + .06);
        oscillator.connect(envelope); envelope.connect(output); oscillator.start(start); oscillator.stop(stop + .07);
        this.voices.add(oscillator); oscillator.onended = () => { this.voices.delete(oscillator); oscillator.disconnect(); envelope.disconnect(); };
      }
      let previousSeconds = 0, previousBeat = 0, bpm = 120;
      for (const tempo of clip.tempos) {
        const at = secondsAtBeat(tempo.beat, clip.tempos); if (at > now) break;
        previousSeconds = at; previousBeat = tempo.beat; bpm = tempo.bpm;
      }
      onPosition(Math.max(0, previousBeat + (now - previousSeconds) * bpm / 60));
      if (now > end + .1) { this.stop(); onEnd(); }
    }, 25);
  }
  stop() {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const voice of this.voices) { try { voice.stop(); } catch {} voice.disconnect(); } this.voices.clear();
    if (this.context && this.context.state !== 'closed') void this.context.close(); this.context = undefined;
  }
}

export async function transcribeFile(file: File, settings: Settings, bpm: number, progress: (n: number) => void): Promise<Clip> {
  if (file.size > 40 * 1024 * 1024) throw new Error('Choose an audio file smaller than 40 MB.');
  const context = new AudioContext();
  let audio: AudioBuffer;
  try { audio = await context.decodeAudioData(await file.arrayBuffer()); } finally { await context.close(); }
  if (audio.duration > 600) throw new Error('Choose an audio clip shorter than 10 minutes.');
  const modulePath = '/audio/tracker.js';
  const { PitchTracker } = await import(/* @vite-ignore */ modulePath);
  const notes: Clip['notes'] = []; let open: { pitch: number; start: number; velocity: number } | null = null;
  const tracker = new PitchTracker(audio.sampleRate, (event: Detection) => {
    const beat = event.sample / audio.sampleRate * bpm / 60;
    if (event.type === 'on') open = { pitch: event.note, start: beat, velocity: event.velocity ?? 90 };
    else if (open) { notes.push({ ...open, duration: Math.max(1 / 480, beat - open.start), channel: 0, id: `a${notes.length}` }); open = null; }
  });
  tracker.configure(settings);
  const samples = audio.getChannelData(0); // One melodic source, rather than mixing unrelated channels.
  for (let offset = 0; offset < samples.length; offset += 8192) {
    tracker.process(samples.subarray(offset, offset + 8192));
    if (offset % 131072 === 0) { progress(offset / samples.length); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  tracker.flush(); return { notes, tempos: [{ beat: 0, bpm }] };
}

export type Note = { id: string; pitch: number; start: number; duration: number; velocity: number; channel: number };
export type Tempo = { beat: number; bpm: number };
export type Clip = { notes: Note[]; tempos: Tempo[]; extra?: { beat: number; bytes: number[] }[] };
export const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));
export const noteName = (n: number) => n < 0 ? '—' : ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][n % 12] + (Math.floor(n / 12) - 1);
export function secondsAtBeat(beat: number, tempos: Tempo[]) {
  let seconds = 0, previous = 0, bpm = 120;
  for (const t of tempos) { if (t.beat > beat) break; seconds += (t.beat - previous) * 60 / bpm; previous = t.beat; bpm = t.bpm; }
  return seconds + (beat - previous) * 60 / bpm;
}
const text = (s: string) => Array.from(s).map(c => c.charCodeAt(0));
const u32 = (n: number) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
function vlq(n: number) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xfffffff) throw new Error('MIDI event is outside the supported time range.');
  const b = [n & 127]; while ((n >>>= 7) > 0) b.unshift((n & 127) | 128); return b;
}
export function exportMidi(clip: Clip) {
  const events: { tick: number; bytes: number[]; order: number }[] = [];
  const add = (beat: number, bytes: number[], order: number) => events.push({ tick: Math.round(beat * 480), bytes, order });
  for (const t of clip.tempos) { const us = Math.round(60000000 / t.bpm); add(t.beat, [255, 81, 3, us >>> 16 & 255, us >>> 8 & 255, us & 255], 0); }
  for (const n of clip.notes) {
    if (![n.start, n.duration, n.pitch, n.velocity, n.channel].every(Number.isFinite) || n.start < 0 || n.duration <= 0)
      throw new Error('A note contains an invalid value.');
    const channel = clamp(Math.round(n.channel), 0, 15), pitch = clamp(Math.round(n.pitch), 0, 127);
    add(n.start, [0x90 | channel, pitch, clamp(Math.round(n.velocity), 1, 127)], 2);
    add(Math.max(n.start + 1 / 480, n.start + n.duration), [0x80 | channel, pitch, 0], 1);
  }
  for (const e of clip.extra ?? []) add(e.beat, e.bytes, 0);
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = []; let last = 0;
  for (const e of events) { track.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
  track.push(0, 255, 47, 0);
  return new Uint8Array([...text('MThd'), 0, 0, 0, 6, 0, 0, 0, 1, 1, 224, ...text('MTrk'), ...u32(track.length), ...track]);
}
export function importMidi(buffer: ArrayBuffer): Clip {
  if (buffer.byteLength > 8 * 1024 * 1024) throw new Error('Choose a MIDI file smaller than 8 MB.');
  const d = new DataView(buffer); let p = 0, limit = buffer.byteLength, count = 0;
  const need = (n: number) => { if (p + n > limit) throw new Error('The MIDI file is truncated.'); };
  const byte = () => { need(1); return d.getUint8(p++); };
  const short = () => byte() * 256 + byte();
  const long = () => byte() * 16777216 + byte() * 65536 + byte() * 256 + byte();
  const str = () => String.fromCharCode(byte(), byte(), byte(), byte());
  const variable = () => { let n = 0; for (let i = 0; i < 4; i++) { const b = byte(); n = n * 128 + (b & 127); if (!(b & 128)) return n; } throw new Error('Invalid MIDI time value.'); };
  if (str() !== 'MThd') throw new Error('This is not a Standard MIDI File.');
  const headerLength = long(); if (headerLength < 6) throw new Error('Invalid MIDI header.'); need(headerLength);
  const format = short(), tracks = short(), division = short();
  if (format > 1) throw new Error('Use MIDI format 0 or 1; format 2 contains separate songs.');
  if (!division || division & 0x8000) throw new Error('Use a beat-based MIDI file; SMPTE timing is not supported.');
  p += headerLength - 6;
  const notes: Note[] = [], tempos: Tempo[] = [], extra: NonNullable<Clip['extra']> = [];
  for (let track = 0; track < tracks; track++) {
    limit = buffer.byteLength; if (str() !== 'MTrk') throw new Error('Missing MIDI track.');
    const length = long(); need(length); limit = p + length;
    let tick = 0, running = 0;
    const active = new Map<number, { tick: number; velocity: number }[]>();
    while (p < limit) {
      tick += variable(); if (++count > 100000) throw new Error('The MIDI file has too many events.');
      let status = byte();
      if (status < 128) { if (!running) throw new Error('Invalid MIDI running status.'); p--; status = running; }
      if (status === 255) {
        running = 0; const type = byte(), size = variable(); need(size);
        if (type === 81 && size === 3) { const us = d.getUint8(p) * 65536 + d.getUint8(p + 1) * 256 + d.getUint8(p + 2); if (us > 0) tempos.push({ beat: tick / division, bpm: 60000000 / us }); }
        if (type === 88 || type === 89) extra.push({ beat: tick / division, bytes: [255, type, ...vlq(size), ...new Uint8Array(buffer, p, size)] });
        p += size; if (type === 47) { p = limit; break; } continue;
      }
      if (status === 240 || status === 247) { running = 0; const n = variable(); need(n); p += n; continue; }
      if (status < 128 || status >= 240) throw new Error('Unsupported MIDI event.');
      running = status; const kind = status & 240, channel = status & 15;
      const a = byte(), b = kind === 192 || kind === 208 ? undefined : byte();
      if (a > 127 || (b !== undefined && b > 127)) throw new Error('Invalid MIDI data byte.');
      const key = channel * 128 + a;
      if (kind === 144 && b! > 0) {
        const list = active.get(key) ?? []; list.push({ tick, velocity: b! }); active.set(key, list);
      } else if (kind === 128 || kind === 144) {
        const start = active.get(key)?.shift();
        if (start && tick > start.tick) notes.push({ id: `m${notes.length}`, pitch: a, start: start.tick / division, duration: (tick - start.tick) / division, velocity: start.velocity, channel });
      } else extra.push({ beat: tick / division, bytes: b === undefined ? [status, a] : [status, a, b] });
    }
    for (const [key, list] of active) for (const start of list) if (tick > start.tick)
      notes.push({ id: `m${notes.length}`, pitch: key % 128, channel: Math.floor(key / 128), start: start.tick / division, duration: (tick - start.tick) / division, velocity: start.velocity });
  }
  if (notes.length > 10000) throw new Error('Choose a clip with fewer than 10,000 notes.');
  tempos.sort((a, b) => a.beat - b.beat);
  if (!tempos.length || tempos[0].beat > 0) tempos.unshift({ beat: 0, bpm: 120 });
  return { notes: notes.sort((a, b) => a.start - b.start), tempos, extra };
}

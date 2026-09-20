import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMidi, importMidi, secondsAtBeat } from '../lib/midi.ts';
const fixture={notes:[{id:'a',pitch:60,start:0,duration:1,velocity:96,channel:0},{id:'b',pitch:60,start:1,duration:2,velocity:45,channel:0},{id:'c',pitch:64,start:.5,duration:1,velocity:110,channel:1}],tempos:[{beat:0,bpm:120},{beat:2,bpm:90}],extra:[{beat:.5,bytes:[176,11,80]}]};
test('MIDI round-trip preserves notes, channels, timing, velocities and controllers',()=>{const bytes=exportMidi(fixture);const clip=importMidi(bytes.buffer);const clean=(notes)=>notes.map(({id,...n})=>n).sort((a,b)=>a.start-b.start);assert.deepEqual(clean(clip.notes),clean(fixture.notes));assert.equal(clip.tempos.length,2);assert.ok(Math.abs(clip.tempos[1].bpm-90)<.001);assert.deepEqual(clip.extra,fixture.extra);});
test('tempo map controls elapsed time',()=>assert.ok(Math.abs(secondsAtBeat(3,fixture.tempos)-(1+2/3))<1e-8));
test('truncated and malformed MIDI is rejected',()=>{assert.throws(()=>importMidi(new Uint8Array([0,1,2]).buffer));const data=exportMidi(fixture);assert.throws(()=>importMidi(data.slice(0,-3).buffer));});
test('consecutive same-pitch notes remain separate',()=>{const result=importMidi(exportMidi({...fixture,notes:fixture.notes.slice(0,2)}).buffer);assert.equal(result.notes.length,2);assert.equal(result.notes[0].duration,1);assert.equal(result.notes[1].start,1);});
test('zero-velocity note-on is recognized as note-off',()=>{const bytes=exportMidi({notes:fixture.notes.slice(0,1),tempos:fixture.tempos.slice(0,1)});for(let i=0;i<bytes.length-2;i++)if(bytes[i]===128&&bytes[i+1]===60){bytes[i]=144;break;}assert.equal(importMidi(bytes.buffer).notes.length,1);});

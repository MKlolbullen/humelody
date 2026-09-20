import test from 'node:test';
import assert from 'node:assert/strict';
import { PitchTracker } from '../public/audio/tracker.js';
function render(rate,segments,settings={}) {
 const events=[],tracker=new PitchTracker(rate,e=>events.push(e));tracker.configure(settings);let phase=0;
 for(const {seconds,hz,amplitude=.15,vibrato=0} of segments){const data=new Float32Array(Math.round(rate*seconds));for(let i=0;i<data.length;i++){const f=hz*Math.pow(2,vibrato*Math.sin(2*Math.PI*5*i/rate)/12);phase+=2*Math.PI*f/rate;data[i]=hz?amplitude*Math.sin(phase):0;}for(let i=0;i<data.length;i+=128)tracker.process(data.subarray(i,i+128));}tracker.flush();return events;
}
for(const rate of [44100,48000,96000])test(`pitch transition and silence at ${rate} Hz`,()=>{const events=render(rate,[{seconds:.7,hz:220},{seconds:.6,hz:261.625565},{seconds:.7,hz:0}]);assert.deepEqual(events.map(e=>[e.type,e.note]),[['on',57],['off',57],['on',60],['off',60]]);assert.ok(events[0].sample/rate<.15);assert.ok(events[3].sample/rate<1.55);});
test('vibrato remains one held note',()=>{const events=render(48000,[{seconds:2,hz:440,vibrato:.35}]);assert.deepEqual(events.map(e=>e.type),['on','off']);assert.equal(events[0].note,69);});
test('silence and below-gate input do not become notes',()=>{assert.equal(render(48000,[{seconds:1,hz:0},{seconds:1,hz:440,amplitude:.0001}]).length,0);});
test('two attacks at the same pitch become two notes',()=>{const events=render(48000,[{seconds:.5,hz:220},{seconds:.3,hz:0},{seconds:.5,hz:220}]);assert.deepEqual(events.map(e=>[e.type,e.note]),[['on',57],['off',57],['on',57],['off',57]]);});
test('input loudness changes initial velocity',()=>{const quiet=render(48000,[{seconds:.5,hz:220,amplitude:.015}]);const loud=render(48000,[{seconds:.5,hz:220,amplitude:.25}]);assert.ok(quiet[0].velocity<loud[0].velocity);assert.ok(quiet[0].velocity>=1&&loud[0].velocity<=127);});
test('flush closes the active note once',()=>{const events=[],tracker=new PitchTracker(48000,e=>events.push(e));const data=Float32Array.from({length:24000},(_,i)=>.15*Math.sin(i*2*Math.PI*440/48000));tracker.process(data);tracker.flush();tracker.flush();assert.deepEqual(events.map(e=>e.type),['on','off']);});

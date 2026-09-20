'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Mic, Square, Play, Upload, Download, Undo2, Redo2, Plus, Minus, Trash2, SlidersHorizontal, Music2, Headphones, Circle, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Capture, PreviewSynth, transcribeFile, type Settings, type Frame, type Detection } from '@/lib/audio';
import { clamp, noteName, importMidi, exportMidi, type Clip, type Note } from '@/lib/midi';

const INITIAL: Clip = { notes: [], tempos: [{ beat: 0, bpm: 120 }] };
const DEFAULT: Settings = { gateDb: -45, gainDb: 0, stableMs: 40, releaseMs: 70, minHz: 65, maxHz: 1000, retrigger: true };
const EMPTY_FRAME: Frame = { db: -100, hz: 0, confidence: 0, note: -1, sample: 0, wave: [] };
const clone = (clip: Clip): Clip => JSON.parse(JSON.stringify(clip));
function Choice({ label, value, values, onChange, disabled = false }: { label: string; value: string; values: [string, string][]; onChange: (s: string) => void; disabled?: boolean }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger aria-label={label} className="choice"><SelectValue /></SelectTrigger><SelectContent>{values.map(([v,l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select>;
}
function Range({ label, value, min, max, step = 1, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (n: number) => void }) {
  return <div className="range-control"><div><label>{label}</label><output>{value}{suffix}</output></div><Slider ref={root=>{root?.querySelector('[data-slot="slider-thumb"]')?.setAttribute('aria-label',label);}} aria-label={label} value={[value]} min={min} max={max} step={step} onValueChange={v => onChange(v[0])}/></div>;
}

export default function Home() {
  const [clip, setClip] = useState<Clip>(INITIAL), clipRef = useRef<Clip>(INITIAL);
  const [title, setTitle] = useState('Untitled take'), [selected, select] = useState<string | null>(null);
  const [settings, setSettings] = useState(DEFAULT), [frame, setFrame] = useState(EMPTY_FRAME);
  const [recording, setRecording] = useState(false), [busy, setBusy] = useState(''), [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0), [elapsed, setElapsed] = useState(0), [wave, setWave] = useState<OscillatorType>('triangle');
  const [snap, setSnap] = useState(.25), [zoom, setZoom] = useState(52), [message, setMessage] = useState('');
  const history = useRef<Clip[]>([]), future = useRef<Clip[]>([]), [historyVersion, bumpHistory] = useState(0);
  const capture = useRef<Capture | null>(null), synth = useRef<PreviewSynth | null>(null);
  const captureNotes = useRef<Note[]>([]), openNote = useRef<Note | null>(null), captureBeat = useRef(0), captureBpm = useRef(120);
  const file = useRef<HTMLInputElement>(null), mounted = useRef(true), recordingRef = useRef(false);
  const rollScroll = useRef<HTMLDivElement>(null), velocityScroll = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; note: Note; resize: boolean; begun: boolean } | null>(null);
  const note = clip.notes.find(n => n.id === selected), bpm = clip.tempos[0]?.bpm ?? 120;
  const locked = recording || !!busy || playing;
  const minPitch = Math.max(0, Math.min(48, ...clip.notes.map(n => n.pitch)) - 1);
  const maxPitch = Math.min(127, Math.max(72, ...clip.notes.map(n => n.pitch)) + 1);
  const rows = Array.from({ length: maxPitch - minPitch + 1 }, (_,i) => maxPitch - i);
  const beats = Math.max(16, Math.ceil(Math.max(position, ...clip.notes.map(n => n.start + n.duration), 0) / 4) * 4 + 4);
  const put = useCallback((next: Clip) => { clipRef.current = next; setClip(next); }, []);
  const checkpoint = useCallback(() => { history.current = [...history.current.slice(-39), clone(clipRef.current)]; future.current = []; bumpHistory(n => n + 1); }, []);
  const commit = useCallback((next: Clip) => { checkpoint(); put(next); }, [checkpoint, put]);
  const undo = useCallback(() => { const previous = history.current.pop(); if (previous) { future.current.push(clone(clipRef.current)); put(previous); bumpHistory(n => n + 1); select(null); } }, [put]);
  const redo = useCallback(() => { const next = future.current.pop(); if (next) { history.current.push(clone(clipRef.current)); put(next); bumpHistory(n => n + 1); select(null); } }, [put]);
  const updateNote = useCallback((id: string, patch: Partial<Note>, save = true) => {
    const next = { ...clipRef.current, notes: clipRef.current.notes.map(n => n.id === id ? { ...n, ...patch } : n) };
    if (save) commit(next); else put(next);
  }, [commit, put]);
  const removeNote = useCallback(() => { if (!selected) return; commit({ ...clipRef.current, notes: clipRef.current.notes.filter(n => n.id !== selected) }); select(null); }, [commit, selected]);
  const stopPlay = useCallback(() => { synth.current?.stop(); setPlaying(false); setPosition(0); }, []);
  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return; recordingRef.current = false; setBusy('Finishing take…');
    await capture.current?.stop(); capture.current = null;
    if (openNote.current) { captureNotes.current.push({ ...openNote.current, duration: Math.max(1/480, captureBeat.current - openNote.current.start) }); openNote.current = null; }
    if (!mounted.current) return;
    put({ notes: [...captureNotes.current], tempos: [{ beat: 0, bpm: captureBpm.current }] });
    setRecording(false); setBusy(''); setPosition(0); setFrame(EMPTY_FRAME);
    setMessage(captureNotes.current.length ? `Recorded ${captureNotes.current.length} notes. Select a note to edit it.` : 'No clear notes detected. Try a steady hum, increase input gain, or lower the gate.');
  }, [put]);
  const stopRef = useRef(stopRecording); stopRef.current = stopRecording;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void capture.current?.stop(); synth.current?.stop(); }; }, []);
  useEffect(() => { capture.current?.configure(settings); }, [settings]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (locked || (e.target instanceof HTMLElement && (e.target.closest('input,textarea,select,[role="slider"],[role="combobox"]') || e.target.isContentEditable))) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if(e.shiftKey) redo(); else undo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeNote(); }
      if (selected && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault(); const current = clipRef.current.notes.find(n => n.id === selected); if (!current) return;
        const pitch = e.key === 'ArrowUp' ? clamp(current.pitch + 1,0,127) : e.key === 'ArrowDown' ? clamp(current.pitch - 1,0,127) : current.pitch;
        const start = e.key === 'ArrowLeft' ? Math.max(0,current.start-(snap||.0625)) : e.key === 'ArrowRight' ? current.start+(snap||.0625) : current.start;
        updateNote(selected,{pitch,start});
      }
    }; window.addEventListener('keydown',key); return () => window.removeEventListener('keydown',key);
  }, [locked, selected, snap, undo, redo, updateNote, removeNote]);

  // WebMCP exposes the same visible clip and note-editing action; it never opens the microphone.
  const toolsState = useRef({ locked, updateNote }); toolsState.current = { locked, updateNote };
  useEffect(() => {
    type Tool = { name: string; title: string; description: string; inputSchema: object; annotations: object; execute: (input: unknown) => unknown };
    const context = (document as Document & { modelContext?: { registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return; const lifecycle = new AbortController();
    const register = (tool: Tool) => { try { void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(() => {}); } catch {} };
    register({name:'read_midi_clip',title:'Read MIDI clip',description:'Read the current notes and tempo map in the piano roll.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:()=>clone(clipRef.current)});
    register({name:'edit_midi_note',title:'Edit a MIDI note',description:'Change the pitch and velocity of an existing note in the visible clip.',inputSchema:{type:'object',properties:{id:{type:'string'},pitch:{type:'integer',minimum:0,maximum:127},velocity:{type:'integer',minimum:1,maximum:127}},required:['id','pitch','velocity'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:(input)=>{
      const data=input as {id:string;pitch:number;velocity:number};
      if(!data || typeof data.id!=='string' || !Number.isInteger(data.pitch)||data.pitch<0||data.pitch>127||!Number.isInteger(data.velocity)||data.velocity<1||data.velocity>127)throw new Error('Invalid note values.');
      if(toolsState.current.locked)throw new Error('Stop recording or playback before editing.');
      if(!clipRef.current.notes.some(n=>n.id===data.id))throw new Error('Note not found.');
      toolsState.current.updateNote(data.id,{pitch:data.pitch,velocity:data.velocity});return {...data,updated:true};
    }});
    return () => lifecycle.abort();
  }, []);

  async function record() {
    if (recording) { await stopRecording(); return; }
    stopPlay(); setMessage(''); setBusy('Opening microphone…');
    const session = new Capture(); capture.current = session; captureBpm.current = bpm;
    captureNotes.current = []; openNote.current = null; captureBeat.current = 0;
    const onNote = (event: Detection, rate: number) => {
      const beat = event.sample / rate * captureBpm.current / 60;
      if (event.type === 'on') openNote.current = { id:`r${event.sample}`, pitch:event.note, start:beat, duration:.01, velocity:event.velocity??90, channel:0 };
      else if (openNote.current) { captureNotes.current.push({...openNote.current,duration:Math.max(1/480,beat-openNote.current.start)});openNote.current=null; }
    };
    try {
      await session.start(settings,onNote,(next,rate)=>{
        if (!mounted.current) return;
        const beat=next.sample/rate*captureBpm.current/60;captureBeat.current=beat;setFrame(next);setElapsed(next.sample/rate);setPosition(beat);
        put({notes:[...captureNotes.current,...(openNote.current?[{...openNote.current,duration:Math.max(.01,beat-openNote.current.start)}]:[])],tempos:[{beat:0,bpm:captureBpm.current}]});
        if(next.sample/rate>=600)void stopRef.current();
      },()=>void stopRef.current());
      if (!mounted.current) { await session.stop(); return; }
      checkpoint(); put({notes:[],tempos:[{beat:0,bpm}]});setTitle('Voice take'); select(null); setElapsed(0);setRecording(true);recordingRef.current=true;
    } catch(error) {
      setMessage(error instanceof DOMException && error.name==='NotAllowedError' ? 'Microphone permission was denied. Allow it in your browser, then press Record again.' : error instanceof Error ? error.message : 'Could not open the microphone.');
      capture.current=null;
    } finally { if(mounted.current)setBusy(''); }
  }
  async function play() {
    if(playing){stopPlay();return;}setMessage('');setPlaying(true);synth.current=new PreviewSynth();
    try{await synth.current.play(clip,wave,setPosition,()=>{setPlaying(false);setPosition(0);});}
    catch{setMessage('Could not start audio playback. Try pressing Play again.');setPlaying(false);}
  }
  async function loadFile(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen=event.target.files?.[0];event.target.value='';if(!chosen)return;setMessage('');setBusy('Reading file…');
    try {
      const result=/\.midi?$/i.test(chosen.name) ? importMidi(await chosen.arrayBuffer()) : await transcribeFile(chosen,settings,bpm,p=>setBusy(`Finding notes… ${Math.round(p*100)}%`));
      commit(result);setTitle(chosen.name.replace(/\.[^.]+$/,''));select(null);setPosition(0);
      setMessage(result.notes.length?`Imported ${result.notes.length} notes.`:'No clear notes found. Use a recording with one melody at a time.');
    }catch(error){setMessage(error instanceof Error?error.message:'Could not import this file.');}finally{setBusy('');}
  }
  function download() {
    try{const bytes=exportMidi(clip),url=URL.createObjectURL(new Blob([bytes],{type:'audio/midi'})),a=document.createElement('a');a.href=url;a.download=`${title.replace(/[^a-z0-9_-]/gi,'-')||'humline'}.mid`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('MIDI exported. Import it into your DAW or another instrument.');}
    catch(error){setMessage(error instanceof Error?error.message:'Export failed.');}
  }
  function example() {
    commit({notes:[60,64,67,69,67,64,62,60].map((pitch,i)=>({id:`example${i}`,pitch,start:i*1.5,duration:i===7?2.5:1.2,velocity:[76,91,104,113,101,88,79,84][i],channel:0})),tempos:[{beat:0,bpm:100}]});setTitle('Example · little orbit');setMessage('Example melody loaded. Move a note, change its length, or press Play.');
  }
  function addNote(start=0,pitch=60) {const id=`edit${Date.now()}`;commit({...clipRef.current,notes:[...clipRef.current.notes,{id,pitch,start:Math.max(0,start),duration:1,velocity:96,channel:0}]});select(id);}
  function pointerDown(e:React.PointerEvent<HTMLButtonElement>,n:Note){if(locked)return;e.preventDefault();e.currentTarget.focus();select(n.id);e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:n.id,x:e.clientX,y:e.clientY,note:{...n},resize:(e.target as HTMLElement).dataset.resize==='true',begun:false};}
  function pointerMove(e:React.PointerEvent<HTMLButtonElement>){const d=drag.current;if(!d)return;const quant=(x:number)=>snap?Math.round(x/snap)*snap:x;const dx=(e.clientX-d.x)/zoom;if(!d.begun){if(Math.abs(e.clientX-d.x)+Math.abs(e.clientY-d.y)<3)return;checkpoint();d.begun=true;}
    updateNote(d.id,d.resize?{duration:Math.max(snap||.0625,quant(d.note.duration+dx))}:{start:Math.max(0,quant(d.note.start+dx)),pitch:clamp(d.note.pitch-Math.round((e.clientY-d.y)/22),0,127)},false);}
  const waveform=frame.wave.map((v,i)=>`${i/frame.wave.length*320},${38-clamp(v*140,-34,34)}`).join(' ');
  void historyVersion;
  return <main className="studio">
    <header className="topbar"><a className="brand" href="/" aria-label="Humline home"><AudioLines/><span>humline<span className="brand-dot">.</span></span></a><div className="app-kind">VOICE → MIDI</div><div className="top-right"><span className="local-badge">On-device audio</span><a className="native-link" href="https://humline.victor-ahgren.chatgpt.site/downloads/Humline-Linux-x86_64.zip">Linux VST3 <Download size={14}/></a><a className="native-link" href="https://humline.victor-ahgren.chatgpt.site/downloads/Humline-native-source.zip">Source <ArrowUpRight size={14}/></a></div></header>
    <div className="workspace-heading"><div><div className="eyebrow">YOUR MELODY, IN NOTES</div><h1>{title}</h1></div><div className="file-actions"><Button variant="outline" disabled={locked} onClick={()=>file.current?.click()}><Upload size={16}/>Import</Button><Button className="export-btn" disabled={!clip.notes.length||locked} onClick={download}><Download size={16}/>Export MIDI</Button><input ref={file} type="file" accept=".mid,.midi,.wav,.mp3,.m4a,.ogg,.flac" hidden onChange={loadFile}/></div></div>
    <div className="transport"><div className="transport-main"><Button className={`record-btn ${recording?'recording':''}`} onClick={()=>void record()} disabled={!!busy||playing}>{recording?<Square size={15} fill="currentColor"/>:<Circle size={15} fill="currentColor"/>}{recording?'Stop recording':'Record voice'}</Button><Button className="play-btn" variant="outline" disabled={!clip.notes.length||recording||!!busy} onClick={()=>void play()}>{playing?<Square size={16}/>:<Play size={16} fill="currentColor"/>}<span>{playing?'Stop':'Play'}</span></Button><div className="time-display">{Math.floor((recording?elapsed:position*60/bpm)/60).toString().padStart(2,'0')}<span>:</span>{Math.floor((recording?elapsed:position*60/bpm)%60).toString().padStart(2,'0')}<small>{recording?'RECORDING':playing?'PLAYING':'READY'}</small></div></div><div className="transport-options"><label className="tempo-field"><input aria-label="Tempo in beats per minute" type="number" min={20} max={300} step={1} value={Math.round(bpm*100)/100} disabled={locked} onChange={e=>{const value=Number(e.target.value);if(value>=20&&value<=300)commit({...clip,tempos:clip.tempos.map(t=>({...t,bpm:t.bpm*value/bpm}))});}}/><span>BPM</span></label><div className="transport-separator"/><Headphones size={17} className="muted"/><Choice label="Playback sound" value={wave} values={[[ 'triangle','Soft keys'],['sine','Pure tone'],['sawtooth','Analog lead']]} onChange={v=>setWave(v as OscillatorType)} disabled={locked}/></div></div>
    <div className="workspace">
      <aside className="input-panel"><div className="panel-title"><Mic size={17}/><h2>Voice input</h2><span className={recording?'live-label active':'live-label'}>{recording?'LIVE':'OFF'}</span></div>
        <div className="pitch-display"><span className="detected-note">{noteName(frame.note)}</span><div><strong>{frame.hz?`${frame.hz.toFixed(1)} Hz`:'Waiting for a note'}</strong><span>{frame.hz?`${Math.round(frame.confidence*100)}% pitch confidence`:'Sing or hum one note at a time'}</span></div></div>
        <div className="wave-monitor"><svg viewBox="0 0 320 76" aria-label="Live microphone waveform" role="img"><path d="M0 38H320" stroke="#363e42"/><polyline points={waveform} fill="none" stroke="#c2ed75" strokeWidth="1.5"/></svg><span>INPUT SIGNAL</span><output>{frame.db<=-99?'−∞':frame.db.toFixed(0)} dB</output></div>
        <div className="level-meter" aria-label="Microphone level"><i style={{width:`${clamp((frame.db+72)/66*100,0,100)}%`}}/><b style={{left:`${clamp((settings.gateDb+72)/66*100,0,100)}%`}}/></div>
        <div className="panel-rule"/><div className="section-label"><SlidersHorizontal size={14}/>DETECTION</div>
        <Range label="Input gain" value={settings.gainDb} min={-12} max={24} suffix=" dB" onChange={gainDb=>setSettings({...settings,gainDb})}/>
        <Range label="Noise gate" value={settings.gateDb} min={-72} max={-12} suffix=" dB" onChange={gateDb=>setSettings({...settings,gateDb})}/>
        <Range label="Note stability" value={settings.stableMs} min={10} max={120} step={5} suffix=" ms" onChange={stableMs=>setSettings({...settings,stableMs})}/>
        <Range label="Release time" value={settings.releaseMs} min={20} max={200} step={5} suffix=" ms" onChange={releaseMs=>setSettings({...settings,releaseMs})}/>
        <div className="labeled-choice"><label>Vocal range</label><Choice label="Vocal range" value={String(settings.minHz)} values={[[ '50','Low · 50–500 Hz'],['65','Mid · 65–1,000 Hz'],['100','High · 100–1,800 Hz']]} onChange={v=>setSettings({...settings,minHz:Number(v),maxHz:v==='50'?500:v==='65'?1000:1800})}/></div>
        <div className="switch-row"><label htmlFor="retrigger">Separate repeated notes</label><Switch id="retrigger" checked={settings.retrigger} onCheckedChange={retrigger=>setSettings({...settings,retrigger})}/></div>
        <p className="quiet-note">The microphone runs only while recording. Your audio stays on this device.</p>
      </aside>
      <section className="editor"><div className="editor-toolbar"><div className="panel-title"><Music2 size={17}/><h2>Piano roll</h2><span className="note-count">{clip.notes.length} notes</span></div><div className="editor-tools"><Button size="icon" variant="ghost" aria-label="Undo" disabled={locked||!history.current.length} onClick={undo}><Undo2 size={16}/></Button><Button size="icon" variant="ghost" aria-label="Redo" disabled={locked||!future.current.length} onClick={redo}><Redo2 size={16}/></Button><span className="snap-label">Snap</span><Choice label="Grid snap" value={String(snap)} values={[[ '0','Off'],['0.25','1/16'],['0.5','1/8'],['1','1/4']]} onChange={v=>setSnap(Number(v))}/><Button size="icon" variant="ghost" aria-label="Zoom out" onClick={()=>setZoom(Math.max(24,zoom-8))} disabled={zoom<=24}><Minus size={15}/></Button><Button size="icon" variant="ghost" aria-label="Zoom in" onClick={()=>setZoom(Math.min(100,zoom+8))} disabled={zoom>=100}><Plus size={15}/></Button></div></div>
        <div className="roll-scroll" ref={rollScroll} onScroll={e=>{if(velocityScroll.current)velocityScroll.current.scrollLeft=e.currentTarget.scrollLeft;}}><div className="roll" style={{width:60+beats*zoom,height:32+rows.length*22}}>
          <div className="ruler" style={{width:beats*zoom}}>{Array.from({length:beats},(_,i)=><span key={i} className={i%4===0?'bar-mark':''} style={{left:i*zoom}}>{i%4===0?`${i/4+1}`:'·'}</span>)}</div><div className="ruler-corner">4/4</div>
          <div className="note-grid" style={{left:60,top:32,width:beats*zoom,height:rows.length*22,backgroundSize:`${zoom}px 22px, ${zoom*4}px 100%`}} onDoubleClick={e=>{if(locked||e.target!==e.currentTarget)return;const rect=e.currentTarget.getBoundingClientRect();const at=(e.clientX-rect.left)/zoom;addNote(snap?Math.floor(at/snap)*snap:at,maxPitch-Math.floor((e.clientY-rect.top)/22));}}>
            {rows.map((pitch,i)=><div key={pitch} className={`pitch-row ${[1,3,6,8,10].includes(pitch%12)?'accidental':''}`} style={{top:i*22}}/>)}
            {clip.notes.map(n=><button key={n.id} aria-label={`${noteName(n.pitch)}, beat ${n.start.toFixed(2)}, length ${n.duration.toFixed(2)}, velocity ${n.velocity}`} aria-pressed={selected===n.id} className={`midi-note ${selected===n.id?'selected':''}`} style={{left:n.start*zoom,top:(maxPitch-n.pitch)*22+2,width:Math.max(9,n.duration*zoom-2),opacity:.55+n.velocity/127*.45}} onPointerDown={e=>pointerDown(e,n)} onPointerMove={pointerMove} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onClick={()=>select(n.id)}><span>{noteName(n.pitch)}</span><i data-resize="true" aria-hidden="true"/></button>)}
            {(recording||playing)&&<div className="playhead" style={{left:position*zoom}}/>}
          </div><div className="piano-keys">{rows.map(pitch=><div key={pitch} className={`piano-key ${[1,3,6,8,10].includes(pitch%12)?'black':'white'}`}>{noteName(pitch)}</div>)}</div>
          {!clip.notes.length&&!recording&&<div className="empty-roll"><div className="empty-icon"><AudioLines size={27}/></div><h3>A melody starts with a hum.</h3><p>Record your voice, then shape it here.</p><Button variant="outline" onClick={example} disabled={!!busy}>Try an example <ArrowUpRight size={15}/></Button></div>}
        </div></div>
        <div className="velocity-header"><span>VELOCITY</span><span>Louder voice → stronger note</span></div><div className="velocity-lane" ref={velocityScroll} onScroll={e=>{if(rollScroll.current)rollScroll.current.scrollLeft=e.currentTarget.scrollLeft;}}><div style={{width:60+beats*zoom,height:64,position:'relative'}}>{clip.notes.map(n=><button key={n.id} aria-label={`Select ${noteName(n.pitch)}, velocity ${n.velocity}`} className={`velocity-bar ${selected===n.id?'selected':''}`} style={{left:60+n.start*zoom,height:Math.max(5,n.velocity/127*48),width:Math.max(4,Math.min(14,n.duration*zoom-3))}} onClick={()=>select(n.id)}/>)}</div></div>
        <div className="editor-bottom"><span>Drag to move · drag the right edge to resize</span><Button variant="ghost" size="sm" disabled={locked} onClick={()=>addNote(position)}><Plus size={15}/>Add note</Button></div>
      </section>
    </div>
    <section className="note-inspector"><div className="inspector-label"><span className="section-label">SELECTED NOTE</span><strong>{note?noteName(note.pitch):'No note selected'}</strong></div>{note?<><label>Pitch<input aria-label="Selected note pitch" type="number" value={note.pitch} min={0} max={127} disabled={locked} onChange={e=>updateNote(note.id,{pitch:clamp(Math.round(Number(e.target.value)),0,127)})}/></label><label>Start · beats<input aria-label="Selected note start" type="number" value={Number(note.start.toFixed(3))} min={0} step={snap||.0625} disabled={locked} onChange={e=>updateNote(note.id,{start:clamp(Number(e.target.value),0,100000)})}/></label><label>Length · beats<input aria-label="Selected note length" type="number" value={Number(note.duration.toFixed(3))} min={.01} step={snap||.0625} disabled={locked} onChange={e=>updateNote(note.id,{duration:clamp(Number(e.target.value),.01,10000)})}/></label><div className="velocity-control"><Range label="Velocity" value={note.velocity} min={1} max={127} onChange={velocity=>updateNote(note.id,{velocity})}/></div><Button variant="ghost" size="icon" aria-label="Delete selected note" disabled={locked} onClick={removeNote}><Trash2 size={17}/></Button></>:<p>Select a note to edit its pitch, start, length, and velocity. Arrow keys move it; Delete removes it.</p>}</section>
    <footer className="footer"><div className="status-message" role="status" aria-live="polite">{busy||message||'Ready when you are. Record a melody or import an audio / MIDI file.'}</div><span>MONOPHONIC CAPTURE · MIDI 1.0</span></footer>
  </main>;
}

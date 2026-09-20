#include <juce_audio_utils/juce_audio_utils.h>
#include "Tracker.h"
#include <mutex>
#include <vector>
#include <atomic>
#include <climits>

namespace {
struct Note { int pitch=60,velocity=96,channel=1;double start=0,duration=1; };
struct CaptureEvent { int kind=0,pitch=0,velocity=0;double beat=0,bpm=120;unsigned generation=0; }; // begin/on/off/end
struct Scheduled { int sample=0,pitch=60,velocity=0,channel=1;bool on=false; };
struct Playback { std::array<Scheduled,8192> events{};int count=0,lastSample=0; };
constexpr int maximumNotes=4096;
juce::Colour ink(0xffe5ecdf), muted(0xff9facaa), lime(0xffc2ed75), panel(0xff20292d), background(0xff121a1e);

class Processor : public juce::AudioProcessor, private juce::Timer {
public:
  juce::AudioProcessorValueTreeState params;
  std::atomic<bool> requested{false},recording{false},playing{false},overflow{false},monitor{false};
  std::atomic<float> inputDb{-100},frequency{0},confidence{0};std::atomic<int> activePitch{-1};
  std::atomic<double> audioRate{48000},recordBeat{0},clipTempo{120};
  Processor():AudioProcessor(BusesProperties().withInput("Voice input",juce::AudioChannelSet::stereo(),true).withOutput("Synth output",juce::AudioChannelSet::stereo(),true)),
    params(*this,nullptr,"HUMLINE",layout()) { for(auto&s:slots)s.store(0); startTimerHz(30); }
  ~Processor()override{stopTimer();}
  static juce::AudioProcessorValueTreeState::ParameterLayout layout(){
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    auto add=[&](const char*id,const char*name,float lo,float hi,float initial){p.push_back(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID(id,1),name,juce::NormalisableRange<float>(lo,hi),initial));};
    add("gate","Noise gate (dB)",-72,-12,-45);add("gain","Input gain (dB)",-12,24,0);add("stability","Note stability (ms)",10,120,40);add("release","Release time (ms)",20,200,70);add("tempo","Clip tempo",20,300,120);return {p.begin(),p.end()};
  }
  const juce::String getName()const override{return "Humline";}
  bool acceptsMidi()const override{return true;}bool producesMidi()const override{return true;}bool isMidiEffect()const override{return false;}
  double getTailLengthSeconds()const override{return .1;}int getNumPrograms()override{return 1;}int getCurrentProgram()override{return 0;}
  void setCurrentProgram(int)override{}const juce::String getProgramName(int)override{return "Default";}void changeProgramName(int,const juce::String&)override{}
  bool hasEditor()const override{return true;}juce::AudioProcessorEditor*createEditor()override;
  bool isBusesLayoutSupported(const BusesLayout&l)const override{return (l.getMainInputChannelSet()==juce::AudioChannelSet::mono()||l.getMainInputChannelSet()==juce::AudioChannelSet::stereo())&&l.getMainOutputChannelSet()==juce::AudioChannelSet::stereo();}
  void prepareToPlay(double r,int)override{releaseResources();audioRate.store(r);tracker.prepare(r);midiScratch.ensureSize(16384);outputScratch.ensureSize(16384);phase.fill(0);levels.fill(0);gates.fill(0);for(int n=0;n<128;++n)increments[(size_t)n]=440*std::pow(2.,(n-69)/12.)/r;}
  void releaseResources()override{requested.store(false);if(recording.exchange(false)){tracker.flush([&](auto e){push({2,e.note,0,e.sample/audioRate.load()*captureTempo/60,captureTempo});});push({3,0,0,recordBeat.load(),captureTempo});}const int pending=pendingPlayback.exchange(-1);if(pending>=0)slots[(size_t)pending].store(0);stopPlaybackAudio();}
  void startRecording(){stopPlaybackRequest.store(true);overflow.store(false);requested.store(true);}
  void stopRecording(){requested.store(false);}
  std::vector<Note> getNotes(){drain();const std::lock_guard<std::mutex> lock(clipLock);auto copy=notes;if(havePending&&recording){auto n=pendingNote;n.duration=std::max(.01,recordBeat.load()-n.start);copy.push_back(n);}return copy;}
  void checkpoint(){const std::lock_guard<std::mutex> lock(clipLock);if(history.size()>30)history.erase(history.begin());history.push_back(notes);}
  bool isBusy()const{return requested||recording||playing||pendingPlayback.load()>=0;}
  void undo(){if(isBusy())return;drain();const std::lock_guard<std::mutex>lock(clipLock);if(!history.empty()){notes=history.back();history.pop_back();}}
  void setNote(int index,const Note&n){if(isBusy())return;const std::lock_guard<std::mutex>lock(clipLock);if(index>=0&&index<(int)notes.size())notes[(size_t)index]=sanitize(n);}
  void addNote(Note n){if(isBusy())return;checkpoint();const std::lock_guard<std::mutex>lock(clipLock);if(notes.size()<maximumNotes)notes.push_back(sanitize(n));}
  void deleteNote(int index){if(isBusy())return;checkpoint();const std::lock_guard<std::mutex>lock(clipLock);if(index>=0&&index<(int)notes.size())notes.erase(notes.begin()+index);}
  static Note sanitize(Note n){n.pitch=juce::jlimit(0,127,n.pitch);n.velocity=juce::jlimit(1,127,n.velocity);n.channel=juce::jlimit(1,16,n.channel);n.start=std::isfinite(n.start)?juce::jlimit(0.,100000.,n.start):0;n.duration=std::isfinite(n.duration)?juce::jlimit(.01,10000.,n.duration):1;return n;}
  bool startPlayback(){
    if(isBusy())return false;auto copy=getNotes();if(copy.empty())return false;
    for(int i=0;i<3;++i){int free=0;if(!slots[(size_t)i].compare_exchange_strong(free,1))continue;
      auto&data=playback[(size_t)i];data.count=0;data.lastSample=0;const auto factor=audioRate.load()*60/params.getRawParameterValue("tempo")->load();
      for(const auto&n:copy){if(data.count+2>8192)break;const auto begin=juce::jlimit(0.,double(INT_MAX-1),n.start*factor),end=juce::jlimit(begin+1.,double(INT_MAX),(n.start+n.duration)*factor);data.events[(size_t)data.count++]={(int)begin,n.pitch,n.velocity,n.channel,true};data.events[(size_t)data.count++]={(int)end,n.pitch,0,n.channel,false};data.lastSample=std::max(data.lastSample,(int)end);}
      std::sort(data.events.begin(),data.events.begin()+data.count,[](const auto&a,const auto&b){return a.sample<b.sample||(a.sample==b.sample&&!a.on&&b.on);});
      slots[(size_t)i].store(2,std::memory_order_release);const int old=pendingPlayback.exchange(i);if(old>=0)slots[(size_t)old].store(0);return true;
    }return false;
  }
  void stopPlayback(){stopPlaybackRequest.store(true);}
  void processBlock(juce::AudioBuffer<float>&audio,juce::MidiBuffer&midi)override{
    juce::ScopedNoDenormals noDenormals;const int samples=audio.getNumSamples();if(samples<=0)return;
    const auto rate=audioRate.load();midiScratch.clear();midiScratch.addEvents(midi,0,samples,0);outputScratch.clear();
    if(stopPlaybackRequest.exchange(false)){const auto pending=pendingPlayback.exchange(-1);if(pending>=0)slots[(size_t)pending].store(0);stopPlaybackAudio();for(int ch=1;ch<=16;++ch)midiScratch.addEvent(juce::MidiMessage::allNotesOff(ch),0);}
    const int next=pendingPlayback.exchange(-1);if(next>=0){stopPlaybackAudio();activePlayback=next;slots[(size_t)next].store(3);playCursor=playSample=0;playing.store(true);}
    tracker.settings.gateDb=params.getRawParameterValue("gate")->load();tracker.settings.gainDb=params.getRawParameterValue("gain")->load();tracker.settings.stableMs=params.getRawParameterValue("stability")->load();tracker.settings.releaseMs=params.getRawParameterValue("release")->load();
    const auto generation=captureGeneration.load();const bool want=requested.load();
    if(recording.load()&&audioGeneration!=generation){tracker.flush([&](auto e){midiScratch.addEvent(juce::MidiMessage::noteOff(1,e.note),0);});recording.store(false);}
    if(want&&!recording.load()){
      tracker.flush([&](auto e){midiScratch.addEvent(juce::MidiMessage::noteOff(1,e.note),0);});tracker.reset();audioGeneration=generation;captureTempo=params.getRawParameterValue("tempo")->load();recordBeat.store(0);recording.store(true);push({0,0,0,0,captureTempo});
    }else if(!want&&recording.load()){
      tracker.flush([&](auto e){midiScratch.addEvent(juce::MidiMessage::noteOff(1,e.note),0);push({2,e.note,0,e.sample/rate*captureTempo/60,captureTempo});});push({3,0,0,tracker.sample/rate*captureTempo/60,captureTempo});recording.store(false);
    }
    if(recording.load())for(int i=0;i<samples;++i){const float x=audio.getNumChannels()>0?audio.getSample(0,i):0;tracker.process(x,[&](auto e){midiScratch.addEvent(e.on?juce::MidiMessage::noteOn(1,e.note,(juce::uint8)e.velocity):juce::MidiMessage::noteOff(1,e.note),i);push({e.on?1:2,e.note,e.velocity,e.sample/rate*captureTempo/60,captureTempo});});}
    if(recording.load()){recordBeat.store(tracker.sample/rate*captureTempo/60);if(tracker.sample/rate>=600)requested.store(false);}
    inputDb.store(recording?tracker.db:-100);frequency.store(recording?tracker.hz:0);confidence.store(recording?tracker.confidence:0);activePitch.store(recording?tracker.active:-1);
    const bool audition=activePlayback>=0;
    if(activePlayback>=0){auto&data=playback[(size_t)activePlayback];while(playCursor<data.count&&data.events[(size_t)playCursor].sample<playSample+samples){const auto&e=data.events[(size_t)playCursor++];midiScratch.addEvent(e.on?juce::MidiMessage::noteOn(e.channel,e.pitch,(juce::uint8)e.velocity):juce::MidiMessage::noteOff(e.channel,e.pitch),std::max(0,e.sample-playSample));}playSample+=samples;if(playSample>data.lastSample+(int)(rate*.1)){slots[(size_t)activePlayback].store(0);activePlayback=-1;playing.store(false);}}
    audio.clear();int position=0;
    for(const auto metadata:midiScratch){const int end=juce::jlimit(position,samples,metadata.samplePosition);render(audio,position,end,audition||monitor.load());position=end;const auto message=metadata.getMessage();if(message.isNoteOn()){gates[(size_t)message.getNoteNumber()]=message.getFloatVelocity()*.14f;phase[(size_t)message.getNoteNumber()]=0;}else if(message.isNoteOff())gates[(size_t)message.getNoteNumber()]=0;else if(message.isAllNotesOff()||message.isAllSoundOff())gates.fill(0);outputScratch.addEvent(message,metadata.samplePosition);}
    render(audio,position,samples,audition||monitor.load());midi.swapWith(outputScratch);
  }
  juce::String importFile(const juce::File&file){
    if(isBusy())return "Stop before importing.";if(file.getSize()>8*1024*1024)return "MIDI file is too large.";
    juce::FileInputStream input(file);juce::MidiFile midi;if(!input.openedOk()||!midi.readFrom(input))return "Could not read this MIDI file.";
    if(midi.getTimeFormat()<=0)return "Use a beat-based MIDI file.";
    juce::MidiMessageSequence tempos;midi.findAllTempoEvents(tempos);double tempo=120;if(tempos.getNumEvents()>0)tempo=60/tempos.getEventPointer(0)->message.getTempoSecondsPerQuarterNote();tempo=juce::jlimit(20.,300.,tempo);midi.convertTimestampTicksToSeconds();std::vector<Note> imported;
    for(int t=0;t<midi.getNumTracks();++t){auto sequence=*midi.getTrack(t);sequence.updateMatchedPairs();for(int i=0;i<sequence.getNumEvents();++i){const auto*e=sequence.getEventPointer(i);if(e->message.isNoteOn()&&e->noteOffObject){imported.push_back(sanitize({e->message.getNoteNumber(),(int)e->message.getVelocity(),e->message.getChannel(),e->message.getTimeStamp()*tempo/60,(e->noteOffObject->message.getTimeStamp()-e->message.getTimeStamp())*tempo/60}));if(imported.size()>maximumNotes)return "Use a clip with at most 4096 notes.";}}}
    checkpoint();{const std::lock_guard<std::mutex>lock(clipLock);notes=std::move(imported);}setTempo(tempo);return "MIDI imported. Tempo changes are flattened with note timing preserved.";
  }
  juce::String exportFile(const juce::File&file){
    const auto copy=getNotes();if(copy.empty())return "Record or import notes first.";juce::MidiMessageSequence sequence;const auto tempo=params.getRawParameterValue("tempo")->load();sequence.addEvent(juce::MidiMessage::tempoMetaEvent((int)std::lround(60000000/tempo)));
    for(const auto&n:copy){auto on=juce::MidiMessage::noteOn(n.channel,n.pitch,(juce::uint8)n.velocity);on.setTimeStamp(n.start*480);sequence.addEvent(on);auto off=juce::MidiMessage::noteOff(n.channel,n.pitch);off.setTimeStamp((n.start+n.duration)*480);sequence.addEvent(off);}sequence.sort();sequence.updateMatchedPairs();juce::MidiFile midi;midi.setTicksPerQuarterNote(480);midi.addTrack(sequence);juce::MemoryOutputStream bytes;if(!midi.writeTo(bytes,0)||!file.replaceWithData(bytes.getData(),bytes.getDataSize()))return "Could not save the MIDI file.";return "MIDI exported.";
  }
  void getStateInformation(juce::MemoryBlock&dest)override{auto state=params.copyState();juce::ValueTree clip("Clip");for(const auto&n:getNotes()){juce::ValueTree value("Note");value.setProperty("pitch",n.pitch,nullptr);value.setProperty("velocity",n.velocity,nullptr);value.setProperty("channel",n.channel,nullptr);value.setProperty("start",n.start,nullptr);value.setProperty("duration",n.duration,nullptr);clip.addChild(value,-1,nullptr);}state.removeChild(state.getChildWithName("Clip"),nullptr);state.addChild(clip,-1,nullptr);if(auto xml=state.createXml())copyXmlToBinary(*xml,dest);}
  void setStateInformation(const void*data,int size)override{if(auto xml=getXmlFromBinary(data,size)){auto state=juce::ValueTree::fromXml(*xml);if(state.isValid()&&state.hasType("HUMLINE")){requested.store(false);stopPlaybackRequest.store(true);std::vector<Note> restored;for(const auto&n:state.getChildWithName("Clip")){if(restored.size()>=maximumNotes)break;restored.push_back(sanitize({(int)n["pitch"],(int)n["velocity"],(int)n["channel"],(double)n["start"],(double)n["duration"]}));}{const std::lock_guard<std::mutex>lock(clipLock);captureGeneration.fetch_add(1);havePending=false;notes=std::move(restored);history.clear();}params.replaceState(state);}}}
private:
  humline::Tracker tracker;juce::MidiBuffer midiScratch,outputScratch;
  std::mutex clipLock;std::vector<Note>notes;std::vector<std::vector<Note>>history;Note pendingNote;bool havePending=false;
  juce::AbstractFifo fifo{16384};std::array<CaptureEvent,16384>queue{};double captureTempo=120;
  std::array<Playback,3>playback;std::array<std::atomic<int>,3>slots;std::atomic<int>pendingPlayback{-1};std::atomic<bool>stopPlaybackRequest{false};int activePlayback=-1,playCursor=0,playSample=0;
  std::atomic<unsigned>captureGeneration{0};unsigned audioGeneration=0;
  std::array<double,128>phase{},increments{};std::array<float,128>levels{},gates{};
  void setTempo(double tempo){clipTempo.store(tempo);if(auto*p=params.getParameter("tempo"))p->setValueNotifyingHost(p->convertTo0to1((float)tempo));}
  void push(CaptureEvent event){event.generation=audioGeneration;int s1,n1,s2,n2;fifo.prepareToWrite(1,s1,n1,s2,n2);if(n1){queue[(size_t)s1]=event;fifo.finishedWrite(1);}else{overflow.store(true);requested.store(false);}}
  void drain(){const std::lock_guard<std::mutex>lock(clipLock);int s1,n1,s2,n2;fifo.prepareToRead(fifo.getNumReady(),s1,n1,s2,n2);
    auto consume=[&](int start,int n){for(int i=0;i<n;++i){const auto&e=queue[(size_t)(start+i)];if(e.generation!=captureGeneration.load())continue;if(e.kind==0){history.push_back(notes);if(history.size()>30)history.erase(history.begin());notes.clear();havePending=false;clipTempo.store(e.bpm);}else if(e.kind==1){pendingNote={e.pitch,e.velocity,1,e.beat,.01};havePending=true;}else if((e.kind==2||e.kind==3)&&havePending){pendingNote.duration=std::max(.01,e.beat-pendingNote.start);if(notes.size()<maximumNotes)notes.push_back(pendingNote);else{overflow.store(true);requested.store(false);}havePending=false;}}};consume(s1,n1);consume(s2,n2);fifo.finishedRead(n1+n2);
  }
  void timerCallback()override{drain();}
  void stopPlaybackAudio(){if(activePlayback>=0)slots[(size_t)activePlayback].store(0);activePlayback=-1;playing.store(false);gates.fill(0);}
  void render(juce::AudioBuffer<float>&buffer,int start,int end,bool enabled){
    for(int i=start;i<end;++i){float out=0;for(int n=0;n<128;++n){levels[(size_t)n]+=(gates[(size_t)n]-levels[(size_t)n])*(gates[(size_t)n]>levels[(size_t)n]?.025f:.002f);if(levels[(size_t)n]<.00001f)continue;phase[(size_t)n]+=increments[(size_t)n];phase[(size_t)n]-=std::floor(phase[(size_t)n]);out+=std::sin(phase[(size_t)n]*juce::MathConstants<double>::twoPi)*levels[(size_t)n];}out=enabled?std::tanh(out):0;for(int ch=0;ch<buffer.getNumChannels();++ch)buffer.setSample(ch,i,out);}
  }
};

class Roll:public juce::Component {
public:
 Processor&p;int selected=-1;std::function<void(int)>onSelect;
 explicit Roll(Processor&processor):p(processor){setSize(1200,49*18);setWantsKeyboardFocus(true);}
 std::vector<Note>cache;juce::Point<int>origin;Note original;bool resizing=false;
 juce::Rectangle<float>box(const Note&n)const{return {(float)(60+n.start*56),(float)((127-n.pitch)*18+2),(float)std::max(8.,n.duration*56-2),14};}
 void refresh(){cache=p.getNotes();double end=16;for(const auto&n:cache)end=std::max(end,n.start+n.duration+2);setSize((int)(end*56+60),128*18);repaint();}
 void paint(juce::Graphics&g)override{
   g.fillAll(background);for(int pitch=0;pitch<128;++pitch){const auto y=(127-pitch)*18;const bool black=juce::MidiMessage::isMidiNoteBlack(pitch);g.setColour(black?juce::Colour(0xff182126):juce::Colour(0xff212d31));g.fillRect(60,y,getWidth()-60,18);g.setColour(black?juce::Colour(0xff36454a):juce::Colour(0xffbac7be));g.fillRect(0,y,59,17);g.setColour(black?muted:background);g.setFont(11.f);g.drawText(juce::MidiMessage::getMidiNoteName(pitch,true,true,4),2,y,48,17,juce::Justification::centredRight);}
   for(int x=60;x<getWidth();x+=56){g.setColour((x-60)%224==0?juce::Colour(0xff435650):juce::Colour(0xff303f43));g.drawVerticalLine(x,0,(float)getHeight());}
   for(size_t i=0;i<cache.size();++i){const auto&n=cache[i];const auto b=box(n);g.setColour(i==(size_t)selected?juce::Colour(0xffe0ffb4):lime.withAlpha(.55f+n.velocity/127.f*.45f));g.fillRoundedRectangle(b,3);g.setColour(background);g.setFont(11.f);g.drawText(juce::MidiMessage::getMidiNoteName(n.pitch,true,true,4),b.reduced(4,0),juce::Justification::centredLeft);g.setColour(background.withAlpha(.3f));g.fillRect(b.getRight()-6,b.getY()+2,2.f,b.getHeight()-4);}
   if(p.recording){g.setColour(juce::Colour(0xfff18170));g.drawVerticalLine((int)(60+p.recordBeat.load()*56),0,(float)getHeight());}
 }
 void mouseDown(const juce::MouseEvent&e)override{if(p.isBusy())return;selected=-1;for(int i=(int)cache.size()-1;i>=0;--i)if(box(cache[(size_t)i]).contains(e.position)){selected=i;original=cache[(size_t)i];origin=e.getPosition();resizing=e.x>box(original).getRight()-9;p.checkpoint();break;}if(onSelect)onSelect(selected);repaint();}
 void mouseDrag(const juce::MouseEvent&e)override{if(selected<0||p.isBusy())return;auto n=original;const auto dx=(e.x-origin.x)/56.;if(resizing)n.duration=std::max(.25,std::round((original.duration+dx)*4)/4);else{n.start=std::max(0.,std::round((original.start+dx)*4)/4);n.pitch=juce::jlimit(0,127,original.pitch-(int)std::lround((e.y-origin.y)/18.));}p.setNote(selected,n);refresh();if(onSelect)onSelect(selected);}
 void mouseDoubleClick(const juce::MouseEvent&e)override{if(selected>=0||p.isBusy())return;Note n;n.start=std::max(0.,std::floor((e.x-60)/56.*4)/4);n.pitch=juce::jlimit(0,127,127-e.y/18);p.addNote(n);refresh();}
};

class Editor:public juce::AudioProcessorEditor,private juce::Timer {
public:
 Processor&p;Roll roll;juce::Viewport viewport;juce::TextButton record{"Record voice"},play{"Play"},import{"Import MIDI"},exportMidi{"Export MIDI"},undo{"Undo"},remove{"Delete note"};juce::ToggleButton monitor{"Synth monitor (headphones)"};
 juce::Slider gain,gate,stability,release,tempo,pitch,start,length,velocity;juce::Label status;std::unique_ptr<juce::FileChooser>chooser;
 std::vector<std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment>>attachments;
 explicit Editor(Processor&processor):AudioProcessorEditor(processor),p(processor),roll(processor){
   setSize(1000,700);setResizable(true,true);setResizeLimits(820,600,1600,1000);
   for(auto*b:{&record,&play,&import,&exportMidi,&undo,&remove}){addAndMakeVisible(b);b->setColour(juce::TextButton::buttonColourId,panel);b->setColour(juce::TextButton::textColourOffId,ink);}record.setColour(juce::TextButton::buttonColourId,juce::Colour(0xffa54c3f));exportMidi.setColour(juce::TextButton::buttonColourId,juce::Colour(0xff50642f));
   addAndMakeVisible(monitor);monitor.setColour(juce::ToggleButton::textColourId,ink);monitor.onClick=[this]{p.monitor.store(monitor.getToggleState());};
   auto slider=[&](juce::Slider&s,const char*name,double lo,double hi,double step){addAndMakeVisible(s);s.setName(name);s.setRange(lo,hi,step);s.setSliderStyle(juce::Slider::LinearHorizontal);s.setTextBoxStyle(juce::Slider::TextBoxRight,false,70,25);s.setColour(juce::Slider::trackColourId,lime);s.setColour(juce::Slider::thumbColourId,lime);s.setColour(juce::Slider::textBoxTextColourId,ink);s.setColour(juce::Slider::textBoxOutlineColourId,juce::Colours::transparentBlack);};
   slider(gain,"Input gain",-12,24,1);slider(gate,"Noise gate",-72,-12,1);slider(stability,"Note stability",10,120,1);slider(release,"Release time",20,200,1);slider(tempo,"Tempo",20,300,1);slider(pitch,"Note pitch",0,127,1);slider(start,"Start in beats",0,100000,.0625);slider(length,"Length in beats",.01,10000,.0625);slider(velocity,"Velocity",1,127,1);
   for(const auto&entry:std::vector<std::pair<const char*,juce::Slider*>>{{"gain",&gain},{"gate",&gate},{"stability",&stability},{"release",&release},{"tempo",&tempo}})attachments.push_back(std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(p.params,entry.first,*entry.second));
   auto format=[](juce::Slider&s,const char*unit){s.textFromValueFunction=[unit](double v){return juce::String(v,0)+unit;};s.valueFromTextFunction=[](const juce::String&text){return text.getDoubleValue();};s.updateText();};format(gain," dB");format(gate," dB");format(stability," ms");format(release," ms");format(tempo,"");
   viewport.setViewedComponent(&roll,false);addAndMakeVisible(viewport);roll.onSelect=[this](int){showSelection();};
   auto edit=[this]{if(roll.selected<0||roll.selected>=(int)roll.cache.size())return;auto n=roll.cache[(size_t)roll.selected];n.pitch=(int)pitch.getValue();n.start=start.getValue();n.duration=length.getValue();n.velocity=(int)velocity.getValue();p.checkpoint();p.setNote(roll.selected,n);roll.refresh();};pitch.onValueChange=edit;start.onValueChange=edit;length.onValueChange=edit;velocity.onValueChange=edit;
   record.onClick=[this]{if(p.requested)p.stopRecording();else p.startRecording();};play.onClick=[this]{if(p.playing)p.stopPlayback();else if(!p.startPlayback())status.setText("Record or import some notes first.",juce::dontSendNotification);};undo.onClick=[this]{p.undo();roll.refresh();showSelection();};remove.onClick=[this]{p.deleteNote(roll.selected);roll.selected=-1;roll.refresh();showSelection();};
   import.onClick=[this]{choose(false);};exportMidi.onClick=[this]{choose(true);};addAndMakeVisible(status);status.setColour(juce::Label::textColourId,muted);status.setText("Route one microphone signal into this plug-in. Record, edit, then export MIDI.",juce::dontSendNotification);startTimerHz(20);roll.refresh();viewport.setViewPosition(0,990);showSelection();
 }
 void choose(bool save){chooser=std::make_unique<juce::FileChooser>(save?"Export MIDI":"Import MIDI",juce::File::getSpecialLocation(juce::File::userDocumentsDirectory).getChildFile("Humline.mid"),"*.mid;*.midi");auto safe=juce::Component::SafePointer<Editor>(this);chooser->launchAsync(save?juce::FileBrowserComponent::saveMode|juce::FileBrowserComponent::canSelectFiles|juce::FileBrowserComponent::warnAboutOverwriting:juce::FileBrowserComponent::openMode|juce::FileBrowserComponent::canSelectFiles,[safe,save](const auto&dialog){if(!safe)return;const auto file=dialog.getResult();if(file==juce::File{})return;safe->status.setText(save?safe->p.exportFile(file.withFileExtension("mid")):safe->p.importFile(file),juce::dontSendNotification);safe->roll.refresh();safe->showSelection();});}
 void showSelection(){const int i=roll.selected;const bool valid=i>=0&&i<(int)roll.cache.size();for(auto*s:{&pitch,&start,&length,&velocity})s->setEnabled(valid&&!p.isBusy());remove.setEnabled(valid&&!p.isBusy());if(valid){const auto&n=roll.cache[(size_t)i];pitch.setValue(n.pitch,juce::dontSendNotification);start.setValue(n.start,juce::dontSendNotification);length.setValue(n.duration,juce::dontSendNotification);velocity.setValue(n.velocity,juce::dontSendNotification);}}
 void paint(juce::Graphics&g)override{g.fillAll(background);g.setColour(ink);g.setFont(30.f);g.drawText("humline.",24,14,190,42,juce::Justification::centredLeft);g.setColour(muted);g.setFont(13.f);g.drawText("VOICE TO MIDI",205,25,160,24,juce::Justification::centredLeft);g.setColour(lime);g.setFont(23.f);const auto note=p.activePitch.load();g.drawText(note>=0?juce::MidiMessage::getMidiNoteName(note,true,true,4):"--",getWidth()-220,17,90,38,juce::Justification::centredRight);g.setColour(muted);g.setFont(13.f);g.drawText(juce::String(p.frequency.load(),1)+" Hz",getWidth()-120,25,95,24,juce::Justification::centredRight);
   for(auto*s:{&gain,&gate,&stability,&release,&tempo,&pitch,&start,&length,&velocity}){g.setColour(muted);g.setFont(12.f);g.drawText(s->getName(),s->getX(),s->getY()-20,s->getWidth(),19,juce::Justification::centredLeft);}
   g.setColour(muted);g.setFont(12.f);g.drawText("PIANO ROLL  |  drag notes / right edge to edit  |  double-click to add",250,130,getWidth()-270,23,juce::Justification::centredLeft);
 }
 void resized()override{const int w=getWidth(),h=getHeight();record.setBounds(24,76,140,38);play.setBounds(174,76,70,38);undo.setBounds(254,76,70,38);import.setBounds(w-300,76,125,38);exportMidi.setBounds(w-165,76,140,38);gain.setBounds(24,173,200,30);gate.setBounds(24,243,200,30);stability.setBounds(24,313,200,30);release.setBounds(24,383,200,30);tempo.setBounds(24,453,200,30);monitor.setBounds(24,503,220,40);viewport.setBounds(250,155,w-274,h-305);const int field=(w-200)/4;pitch.setBounds(24,h-100,field,30);start.setBounds(34+field,h-100,field,30);length.setBounds(44+2*field,h-100,field,30);velocity.setBounds(54+3*field,h-100,field,30);remove.setBounds(w-130,h-98,105,30);status.setBounds(20,h-45,w-40,30);}
 void timerCallback()override{record.setButtonText(p.requested?"Stop recording":"Record voice");play.setButtonText(p.playing?"Stop":"Play");const bool locked=p.requested||p.recording||p.playing;import.setEnabled(!locked);exportMidi.setEnabled(!locked);undo.setEnabled(!locked);tempo.setEnabled(!locked);play.setEnabled(!p.requested);record.setEnabled(!p.playing);roll.refresh();showSelection();if(p.overflow)status.setText("Recording stopped: note/event capacity reached. Export this take before continuing.",juce::dontSendNotification);else if(p.requested&&!p.recording)status.setText("Waiting for audio from the DAW. Enable track input monitoring.",juce::dontSendNotification);repaint();}
};
juce::AudioProcessorEditor*Processor::createEditor(){return new Editor(*this);}
}
juce::AudioProcessor*JUCE_CALLTYPE createPluginFilter(){return new Processor();}

// Compiles the production processor into this test translation unit so its
// message-thread clip API can be exercised without a DAW or test-only exports.
#include "../native/Plugin.cpp"
#include <iostream>
#include <stdexcept>

void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
struct Harness {
  std::unique_ptr<Processor> p=std::make_unique<Processor>();
  int ons=0,offs=0;double phase=0;std::vector<int> pitches;
  Harness(){p->prepareToPlay(48000,256);}
  ~Harness(){p->releaseResources();}
  void block(double hz=0,bool silentOutput=false){
    juce::AudioBuffer<float> audio(2,256);juce::MidiBuffer midi;
    for(int i=0;i<256;++i){phase+=juce::MathConstants<double>::twoPi*hz/48000;for(int ch=0;ch<2;++ch)audio.setSample(ch,i,hz?(float)(.15*std::sin(phase)):0);}
    p->processBlock(audio,midi);
    for(const auto meta:midi){auto message=meta.getMessage();require(meta.samplePosition>=0&&meta.samplePosition<256,"MIDI offset outside the audio block");if(message.isNoteOn()){++ons;pitches.push_back(message.getNoteNumber());}if(message.isNoteOff())++offs;}
    if(silentOutput)require(audio.getMagnitude(0,0,256)==0,"Microphone audio leaked to the output");
  }
  void tone(double hz,int blocks=100){for(int i=0;i<blocks;++i)block(hz,true);}
};

int main(int argc,char** argv){
 try {
  Harness h;h.p->startRecording();h.tone(220);h.tone(261.625565);h.p->stopRecording();h.block();
  auto notes=h.p->getNotes();require(notes.size()==2,"Capture did not produce two notes");require(notes[0].pitch==57&&notes[1].pitch==60,"Incorrect captured pitch");require(h.ons==2&&h.offs==2,"Unbalanced MIDI note messages");require(notes[0].duration>.5&&notes[1].duration>.5,"Held notes were too short");
  juce::MemoryBlock saved;h.p->getStateInformation(saved);
  h.p->startRecording();h.tone(440); // Events deliberately remain queued.
  h.p->setStateInformation(saved.getData(),(int)saved.getSize());h.block();
  notes=h.p->getNotes();require(notes.size()==2&&notes[0].pitch==57,"Queued capture corrupted restored session");
  h.p->startRecording();h.tone(330);h.p->releaseResources();notes=h.p->getNotes();require(notes.size()==1&&notes[0].pitch==64&&notes[0].duration>.5,"Host suspension lost held note");
  h.p->prepareToPlay(48000,256);h.p->setStateInformation(saved.getData(),(int)saved.getSize());h.block();
  auto edited=h.p->getNotes()[0];edited.velocity=41;edited.channel=3;h.p->setNote(0,edited);
  const auto file=juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("humline-smoke",".mid");
  require(h.p->exportFile(file)=="MIDI exported.","MIDI export failed");Harness imported;auto result=imported.p->importFile(file);file.deleteFile();
  require(result.startsWith("MIDI imported"),"MIDI import failed");auto copy=imported.p->getNotes();require(copy.size()==2&&copy[0].velocity==41&&copy[0].channel==3,"MIDI round trip lost note data");
  require(imported.p->startPlayback(),"Playback did not start");for(int i=0;i<350;++i)imported.block();require(imported.ons==2&&imported.offs==2&&!imported.p->playing,"Playback MIDI was incomplete");
  require(imported.p->startPlayback(),"Second playback did not queue");imported.p->stopPlayback();imported.block();require(!imported.p->playing,"Cancelled playback started anyway");
  if(argc==2){
    juce::ScopedJuceInitialiser_GUI gui;
    std::unique_ptr<juce::AudioProcessorEditor> editor(imported.p->createEditor());
    auto picture=editor->createComponentSnapshot(editor->getLocalBounds());
    juce::FileOutputStream out{juce::File(argv[1])};out.setPosition(0);out.truncate();juce::PNGImageFormat png;
    require(out.openedOk()&&png.writeImageToStream(picture,out),"Could not render native editor");
  }
  std::cout<<"Native processor tests passed: capture, MIDI output, silence, restore, suspend, import/export, playback.\n";
  return 0;
 } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}

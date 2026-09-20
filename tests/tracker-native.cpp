#include "../native/Tracker.h"
#include <vector>
#include <iostream>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
int main(){
 for(double rate:{44100.,48000.,96000.}){
  humline::Tracker t;t.prepare(rate);std::vector<humline::NoteEvent> events;
  auto emit=[&](auto e){events.push_back(e);};double phase=0;
  for(int i=0;i<(int)(rate*2);++i){double time=i/rate;double hz=time<.7?220:time<1.3?261.625565:0;phase+=2*3.141592653589793*hz/rate;t.process(hz?.15f*std::sin(phase):0,emit);}t.flush(emit);
  std::cout<<rate;for(auto&e:events)std::cout<<" "<<(e.on?"on":"off")<<":"<<e.note<<":"<<e.sample;std::cout<<"\n";
  assert(events.size()==4);assert(events[0].note==57&&events[2].note==60);assert(events[0].on&&!events[1].on);assert(events[0].velocity>0&&events[0].velocity<=127);
 }
 humline::Tracker vibrato;vibrato.prepare(48000);std::vector<humline::NoteEvent> events;double phase=0;
 for(int i=0;i<96000;++i){auto hz=440*std::pow(2,.35*std::sin(2*3.14159265*5*i/48000)/12);phase+=2*3.14159265*hz/48000;vibrato.process(.1f*std::sin(phase),[&](auto e){events.push_back(e);});}
 vibrato.flush([&](auto e){events.push_back(e);});assert(events.size()==2&&events[0].note==69);std::cout<<"Native detector tests passed\n";
}

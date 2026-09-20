#pragma once
#include <array>
#include <cmath>
#include <algorithm>
#include <cstdint>

namespace humline {
struct Settings { float gateDb=-45, gainDb=0, minHz=65, maxHz=1000, confidence=.8f, stableMs=40, releaseMs=70, hysteresis=.25f, onsetDb=7; bool retrigger=true; };
struct NoteEvent { bool on; int note, velocity; std::int64_t sample; };
// Allocation-free detector. One instance belongs to one audio-processing thread.
class Tracker {
public:
  Settings settings;
  double rate=48000, analysisRate=12000; float db=-100,hz=0,confidence=0; int active=-1;
  std::int64_t sample=0;
  void prepare(double r) { rate=r; factor=std::max(1,(int)std::lround(r/12000));analysisRate=r/factor;attack=std::exp(-1/(rate*.008));release=std::exp(-1/(rate*.035));reset(); }
  void reset(){window.fill(0);write=fill=hop=decCount=candidateFrames=invalidFrames=0;decSum=power=0;sample=0;active=candidate=-1;lastOn=-1000000000;lastDb=db=-100;hz=confidence=0;}
  template<class Emit> void process(float x,Emit&& emit){
    if(!std::isfinite(x))x=0;x*=std::pow(10.f,settings.gainDb/20);
    const auto p=x*x,c=p>power?attack:release;power=c*power+(1-c)*p;++sample;decSum+=x;
    if(++decCount<factor)return;window[write]=decSum/factor;write=(write+1)%1024;fill=std::min(1024,fill+1);decCount=0;decSum=0;
    if(++hop>=128&&fill==1024){hop=0;analyse(emit);}
  }
  template<class Emit> void flush(Emit&& emit){close(emit);}
private:
  std::array<float,1024>window{},frame{};std::array<float,514>cmnd{};
  int factor=4,write=0,fill=0,hop=0,decCount=0,candidate=-1,candidateFrames=0,invalidFrames=0;
  float decSum=0,power=0,attack=0,release=0,lastDb=-100;std::int64_t lastOn=-1000000000;
  template<class Emit>void close(Emit&& emit){if(active>=0)emit(NoteEvent{false,active,0,sample});active=-1;}
  template<class Emit>void analyse(Emit&& emit){
    const auto&s=settings;db=std::max(-100.f,10*std::log10(power+1e-12f));hz=confidence=0;
    const int minTau=std::max(2,(int)std::floor(analysisRate/s.maxHz)),maxTau=std::min(510,(int)std::ceil(analysisRate/s.minHz));
    if(db>=s.gateDb-4){
      for(int i=0;i<1024;++i)frame[i]=window[(write+i)%1024];double cumulative=0;cmnd[0]=1;
      for(int tau=1;tau<=maxTau;++tau){double d=0;for(int i=0;i<1024-maxTau;++i){const auto delta=frame[i]-frame[i+tau];d+=delta*delta;}cumulative+=d;cmnd[tau]=cumulative>1e-20?float(d*tau/cumulative):1;}
      int best=minTau;bool found=false;
      for(int tau=minTau;tau<=maxTau;++tau)if(cmnd[tau]<1-s.confidence){while(tau<maxTau&&cmnd[tau+1]<cmnd[tau])++tau;best=tau;found=true;break;}
      if(!found)for(int tau=minTau+1;tau<=maxTau;++tau)if(cmnd[tau]<cmnd[best])best=tau;
      double refined=best;if(best>minTau&&best<maxTau){const auto a=cmnd[best-1],b=cmnd[best],c=cmnd[best+1],den=a-2*b+c;if(std::abs(den)>1e-12)refined+=std::clamp(.5*(a-c)/den,-.5,.5);}
      hz=float(analysisRate/refined);confidence=std::max(0.f,1-cmnd[best]);
    }
    const bool valid=db>=s.gateDb-(active>=0?4:0)&&hz>=s.minHz&&hz<=s.maxHz&&confidence>=s.confidence-(active>=0?.05f:0.f);
    const auto onset=db-lastDb;lastDb=db;const double hopMs=128/analysisRate*1000;
    if(!valid){hz=0;candidate=-1;candidateFrames=0;if(++invalidFrames*hopMs>=s.releaseMs)close(emit);return;}
    invalidFrames=0;const double pitch=69+12*std::log2(hz/440);
    const int note=active>=0&&std::abs(pitch-active)<=.5+s.hysteresis?active:std::clamp((int)std::lround(pitch),0,127);
    if(note!=candidate){candidate=note;candidateFrames=1;}else++candidateFrames;
    if(candidateFrames*hopMs<s.stableMs)return;
    const bool reattack=s.retrigger&&onset>=s.onsetDb&&(sample-lastOn)/rate>.12;
    if(note!=active||reattack){close(emit);active=note;lastOn=sample;const auto dynamic=std::clamp((db-s.gateDb)/(-9-s.gateDb),0.f,1.f);emit(NoteEvent{true,note,(int)std::lround(20+107*std::pow(dynamic,.7f)),sample});}
  }
};
}

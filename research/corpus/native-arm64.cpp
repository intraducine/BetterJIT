// SPDX-License-Identifier: GPL-3.0-or-later
// Measurement-only adapter around an unmodified pinned FEX core. It returns
// through the stock spilled thread-stop path instead of modifying link thunks.
#include "state.h"
#include <FEXCore/Config/Config.h>
#include <FEXCore/Core/Context.h>
#include <FEXCore/Core/CoreState.h>
#include <FEXCore/Core/HostFeatures.h>
#include <FEXCore/Core/SignalDelegator.h>
#include <FEXCore/Debug/InternalThreadState.h>
#include <FEXCore/HLE/SyscallHandler.h>
#include <FEXCore/Utils/AllocatorHooks.h>
#include <FEXCore/Utils/LogManager.h>
#include "Interface/Context/Context.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <optional>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>
#if defined(__APPLE__) && defined(__aarch64__)
#include <pthread.h>
#endif

extern "C" { struct rpm_cas_snapshot; int rpm_cas_snapshot_take(struct rpm_cas_snapshot*) { return 0; } }
namespace {
constexpr size_t ArenaBytes=64*1024*1024;
unsigned char* Arena=nullptr;
size_t Used=0,Page=0;
bool Executing=false,ReturnedBlock=false;
unsigned char* Code=nullptr;
unsigned char* Stack=nullptr;
void* JitMap(void* address,size_t size,int protection,int flags,int fd,off_t off) {
  if(!(protection&PROT_EXEC))return ::mmap(address,size,protection,flags,fd,off);
  if(address||fd!=-1||off)return MAP_FAILED;
  const size_t length=(size+Page-1)&~(Page-1);
  if(Used>ArenaBytes||length>ArenaBytes-Used)return MAP_FAILED;
  void* result=Arena+Used;Used+=length;return result;
}
int JitUnmap(void* address,size_t size) {
  const uintptr_t p=reinterpret_cast<uintptr_t>(address),base=reinterpret_cast<uintptr_t>(Arena);
  if(Arena&&p>=base&&p<base+ArenaBytes)return 0;
  return ::munmap(address,size);
}
void* MapAt(uint64_t address) {
  void* p=::mmap(reinterpret_cast<void*>(address),CORPUS_MAP_BYTES,PROT_READ|PROT_WRITE,MAP_ANONYMOUS|MAP_PRIVATE,-1,0);
  if(p==MAP_FAILED||p!=reinterpret_cast<void*>(address)){if(p!=MAP_FAILED)::munmap(p,CORPUS_MAP_BYTES);return nullptr;}return p;
}
class Signals final:public FEXCore::SignalDelegator {};
class Syscalls final:public FEXCore::HLE::SyscallHandler {
public:
  Syscalls(){OSABI=FEXCore::HLE::SyscallOSABI::OS_LINUX64;}
  uint64_t HandleSyscall(FEXCore::Core::CpuStateFrame*,FEXCore::HLE::SyscallArguments*) override {
    fputs("Corpus pilot forbids guest service dispatch\n",stderr);std::_Exit(3);
  }
  void PreCompile() override {
    if(Executing){fputs("Unexpected compilation during protected native execution\n",stderr);std::_Exit(3);}
  }
  FEXCore::HLE::ExecutableRangeInfo QueryGuestExecutableRange(FEXCore::Core::InternalThreadState*,uint64_t address) override {
    return address>=CORPUS_CODE&&address<CORPUS_CODE+CORPUS_MAP_BYTES?FEXCore::HLE::ExecutableRangeInfo{CORPUS_CODE,CORPUS_MAP_BYTES,false}:FEXCore::HLE::ExecutableRangeInfo{0,0,false};
  }
  std::optional<FEXCore::ExecutableFileSectionInfo> LookupExecutableFileSection(FEXCore::Core::InternalThreadState*,uint64_t) override{return std::nullopt;}
};
uint64_t StopAtBlock(FEXCore::Core::CpuStateFrame* frame,FEXCore::Context::ExitFunctionLinkData* record) {
  frame->State.rip=record->GuestRIP;ReturnedBlock=true;
  return frame->Pointers.ThreadStopHandlerSpillSRA;
}
void Message(LogMan::DebugLevels level,const char* text) {
  static unsigned count=0;
  if(level<=LogMan::ERROR&&count++<24)fprintf(stderr,"[corpus-fex] %.400s\n",text);
}
void Assertion(const char* text){fprintf(stderr,"[corpus-fex-assert] %.1000s\n",text);std::abort();}
}
int main(int argc,char** argv) {
#if !defined(__APPLE__) || !defined(__aarch64__)
  (void)argc;(void)argv;puts("{\"status\":\"skip\",\"reason\":\"macOS ARM64 native core profile required\"}");return 77;
#else
  if(argc!=5)return 2;
  const size_t halt=std::strtoull(argv[2],nullptr,0);const unsigned maximum=std::strtoul(argv[3],nullptr,0);const bool multi=std::strcmp(argv[4],"1")==0;
  if((maximum!=1&&maximum!=500)||(maximum==1&&multi))return 2;
  Page=static_cast<size_t>(sysconf(_SC_PAGESIZE));
  Arena=static_cast<unsigned char*>(::mmap(nullptr,ArenaBytes,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS|MAP_JIT,-1,0));
  if(Arena==MAP_FAILED){puts("{\"status\":\"skip\",\"reason\":\"normal process MAP_JIT arena unavailable; no permission or signing fallback\"}");return 77;}
  Code=static_cast<unsigned char*>(MapAt(CORPUS_CODE));Stack=static_cast<unsigned char*>(MapAt(CORPUS_STACK));
  if(!Code||!Stack){puts("{\"status\":\"skip\",\"reason\":\"synthetic guest mapping unavailable\"}");return 77;}
  std::ifstream input(argv[1],std::ios::binary);input.read(reinterpret_cast<char*>(Code),CORPUS_MAP_BYTES);const auto size=input.gcount();
  if(size<=0||input.peek()!=std::ifstream::traits_type::eof()||halt>=static_cast<size_t>(size)||Code[halt]!=0xf4)return 2;
  struct rlimit cpu{4,5};setrlimit(RLIMIT_CPU,&cpu);
  pthread_jit_write_protect_np(0);
  FEXCore::Allocator::mmap=JitMap;FEXCore::Allocator::munmap=JitUnmap;
  LogMan::Throw::InstallHandler(Assertion);LogMan::Msg::InstallHandler(Message);
  FEXCore::Config::Initialize();FEXCore::Config::Load();
  FEXCore::Config::Set(FEXCore::Config::CONFIG_IS64BIT_MODE,"1");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_MULTIBLOCK,multi?"1":"0");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_MAXINST,maximum==1?"1":"500");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_TSOENABLED,"0");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_X87REDUCEDPRECISION,"0");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_ENABLECODECACHINGWIP,"0");
  FEXCore::Config::Set(FEXCore::Config::CONFIG_DISABLETELEMETRY,"1");
  FEXCore::HostFeatures features{};features.DCacheLineSize=64;features.ICacheLineSize=64;
  features.SupportsAtomics=true;features.SupportsRCPC=true;features.SupportsCRC=true;
  for(unsigned core=0;core<16;core++)features.CPUMIDRs.push_back(0x610f0230);
  auto context=FEXCore::Context::Context::CreateNewContext(features);Signals signals;Syscalls syscalls;
  context->SetSignalDelegator(&signals);context->SetSyscallHandler(&syscalls);context->EnableExitOnHLT();if(!context->InitCore())return 1;
  auto* thread=context->CreateThread(CORPUS_CODE,CORPUS_SP);if(!thread)return 1;
  auto* internal=static_cast<FEXCore::Context::ContextImpl*>(context.get());auto* frame=thread->CurrentFrame;auto& state=frame->State;
  FEXCore::Core::CPUState::gdt_segment gdt[32]{};
  state.segment_arrays[0]=gdt;state.segment_arrays[1]=gdt;state.cs_idx=FEXCore::Core::CPUState::DEFAULT_USER_CS<<3;
  auto* segment=FEXCore::Core::CPUState::GetSegmentFromIndex(state,state.cs_idx);FEXCore::Core::CPUState::SetGDTBase(segment,0);FEXCore::Core::CPUState::SetGDTLimit(segment,0xfffff);segment->L=1;segment->D=0;
  state.mxcsr=0x1f80;state.FCW=0x37f;context->SetFlagsFromCompactedEFLAGS(thread,0x202);
  frame->Pointers.ExitFunctionLink=reinterpret_cast<uint64_t>(&StopAtBlock);
  unsigned blocks=0;bool halted=false;
  while(blocks++<10000){
    if(state.rip<CORPUS_CODE||state.rip>=CORPUS_CODE+static_cast<size_t>(size))return 1;
    pthread_jit_write_protect_np(0);if(!internal->CompileBlock(frame,state.rip,maximum))return 1;
    ReturnedBlock=false;Executing=true;pthread_jit_write_protect_np(1);context->ExecuteThread(thread);Executing=false;pthread_jit_write_protect_np(0);
    if(!ReturnedBlock){halted=state.rip==CORPUS_CODE+halt;break;}
  }
  if(!halted)return 1;
  corpus_state result{};result.rip=state.rip;result.rflags=context->ReconstructCompactedEFLAGS(thread,false,nullptr,0);result.mxcsr=state.mxcsr;result.fcw=state.FCW;result.ftw=state.AbridgedFTW;
  for(unsigned r=0;r<16;r++)result.gpr[r]=state.gregs[r];
  __uint128_t xmm[16];context->ReconstructXMMRegisters(thread,xmm,nullptr);memcpy(result.xmm,xmm,sizeof(result.xmm));memcpy(result.mm,state.mm,sizeof(result.mm));
  for(unsigned b=0;b<11;b++)result.fsw|=(state.flags[32+b]&1)<<b;
  result.fsw|=(state.flags[43]&7)<<11;result.fsw|=(state.flags[46]&1)<<14;result.fsw|=(state.flags[47]&1)<<15;
  corpus_print(&result,Code,Stack,"macos-arm64-pinned-FEX-spilled-block-return",blocks);
  context->DestroyThread(thread);context.reset();FEXCore::Config::Shutdown();FEXCore::Allocator::ClearHooks();
  ::munmap(Code,CORPUS_MAP_BYTES);::munmap(Stack,CORPUS_MAP_BYTES);::munmap(Arena,ArenaBytes);pthread_jit_write_protect_np(1);return 0;
#endif
}

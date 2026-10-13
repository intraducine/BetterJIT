// fexserve: the translator (src/translator.h) behind a loopback HTTP server,
// with the routes the app serves on the device, so the page-side client
// (js/fexlive.js, js/linux/) can be exercised on the Mac:
//   fexserve <guest.bin> <base-hex> [port] ["options"]   one image, space 0
//   fexserve --linux [port] ["options"]                   Linux processes: a
//       translator per space (process), made on first use with "linux=1"
//       plus the options
//   GET  /xlat/config /xlat/dispatcher /xlat/state /xlat/stats /xlat/unit?rip=<dec>
//   POST /xlat/region (body: see fexwasm_region)
//   POST /xlat/code?addr=<hex> (body: the bytes)   GET /xlat/uncode?addr=<hex>&size=<hex>
//   GET  /xlat/drop                                 (the process is gone)
// Every route takes &space=<n> (default 0).
#include "translator.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#include <signal.h>
#include <execinfo.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

// Host-only, opt-in evidence for native translator crashes. Reset the handler
// before collecting frames so a diagnostic failure still terminates normally.
static char LastRequest[512];
static volatile sig_atomic_t LastRequestSize;
static void NativeCrash(int Sig) {
  static constexpr char Header[] = "[fexserve] native fatal signal; last request: ";
  write(STDERR_FILENO, Header, sizeof(Header) - 1);
  write(STDERR_FILENO, LastRequest, size_t(LastRequestSize));
  write(STDERR_FILENO, "\n", 1);
  void* Frames[64];
  const int Count = backtrace(Frames, 64);
  backtrace_symbols_fd(Frames, Count, STDERR_FILENO);
  raise(Sig);
}

static std::string ReadFile(const char* Path) {
  std::ifstream F(Path, std::ios::binary);
  std::stringstream S;
  S << F.rdbuf();
  return S.str();
}

static void Reply(int Fd, int Status, const char* Type, const void* Data, size_t Size) {
  char Head[256];
  const int N = snprintf(Head, sizeof(Head), "HTTP/1.1 %d OK\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n", Status,
                         Type, Size);
  std::string Out(Head, size_t(N));
  Out.append(static_cast<const char*>(Data), Size);
  for (size_t Sent = 0; Sent < Out.size();) {
    const ssize_t W = write(Fd, Out.data() + Sent, Out.size() - Sent);
    if (W <= 0) {
      return;
    }
    Sent += size_t(W);
  }
}

// The value of query parameter K in Path ("" if absent).
static std::string Param(const std::string& Path, const char* K) {
  const size_t Q = Path.find('?');
  if (Q == std::string::npos) {
    return "";
  }
  const std::string Key = std::string(K) + "=";
  for (size_t P = Q + 1; P < Path.size();) {
    const size_t E = Path.find('&', P);
    const std::string KV = Path.substr(P, E == std::string::npos ? std::string::npos : E - P);
    if (KV.rfind(Key, 0) == 0) {
      return KV.substr(Key.size());
    }
    if (E == std::string::npos) {
      break;
    }
    P = E + 1;
  }
  return "";
}

extern "C" const char* fexwasm_coverage();

int main(int argc, char** argv) {
  if (getenv("FEXWASM_NATIVE_TRACE")) {
    static char CrashStack[64 * 1024];
    stack_t Stack {}; Stack.ss_sp = CrashStack; Stack.ss_size = sizeof(CrashStack);
    sigaltstack(&Stack, nullptr);
    struct sigaction Action {}; Action.sa_handler = NativeCrash;
    sigemptyset(&Action.sa_mask); Action.sa_flags = SA_RESETHAND | SA_ONSTACK;
    sigaction(SIGSEGV, &Action, nullptr); sigaction(SIGBUS, &Action, nullptr);
  }
  if (argc < 2 || (strcmp(argv[1], "--linux") && argc < 3)) {
    fprintf(stderr, "usage: %s <guest.bin> <base-hex> [port] [\"options\"]\n       %s --linux [port] [\"options\"]\n", argv[0], argv[0]);
    return 1;
  }
  const bool Linux = !strcmp(argv[1], "--linux");
  const int Port = Linux ? (argc > 2 ? atoi(argv[2]) : 47200) : (argc > 3 ? atoi(argv[3]) : 47200);
  const std::string Options = Linux ? std::string("linux=1 ") + (argc > 3 ? argv[3] : "") : (argc > 4 ? argv[4] : "");
  std::map<uint32_t, fexwasm_translator*> Spaces;
  std::map<std::string, double> Dropped; // stats of the spaces dropped
  // Adds a flat JSON object of numbers ({"k":1,...}) into Sum.
  auto AddStats = [](std::map<std::string, double>& Sum, const char* J) {
    for (const char* P = J; (P = strchr(P, '"'));) {
      const char* E = strchr(P + 1, '"');
      if (!E || E[1] != ':') break;
      Sum[std::string(P + 1, E)] += strtod(E + 2, nullptr);
      P = E + 2;
    }
  };
  if (!Linux) {
    const std::string Image = ReadFile(argv[1]);
    fexwasm_translator* T = fexwasm_create(reinterpret_cast<const uint8_t*>(Image.data()), Image.size(), strtoull(argv[2], nullptr, 16),
                                           Options.c_str());
    if (!T) {
      return 1;
    }
    Spaces[0] = T;
  }
  auto Space = [&](const std::string& Path, bool Make) -> fexwasm_translator* {
    const uint32_t Id = uint32_t(strtoul(Param(Path, "space").c_str(), nullptr, 10));
    auto It = Spaces.find(Id);
    if (It != Spaces.end()) {
      return It->second;
    }
    if (!Linux || !Make) {
      return nullptr;
    }
    return Spaces[Id] = fexwasm_create(nullptr, 0, 0, Options.c_str());
  };

  const int L = socket(AF_INET, SOCK_STREAM, 0);
  const int One = 1;
  setsockopt(L, SOL_SOCKET, SO_REUSEADDR, &One, sizeof(One));
  sockaddr_in A {};
  A.sin_family = AF_INET;
  A.sin_port = htons(uint16_t(Port));
  A.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(L, reinterpret_cast<sockaddr*>(&A), sizeof(A)) || listen(L, 64)) {
    perror("bind");
    return 1;
  }
  fprintf(stderr, "fexserve on 127.0.0.1:%d%s\n", Port, Linux ? " (linux)" : "");
  for (;;) {
    const int C = accept(L, nullptr, nullptr);
    if (C < 0) {
      continue;
    }
    setsockopt(C, IPPROTO_TCP, TCP_NODELAY, &One, sizeof(One));
    std::string Buf;
    std::vector<char> Tmp(1 << 20);
    for (;;) {
      const size_t Hdr = Buf.find("\r\n\r\n");
      if (Hdr == std::string::npos) {
        const ssize_t R = read(C, Tmp.data(), Tmp.size());
        if (R <= 0) {
          break;
        }
        Buf.append(Tmp.data(), size_t(R));
        continue;
      }
      const std::string Head = Buf.substr(0, Hdr);
      size_t Len = 0;
      if (const size_t P = Head.find("Content-Length:"); P != std::string::npos) {
        Len = strtoul(Head.c_str() + P + 15, nullptr, 10);
      } else if (const size_t P2 = Head.find("content-length:"); P2 != std::string::npos) {
        Len = strtoul(Head.c_str() + P2 + 15, nullptr, 10);
      }
      while (Buf.size() < Hdr + 4 + Len) {
        const ssize_t R = read(C, Tmp.data(), Tmp.size());
        if (R <= 0) {
          break;
        }
        Buf.append(Tmp.data(), size_t(R));
      }
      const std::string Body = Buf.substr(Hdr + 4, Len);
      Buf.erase(0, Hdr + 4 + Len);
      const size_t Sp1 = Head.find(' '), Sp2 = Head.find(' ', Sp1 + 1);
      const std::string Path = Head.substr(Sp1 + 1, Sp2 - Sp1 - 1);
      const std::string Route = Path.substr(0, Path.find('?'));
      const size_t RequestSize = std::min(Path.size(), sizeof(LastRequest) - 1);
      memcpy(LastRequest, Path.data(), RequestSize); LastRequestSize = sig_atomic_t(RequestSize);
      if (Route == "/xlat/totals") {
        // every space's stats added up, the dropped ones' included
        std::map<std::string, double> Sum = Dropped;
        for (auto& [Id, T] : Spaces) AddStats(Sum, fexwasm_stats_json(T));
        if (getenv("FEXWASM_COVERAGE")) fprintf(stderr, "[fexserve] coverage %s\n", fexwasm_coverage());
        std::string J = "{";
        for (auto& [K, V] : Sum) J += (J.size() > 1 ? ",\"" : "\"") + K + "\":" + std::to_string(V);
        J += "}";
        Reply(C, 200, "application/json", J.data(), J.size());
        break;
      }
      if (Route == "/xlat/drop") {
        const uint32_t Id = uint32_t(strtoul(Param(Path, "space").c_str(), nullptr, 10));
        if (auto It = Spaces.find(Id); It != Spaces.end() && Linux) {
          AddStats(Dropped, fexwasm_stats_json(It->second));
          fexwasm_destroy(It->second);
          Spaces.erase(It);
        }
        Reply(C, 200, "text/plain", "", 0);
        break;
      }
      fexwasm_translator* T = Space(Path, true);
      if (!T) {
        Reply(C, 404, "text/plain", "no such space", 13);
        break;
      }
      fexwasm_bytes B {nullptr, 0};
      if (Route == "/xlat/config") {
        const char* J = fexwasm_config_json(T);
        Reply(C, 200, "application/json", J, strlen(J));
        break;
      } else if (Route == "/xlat/stats") {
        const char* J = fexwasm_stats_json(T);
        Reply(C, 200, "application/json", J, strlen(J));
        break;
      } else if (Route == "/xlat/dispatcher") {
        B = fexwasm_dispatcher(T);
      } else if (Route == "/xlat/state") {
        B = fexwasm_state(T);
      } else if (Route == "/xlat/unit") {
        B = fexwasm_unit(T, uint32_t(strtoul(Param(Path, "rip").c_str(), nullptr, 10)));
      } else if (Route == "/xlat/region") {
        static const bool Log = getenv("FEXWASM_LOGREGIONS");
        if (Log && Body.size() >= 8) {
          uint32_t Entry;
          memcpy(&Entry, Body.data() + 4, 4);
          fprintf(stderr, "region space=%s entry=%#x\n", Param(Path, "space").c_str(), Entry);
        }
        B = fexwasm_region(T, reinterpret_cast<const uint8_t*>(Body.data()), Body.size());
      } else if (Route == "/xlat/code") {
        fexwasm_map_code_abi(T, strtoull(Param(Path, "addr").c_str(), nullptr, 16), reinterpret_cast<const uint8_t*>(Body.data()), Body.size(),
                             uint32_t(strtoul(Param(Path, "abi").c_str(), nullptr, 10)));
      } else if (Route == "/xlat/patch") {
        fexwasm_patch_code(T, strtoull(Param(Path, "addr").c_str(), nullptr, 16), reinterpret_cast<const uint8_t*>(Body.data()), Body.size());
      } else if (Route == "/xlat/uncode") {
        fexwasm_unmap_code(T, strtoull(Param(Path, "addr").c_str(), nullptr, 16), strtoull(Param(Path, "size").c_str(), nullptr, 16));
      } else {
        Reply(C, 404, "text/plain", "not found", 9);
        break;
      }
      Reply(C, 200, "application/octet-stream", B.data, B.size);
      break; // one request per connection: a client's idle keep-alive connection can't block the others
    }
    close(C);
  }
}

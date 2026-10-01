// Local coalescing for the functions the backend emits (see coalesce.h).
#include "coalesce.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <vector>

namespace fexwasm {
namespace {

struct Reader {
  const uint8_t* P;
  const uint8_t* End;
  bool Ok = true;
  uint8_t u8() {
    if (P >= End) {
      Ok = false;
      return 0;
    }
    return *P++;
  }
  uint64_t uleb() {
    uint64_t V = 0;
    for (int S = 0; S < 64; S += 7) {
      const uint8_t B = u8();
      V |= uint64_t(B & 0x7f) << S;
      if (!(B & 0x80)) {
        return V;
      }
    }
    Ok = false;
    return V;
  }
  void sleb() {
    while (u8() & 0x80) {
    }
  }
  void skip(size_t N) {
    if (size_t(End - P) < N) {
      Ok = false;
      P = End;
      return;
    }
    P += N;
  }
  void memarg() {
    uleb();
    uleb();
  }
  void blocktype() {
    const uint8_t B = *P;
    if (B == 0x40 || (B >= 0x7b && B <= 0x7f) || B == 0x70 || B == 0x6f) {
      u8();
    } else {
      sleb();
    }
  }
};

// One local access, in instruction order.
struct Access {
  uint32_t Local;
  bool Write;   // local.set / local.tee
  size_t Pos;   // offset of the index in the body (for rewriting)
  uint8_t Len;  // bytes of the index as encoded
};

struct BB {
  std::vector<Access> Acc;
  std::vector<uint32_t> Succ;
};

struct Ctrl {
  uint8_t Kind;     // 0x02 block, 0x03 loop, 0x04 if
  uint32_t Head;    // loop: the header block
  uint32_t Join;    // the block after end
  uint32_t Cond;    // if: the block the condition ends
  bool HasElse = false;
};

void EncodeU32(std::vector<uint8_t>& Out, uint32_t V, uint32_t MinLen) {
  uint32_t N = 0;
  do {
    uint8_t B = V & 0x7f;
    V >>= 7;
    N++;
    if (V || N < MinLen) {
      B |= 0x80;
    }
    Out.push_back(B);
  } while (V || N < MinLen);
}

} // namespace

bool CoalesceLocals(std::vector<uint8_t>& Body, uint32_t NumParams, std::vector<uint8_t>& Types, CoalesceStats* Stats) {
  const uint32_t N = uint32_t(Types.size()); // the locals after the params
  if (N < 2) {
    return true;
  }
  Reader R {Body.data(), Body.data() + Body.size()};
  std::vector<BB> Blocks(1);
  uint32_t Cur = 0;
  std::vector<Ctrl> Stack;
  auto NewBlock = [&]() {
    Blocks.emplace_back();
    return uint32_t(Blocks.size() - 1);
  };
  auto Edge = [&](uint32_t From, uint32_t To) { Blocks[From].Succ.push_back(To); };
  // the block a branch to label L goes to
  auto Target = [&](uint64_t L) -> uint32_t {
    if (L >= Stack.size()) {
      return UINT32_MAX; // the function body itself: a return
    }
    const Ctrl& C = Stack[Stack.size() - 1 - L];
    return C.Kind == 0x03 ? C.Head : C.Join;
  };
  // Function body = implicit block.
  Stack.push_back({0x02, 0, NewBlock(), 0});
  const uint32_t FuncJoin = Stack.back().Join;
  bool Dead = false; // after an unconditional branch: code up to the next end/else is unreachable

  while (R.Ok && R.P < R.End) {
    const uint8_t Op = R.u8();
    switch (Op) {
    case 0x02: // block
    case 0x03: // loop
    case 0x04: { // if
      R.blocktype();
      Ctrl C {Op, 0, NewBlock(), Cur};
      if (Op == 0x03) {
        C.Head = NewBlock();
        Edge(Cur, C.Head);
        Cur = C.Head;
      } else if (Op == 0x04) {
        const uint32_t Then = NewBlock();
        Edge(Cur, Then);
        Cur = Then;
      } else {
        const uint32_t In = NewBlock();
        Edge(Cur, In);
        Cur = In;
      }
      Stack.push_back(C);
      Dead = false;
      break;
    }
    case 0x05: { // else
      Ctrl& C = Stack.back();
      Edge(Cur, C.Join);
      C.HasElse = true;
      const uint32_t Else = NewBlock();
      Edge(C.Cond, Else);
      Cur = Else;
      Dead = false;
      break;
    }
    case 0x0b: { // end
      Ctrl C = Stack.back();
      Stack.pop_back();
      Edge(Cur, C.Join);
      if (C.Kind == 0x04 && !C.HasElse) {
        Edge(C.Cond, C.Join);
      }
      Cur = C.Join;
      Dead = false;
      if (Stack.empty()) {
        R.P = R.End; // end of the function
      }
      break;
    }
    case 0x0c: { // br
      const uint32_t T = Target(R.uleb());
      if (T != UINT32_MAX) {
        Edge(Cur, T);
      }
      Cur = NewBlock();
      Dead = true;
      break;
    }
    case 0x0d: { // br_if
      const uint32_t T = Target(R.uleb());
      if (T != UINT32_MAX) {
        Edge(Cur, T);
      }
      const uint32_t Next = NewBlock();
      Edge(Cur, Next);
      Cur = Next;
      break;
    }
    case 0x0e: { // br_table
      const uint64_t Count = R.uleb();
      for (uint64_t I = 0; I <= Count && R.Ok; I++) {
        const uint32_t T = Target(R.uleb());
        if (T != UINT32_MAX) {
          Edge(Cur, T);
        }
      }
      Cur = NewBlock();
      Dead = true;
      break;
    }
    case 0x0f: // return
    case 0x00: // unreachable
      Cur = NewBlock();
      Dead = true;
      break;
    case 0x12: // return_call
      R.uleb();
      Cur = NewBlock();
      Dead = true;
      break;
    case 0x13: // return_call_indirect
      R.uleb();
      R.uleb();
      Cur = NewBlock();
      Dead = true;
      break;
    case 0x01:
    case 0x1a:
    case 0x1b:
      break;
    case 0x1c: {
      const uint64_t K = R.uleb();
      R.skip(K);
      break;
    }
    case 0x10:
      R.uleb();
      break;
    case 0x11:
      R.uleb();
      R.uleb();
      break;
    case 0x20:
    case 0x21:
    case 0x22: {
      const size_t Pos = size_t(R.P - Body.data());
      const uint64_t L = R.uleb();
      const uint8_t Len = uint8_t(size_t(R.P - Body.data()) - Pos);
      if (L >= NumParams && L < NumParams + N && !Dead) {
        Blocks[Cur].Acc.push_back({uint32_t(L - NumParams), Op != 0x20, Pos, Len});
      } else if (L >= NumParams && L < NumParams + N) {
        // unreachable code still gets rewritten; keep it out of liveness
        Blocks[Cur].Acc.push_back({uint32_t(L - NumParams), Op != 0x20, Pos, Len});
      }
      break;
    }
    case 0x23:
    case 0x24:
    case 0x25:
    case 0x26:
      R.uleb();
      break;
    case 0x3f:
    case 0x40:
      R.u8();
      break;
    case 0x41:
    case 0x42:
      R.sleb();
      break;
    case 0x43:
      R.skip(4);
      break;
    case 0x44:
      R.skip(8);
      break;
    case 0xd0:
      R.u8();
      break;
    case 0xd1:
      break;
    case 0xd2:
      R.uleb();
      break;
    case 0xfc: {
      const uint64_t Sub = R.uleb();
      if (Sub <= 7) {
      } else if (Sub == 8) {
        R.uleb();
        R.u8();
      } else if (Sub == 9 || Sub == 13 || (Sub >= 15 && Sub <= 17)) {
        R.uleb();
      } else if (Sub == 10) {
        R.u8();
        R.u8();
      } else if (Sub == 11) {
        R.u8();
      } else if (Sub == 12 || Sub == 14) {
        R.uleb();
        R.uleb();
      } else {
        return false;
      }
      break;
    }
    case 0xfd: {
      const uint64_t Sub = R.uleb();
      if (Sub <= 11 || Sub == 92 || Sub == 93) {
        R.memarg();
      } else if (Sub == 12 || Sub == 13) {
        R.skip(16);
      } else if (Sub >= 21 && Sub <= 34) {
        R.u8();
      } else if (Sub >= 84 && Sub <= 91) {
        R.memarg();
        R.u8();
      }
      break;
    }
    case 0xfe: {
      const uint64_t Sub = R.uleb();
      if (Sub == 3) {
        R.u8();
      } else {
        R.memarg();
      }
      break;
    }
    default:
      if (Op >= 0x28 && Op <= 0x3e) {
        R.memarg();
      } else if (Op >= 0x45 && Op <= 0xc4) {
      } else {
        return false; // an opcode this pass doesn't know: leave the function alone
      }
    }
  }
  if (!R.Ok || !Stack.empty()) {
    return false;
  }
  (void)FuncJoin;

  // Liveness, backwards to a fixed point: bitsets of N locals per block.
  const uint32_t W = (N + 63) / 64;
  const size_t NB = Blocks.size();
  std::vector<uint64_t> Gen(NB * W), Kill(NB * W), In(NB * W), Out(NB * W);
  for (size_t B = 0; B < NB; B++) {
    uint64_t* G = &Gen[B * W];
    uint64_t* K = &Kill[B * W];
    for (auto It = Blocks[B].Acc.rbegin(); It != Blocks[B].Acc.rend(); ++It) {
      const uint64_t Bit = 1ull << (It->Local & 63);
      if (It->Write) {
        K[It->Local >> 6] |= Bit;
        G[It->Local >> 6] &= ~Bit;
      } else {
        G[It->Local >> 6] |= Bit;
      }
    }
  }
  for (bool Changed = true; Changed;) {
    Changed = false;
    for (size_t B = NB; B-- > 0;) {
      uint64_t* O = &Out[B * W];
      for (uint32_t S : Blocks[B].Succ) {
        const uint64_t* I = &In[size_t(S) * W];
        for (uint32_t K = 0; K < W; K++) {
          O[K] |= I[K];
        }
      }
      uint64_t* I = &In[B * W];
      const uint64_t* G = &Gen[B * W];
      const uint64_t* Kl = &Kill[B * W];
      for (uint32_t K = 0; K < W; K++) {
        const uint64_t V = G[K] | (O[K] & ~Kl[K]);
        if (V != I[K]) {
          I[K] = V;
          Changed = true;
        }
      }
    }
  }

  // Interference: a local written while another is live can't share with it.
  // Locals live into the function (read before written: they count on being
  // zero) keep their own index.
  std::vector<uint64_t> Inter(size_t(N) * W);
  std::vector<uint64_t> Live(W);
  auto Interfere = [&](uint32_t A, uint32_t Bv) {
    Inter[size_t(A) * W + (Bv >> 6)] |= 1ull << (Bv & 63);
    Inter[size_t(Bv) * W + (A >> 6)] |= 1ull << (A & 63);
  };
  for (size_t B = 0; B < NB; B++) {
    memcpy(Live.data(), &Out[B * W], W * 8);
    for (auto It = Blocks[B].Acc.rbegin(); It != Blocks[B].Acc.rend(); ++It) {
      const uint32_t L = It->Local;
      if (It->Write) {
        for (uint32_t K = 0; K < W; K++) {
          for (uint64_t M = Live[K]; M; M &= M - 1) {
            const uint32_t O = K * 64 + uint32_t(__builtin_ctzll(M));
            if (O != L) {
              Interfere(L, O);
            }
          }
        }
        Live[L >> 6] &= ~(1ull << (L & 63));
      } else {
        Live[L >> 6] |= 1ull << (L & 63);
      }
    }
  }
  const uint64_t* EntryIn = &In[0];

  // Greedy coloring per type, in index order.
  std::vector<int32_t> Color(N, -1);
  std::vector<uint8_t> ColorType;
  std::vector<std::vector<uint32_t>> Members; // color -> locals
  for (uint32_t L = 0; L < N; L++) {
    const bool Pinned = EntryIn[L >> 6] >> (L & 63) & 1;
    int32_t C = -1;
    if (!Pinned) {
      for (uint32_t Cand = 0; Cand < ColorType.size() && C < 0; Cand++) {
        if (ColorType[Cand] != Types[L] || Members[Cand].empty()) {
          continue;
        }
        bool Clash = false;
        for (uint32_t O : Members[Cand]) {
          if ((Inter[size_t(L) * W + (O >> 6)] >> (O & 63) & 1) || (EntryIn[O >> 6] >> (O & 63) & 1)) {
            Clash = true;
            break;
          }
        }
        if (!Clash) {
          C = int32_t(Cand);
        }
      }
    }
    if (C < 0) {
      C = int32_t(ColorType.size());
      ColorType.push_back(Types[L]);
      Members.emplace_back();
    }
    Color[L] = C;
    Members[size_t(C)].push_back(L);
  }
  if (ColorType.size() == N) {
    if (Stats) {
      Stats->Before += N;
      Stats->After += N;
    }
    return true;
  }

  // New locals: colors grouped by type (the locals header wants runs).
  std::vector<uint32_t> NewIndex(ColorType.size());
  std::vector<uint8_t> NewTypes;
  for (uint8_t T : {uint8_t(0x7f), uint8_t(0x7e), uint8_t(0x7d), uint8_t(0x7c), uint8_t(0x7b), uint8_t(0x70), uint8_t(0x6f)}) {
    for (uint32_t C = 0; C < ColorType.size(); C++) {
      if (ColorType[C] == T) {
        NewIndex[C] = NumParams + uint32_t(NewTypes.size());
        NewTypes.push_back(T);
      }
    }
  }
  if (NewTypes.size() != ColorType.size()) {
    return false; // a type this pass doesn't order
  }

  // Rewrite every local index (the encoded length may change).
  std::vector<std::pair<size_t, const Access*>> All;
  for (const auto& B : Blocks) {
    for (const auto& A : B.Acc) {
      All.push_back({A.Pos, &A});
    }
  }
  std::sort(All.begin(), All.end(), [](const auto& A, const auto& B) { return A.first < B.first; });
  std::vector<uint8_t> NewBody;
  NewBody.reserve(Body.size());
  size_t Prev = 0;
  for (const auto& [Pos, A] : All) {
    NewBody.insert(NewBody.end(), Body.begin() + Prev, Body.begin() + Pos);
    EncodeU32(NewBody, NewIndex[size_t(Color[A->Local])], 1);
    Prev = Pos + A->Len;
  }
  NewBody.insert(NewBody.end(), Body.begin() + Prev, Body.end());
  if (Stats) {
    Stats->Before += N;
    Stats->After += uint32_t(NewTypes.size());
  }
  Body = std::move(NewBody);
  Types = std::move(NewTypes);
  return true;
}

} // namespace fexwasm

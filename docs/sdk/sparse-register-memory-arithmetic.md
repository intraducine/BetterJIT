# Checked register-destination memory-source ADD/SUB

Coverage 23 admits `ADD r32,r/m32`, `ADD r64,r/m64`, `SUB r32,r/m32` and
`SUB r64,r/m64` with a memory source. ADD keeps operation 15; SUB uses operation
18. Memory/checkpoint/step ABIs remain 1/1/4, the header remains 96 bytes, and
each instruction uses exactly one existing READ RPC. This is shared SDK coverage
for any consumer using the sparse execution path.

Raw admission and JS parsing independently bind the selected destination and
complete ModRM/SIB/displacement encoding to one FEX-decoded instruction. Both
widths support the existing 64-bit base/index/scale, signed displacement and
RIP-relative grammar. A 32-bit result clears the destination's upper half.
Destination/base/index aliasing uses the owned old register values. Reads need
only read permission and do not write guest memory, detach COW pages or allocate
guest backing. Register-direct arithmetic keeps its earlier profile.

LOCK, REP, segment, operand/address-size and repeated REX prefixes remain refused.
Byte/16-bit operands, memory-destination SUB, ADC/SBB and other memory arithmetic
are outside this family. The existing no-base SIB with REX.B exclusion remains:
the pinned FEX frontend retains R13 for an encoding which should ignore the base.
No frontend/vendor change is included.

The complete ordered native IR proof links one checked load to the old selected
destination, one width-matched arithmetic producer, exact AF/PF dataflow, one
full destination store and constant fallthrough. ADD additionally proves its
NZCV carry-inversion sequence. SUB already has FEX's no-borrow carry convention
and must contain no ADD carry fixup. Unknown or additional memory, register,
context, syscall and control effects are rejected before emission.

FINISH now validates final flag semantics for **both** ADD and SUB. Expected
CF/PF/AF/ZF/SF/OF come independently from the owned old destination and
authenticated read. The actual descriptor is canonicalized using the exact
production materializer semantics and all six defined bits are compared. The
only accepted kinds are materialized 0 or the matching lazy kind: ADD32/64
19/20, SUB32/64 1/2. FA/FB must equal the width-masked owned operands even for
materialized output. Materialized NZCV must equal the exact canonical word;
lazy NZCV must preserve its original word. Unknown, wrong-width and wrong-family
kinds fail. Valid equivalent materialized/lazy representations are accepted
without rewriting the spill. All unrelated CPU/GPR bytes, lazy padding and
rounding bytes remain unchanged. Invalid successful post-state poisons the
registration; it does not become successful arithmetic or a typed memory fault.

The production arithmetic materializer has a differential test against the
source-digest-bound C++ `MaterializeFlags`, mandatory in repository CI. That
repository-only test is outside the exported SDK test glob; an allowlist-only
SDK copy runs all exported Node tests without the unshipped backend source.
The expected flag calculation uses
signed overflow bounds and nibble carry/borrow independently of that port.
Native x86 oracles and subsequent actual FEX/Wasm SETcc, Jcc and syscall flag
consumers check architectural flags. Copied actual FEX IR mutations check the
proof, including operation substitution, ordering and extra effects. Broker
tests cover NZCV/FK/FA/FB corruption, equivalent representations and exact byte
preservation. Cross-page faults and typed refusals restore the full checkpoint,
leave RIP at the faulting instruction and preserve guest bytes, aliases, frames
and backing accounting. Fault regressions compare every still-mapped initialized
page against its post-setup byte/frame/permission baseline and check exact fault
addresses. Deliberately unmapped pages are checked for continued absence, not
for inaccessible byte contents. Injected byte, frame and fault-address drift
must be detected by these assertions. Each operation's 9,504 attempted arithmetic
steps consist of 9,480 golden executions, 14 successful edges and 10 typed faults;
9,494 are successful arithmetic executions.

The dynamic ELF/interpreter fixture executes self-checking ADD/SUB in both
widths, including old-address aliasing, writes `arithmetic-ok\n` and exits zero
through the production kernel and worker with writable or read-only source
pages. A protected-source variant checks complete checkpoint rollback. These
are deterministic host SDK fixtures, not a completed Wine command or device run.

The last independently read Wine receipt remains run 38963048133 at production
head `9694b4e202efaa044ffd0c927ceed2040ae6e2ec`: 3,502 executed Wasm steps,
516 compiled units, then unsupported `2b4604` (`SUB EAX,[RSI+4]`) at
`0x7f000003680c`, guest exit null. A reviewed commit's unchanged-input automatic
probe must establish the next real boundary. This document does not predeclare
that result. Earlier phone fork/exec/cat receipts and dense Wine memory-limit
evidence remain unchanged.

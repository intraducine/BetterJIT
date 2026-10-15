# Experimental prepared copyout

Prepared copyout extends the authenticated spilled user-memory capability with
`prepareCopyOut(address, length)`. It validates every destination page and
preallocates all private-view detachments before returning a fixed ordinary
Uint8Array named `bytes`. The broker retains the existing 65536-byte transfer
limit and full BigInt pointers. This is a prerequisite for future input handlers;
it does not enable read/write syscalls, ELF loading or guest fork/clone/exec.

The returned frozen handle offers `validate()`, `commit(count = length)` and
`cancel()`. Commit publishes exactly the selected prefix, releases untouched
staged pages, and makes the handle unusable. A zero-byte commit changes no
mapping or guest byte. Cancellation is idempotent. A valid commit allocates no
guest frames, buffers or views and invokes no callbacks. Failures during
preparation leave the original bytes and mapping identities unchanged.

Only one prepared write may own an address space. Mapping changes, writes,
atomics, fork and further prepared writes are refused until commit or cancel;
ordinary reads remain available. Writes through another address space's
canonical shared alias invalidate the handle using an opaque per-frame content
revision. Commit then cancels staging and refuses to overwrite the newer bytes.
This check is deliberately conservative, including changes to other bytes in
the same frame. Closing the address space cancels its staged frames.

The broker also holds the original spilled syscall owner. BEGIN, other user
copies, futex parking/waking and syscall completion cannot advance that owner
with an outstanding transaction. Kernel handles recheck the exact thread,
token, slot, occupied lease, broker, memory-owner object and address space on
each validation or commit. Retirement cancels staging before slot reuse;
replacement of the memory owner invalidates the handle even if it refers to
the same guest address space. Invalid broker/kernel use cancels the transaction.

A future synchronous input handler must prepare, validate immediately before
acquiring bytes, fill the staging buffer, and commit the returned byte count.
There must be no await, reentrant callback, mapping change or other authority
operation between validation, acquisition and commit. Blocked I/O must cancel
and retry from preparation after waking. The transaction does not roll back an
external input source, so these ordering requirements are part of the contract.
Partial Linux I/O/error rules and actual descriptor handlers are still pending.

Existing guest stores and atomics use the same storage preparation path. The
real FEX/Wasm synchronization fixture checks 51 successful preparations and
commits totaling 408 bytes: 48 fetch-add operations, two compare/exchanges
(including failed comparison write intent), and one private store. It retains
the 172-step, nine-futex-call, three-host-created-process/four-worker checks.
Those process records are fixtures, not evidence of guest process creation.
Synthetic storage/broker/kernel tests separately cover allocation rollback,
short prefixes, cancellation, alias invalidation, detached buffers, stale owners
and worker retirement.

Staged guest frames count toward the existing backing budget and peak. The
temporary Uint8Array uses the host JavaScript heap and is not included in guest
payload counters, as with copied read results. These counters do not establish
resident RAM savings. Native memory/checkpoint/step/coverage ABIs remain 1/1/2/2;
no native import, instruction family or default-runtime policy changes. Host
evidence establishes no sparse WebKit lifecycle or device compatibility.

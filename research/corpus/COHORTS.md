# Reviewed external cohorts

The frozen fourteen-fixture pilot and its assertions remain unchanged. The new
runner accepts an external source/byte/state/profile-bound admission. The explicit
127-source review list is broader than a smoke batch; no directory scan admits or
executes code. `reviewed-admissions.json` is empty, so new guest execution is
disabled until independent review approves the exact admission SHA256.

`review_admission.py` performs bounded assembly, complete decoding and fail-closed
constant/definedness analysis. It is source review, not guest execution. The audit
supports the reviewed register-only forms, rejects undefined predicates and target
escapes, and binds every byte, including raw DB prefixes/XADD. The resulting
`register-admission.json` preserves original RegData and supplies semantic GPR and
flag masks. Thirty-three candidates normalize only undefined RAX bit 12; raw
expectations and observations remain in results. Two DIV/IDIV proofs record
dividend, nonzero divisor, fitting quotient and remainder. All 22 control-flow
cases have decoded CFG and dynamic-work evidence.

`LoopAddressSizeCheck` has a 131,081-instruction constant path. Oracle admission
retains its wall/CPU limits. Single-step and Wasm exceed the unchanged 10,000-block
bound; larger native profiles are conservatively excluded because this review has
not proved a tighter bound. The other 126 candidates have bounds at most 137.

`cohort_schedule.py` selects the largest fitting prefix, at most 512 new fixtures,
and packs oracle/execution shards at most 64/48 fixtures with byte accounting and
hash-bound continuation. The present proposal fits two oracle and three execution
shards. Bounds may reduce cardinality. Linear memory and JIT arena limits are not
process RSS limits. The 64 MiB runtime asset cap applies to the unique transferred
asset set once, not cumulative traffic across workers.

The workflow keeps the baseline named separately, compiles the reference adapter
once, restores/verifies the existing native and translator assets once, and shares
their producer receipts and exact runtime bytes. New workers verify those bytes
and recipes. Cold host builds use a separate current-workflow receipt and never
impersonate the production-cache sealer. Native recipe inputs and production pins
are unchanged. The only future activation is a reviewed exact admission hash;
there is one automatic workflow, with no duplicate dispatch.

`measure_cohort.py` reserves every layer's complete skeleton before execution,
retains raw output digests/prefix bytes and rawOutcome/failureKind, and does not
turn timeout, nonzero exit, refusal or malformed output into pass. It never begins
a fixture without a reserved result slot. Per-fixture input/reference failures
leave that fixture untested; structural reference corruption isolates its shard.
Aggregation verifies file hashes, order, all source/run/profile bindings and
recomputes successful comparisons. Missing, duplicate and stale results fail
integrity while retaining complete conservative whole-corpus outcome indexes.
These consistency checks are not execution attestation for arbitrary supplied files.

Only host integrity tests and bounded assembly/decode were performed to prepare
this proposal. No new guest execution, build dispatch, commit or push occurred.
The six native recipe inputs, baseline assertions, production code and FEX pins
are frozen. Review the exact patch and manifest before activating execution.

See [PLAYABLE-PATH.txt](PLAYABLE-PATH.txt) and `playable-path.json` for the actual
product gaps. Corpus counts are neither release percentages nor a playable IPA.
The demonstrated next Wine stop is memory-source SUB, which this register-only
cohort does not implement. BetterJIT remains an application-independent SDK;
Madeira/Wine, PPSSPP and MeloNX each require their own integration evidence.

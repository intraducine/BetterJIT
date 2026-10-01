# Experimental mapped data transport

BetterJITWebKit keeps its existing versioned RPC/message channel as the control plane. An opt-in mapped data lane can move large canonical Base64 service payloads through one OPFS file that native code opens and maps with `MAP_SHARED`.

This is an optimization, not a different execution model and not Wasm linear-memory sharing. WebKit still owns the worker and Wasm memory. Commands, request IDs, errors, cancellation and small payloads continue over the existing RPC channel.

## Negotiation

`WebKitTransport` accepts `MappedTransportPreference.disabled`, `.preferred`, or `.required`.

1. The dedicated worker creates a bounded OPFS file and writes a session marker.
2. `configure` returns only a candidate description: protocol version, file/slot sizes and threshold.
3. Native discovers an existing backing file only inside app-owned Library/Application Support/Caches/tmp roots, opens it with `O_NOFOLLOW`, verifies regular-file/link/size constraints and the per-session marker, then maps the fixed file read/write without executable permissions.
4. Native sends `mapped.confirm`. The worker does not send mapped service payloads before this confirmation.
5. Only after both sides agree does `RuntimeCapabilities.extensions` gain `mappedTransport`.

Preferred mode falls back to copied service messages if any setup step fails. Required mode fails startup instead. The default is disabled, so existing consumers retain their previous storage and transport behavior.

Mapped sessions use `WKWebsiteDataStore.default()` because the tested iOS build did not create the synchronous OPFS lane in an ephemeral data store, while the existing OPFS/native-mmap probe succeeds with the default store. This storage change is opt-in: sessions with mapped transport disabled retain `WKWebsiteDataStore.nonPersistent()`. The per-session mapped file is removed on lane teardown, although normal WebKit origin metadata may persist.

## Slot protocol

The worker exclusively allocates four fixed slots in one pre-sized file. Each lease carries:

- the session token,
- slot index,
- fixed offset and capacity,
- a monotonically increasing per-slot generation,
- payload length and FNV-1a checksum when bytes are present.

Native rejects arbitrary offsets, capacities, tokens and generations. It derives the only accepted offset from the slot index. The file is never resized after native mapping and is never mapped executable.

The compatibility JSON service path still supports canonical Base64 values and checksummed mapped descriptors.

For high-volume services, `NativeBinaryService` carries one typed byte leaf separately from its structured JSON metadata. In mapped mode, payloads of at least 64 KiB go through the leased OPFS slot with fixed token/slot/offset/generation ownership and no Base64 conversion. Smaller values stay copied because device measurements showed that mapping tiny payloads costs more than the control-plane copy. Native binary replies use the same rule.

The binary fast path deliberately omits the per-payload FNV pass: exclusive lease ownership, generation validation, fixed offsets and bounded lengths provide the transport contract, while the compatibility lane and dedicated integrity tests continue to exercise checksummed transfers. This avoids hashing the same multi-megabyte buffer in JavaScript and Swift on every boundary crossing.

If all slots are busy, that service call uses the existing copied path. Mapped transport is therefore an optimization rather than a correctness dependency unless `.required` was chosen for a test.

## Current limits

- 4 slots, each slightly larger than 16 MiB; the file is roughly 64 MiB and may be sparse.
- 4 KiB raw-payload threshold.
- At most one large Base64 value in a service request is mapped in v1. Other values remain copied.
- Only top-level canonical Base64 service responses are mapped in v1.
- The data lane does not page guest RAM, bypass WebContent memory limits, share Wasm linear memory, or provide lock-free cross-process atomics.
- Native mapping/discovery depends on WebKit's current OPFS backing-file layout and is explicitly capability-negotiated/failable.

`mappedTransportStatistics` reports native bytes read/written and service calls that actually used mapped bytes. A host should report these together with the active/fallback state rather than inferring mapped use from OPFS availability alone.

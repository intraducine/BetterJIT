# Device-interface address experiment — 0.2.0 (3)

## Scope

This is still a COOKIE transport probe, not a VPN or JIT enabler. It tests whether
using an address assigned to the interface selected by Apple's native IKEv2
client avoids the observed localhost send failure. It does **not** force the
native client to choose a particular interface. A passing Wi-Fi control is not
offline or cellular success. Do not start implementing ESP/JIT based on it alone.

The preceding device Console trace showed `required interface: en0(20)` with a
loopback route (`interface: lo0`), followed by `sendmsg` error 49 and zero outgoing
packets. The app independently passed a UDP/500 nonce echo and recorded no native
IKE datagrams. Raw device logs are intentionally not committed: they contain
unrelated personal/device information.

## What changed

- Discover assigned IPv4 and IPv6 addresses with `getifaddrs`; show interface name,
  index, address and exclusions. Interface name hints are not authoritative path
  selection. The UI separately shows default-path interface candidates.
- Listen only on the explicitly selected local unicast address, not wildcard.
  IPv6 listeners are IPv6-only. No port reuse, route manipulation, Network
  Extension, Personal VPN entitlement or native-interface override is requested.
- Reject unassigned/down/stale targets before binding and profile generation.
  Recheck assignment before responding and on two-second heartbeats. Stop if it
  changes; never substitute a different target behind an installed profile.
- Allow incoming peers only from the selected address or same-family loopback.
  Reject other source addresses after logging metadata. Address matching is NOT
  authenticated peer identity and does not prevent IP spoofing. No remote daemon
  or general-purpose VPN service is exposed. Replies/parsing are limited to the
  first 128 non-self-test datagrams of a run. Packet counters remain independent
  of the 512-entry UI log.
- Separate identity/name for the new profile: **BetterJIT Interface (name IP)**.
  It can coexist with the old Loopback Probe profile. New interface profiles use
  a stable identity so installing another replaces that experiment configuration.
  Numeric IPv6 addresses are profile values, not bracketed URLs. Link-local IPv6
  zone IDs and auxiliary/tunnel interfaces are explicitly excluded for now.
- Include both prior diagnostics and the UDP/4500 four-zero Non-ESP Marker fix.
  Framing follows the encapsulated-listener flag, even with ephemeral test ports.
  Exact random nonce/source matching isolates health traffic from CookieProbe.
- Report schema 3 includes selected target, address inventory at start, start/current
  path observations, host process/bundle, explicit experiment/framing revision,
  user-reported profile and VPN status, run lifetime, counters and stop reason.
  It does not infer signing identity, native peer identity, installed-profile
  correctness, radio switches or actual native VPN path from those observations.
- A user must confirm installing the matching generated profile before starting.
  Confirmation is user-reported; the app cannot inspect manual system profiles.

## Wi-Fi control

1. Sign/install the new IPA and launch without Xcode attached. Prefer a standalone
   free-signed install for the final provisioning claim. LiveContainer runs must
   be described as hosted; the report includes host process information.
2. Leave Wi-Fi on. Select `en0` with its assigned IPv4 address (not `127.0.0.1`) and
   select the Wi-Fi control condition. Verify the displayed path candidates.
3. Install the matching profile through Safari/Settings, return, and check the
   installation-confirmation toggle. Use **BetterJIT Interface**, not the old
   localhost VPN. Reinstall whenever the selected IP changes.
4. Start the probe; note both local socket tests. Open Settings > General > VPN &
   Device Management > VPN and connect the matching entry. Return promptly after
   the attempt: iOS grants finite background time, not a guaranteed 60 seconds.
5. Record Settings status, stop/finalize and export the JSON. Stream Console for
   the attempt, especially NEIKEv2Provider's local/remote addresses, required
   interface, send result and packet counters. Do not equate socket `ready` with
   successful packet transmission.
6. Remove the test profile after finishing. On a trusted network only: although
   the app rejects unrelated source IPs, a non-loopback listener is network-facing.

## Cellular-only control

Turn Wi-Fi off in Settings and leave cellular data on. Refresh addresses. Select
an assigned `pdp_ip` unicast address consistent with the path observation, then
generate/install its own matching profile and repeat. Do not assume `pdp_ip0` is
always the active data interface; other cellular services may have their own
interfaces. IPv6-only cellular candidates are supported when they have a usable
unicast address. If no eligible data-interface address is available, record that
limitation rather than using a fabricated address. This run is no-Wi-Fi, **not**
fully offline. The app does not activate radios, choose a carrier interface for
the native provider, or create absent interface addresses.

## Interpretation

- Both self-tests pass: the app's own local UDP path works; not native IKE proof.
- `datagramReceived`: something reached the listener; origin is not authenticated.
- `cookieChallenge` plus `replySent`: initial request parsed and reply submitted;
  not proof the native client received it.
- `cookieRoundTrip`: unchanged request echoed the challenge; still no IKE_AUTH,
  Child SA, packet reflection, debugger service, or JIT.
- Native error 49 disappears but no cookie: inspect new native errors/demultiplexing;
  don't count it as a successful exchange.
- `bindFailed`: exact-address bind failed. Never enable port reuse silently.
- `targetAddressLost`: network/address changed; regenerate the profile before rerun.
- `backgroundExpired`: observation ended; use the time-correlated native trace.

Known unresolved gates include native interface scoping, same-address/port socket
selection, ESP interception at UDP/4500, fully-offline startup, helper lifetime,
and all developer-service/JIT integration. This revision fixes none by assertion.

## References

- Apple profile schema: https://developer.apple.com/documentation/devicemanagement/vpn/ikev2-data.dictionary
- Apple interface metadata: https://developer.apple.com/documentation/network/nwinterface/type
- UDP encapsulation framing: https://www.rfc-editor.org/rfc/rfc3948#section-2.2
- IKEv2 COOKIE exchange: https://www.rfc-editor.org/rfc/rfc7296#section-2.6

## Validation

The added tests exercise assignment validation, peer rejection, marker framing,
profiles and actual IPv4/IPv6 sockets. The independent Python script performs
synthetic IKE cookie exchanges on loopback and an assigned non-loopback address.
These are host tests; they do not reproduce Apple's native iOS VPN behavior.
The macOS CI also runs the original tests and original wire test, then builds an
unsigned IPA using the installed Apple SDK. Inspect the run before asserting a
successful Apple build. No paid certificate is included or required by the source.

# BetterJIT

**Research prototype, not a functioning VPN or JIT enabler.**

Current experiment: **0.2.0 (3), `interfaces-v3`**. It selects an address actually
assigned to a device interface and generates a matching native-IKEv2 profile.
This tests a possible alternative to the localhost/interface mismatch recorded
in the preceding physical-device experiment; it does not override Apple's native
interface selection or claim offline JIT support.

See [the experiment and exact device procedure](docs/interface-experiment.md).

## Build

```sh
brew install xcodegen
swift test
python3 scripts/wire_smoke.py
python3 scripts/interface_wire_smoke.py
bash scripts/build-ios.sh
```

The unsigned IPA is `build/BetterJIT-unsigned.ipa`. Sign it before installation.
No Network Extension or Personal VPN entitlement is requested. Free provisioning
and each supported device/OS still need actual installation/runtime validation.
For an Xcode Personal Team build, run `xcodegen generate`, open the generated
project, select your team, and use a unique bundle identifier if necessary.
Launch from the app icon without the debugger for the actual experiment.

## Device test

Choose an assigned **en0 IPv4** address for the initial Wi-Fi control. Install the
new **BetterJIT Interface (interface IP)** profile and confirm installation in the
app. Start the probe, check the socket self-tests, switch on that VPN in Settings,
then return promptly and export a finalized report. A permanent VPN connection is
not expected: the responder intentionally rejects negotiation after a valid COOKIE
echo. `cookieRoundTrip` is transport evidence, not authenticated VPN or JIT.

For a separately labeled no-Wi-Fi experiment, disable Wi-Fi, refresh, select an
eligible assigned cellular address and install its matching profile. IPv4 and
unicast IPv6 are supported. No eligible address means this variant cannot run;
there is no automatic fallback to an external server. Both-radios-off remains an
unverified, separate goal. Remove the test profiles after use.

## Safety and diagnostics

Only the selected local address is bound; no wildcard or port reuse. Unrelated
source IPs are rejected before parsing/replying, with metadata logged. Address
matching is not authentication. Run on a trusted network. The probe stops when the
address disappears and retains bounded counters/logs. Profiles contain no root
certificate or management enrollment. Reports include interface addresses and
host process details; review them before sharing. Never commit raw device logs,
pairing files, provisioning profiles or signing secrets.

The original [research notes](docs/research.md) describe historical hypotheses,
not proven capabilities. The newer experiment document supersedes their device
procedure and records the remaining transport and JIT gates.

# Research boundaries and next gates

## Why a cookie probe

RFC 7296 §2.6 requires a client receiving a COOKIE notification to repeat its IKE_SA_INIT request with that cookie first and all other payloads unchanged. This allows a bidirectional transport check without pretending to implement DH, authentication, or IPsec. The responder SPI remains zero because no IKE SA has been created. Stage 1 then returns NO_PROPOSAL_CHOSEN. An error in Settings is therefore expected.

The implementation parses only an initial-request envelope and validates payload bounds, required SA/KE/nonce presence and cookie context. It does not validate SA transforms or DH public keys because it never accepts an SA. It ignores unsupported critical payloads instead of implementing general IKE error negotiation. Its challenge cache is stateful, local-only, bounded to 32 records and expires after 60 monotonic seconds. It is not a production VPN server.

Sources checked during development:

- RFC 7296 §§2.6, 3.1, 3.2 and 3.10: https://www.rfc-editor.org/rfc/rfc7296.html
- Apple's profile schema (the IKEv2 SharedSecret field is a **string**, not the data field used by some other VPN payloads): https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.vpn.managed.yaml
- Apple IKEv2 configuration: https://support.apple.com/guide/deployment/ikev2-settings-dep4ce9487d/web
- StikJIT's integration contract: https://github.com/StikDebug/StikJIT/blob/main/INTEGRATION.md
- LocalDevVPN's existing packet-reflection approach: https://github.com/jkcoxson/LocalDevVPN/blob/main/TunnelProv/PacketTunnelProvider.swift

These sources motivate an experiment. None proves that native IKEv2 accepts a localhost responder on a stock, free-provisioned, fully offline iPhone.

## Acceptance gates

| Gate | Required evidence | Status at initial prototype |
| --- | --- | --- |
| Parser and synthetic transport | Unit tests plus a separately implemented client exchanging real UDP messages | Tested on Linux; see PR validation |
| Apple build | Xcode builds the actual iOS app; not just `swiftc -parse` | CI workflow provided; inspect its result |
| Free provisioning | Install and launch without paid capabilities or Xcode attached | Not device-tested |
| Native offline reachability | Native Settings connection echoes COOKIE with both radios off, with a connected-Wi-Fi control | Not device-tested |
| Full IKE session | DH/key derivation, authenticated IKE_AUTH and correct retransmissions | Not implemented |
| IPsec reflection | Working UDP-encapsulated ESP, inbound/outbound keys, replay protection and tightly scoped selectors | Not implemented |
| Developer services | Reach and authenticate the actual RSD/developer service endpoint | Not implemented |
| JIT | Match target entitlements and allocator protocol; execute newly generated code from a clean launch | Not implemented |

**Do not equate a COOKIE echo with a full IKE_SA_INIT exchange, an authenticated client, a tunnel, or JIT.** UDP/4500 support here is framing/parser coverage; the cookie test does not negotiate NAT traversal or prove that Apple's client reaches that port. The client should normally start on UDP/500.

## Device test matrix

Record exact device/OS build, installation method, matching profile address, background-expiration events, actual Settings radio state, and the complete JSON report. Run separate Wi-Fi-on, cellular-only and fully-offline trials. Do not count a session activated earlier while connected as offline startup. Repeat after a device reboot. Do not use a debugger or another JIT/VPN app during the definitive trial.

`NWPathMonitor` reports path usage, not physical radio-switch state. A loopback packet's source does not cryptographically identify Apple's VPN daemon. Diagnostics explicitly preserve these limitations. An empty trace could mean the client refused localhost, a port conflicted, the profile was not installed/matched, the client never started, or the app was suspended. It does not isolate the cause.

## Next implementation boundary

Only after native-client reachability is demonstrated should the responder implement a small explicit IKE suite, mutual authentication, session/message-ID handling and UDP-encapsulated ESP with replay protection. Constrain any future reflection to the synthetic developer-service peer; do not install a default route or reflect general network traffic. Security review and interoperability tests are required before treating hand-written cryptography or packet processing as reliable.

The proposed full design still depends on platform behavior that this repository has not established. In particular, a native VPN could require network availability despite a loopback endpoint, or have daemon binding conflicts. Integrating StikJIT into the process it pauses is not a fix: self-debugging needs an independently scheduled helper, whose free-provisioned lifecycle must also be demonstrated. Pairing, developer-image readiness and target JIT memory preparation remain separate requirements.

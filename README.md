# BetterJIT

**Stage 1: a localhost IKEv2 reachability probe. This does not enable JIT or establish a VPN.**

The research target is JIT activation in a free-provisioned iOS app without Wi-Fi, a separate VPN app, or an external computer during activation. The proposed transport uses the system's native IKEv2 client and a responder inside the app. This repository tests the first prerequisite rather than assuming that design works.

## Implemented

- A SwiftUI iPhone/iPad app with exclusive UDP listeners on `127.0.0.1:500` and `:4500`, plus an alternate `127.0.0.2` test.
- An IKE_SA_INIT **COOKIE challenge/echo** experiment. A valid echo must preserve the original payloads and match an unexpired challenge issued to the same endpoint. It deliberately finishes with `NO_PROPOSAL_CHOSEN`.
- A removable, locally generated native-IKEv2 profile. The app offers it to Safari through a short-lived loopback HTTP server or exports it to Files. The user must approve installation in Settings. No root certificates, MDM enrollment, auto-connect rules, or Network Extension are added.
- Per-run JSON diagnostics, explicit user-labeled network conditions, finite background execution, bounded parsing/cache sizes, and port-conflict reporting.
- A dependency-free Swift package and desktop CLI; unit tests and an independent Python UDP wire test; an unsigned-iOS-build workflow.

**Not implemented:** successful SA negotiation, DH/session keys, IKE_AUTH, ESP/NAT-T data transport, address reflection, developer-service access, pairing/DDI setup, a self-debugging helper, or StikJIT integration. There is no fake “enable JIT” button.

## Build

On a Mac with Xcode and XcodeGen:

```sh
brew install xcodegen
xcodegen generate
open BetterJIT.xcodeproj
```

Select the BetterJIT target, choose your **Personal Team** under Signing & Capabilities, and use a unique bundle ID if necessary. No paid-only capability is requested. Build/install, then **stop Xcode debugging and launch the app from its icon** for experiments. Physical-device free provisioning, native-client loopback access, and fully offline operation still require device validation. The deployment target is iOS 17; this is not a claim that every supported OS permits the experiment.

To create an unsigned IPA for your own signing tool:

```sh
bash scripts/build-ios.sh
```

Output: `build/BetterJIT-unsigned.ipa`. Unsigned is not directly installable. GitHub Actions also builds this artifact when the workflow succeeds; no signing certificates are uploaded or embedded.

## Device experiment

1. Open BetterJIT, keep `127.0.0.1`, and select **Install test profile**. Accept Safari's download and install **BetterJIT Loopback Probe** in Settings. Alternatively export the profile. The profile is intentionally unsigned and removable.
2. Disconnect other VPNs. Configure the actual radio settings in **Settings**, not merely Control Center. Choose the matching condition in BetterJIT; this label is not automatic radio-state verification.
3. Select **Start 60-second probe**. Check that UDP/500 bound. Go to Settings → General → VPN & Device Management → VPN, select **BetterJIT Probe**, and connect. Return to the app and export the diagnostic report.
4. Repeat with Wi-Fi connected as a control, Wi-Fi off/cellular on, and Wi-Fi off/cellular off. If there is a port conflict, separately try `127.0.0.2` **and reinstall its matching profile**. Record each attempt, including failures.
5. Disconnect and remove the test profile after use. The app stops its sockets on Stop, deadline, or background-expiration notification. iOS can suspend it sooner.

A **VPN connection error is expected** because this stage intentionally rejects negotiation after the cookie echo. The important event is `cookieRoundTrip`, not a VPN icon. Neither it nor a high-port synthetic test proves JIT, IPsec data transport, native-client identity, or the device's radio settings. A silent/expired trace is inconclusive. Reports are also available in Files → On My iPhone/iPad → BetterJIT → Reports.

## Run tests

On macOS or Linux with Swift 5.9+ and Python 3:

```sh
swift test
python3 scripts/wire_smoke.py
swift run betterjit-probe listen --duration 60
swift run betterjit-probe profile --output /tmp/BetterJIT.mobileconfig
```

The CLI binds **15000/14500** by default; these are synthetic-control ports, not the native IKEv2 ports. `--ike-port 500 --nat-port 4500` selects native ports; macOS may require elevated binding privileges. `0` requests ephemeral ports for tests. CLI success on a desktop is not evidence about the iOS sandbox.

See [research and acceptance gates](docs/research.md). Do not publish pairing files, provisioning profiles, signing keys, or packet captures containing credentials in issues. Diagnostic JSON contains only event metadata, OS/model information and user-provided condition labels; it does not include raw IKE packets or profile secrets.

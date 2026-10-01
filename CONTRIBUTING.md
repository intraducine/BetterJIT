# Contributing

BetterJIT is an app-independent runtime SDK. Put public protocol and lifecycle code
in Sources/BetterJIT, the Apple executor in Sources/BetterJITWebKit, optional FEX
service integration in Sources/BetterJITFEX/Backends/FEX, and application-specific
work in adapters such as addon/iridium. Public SDK products must not depend on an
adapter, host UI, username, signing team, renderer or private checkout layout.

Start a focused branch. Preserve upstream licenses and attribution. Do not change
repository visibility, sign, install, publish or expose historical research merely
because source changes are ready. Never commit secrets, profiles, device identifiers,
raw personal logs, games, local configuration or built applications.

Run bash scripts/check-sdk.sh and the relevant adapter/research tests. Add regression
tests for protocol, lifecycle, native boundaries and backend behavior. Keep Apple
compilation, physical-device execution, fixture replay, game compatibility and
performance claims separate. Tests must explicitly identify unsupported/skipped
capabilities, not fake a passing implementation. Do not bypass memory or import
checks to make tests pass.

Update the exact-path distribution/sdk-files.json list for SDK source changes.
Run the SDK exporter and test its extracted package independently of Iridium.
The previous distribution/manifest and exporter serve the optional Iridium adapter,
not the default SDK. Use docs/sdk/publishing.md for future SDK publication and
preserve all applicable component notices. No automated export is a legal or
security certification. Public Iridium stays untouched unless separately requested.

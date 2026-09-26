# Iridium integration fixtures

Verbatim host integration files retrieved from `intraducine/iridium`:

- `common/RootTabView.swift`: `iridium/apps/ios/Iridium/Views/RootTabView.swift`, Git blob `1a5941432633d6886f19da895b0432722d83494f` at both revisions below.
- `common/stikjit.yml`: `iridium/apps/ios/stikjit.yml`, Git blob `eb83eb4c45e3088a6fe54db1d003af0770700229` at both revisions.
- `31ca8f113b84/build-local-ipa.sh`: `ci/build-local-ipa.sh` at `31ca8f113b842d4c995474438f14c04ef50b7110`, Git blob `dea459e61e1ee3c3256ca6bbb4a3766cb5d1e6e2`.
- `f89099fa8810/build-local-ipa.sh`: `ci/build-local-ipa.sh` at `f89099fa8810261fdffd334b2d4cd87e98b92ad1` (`update/madeira-upstream`), Git blob `f98c102fdbaffda25f09f13b1265f54d1078442a`.

These files retain Iridium's GPL-3.0 license; see the repository's `COPYING`.
Tests verify the Git blob hashes before applying the local overlay. Do not edit
the fixtures to satisfy a new hash: review the upstream change and add a new
profile and corresponding fixture. The build scripts are syntax-checked, never
executed by this test. Add-on asset stubs in the unit test cover checkout safety
and packaging only, not native compilation or device execution.

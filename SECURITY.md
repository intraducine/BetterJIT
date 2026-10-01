# Security and privacy

This is experimental local execution code, not a hardened game sandbox. Do not
run untrusted inputs or grant it access to sensitive files. The lab's transport
is loopback-only; local isolation and pre-push hooks are accidental-publication
guards, not authentication, DRM or a guarantee of owner-only filesystem access.

Use the repository's private security-reporting channel when available. Otherwise
ask for a private channel without posting credentials, personal logs or exploit
details publicly. There is no promised response time.

The exporter applies an exact-path allowlist, fixture hashes and a limited set of
credential/path checks. Review the result manually. A passing export does not mean
that private branches, Git history, Actions logs or past artifacts are safe to publish.

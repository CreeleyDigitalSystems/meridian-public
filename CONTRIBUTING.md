# Contributing to Meridian

Work from this clean source tree and a newly created synthetic directory. Do not copy private worlds, conversations, screenshots, keys or deployment configuration into issues, fixtures or changes.

Keep contributions focused. Describe the user-visible behaviour, how to reproduce it and a test that proves it. Run `pnpm test`, `pnpm typecheck` and the web build for relevant renderer changes. Changes to saved events, replay, admission or public facts must preserve historical meaning and include a restart/replay check. Prefer typed public facts over arbitrary generated prose.

The owner reviews and accepts contributions and controls releases. A proposed change or passing local test does not grant production access. By intentionally submitting a contribution, you agree to license it under the Apache License 2.0, as provided in [LICENSE](LICENSE), unless you explicitly state otherwise. Copyright 2026 Jake Creeley / Creeley Digital Systems. Third-party material retains its own terms; identify its provenance and compatible licence. This does not grant access or rights to private worlds, operator data, branding or excluded assets.

Avoid adding hosted services to the default demo. Optional integrations must be separate, explicit and disabled by default, with no credential or paid-request fallback. Keep local HTTP read-only and loopback-bound.

## Owner approval and CI

Open a pull request for focused code or synthetic tests. The owner reviews and merges changes; CODEOWNERS requests that review but does not enforce it alone. The merge workflow requires Jake’s approval. The owner must enable a main-branch rule requiring a pull request, code-owner approval and the `public-core` check, and restrict bypasses before accepting public contributions. Enable private vulnerability reporting separately. No contributor pull request deploys Meridian. The prepared CI uses an ephemeral hosted runner, anonymous source fetch and a disposable container, with no repository token permissions, secrets, production environment or self-hosted runner. It has not been exercised on a public repository.

See AI-CONTRIBUTING.md for generic AI/tool/revision interfaces and the exact native-runtime and canonical-admission limits. Keep optional AI, keys, generated journals and runtime data outside source control.

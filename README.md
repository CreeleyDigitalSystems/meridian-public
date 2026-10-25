# Meridian

A persistent 3D city where residents travel, work, spend materials and leave a saved history. Built by Jake Creeley at Creeley Digital Systems.

[Watch the live city](https://meridian.creeleydigital.com.au). The hosted viewer observes a separately operated saved city; this repository runs a new fictional local city. A repository change does not update the hosted city.

This alpha source showcase contains the city engine, procedural viewer and generic optional AI interfaces. The default demo needs no account or provider key. Project-owned source is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Jake Creeley / Creeley Digital Systems. Third-party dependencies retain their own terms.

The demo runs Meridian's actual integrated city-life kernel, hash-chained ledger, SQLite store, streamed integrity verification and public fact projection. Twenty-four fictional residents choose deterministic legal engine actions, complete tasks and change the saved city. Sol and Luna are fictional given names here, with no recovered biography or relationships. The default run is a deterministic simulation with no model calls, paid inference or internet tools. Optional AI source is included separately; there is no AGI or general autonomous-development claim.

## Run the fictional city

Install Node **26.7.0** and pnpm **11.22.0**, then run these commands from the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm demo
```

In a second terminal:

```sh
pnpm --filter @meridian/web dev --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173`. The viewer proxies public snapshot, event and history requests to `127.0.0.1:8787`. The engine advances one canonical minute every 100ms. Keep the engine running while viewing. Stop it with Ctrl-C; `pnpm demo` resumes the same verified synthetic city from `.meridian-demo`. To create another fictional run, use `pnpm demo --data new-empty-directory`. Unknown/unmarked directories are refused; there is no reset or import-production command.

The read-only local service exposes `/world`, `/events?after=<public-cursor>`, `/world?view=city-ledger&limit=20`, `/world?view=resident-discovery&resident=<public-number>` and `/health`. Public cursors are separate from the canonical ledger. Raw canonical state, private owner commands and companion routes are unavailable over HTTP.

The city starts with operator-commissioned Meridian Central, civic plans at zero progress and an entirely fogged frontier. Residents must earn charting by travelling to a real worksite, working and returning; a circuit is derived only after real connected ground is charted. The provisional first landing is civic; it grants no free house or materials. Later work still uses canonical paid resource accounting. Opening events are recorded in the actual ledger. Public cursors and clock minutes are separate.

The procedural viewer retains the integrated circuit, home/door/camera and audience walking controls, resident inspection and readable saved-world history. Its owned layout supplies 24 homes and 24 workplaces; it does not reproduce the private city's full population or visual appearance. Unresolved binary kits, authored characters, kit coordinates and provider-generated texture patterns are replaced by procedural shells and flat materials. No GLB, photograph, panorama or brand icon is shipped. Imported models are disabled explicitly. Viewer walking changes only the audience camera, never a resident's canonical location or knowledge.

Wardrobe stays closed in this provider-free world, with no fabricated model choices or unsupported adult model changes; shared typed catalogue/capability/replay code is retained. Hosted feedback and its relay/proxy are omitted only from this local demo, with no fake feedback success. Private continuity, production service composition, cloud administration and hosted deployment are outside this candidate; generic optional AI/tool/session source is included. An optional offline host binder has observed failure/repair, canonical admission, verified cold restart and a typed adopt-version transition using configured doubles; production execution, paid useful work and teaching remain unproved. The default demo still refuses executable admission; no integrity validator is bypassed to simulate success. This new format refuses older or unknown demo directories and never overwrites/imports production data. The source showcase does not include the hosted operator environment.

See [CONTRIBUTING.md](CONTRIBUTING.md), [LICENSE](LICENSE), [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and the exact `PUBLIC-SOURCE-MANIFEST.json`. Build/runtime checks establish local behaviour, not ownership, a licence grant or public deployment acceptance.

## What works and what remains alpha

The current viewer includes city-centre navigation, resident task/change activity and an ephemeral “Watching now” viewing-session badge. The badge counts this local demo's sessions, not verified humans or the hosted project's audience; it resets on restart. Use `http://127.0.0.1:5173` for the local viewer (`pnpm --filter @meridian/web dev --host 127.0.0.1 --port 5173 --strictPort`). If you use a different loopback viewer origin, pass exactly that origin with `pnpm demo --viewer-origin http://127.0.0.1:PORT`. The provider-free engine still records actual canonical work, transit, materials and replay; its fictional residents do not represent the live saved city. Hosted feedback and chat are not available in this demo.

Generic optional provider, prompt, tool-session, revision/evaluator and executor source is included. Importing it enables nothing. See AI-CONTRIBUTING.md for explicit caller configuration, native runtime limitations and the private production composition excluded from this tree. The included request/tool tests use explicit doubles; no live provider or native runtime acceptance is claimed. Private canonical method admission and root prefix attestation refuse explicitly, while ordinary uncached store verification remains active.

## Contribute

Useful areas include clearer resident choices, repair feedback, measured task usefulness, replay correctness and the procedural viewer. Start with a focused issue describing an observed problem and a way to reproduce it. Contributions are accepted under Apache 2.0; see [CONTRIBUTING.md](CONTRIBUTING.md). Jake reviews and approves merges and releases.

For the existing local checks:

```sh
pnpm test
pnpm typecheck
pnpm --filter @meridian/web build
pnpm verify:public
```

Protected-branch enforcement and private security reporting require repository settings; files alone do not enable them. There is no deployment workflow or automatic release. See [SECURITY.md](SECURITY.md) before reporting sensitive material.

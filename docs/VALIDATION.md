# Validation scope

Version 0.1.2 targets Paseo `>=0.14.0-beta.1 <0.18.0` and macOS 13+, adding compatibility with Paseo 0.16.2 and the locally installed 0.17.1 without dropping the previous minimum. Local validation used Apple Silicon, Node 26, npm 11.19.1, and Apple Swift 6.4. CI explicitly uses npm 11.19.1 on Node 22 and 24; Node 22's bundled npm 10 rejects optional-platform entries in this development dependency tree. Check the published CI run for its actual runner architecture and Node/Swift versions; local results alone are not evidence that a CI matrix passed.

## Automated coverage

- State mapping, permission priority, finished-attention semantics, archive/internal exclusion, count-before-cap behavior, safe links, sanitized Unicode titles, minimal metadata projection, and unified provider usage projection/sanitization (`providers.listUsage`, percentage clamping, epoch-0 reset filtering, raw error redaction, available-first sorting and 20-account cap).
- One daemon-owned subscription for concurrent bootstrap requests; pagination with buffered upserts/removals; snapshot replacement; superseded-request cancellation; offline state and recovery; reconciliation and teardown; non-starving 100 ms event throttling; plus `UsageObserver` deduplication, 5-minute polling, disabled/unsupported handling, timeout/error retention and teardown.
- Client bootstrap retries and cancellation; native bridge startup deduplication, bounded commands (`refresh`, `refreshUsage`, `hide`), backpressure coalescing, crash retry limit, shutdown and environment filtering.
- Actual Swift compilation, presentation output (tasks and usage submenus), invalid-frame rejection, immutable cache reuse and private directories. `--check-live` uses the SAME POSIX stdin pump as the GUI: several sub-buffer-size frames must render while stdin remains open. This regression catches Foundation pipe reads that can wait for a full buffer or EOF.
- Real SDK types, compilers, production-only compilation without development dependencies, and plugin subprocess IPC for Paseo 0.14.0-beta.1, 0.15.0-beta.1, 0.15.4, 0.16.0-beta.1, 0.16.0-beta.2, 0.16.2 and 0.17.1. Only the OS helper boundary is replaced for the IPC test; the real entry, task observer, usage observer, bridge, host SDK and compiler run. Helper PID termination is checked after unload.
- Listing media, bilingual overview packaging, and absence of runtime npm preparation.

`npm run check` is the canonical local check. The source consistency check ensures that the shipped generated TypeScript string is byte-identical to `native/main.swift`.

## v0.1.2 update (account usage + Paseo 0.17 compatibility)

The installed desktop app and daemon both reported 0.17.1. The previous release failed before loading because of its `<0.17.0` requirement. This update expands the upper bound only after checking seven real published SDK/runtime versions (adding 0.16.2 and 0.17.1) and continues to reject 0.18 prereleases and newer unsupported hosts, while adding read-only account quota display via Paseo's unified `providers.listUsage` API.

`npm run compatibility` resolves plugin, client and protocol declarations from each selected server package, never substitutes the baseline SDK for another host, and type-checks the shipped server/client/shared modules. Runtime integration tests emit the host's actual lifecycle event before any client RPC, confirm notification bootstrap, subscription and usage-query deduplication, and raw usage error redaction, then exercise live updates, hidden background helpers where supported, removal and teardown. The locally passing suite has 60 tests across 8 test files plus the seven SDK type checks.

The shared projection explicitly excludes the `background` flag as well as legacy `internal`; it still discards metadata, usage `details`, and raw error bodies. Legacy notification registration remains supported by the inspected 0.14–0.17 hosts and is tested through their modern event mapping. No mutation hook, provider action or direct third-party network destination was introduced (usage is read solely through the host daemon's `providers.listUsage` RPC). The native Swift UI, `assets/menubar-preview.png` (regenerated with synthetic tasks and synthetic quotas), and application cache/plist version advance to 0.1.2.

The public Git smoke script selects the same-version published client and daemon-control helper and defaults to an isolated 0.17.1 daemon. Its expected version is checked before installation, so it cannot silently validate against a different installed CLI. Published CI and the release-specific smoke result, not a widened manifest alone, establish the tested coverage. Unlisted intermediate patch releases are not individually exercised.

## Native preview

`npm run screenshot` compiles a temporary instrumented copy of the actual menu implementation, feeds synthetic task metadata and captures that process's own AppKit menu content view. It does not recreate the interface in HTML, capture the production desktop, use account data, request Screen Recording/Accessibility permission or modify the installed plugin. A caption marks the image as synthetic data.

## Installation and runtime limits

Local production installation was explicitly authorized by the user. The matching desktop CLI installed the directory source into an already enabled Paseo 0.15.0-beta.1 daemon. Read-only bootstrap RPC confirmed observation initialization, the native process remained running after the verification client closed, and the existing account plugin and daemon process were preserved. No model turn or permission action was started for validation.

That installation check initially verified process lifetime, not native small-frame rendering; the native preview exposed the pipe-buffering issue. Before public release the stdin pump was replaced with POSIX read and covered by the live-frame regression above. This distinction is retained rather than claiming the original process-only check proved rendering latency.

The public Git artifact should also be checked in an isolated daemon at the exact release commit as described in PUBLISHING.md. Public CI, the matching release commit, intake issue and review PR are the authoritative publication evidence, not a local directory or synthetic screenshot.

The interface currently uses Chinese labels. A fresh daemon without any connected client or new lifecycle event waits for bootstrap. Remote Linux-to-Mac rendering is not supported. Intel has a compile target but was not exercised on local Intel hardware. macOS 13 was not hardware-tested locally; the deployment target is 13.0. Model turns, OAuth and agent mutations are deliberately not part of these checks.

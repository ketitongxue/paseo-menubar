# Validation scope

The initial public release targets Paseo `>=0.14.0-beta.1 <0.16.0` and macOS 13+. Local validation used Apple Silicon, Node 26, npm 11.19.1, and Apple Swift 6.4. CI explicitly uses npm 11.19.1 on Node 22 and 24; Node 22's bundled npm 10 rejects optional-platform entries in this development dependency tree. Check the published CI run for its actual runner architecture and Node/Swift versions; local results alone are not evidence that a CI matrix passed.

## Automated coverage

- State mapping, permission priority, finished-attention semantics, archive/internal exclusion, count-before-cap behavior, safe links, sanitized Unicode titles, and minimal metadata projection.
- One daemon-owned subscription for concurrent bootstrap requests; pagination with buffered upserts/removals; snapshot replacement; superseded-request cancellation; offline state and recovery; reconciliation and teardown; non-starving 100 ms event throttling.
- Client bootstrap retries and cancellation; native bridge startup deduplication, bounded commands, backpressure coalescing, crash retry limit, shutdown and environment filtering.
- Actual Swift compilation, presentation output, invalid-frame rejection, immutable cache reuse and private directories. `--check-live` uses the SAME POSIX stdin pump as the GUI: several sub-buffer-size frames must render while stdin remains open. This regression catches Foundation pipe reads that can wait for a full buffer or EOF.
- Paseo 0.14.0-beta.1 and 0.15.0-beta.1 real compilers, production-only source compilation without development dependencies, and real plugin subprocess IPC. Only the OS helper boundary is replaced for the IPC test; the real entry, observer, bridge, host SDK and compiler run. Helper PID termination is checked after unload.
- Listing media, bilingual overview packaging, and absence of runtime npm preparation.

`npm run check` is the canonical local check. The source consistency check ensures that the shipped generated TypeScript string is byte-identical to `native/main.swift`.

## Native preview

`npm run screenshot` compiles a temporary instrumented copy of the actual menu implementation, feeds synthetic task metadata and captures that process's own AppKit menu content view. It does not recreate the interface in HTML, capture the production desktop, use account data, request Screen Recording/Accessibility permission or modify the installed plugin. A caption marks the image as synthetic data.

## Installation and runtime limits

Local production installation was explicitly authorized by the user. The matching desktop CLI installed the directory source into an already enabled Paseo 0.15.0-beta.1 daemon. Read-only bootstrap RPC confirmed observation initialization, the native process remained running after the verification client closed, and the existing account plugin and daemon process were preserved. No model turn or permission action was started for validation.

That installation check initially verified process lifetime, not native small-frame rendering; the native preview exposed the pipe-buffering issue. Before public release the stdin pump was replaced with POSIX read and covered by the live-frame regression above. This distinction is retained rather than claiming the original process-only check proved rendering latency.

The public Git artifact should also be checked in an isolated daemon at the exact release commit as described in PUBLISHING.md. Public CI, the matching release commit, intake issue and review PR are the authoritative publication evidence, not a local directory or synthetic screenshot.

The interface currently uses Chinese labels. A fresh daemon without any connected client or new lifecycle event waits for bootstrap. Remote Linux-to-Mac rendering is not supported. Intel has a compile target but was not exercised on local Intel hardware. macOS 13 was not hardware-tested locally; the deployment target is 13.0. Model turns, OAuth and agent mutations are deliberately not part of these checks.

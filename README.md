# pi-omarchy-cu

**Computer use for the [Pi](https://github.com/earendil-works/pi) coding agent on Linux, built for Omarchy (Hyprland Wayland).**

`pi-omarchy-cu` lets Pi drive real desktop applications through the AT-SPI
accessibility tree, while a calibrated decision model picks the target and the
action. The accessibility tree never enters Pi's context: a tool call reads the
live **Window** or **Overlay Surface**, filters nodes by their **Advertised
Actions**, asks **Jev System One** for the target **Ref** and **Operation**,
enforces deterministic confidence and risk thresholds, and returns compact
evidence about what happened.

```
"switch to list view"                       → cu_act   (one step, dry-run by default)
"open Preferences, then enable Dark Mode"   → cu_run   (multi-step Goal, verifies as it goes)
"click @s8f3k2p9:e12"                       → cu_ref   (you already know the Ref)
"what is on the screen?"                    → cu_observe
"why is Chromium invisible?"                → cu_status
```

## What it can do

| Capability | Tool |
| --- | --- |
| **Readiness report** — agent-desktop binary, private state root, AT-SPI bus, display, Jev config, apps, windows, blind spots | `cu_status`, `/cu status` |
| **Inspect** a Window, a Region, or the active dialog/menu — skeleton overview, drill into a Region, `find`/`get`/`is`/`list-surfaces` | `cu_observe` |
| **Act deterministically** on a known Ref — `click`, `right-click`, `check`, `uncheck`, `toggle`, `expand`, `collapse`, `select`, `set-value`, `clear`, `scroll-to` — plus `wait`, clipboard, and accessibility-enabled `launch` | `cu_ref` |
| **One natural-language Intent** — resolve the target and Operation without reading the tree, optionally execute | `cu_act` |
| **A multi-step Goal** — observe → decide → confirm → act → verify, with budgets and stop conditions | `cu_run` |
| **Dialogs and menus first** — an open sheet, alert, menu, or popover is observed instead of the window it covers | all read paths |
| **Human-in-the-loop** — risky or ambiguous steps prompt with the window, operation, target, confidence, and destructive probability | `cu_act`, `cu_run` |
| **Text entry without a keyboard** — semantic `set-value` on nodes that advertise it, with scoped redaction | `cu_act`, `cu_run`, `cu_ref` |
| **Diagnostics at zero token cost** — `/cu apps`, `/cu windows` | `/cu` |

It is deliberately conservative: only the 11 Wayland-safe AT-SPI Operations are
offered, text entry is reconciled to `set-value` (never synthetic keystrokes),
and confidence thresholds (`0.55` floor, `0.70` action bar, `0.90` destructive
bar) gate every mutation. See [ADR-0002](docs/adr/0002-strict-at-spi-execution-on-hyprland.md).

### What it cannot do (yet)

- **Terminal/TUI apps** (cliamp, nvim, btop): their content never joins the
  AT-SPI bus, and Hyprland Wayland blocks synthetic keystrokes. The extension
  says so and stops; drive these through their own CLI/IPC (the bundled skill
  shows the cliamp recipe).
- **Apps that are not running**: `cu_ref` can launch them with the accessibility
  environment injected, but `cu_act`/`cu_run` do not auto-launch today.
- **Canvas/GPU-drawn UIs with no accessible nodes**: `cu_act` abstains instead of
  guessing coordinates.
- **Compositor-level input**: no `wtype`, `ydotool`, `hyprctl` input, or `grim`
  screenshots (ADR-0002). For Chromium-only work, use
  [surf](https://github.com/nicobailon/surf-cli).
- **Other users' sessions, containers, or sandboxes that don't share the bus.**

## Install

Requires Linux with a running AT-SPI bus (`at-spi2-core`), a graphical session,
and Pi. `agent-desktop` ships as a dependency, so you do not install it
separately.

```bash
# from npm (once published)
pi install npm:pi-omarchy-cu

# from GitHub
pi install git:github.com/Paul-Yuchao-Dong/pi-omarchy-cu

# from a local checkout
npm install
pi install .
```

`pi install` reads the package manifest (`"pi": { "extensions":
["./extensions/index.ts"], "skills": ["./skills"] }`) and loads both the tools
and the `omarchy-cu` skill. A local checkout is not installed by Pi, which is why
it needs its own `npm install` first.

To try it without touching your settings:

```bash
pi -e /path/to/pi-omarchy-cu
```

### Jev credentials

`cu_act` and `cu_run` need a TypeSafe Jev endpoint. Resolution matches
[`pi-jev`](https://github.com/TheoOliveira/pi-jev), so an existing setup works
as-is:

- **Endpoint:** `PI_JEV_BASE_URL` → `TYPESAFE_BASE_URL` → OpenRouter
  (`https://openrouter.ai/api`, when an OpenRouter key is used) → TypeSafe
  (`https://api.typesafe.ai/v1/systemone`).
- **Key:** `$TYPESAFE_API_KEY` → `~/.pi/agent/secrets/typesafe_api_key` →
  `$OPENROUTER_API_KEY` → `~/.pi/agent/secrets/openrouter_api_key`. A custom
  loopback endpoint may run keyless.
- **Model:** explicit → `PI_JEV_MODEL` → `TYPESAFE_MODEL` →
  `TYPESAFE_DEFAULT_MODEL` → `~typesafe/jev-latest` on OpenRouter, `jev-latest`
  on TypeSafe.

HTTPS is required for remote endpoints; plain HTTP is accepted only on loopback,
and URLs with embedded credentials are rejected. `cu_status` reports the
resolved endpoint and key origin, never the key.

### First run

```bash
/cu status            # binary, state root, bus, display, Jev, apps, blind spots
/cu apps              # what is on the accessibility bus
```

Then, from the Pi prompt:

```
Call cu_status. If a running Chromium, Electron, or Qt app is missing from the
accessibility bus, show me the exact flags to relaunch it.
```

## Usage

### `cu_act` — one Intent

```
Call cu_act with intent "press the List View button" and execute: false.
Show the chosen Ref, Operation, confidence, destructive risk, and why.
```

Dry run is the default. Pass `execute: true` to land the step. When the Intent
needs text, pass `text` — the extension never invents strings. When several
foreground apps exist, name the app (`app: "Notes"`); loose names and casing are
resolved against `list-apps`.

### `cu_run` — one Goal

```
Use cu_run with the goal "open Preferences, switch to Appearance, and enable
Dark Mode" and confirmDestructive: true.
```

Every turn streams as a progress update. The loop stops on `done`, `blocked`, a
declined confirmation, `action_failed`, `window_closed`, a window/surface
ownership violation, 40 operations, 80 decision calls, or 3 consecutive non-WAIT
turns with an unchanged SHA-1 screen fingerprint.

### `cu_observe` and `cu_ref`

Use these when you want explicit control: `cu_observe` to read a Window, Region,
or the active dialog; `cu_ref` to run one deterministic operation, wait for a UI
transition, read or write the Wayland clipboard, or launch an app with
accessibility enabled.

## Tools

| Tool | What it does |
| --- | --- |
| `cu_status` | Readiness: binary, private state root (`0700`), AT-SPI bus, display, Jev configuration, running apps and windows, AT-SPI blind spots with exact relaunch flags, and the Electron single-client bridge warning. |
| `cu_observe` | `snapshot` (interactive-only, compact, bounds-included, shallow skeleton, auto-switching to an open Overlay Surface), `find`, `get`, `is`, `list-surfaces`. A `root` Ref or `maxDepth` narrows or deepens a Region read; a `windowId` pins every read to one Window and rejects leaked nodes. |
| `cu_ref` | The 11 Wayland-safe Ref Operations, `wait`, `clipboard-get`/`clipboard-set`/`clipboard-clear` (via `wl-clipboard`), and `launch` with `ACCESSIBILITY_ENABLED=1` and `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`. |
| `cu_act` | One Intent: snapshot, candidate filtering, a five-question System One request, top-5 rerank below `0.70`, Operation reconciliation, Route Decision, confirmation, execution. |
| `cu_run` | One Goal: the observe-decide-act-verify loop with DRILL/WIDEN Region navigation, streaming turns, and hard budgets. |

`/cu status`, `/cu apps`, and `/cu windows` give the same diagnostics in the
terminal, outside the model's context.

## Omarchy AT-SPI flags

An app that starts without its toolkit's accessibility switch never joins the
bus, and every observation then looks like a missing window. `cu_status` names
the offending processes; this is what puts each toolkit on the bus:

| Toolkit | Launch with |
| --- | --- |
| Chromium | `ACCESSIBILITY_ENABLED=1 chromium --force-renderer-accessibility` (`ACCESSIBILITY_ENABLED=1` alone registers the browser with no windows) |
| Qt | `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 <app>` (equivalently `QT_ACCESSIBILITY=1`) |
| Electron | no accessibility flag; add `--no-sandbox` only where `chrome-sandbox` is not setuid |

Electron single-client hazard: when `agent-desktop` is the only AT-SPI client,
its disconnect can crash the Electron accessibility bridge (VS Code exits with
SIGSEGV). A GNOME desktop keeps the shell connected; on Hyprland keep another
AT-SPI client connected.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENT_DESKTOP_BIN` | Explicit `agent-desktop` executable; overrides the bundled dependency. |
| `AGENT_DESKTOP_HOME` | State directory; created and enforced at `0700`. |
| `WAYLAND_DISPLAY`, `DISPLAY` | Passed through to `agent-desktop`. When unset (Herdr server, systemd, SSH, or container pane), they are derived from the newest `/run/user/<uid>/wayland-*` socket and the lowest `/tmp/.X11-unix/X<n>`; explicit values always win. |
| `PI_JEV_BASE_URL`, `TYPESAFE_BASE_URL` | Jev endpoint, as an API root (`https://api.typesafe.ai`) or the full `.../v1/systemone` endpoint; both resolve to the same request URL. |
| `PI_JEV_MODEL`, `TYPESAFE_MODEL`, `TYPESAFE_DEFAULT_MODEL` | Decision model, resolved in that order. |
| `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` | API keys; the `pi` secret files are read when the variables are unset. |

## Architecture

- **Observation and execution** go through [`agent-desktop`](https://github.com/vercel-labs/agent-desktop)
  as an async subprocess (never blocking the event loop), with a private state
  root and full `AbortSignal` propagation.
- **Decisions** are in-process via [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk),
  with bounded retry on `429`/`503`/`529` (ADR-0001). Extensions cannot call
  another extension's tool mid-execution, so the Jev client is embedded rather
  than delegated.
- **Policy is deterministic**: candidate filtering, Operation reconciliation,
  Route Decisions, risk gating, text-queue and redaction rules, and the loop
  budgets live in `src/policy/`, `src/decide/`, and `src/desktop/`.
- **One test seam**: every tool is exercised through `execute(toolCallId, params,
  signal, onUpdate, ctx)` with an injectable CLI runner and decision client; one
  live test drives the real binary.

See `docs/adr/`, `GLOSSARY.md`, and `skills/omarchy-cu/SKILL.md` for the design
record, vocabulary, and the agent-facing usage guide.

## Development

```bash
npm test          # node --test --import tsx test/*.test.ts
npx tsc --noEmit  # typecheck
npm run smoke     # load the extension in Pi and list its tools
```

## Credits

This package stands on several prior works:

- **[agent-desktop](https://github.com/vercel-labs/agent-desktop)** by Vercel Labs
  (Apache-2.0) — the AT-SPI observation and Ref-execution CLI that does the actual
  desktop work. It ships as a dependency, and its Linux skill documents the
  Chromium/Electron/Qt flags and the Electron bridge hazard reused here.
- **[TypeSafe Jev System One](https://typesafe.ai)** and
  **[`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk)** (MIT) —
  the calibrated choice/probability decisions behind `cu_act` and `cu_run`.
- **[pi-jev](https://github.com/TheoOliveira/pi-jev)** by Theophilo Damiao (MIT) —
  prior art for Jev credential/endpoint resolution, retry, and key-origin
  reporting; `src/jev/` mirrors its resolution order deliberately.
- **[Pi](https://github.com/earendil-works/pi)** by Earendil Works — the extension
  runtime, tool API, and the `ctx.ui.confirm` interaction used for risky steps.
- **[Omarchy](https://omarchy.org)** and **[Hyprland](https://hyprland.org)** —
  the target desktop; ADR-0002 exists because of their Wayland constraints.
- **AT-SPI / at-spi2-core** (GNOME) — the accessibility bus everything reads.
- **wl-clipboard** — the Wayland clipboard backend behind `cu_ref` clipboard
  commands.

## License

MIT. See [LICENSE](LICENSE).

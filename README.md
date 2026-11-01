# pi-omarchy-cu

Semantic desktop observation and goal-driven interaction for Linux applications
from the [Pi](https://github.com/badlogic/pi) coding agent, on Omarchy (Hyprland
Wayland), over AT-SPI, with in-process TypeSafe Jev System One decisions.

The accessibility tree never enters the agent's context: each tool call reads
the live **Window** or **Overlay Surface**, filters nodes by their **Advertised
Actions**, asks Jev for the target **Ref** and **Operation**, enforces
deterministic confidence and risk thresholds, and returns compact evidence about
what happened.

## Install

```bash
pi install /home/tuo/Projects/pi-omarchy-cu
```

The package declares its extension and skill in `package.json`
(`"pi": { "extensions": ["./extensions/index.ts"], "skills": ["./skills"] }`).

`agent-desktop` ships as a package dependency, so the binary is resolved from
`AGENT_DESKTOP_BIN`, then the package-local `node_modules/.bin`, then `PATH`.
A local checkout is not installed by `pi install`, so run `npm install` once in
the package directory; npm and git installs get the dependency automatically.
It also needs Jev credentials (below).

## Tools

| Tool | What it does |
| --- | --- |
| `cu_status` | Readiness: `agent-desktop` binary, private state root (`0700`), AT-SPI bus and display, Jev configuration, running apps and windows, plus AT-SPI blind spots (Chromium, Electron, and Qt processes that are missing from the bus, with the exact relaunch flags) and the Electron single-client bridge warning. |
| `cu_observe` | Explicit inspection: `snapshot` (interactive-only, compact, bounds-included, shallow skeleton by default, auto-switching to an open Overlay Surface), `find`, `get`, `is`, `list-surfaces`. A `root` Ref or `maxDepth` narrows or deepens a Region read; a `windowId` pins every read to one Window and rejects a leaked Ref or Surface. |
| `cu_ref` | Deterministic AT-SPI operations on a known Ref (`click`, `right-click`, `check`, `uncheck`, `toggle`, `expand`, `collapse`, `select`, `set-value`, `clear`, `scroll-to`), `wait`, `clipboard-get` / `clipboard-set` / `clipboard-clear` through `wl-clipboard`, and `launch` with accessibility environment variables injected. |
| `cu_act` | One plain-language **Intent** (e.g. `"press the List View button"`): snapshot, candidate filtering, one five-question System One request, top-5 rerank below `0.70` target confidence, Operation reconciliation, Route Decision, optional `ctx.ui.confirm`, execution. Dry run by default. |
| `cu_run` | A multi-step **Goal** (e.g. `"open Preferences and enable Dark Mode"`): loops observe → decide → confirm → act → verify, offering the Wayland-safe element Operations, `DRILL`/`WIDEN` Region navigation, and `WAIT`/`DONE`/`BLOCKED`, streaming every turn as a progress update. |

`cu_run` stops on `done`, `blocked`, `confirm: ...` (declined or headless),
`abstain: ...`, `error: action_failed | window_closed | root_outside_window |
surface_outside_window`, `budget: operations` (40), `budget: jev calls` (80), or
`unchanged: 3 turns` (three consecutive non-`WAIT` turns with an identical
SHA-1 screen fingerprint).

## `/cu` command

Zero-token terminal diagnostics, outside the model's context:

- `/cu status` — readiness summary, blind spots, and the Electron bridge warning.
- `/cu apps` — applications currently on the AT-SPI bus.
- `/cu windows` — Window identifiers and titles, ready to pass as `windowId`.

## Omarchy AT-SPI flags

An app that starts without its toolkit's accessibility switch never joins the
bus, and every observation then looks like a missing window. `cu_status` names
the offending processes; this is what puts each toolkit on the bus:

| Toolkit | Launch with |
| --- | --- |
| Chromium | `ACCESSIBILITY_ENABLED=1 chromium --force-renderer-accessibility` (`ACCESSIBILITY_ENABLED=1` alone registers the browser with no windows) |
| Qt | `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 <app>` (equivalently `QT_ACCESSIBILITY=1`) |
| Electron | no accessibility flag; add `--no-sandbox` only where `chrome-sandbox` is not setuid |

`cu_ref` with `action: "launch"` injects `ACCESSIBILITY_ENABLED=1` and
`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` automatically. Relaunching an application
loses its state, so ask the user first.

Electron single-client bridge hazard: when `agent-desktop` is the only AT-SPI
client, its disconnect can crash the Electron accessibility bridge (VS Code
exits with SIGSEGV). A GNOME desktop keeps the shell connected; on Hyprland keep
another AT-SPI client connected.

## Application scoping and terminal apps

`cu_act` and `cu_run` scope themselves: a loosely-named `app` is resolved
against `list-apps` (casing and near-misses included), and with no `app` the
only foreground application is used and reported in `notes`. Several
foreground applications are never guessed — the error names them so the caller
can pass `app` or `windowId`.

Terminal/TUI apps (cliamp, nvim, btop) and apps with their own CLI/IPC belong on
the shell side, not here: the extension reports them as undrivable and the
companion skill shows the CLI recipe (for example
`cliamp remote call provider.search` then `cliamp open 'cliamp://play?url=...'`).

An application that never joined the AT-SPI bus gets a specific explanation:
GUI toolkits get their relaunch flags, an app that is not running gets
`cu_ref` launch guidance, and terminal/TUI applications (cliamp, nvim, btop)
are reported as undrivable, because terminal content is not on the bus and
Hyprland Wayland blocks synthetic keystrokes.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENT_DESKTOP_BIN` | Explicit `agent-desktop` executable; overrides the bundled dependency. |
| `AGENT_DESKTOP_HOME` | State directory; created and enforced at `0700`. |
| `WAYLAND_DISPLAY`, `DISPLAY` | Passed through to `agent-desktop`. When unset (Herdr server, systemd, SSH, or container pane), the extension derives them from the newest `/run/user/<uid>/wayland-*` socket and the lowest `/tmp/.X11-unix/X<n>`; explicit values always win. |
| `PI_JEV_BASE_URL`, `TYPESAFE_BASE_URL` | Jev endpoint, as an API root (`https://api.typesafe.ai`) or the full `.../v1/systemone` endpoint; both resolve to the same request URL. HTTPS is required for remote hosts; plain HTTP is allowed only on loopback, and URLs with embedded credentials are rejected. |
| `PI_JEV_MODEL`, `TYPESAFE_MODEL`, `TYPESAFE_DEFAULT_MODEL` | Decision model, resolved in that order. |
| `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` | API keys. The `pi` secret files `~/.pi/agent/secrets/typesafe_api_key` and `~/.pi/agent/secrets/openrouter_api_key` are read when the variables are unset. |

With an OpenRouter key the endpoint defaults to `https://openrouter.ai/api` and
bare model names are rewritten to `~typesafe/<name>`; otherwise the request
endpoint is `https://api.typesafe.ai/v1/systemone` with model `jev-latest`. An
explicit `PI_JEV_BASE_URL` may be a root or a full `.../v1/systemone` endpoint;
the SDK root is derived so the request path is never doubled. A custom loopback
endpoint may run without a key. `cu_status` reports the resolved `endpoint` and
key origin and never prints the key.

## The Wayland boundary (ADR-0002)

On Hyprland Wayland, `agent-desktop`'s physical keyboard (`type`, `press`),
pointer gestures, window management, screenshot, and `cmd+v` paste paths fail
because they need XTEST or a GNOME Mutter session. `pi-omarchy-cu` therefore
offers only verified AT-SPI semantic Operations plus `wl-clipboard`: `click`,
`right-click`, `set-value`, `clear`, `select`, `toggle`, `check`, `uncheck`,
`expand`, `collapse`, `scroll-to`. Text entry is reconciled strictly to
`set-value`, and a target that does not advertise `SetValue` abstains with that
explanation instead of falling back to keystrokes. Nothing here shells out to
`wtype`, `hyprctl`, `grim`, or `xdotool`.

## Development

```bash
npm test          # node --test --import tsx test/*.test.ts
npx tsc --noEmit  # typecheck
npm run smoke     # load the extension in pi and list its tools
```

Tool-seam tests drive the real tool definitions with a fake `agent-desktop`
runner and a fake System One client; `test/runner-live.test.ts` exercises the
real binary when one is installed.

See `docs/adr/` for the in-process Jev client (ADR-0001) and the strict AT-SPI
execution boundary (ADR-0002), and `skills/omarchy-cu/SKILL.md` for the agent's
usage guide.

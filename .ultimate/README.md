# pi-omarchy-cu · Ultimate setup

Project-specific setup for working on this repo with Ultimate (`ultimate` in this folder).

**What this repo is.** A Pi package that gives the Pi coding agent semantic
computer use on Omarchy (Hyprland Wayland): `cu_status`, `cu_observe`,
`cu_ref`, `cu_act`, `cu_run`, a `/cu` command and the `omarchy-cu` skill.
Observation and execution go through the bundled `agent-desktop` CLI; target
and operation decisions come from TypeSafe Jev System One in-process.

**Checks before anything lands:**

```sh
npm test            # node --test --import tsx test/*.test.ts — 131 tests
npx tsc --noEmit    # typecheck
```

There is no build step, no dev server and no database. `npm run smoke` loads the
extension into Pi and lists its tools.

**Worktree setup** (`.ultimate/settings.json` → `isolates.worktree.setup`) runs
`npm ci` in every new worktree, so branches and the lander start with
`node_modules` and the bundled `agent-desktop` binary. Nothing else is copied:
credentials come from the environment or Pi's secret files, never from a
committed `.env`.

**Authoritative documents** — read these before changing behaviour:

| Document | What it settles |
| --- | --- |
| `README.md` | user-facing capabilities, install, AT-SPI flags |
| `GLOSSARY.md` | the vocabulary (Ref, Intent, Goal, Route Decision, …) |
| `docs/adr/0001`, `0002` | in-process Jev client; the strict Wayland/AT-SPI boundary |
| `.scratch/omarchy-cu/spec.md` | behaviour spec, the source of truth |
| `.scratch/omarchy-cu/design.md` | module ownership and the single test seam |
| `skills/omarchy-cu/SKILL.md` | agent-facing usage, including the TUI fallback |

**Conventions.** TypeScript ESM with `.js` import specifiers; tests only through
the tool seam (`execute(...)`) with the fakes in `test/fakes.ts`; commit subjects
`feat(cu): …`, `fix(cu): …`, `docs(cu): …`, `test(cu): …`; `agent-desktop` stays
the only desktop boundary (no `hyprctl`, `wtype`, `grim`, `ydotool`, no CDP).

**Secrets.** `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY`) is what `cu_act` and
`cu_run` need; add it in the Secrets panel (⌘K → Secrets). `cu_status` reports
the resolved endpoint and key origin, never the key.

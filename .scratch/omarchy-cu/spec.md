# Omarchy Computer Use Pi Extension (`pi-omarchy-cu`)

**Status:** ready-for-agent

## Problem Statement

When driving Linux desktop applications from the Pi coding agent on Omarchy (Hyprland Wayland), the agent faces three compounding problems:

1. **Context bloat from raw accessibility trees:** Reading a desktop application's accessibility tree directly into the main LLM context injects 50 to 500+ accessibility nodes per turn, rapidly exhausting tokens and degrading reasoning quality.
2. **Mismatched platform assumptions on Hyprland Wayland:** Generic desktop automation tools assume X11 (`XTEST`) or GNOME Mutter (`org.gnome.Mutter.RemoteDesktop`) for keystrokes, pointer gestures, window focus, and clipboard-paste fallbacks (`cmd+v`). On Hyprland Wayland, those operations fail with platform-unsupported errors, causing agents to waste turns retrying impossible actions or failing to notice that Chromium/Electron applications were launched without accessibility flags.
3. **Unverified probabilistic actions:** Letting an LLM guess coordinates or freely execute destructive UI mutations without deterministic capability reconciliation, confidence floors, risk thresholds, and post-execution verification leads to silent misfires or unintended destructive actions.

## Solution

Build a standalone Pi extension (`pi-omarchy-cu`) that combines AT-SPI semantic observation and **Ref** execution (`agent-desktop`) with in-process TypeSafe Jev System One decision-making (`@typesafe-ai/sdk`).

The extension exposes a layered 5-tool surface (`cu_status`, `cu_observe`, `cu_ref`, `cu_act`, `cu_run`), a `/cu` interactive command, and a companion skill:

- **Tree-free semantic execution (`cu_act` and `cu_run`):** The agent states a single-step **Intent** or a multi-step **Goal** in plain language. Inside the tool call, the extension reads the live **Window** or active **Overlay Surface**, filters nodes by their **Advertised Actions**, asks Jev System One for the target **Ref**, **Operation**, and destructive risk, reconciles the chosen Operation against Wayland-supported AT-SPI capabilities, enforces deterministic **Route Decision** thresholds (`act`, `confirm`, `abstain`, `needs_text`), prompts the user via `ctx.ui.confirm` when confirmation is required, and returns compact structured evidence (`Delivery Disposition`) without putting the accessibility tree into Pi's context.
- **Direct inspection and deterministic control (`cu_observe`, `cu_ref`, `cu_status`, `/cu`):** When the agent or user wants explicit tree inspection, deterministic **Ref** operations, clipboard access, app launching with accessibility environment variables enabled, or diagnostics for AT-SPI blind spots on Omarchy, dedicated tools and `/cu` subcommands provide them directly.

## User Stories

1. As a Pi user on Omarchy, I want to run `/cu status` or have the agent call `cu_status`, so that I can immediately see whether the `agent-desktop` binary, state directory (`0700` permissions), AT-SPI bus, and Jev credentials are healthy.
2. As a Pi user on Omarchy, I want `cu_status` to detect running desktop applications (such as Chromium, Electron, or Qt apps) that are missing from the AT-SPI bus and show the exact launch flags needed (`ACCESSIBILITY_ENABLED=1 ... --force-renderer-accessibility`), so that I know why an open window is invisible to automation and how to fix it.
3. As a Pi user on Omarchy, I want `cu_status` to warn about the Electron single-client AT-SPI bridge crash hazard on non-GNOME desktops, so that I do not accidentally crash an active Electron session.
4. As a Pi user, I want to run `/cu apps` and `/cu windows` interactively in the terminal, so that I can inspect visible AT-SPI applications and Window identifiers at zero token cost.
5. As a Pi agent, I want `cu_observe` with `action: "snapshot"` to default to interactive-only, compact, bounds-included, shallow skeleton reads (`-i --compact --include-bounds --skeleton`), so that explicit tree inspection stays small and readable in context.
6. As a Pi agent, I want `cu_observe` to automatically detect an open **Overlay Surface** (`sheet`, `alert`, `menu`, or `popover`) and snapshot that Overlay Surface when no explicit `surface` or **Region** `root` is specified, so that modal dialogs and popups are observed instead of `offscreen` background Window nodes.
7. As a Pi agent, I want to pass a `root` **Ref** or `maxDepth` to `cu_observe`, so that I can inspect a specific **Region** in detail when a shallow skeleton snapshot truncates child nodes.
8. As a Pi agent, I want to use `cu_observe` to run `find`, `get`, `is`, and `list-surfaces` against an application's **Window**, so that I can query specific properties, states, or open surfaces without reading the entire tree.
9. As a Pi agent, I want `cu_observe` to verify that a requested `root` **Ref** or **Overlay Surface** belongs to the pinned `windowId` when `windowId` is provided, so that multi-window applications never leak observations across Windows.
10. As a Pi agent, I want to use `cu_ref` to execute deterministic AT-SPI operations (`click`, `right-click`, `check`, `uncheck`, `toggle`, `expand`, `collapse`, `select`, `set-value`, `clear`, `scroll-to`) on a known **Ref**, so that I can act directly when I already know the target node.
11. As a Pi agent, I want `cu_ref` to return a clear Hyprland Wayland explanation whenever `set-value` fails because the target node does not advertise `SetValue`, so that I immediately understand keyboard typing (`type`/`press`) is unavailable on this session and do not waste turns retrying.
12. As a Pi agent, I want to use `cu_ref` with `action: "launch"` to launch desktop applications with `ACCESSIBILITY_ENABLED=1` and `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` automatically injected, so that newly launched apps register on the AT-SPI bus out of the box.
13. As a Pi agent, I want to use `cu_ref` with `action: "wait"` to wait for an elapsed duration, element predicate, window title, text, menu state, or event, so that I can synchronize with asynchronous UI transitions.
14. As a Pi agent, I want to use `cu_ref` for `clipboard-get`, `clipboard-set`, and `clipboard-clear` via `wl-clipboard`, so that I can read or populate the Wayland clipboard when needed.
15. As a Pi agent, I want to call `cu_act` with a plain-language **Intent** (e.g., `"press the List View button"`) without reading the accessibility tree first, so that Jev resolves the matching **Ref** and **Operation** while keeping my context window clean.
16. As a Pi agent, I want `cu_act` to support dry-run resolution (`execute: false` by default) as well as immediate execution (`execute: true`), so that I can inspect a candidate **Ref**, **Operation**, and **Route Decision** before mutating the application or execute in one step when confident.
17. As a Pi agent, I want `cu_act` to automatically rerank the top 5 candidates using richer element descriptions (including **Advertised Actions** and hidden child counts) whenever the initial wide Jev pass yields target confidence below `0.70`, so that close calls on dense Windows are disambiguated accurately.
18. As a Pi agent, I want `cu_act` to reconcile Jev's chosen **Operation** against the selected node's **Advertised Actions** over the 11 Wayland-safe Operations (`click`, `right-click`, `set-value`, `clear`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll-to`), so that an incompatible verb is corrected deterministically (e.g. a readonly combobox receives `click` rather than `set-value`).
19. As a Pi agent, I want `cu_act` to return `decision: "abstain"` with a clear explanation when an **Intent** requires text entry on a target node that does not advertise `SetValue`, so that the extension never attempts unsupported physical keystrokes on Hyprland.
20. As a Pi agent, I want `cu_act` to return `decision: "needs_text"` when the resolved **Operation** (`set-value` or `select`) requires caller-supplied text and `text` was omitted, so that the extension never invents strings.
21. As a Pi user, I want `cu_act` (when `execute: true`) and `cu_run` to prompt me interactively via `ctx.ui.confirm` whenever a step's **Route Decision** is `confirm` (`0.55 <= confidence < 0.70`, or `destructive >= 0.50` with `confidence < 0.90`, or `confirmDestructive: true`), displaying the Window, Operation, target element, confidence, and destructive score, so that I can approve or reject risky or ambiguous steps in place.
22. As a Pi agent running in a headless subagent or with `confirmPolicy: "return"`, I want `confirm` decisions in `cu_act` and `cu_run` to stop without executing and return the structured candidate details, so that the calling agent can handle confirmation in conversation.
23. As a Pi agent, I want to call `cu_run` with a high-level **Goal** (e.g., `"open the Preferences dialog and enable dark mode"`), so that the extension autonomously loops through observe, decide, act, and verify turns until the Goal is visibly met (`stop: "done"`).
24. As a Pi agent, I want `cu_run` to read Windows shallowly (`--skeleton`) first and offer `DRILL` into truncated **Regions** and `WIDEN` back to the full Window as non-mutating look Operations (`Delivery Disposition` `"looked"`), so that dense applications with hundreds of nodes can be navigated within Jev's 254-option Choice limit.
25. As a Pi user, I want `cu_run` to evaluate destructive risk via `rateRisk` before displaying any `ctx.ui.confirm` dialog (including when target confidence is between `0.55` and `0.70`), so that the confirmation prompt always shows both target confidence and destructive risk probability.
26. As a Pi user, I want `cu_run` to stream each completed turn via `onUpdate`, so that I can watch the Goal loop's progress live in Pi's TUI.
27. As a Pi user, I want pressing `Escape` in Pi to immediately cancel any in-flight `agent-desktop` subprocess or Jev System One HTTP request via `AbortSignal`, so that slow snapshots or long waits never freeze the session.
28. As a Pi user, I want `cu_act` and `cu_run` to support `noValues: true` (withholding live field values from Jev requests) and `redactText: true` (redacting caller-supplied `TYPE_TEXT` strings from output while never redacting `SELECT` option labels), so that sensitive inputs are protected without corrupting UI labels in turn output.
29. As a Pi agent, I want `cu_run` to enforce strict termination budgets (`40` operations, `80` Jev calls, `3` consecutive non-`WAIT` turns with unchanged screen fingerprints) and stop immediately on `action_failed` or `window_closed`, so that a stuck loop never spins indefinitely.
30. As a Pi user, I want `pi-omarchy-cu` to resolve Jev credentials and endpoints identically to `pi-jev` (`PI_JEV_BASE_URL` / `TYPESAFE_BASE_URL`, `PI_JEV_MODEL` / `TYPESAFE_MODEL`, `$TYPESAFE_API_KEY`, `~/.pi/agent/secrets/typesafe_api_key`, `$OPENROUTER_API_KEY`, `~/.pi/agent/secrets/openrouter_api_key`), so that it works out of the box with my existing Pi secret store, OpenRouter, or local loopback Jev server.

## Implementation Decisions

1. **In-Process Jev System One Client (per ADR-0001):**
   - Use `@typesafe-ai/sdk` directly inside the extension rather than delegating to `pi-jev`'s `jev_evaluate` tool or shelling out to external scripts.
   - Support structured object `instructions` and structured object `criteria` in `choice()` and `noul()` questions.
   - Mirror `pi-jev`'s configuration resolution order:
     - Endpoint: `PI_JEV_BASE_URL` → `TYPESAFE_BASE_URL` → `https://openrouter.ai/api` (when using an OpenRouter key) → TypeSafe default (`https://api.typesafe.ai/v1/systemone`). Enforce HTTPS for remote hosts and allow HTTP only for `localhost` / loopback IPs (`127.0.0.0/8`, `::1`), rejecting URLs with embedded credentials.
     - API Key: `$TYPESAFE_API_KEY` → `~/.pi/agent/secrets/typesafe_api_key` → `$OPENROUTER_API_KEY` → `~/.pi/agent/secrets/openrouter_api_key` → empty string when a custom loopback `PI_JEV_BASE_URL` is configured.
     - Model: explicit parameter → `PI_JEV_MODEL` → `TYPESAFE_MODEL` → `TYPESAFE_DEFAULT_MODEL` → `~typesafe/jev-latest` on OpenRouter (rewriting bare model names without `/` to `~typesafe/<name>` on OpenRouter) or `jev-latest` on TypeSafe.
   - Implement bounded retry (`429`, `503`, `529` retried up to 2 times with 500ms / 1000ms backoff) and full `AbortSignal` propagation.

2. **Strict AT-SPI + `wl-clipboard` Boundary on Omarchy (per ADR-0002):**
   - Do not shell out to compositor or virtual-keyboard tools (`wtype`, `hyprctl`, `grim`).
   - Prune X11/Mutter-only operations (`type`, `press`, `double-click`, `hover`, physical wheel `scroll`, `focus`, `focus-window`, `close-app`, `screenshot`, and the macOS `cmd+v` paste fallback).
   - In `cu_act`, offer only the 11 Wayland-safe Operations: `click`, `right-click`, `set-value`, `clear`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll-to`.
   - In `cu_run`, offer only the Wayland-safe element Operations (`CLICK` requiring `Click`, `RIGHT_CLICK` requiring `RightClick`, `TYPE_TEXT` requiring `SetValue` and executing `set-value`, `CLEAR` requiring `SetValue`, `SELECT` requiring `Select`, `CHECK` requiring `Toggle`, `UNCHECK` requiring `Toggle`, `EXPAND` requiring `Expand`, `COLLAPSE` requiring `Collapse`, `SCROLL_TO` requiring `Scroll` and executing `scroll-to <ref>`), view Operations (`DRILL`, `WIDEN`), and terminal Operations (`WAIT`, `DONE`, `BLOCKED`).
   - Reconcile text-entry intents strictly to `set-value`. When the chosen target node does not advertise `SetValue`, return `decision: "abstain"` with `why: "target does not advertise SetValue and keystroke typing is unsupported on Hyprland Wayland"`.

3. **Async `agent-desktop` Subprocess Runner & State Root Guard:**
   - Resolve the `agent-desktop` executable via `AGENT_DESKTOP_BIN` → package-local `node_modules/.bin/agent-desktop` → `/tmp/ad-probe/node_modules/.bin/agent-desktop` (fallback if present) → `PATH`.
   - Before every CLI invocation, ensure the state directory (`AGENT_DESKTOP_HOME` or `~/.agent-desktop`) exists with permissions `0700` (`chmodSync(..., 0o700)`).
   - Execute `agent-desktop` asynchronously (`execFile`) wired to Pi's `AbortSignal` and a configurable timeout (default `15000` ms for standard commands; `timeoutMs + 2000` ms for `wait`), parsing the single JSON envelope from stdout/stderr and never blocking Node's event loop.

4. **Observation & Active Overlay Surface Precedence:**
   - Walk the AT-SPI tree to collect nodes carrying a `ref_id`, recording each node's ancestor path and parent role.
   - Filter offerable candidates by withholding nodes that are `disabled`, `hidden`, advertise no `available_actions`, or are a `cell` directly inside a `treeitem` (where the parent row owns the action).
   - Detect open **Overlay Surfaces** (`sheet`, `alert`, `menu`, `popover`). When no `root` **Ref** or explicit `surface` is pinned, automatically snapshot the active Overlay Surface instead of the occluded Window behind it, verifying `outsideWindow` containment when `windowId` is pinned.

5. **Deterministic Route Decision, Risk Rating, and Interactive Confirmation:**
   - Confidence thresholds: hard floor `0.55`, ordinary action bar `0.70`, destructive action bar `0.90` (when `destructive >= 0.50`).
   - Choice validation: verify the chosen option is in the offered set, all probabilities and confidence are finite numbers in `[0, 1]`, and the probability distribution sums to `1.0 ± 0.02`.
   - In `cu_run`, call `rateRisk` whenever `0.55 <= confidence < 0.90` or `confirmDestructive: true`, ensuring any step that routes to `confirm` has a calibrated `destructive` probability before prompting.
   - When a step routes to `confirm` in `cu_act` (with `execute: true`) or `cu_run`, if `ctx.hasUI` is true and `confirmPolicy !== "return"`, call `ctx.ui.confirm` with the Window, Operation, target description, target confidence, and destructive probability. If approved, execute the step and record `confirmedByUser: true`; if declined or headless, do not execute and return the `confirm` stop/decision with candidate details.

6. **Shared Text Supply Queue & Scoped Redaction:**
   - Both `TYPE_TEXT` and `SELECT` consume from the caller-supplied `text` queue (`string | string[]`), and neither Operation is offered when the queue is empty.
   - Only strings consumed by `TYPE_TEXT` are tracked as sensitive inputs for redaction; `SELECT` option labels are never redacted so UI labels and Window titles are never corrupted.
   - `TYPE_TEXT` strings are redacted from model-bound `recent_actions` when `noValues: true` (`values: false`) or `redactText: true`, and from tool output when `redactText: true`.

7. **5-Tool Extension Surface, `/cu` Command, and Companion Skill:**
   - Register `cu_status`, `cu_observe`, `cu_ref`, `cu_act`, and `cu_run` with self-sufficient `description`, `promptSnippet`, and `promptGuidelines`.
   - Register `/cu` (`status`, `apps`, `windows`) for interactive terminal diagnostics.
   - Ship a companion `omarchy-cu` skill explaining when to use `cu_act` vs `cu_run` vs `cu_observe`/`cu_ref`, how to phrase Intents and Goals, and how to launch Chromium/Electron/Qt apps with AT-SPI enabled on Omarchy.

## Testing Decisions

1. **What makes a good test:**
   - Tests assert observable behavior and returned structured results across public boundaries given specified inputs and external boundary responses — never internal private helper implementation details.
2. **Primary testing seam (one high-level seam):**
   - The Pi extension tool execution boundary (`execute(toolCallId, params, signal, onUpdate, ctx)`) and `/cu` command handler, constructed with an injectable `CliRunner` (returning canned `agent-desktop` JSON envelopes) and an injectable `DecisionClient` (returning canned Jev System One responses) plus a fake `ExtensionContext` (`ctx.ui.confirm`).
   - All 5 tools (`cu_status`, `cu_observe`, `cu_ref`, `cu_act`, `cu_run`) are tested end-to-end through this single seam, covering Overlay Surface selection, candidate filtering, 254-option truncation, `DRILL`/`WIDEN` Region navigation, reranking, Operation reconciliation, `SetValue`-missing abstention, risk gating, interactive `ctx.ui.confirm` approval/rejection, text queue consumption (`TYPE_TEXT` vs `SELECT`), redaction, and loop stop budgets.
3. **Real subprocess smoke seam:**
   - A focused integration test exercises the real `CliRunner` against the installed `agent-desktop` binary to verify state directory `0700` permission enforcement, `status` JSON envelope parsing, and `AbortSignal` cancellation.
4. **Prior art:**
   - `node:test` with `tsx` (`node --test --import tsx`), matching `pi-jev`'s test runner and upstream `agent-desktop/scripts/jev/*.test.mjs` behavioral fixtures.

## Out of Scope

- Compositor-level or virtual-keyboard input fallbacks on Hyprland (`wtype`, `ydotool`, `hyprctl` window management, or `grim` screenshots).
- Vision/screenshot-based coordinate clicking or OCR fallback.
- Modifying global user configuration (`~/.config/hypr/`, `~/.pi/agent/settings.json`) automatically during package build or test runs.
- Sustained held-input gestures (`key-down`, `key-up`, `mouse-down`, `mouse-up`, `drag`).

## Further Notes

- The package is structured as a standalone Pi package (`"pi": { "extensions": ["./extensions/index.ts"], "skills": ["./skills"] }`) ready for local installation (`pi install /home/tuo/Projects/pi-omarchy-cu`) and subsequent publication to GitHub and npm.

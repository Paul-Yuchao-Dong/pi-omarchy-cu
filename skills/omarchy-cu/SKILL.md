---
name: omarchy-cu
description: "Drive Linux desktop applications on Omarchy (Hyprland Wayland) semantically over AT-SPI: use cu_run for a multi-step Goal, cu_act for one Intent, cu_observe/cu_ref for explicit inspection or a known Ref, cu_status for readiness and AT-SPI blind spots, and /cu for zero-token terminal diagnostics. Use whenever a task must touch a real application window (clicking, checking, selecting, typing into fields, opening menus or dialogs) instead of the filesystem or shell."
---

# Omarchy computer use

`pi-omarchy-cu` lets you operate real desktop applications through the
accessibility tree. The tree never enters your context: each tool call returns
compact evidence about the chosen target, Operation, Route Decision, and
Delivery Disposition.

## Pick the smallest tool

| Situation | Tool |
| --- | --- |
| You know the visible end state, it needs several steps | `cu_run` with a **Goal** |
| One step against the live screen, you may not know the Ref | `cu_act` with an **Intent** |
| You already have a Ref, or you want deterministic clipboard / wait / launch | `cu_ref` |
| You need to read the tree, a Region, or a specific property | `cu_observe` |
| Is anything even addressable? Which app is invisible to AT-SPI? | `cu_status`, `/cu status`, `/cu apps`, `/cu windows` |

Never guess coordinates and never shell out to `wtype`, `hyprctl`, or `grim`:
that is out of scope by ADR-0002 and does not work on Hyprland Wayland.

## Phrasing Intents and Goals

- Say the visible outcome, not the mechanism: `"turn on the Dark Mode switch"`,
  not `"call toggle on @s1:e2"`.
- Quote the labels you can see in a `cu_observe` snapshot; they are the
  strongest signal the decision model gets.
- One step per **Intent**. If the sentence needs "then", use `cu_run`.
- A **Goal** is the end state you could verify by looking: `"open Preferences,
  switch to Appearance, and enable Dark Mode"`. Include the window or dialog
  names you expect to see, so the loop can tell when it is done.
- Prefer `DRILL`/`WIDEN` over more `cu_run` calls when a window is dense: the
  loop offers those itself when a skeleton read truncates a **Region**.
- On `abstain`, read `why` instead of retrying the same Intent. On `needs_text`,
  re-run with `text`.

## Which application to drive

- Pass `app` with a name from `cu_status` apps (or a desktop-entry name). Casing
  and near-misses are resolved against `list-apps`, so `"notes"` reaches
  `Notes`.
- Omit `app` when only one application is in the foreground: `cu_act` and
  `cu_run` scope to it automatically and say so in `notes`.
- With several foreground applications nothing is guessed. The error lists
  them; pass `app` or `windowId` instead of retrying.
- An application that is not running gets launch guidance: `cu_ref` with
  `action: "launch"` and that `app`, which injects the accessibility
  environment.
- **Terminal/TUI applications cannot be driven.** cliamp, nvim, btop, and
  friends draw inside a terminal that never joins the AT-SPI bus, and Hyprland
  Wayland blocks synthetic keystrokes. Requests like "play NCS Chill on
  cliamp" explain that and stop; use the shell or the app's own CLI instead.
  The same applies to a canvas with no accessible nodes: `cu_act` returns
  `abstain` without spending a decision call.

## Text supply

- `cu_act` and `cu_run` take `text: string | string[]`. `TYPE_TEXT` (executed as
  `set-value`) and `SELECT` both consume one string per turn, in order, so pass
  the values in the order you expect them to be used.
- Both Operations are only offered while the queue is non-empty. If the app
  needs more text than you supplied, the loop stalls on `abstain`; re-run with
  the remaining values.
- Only `TYPE_TEXT` strings are treated as sensitive. `SELECT` option labels are
  normal UI labels and are never redacted.
- `noValues: true` withholds live field values from the decision request and
  from model-bound history. `redactText: true` also redacts typed strings from
  the tool output itself. Use both for passwords, tokens, and personal data.

## Confirmation

- A step that lands in the Route Decision `confirm` band (target confidence
  `0.55`–`0.70`, destructive risk `>= 0.50` below `0.90` confidence, or
  `confirmDestructive: true`) prompts the user in Pi with the Window, Operation,
  target, target confidence, and destructive probability.
- `cu_run` rates destructive risk before it prompts, so the prompt never shows
  an unrated step as safe.
- In a headless subagent, or with `confirmPolicy: "return"`, no prompt appears:
  the call returns `stop: "confirm: ..."` plus the `confirm` candidate. Ask the
  user in conversation, then re-run, or execute that single step with `cu_act`.
- `cu_act` defaults to a dry run. Pass `execute: true` only when you accept the
  step landing immediately.

## Stop reasons worth handling

`done` (Goal visibly met), `blocked` (model cannot proceed — ask the user),
`confirm: ...` (needs approval), `abstain: ...` (policy refused: read `why`),
`error: action_failed | window_closed | root_outside_window |
surface_outside_window`, `budget: operations`, `budget: jev calls`,
`unchanged: 3 turns` (the screen stopped reacting — re-observe or ask).

## Launching apps so AT-SPI can see them

An application that started without its toolkit's accessibility switch never
registers on the bus; `list-apps` looks healthy and empty and every snapshot
finds nothing. Check `cu_status` (or `/cu status`) first: it reports running
Chromium, Electron, and Qt processes that are missing from the bus together
with the exact relaunch flags.

- **Chromium**: `ACCESSIBILITY_ENABLED=1 chromium --force-renderer-accessibility`
  (`ACCESSIBILITY_ENABLED=1` alone puts the browser on the bus with no windows).
- **Qt**: `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 <app>` (or `QT_ACCESSIBILITY=1`).
- **Electron**: no accessibility flag needed; add `--no-sandbox` only where
  `chrome-sandbox` is not setuid. On non-GNOME desktops keep another AT-SPI
  client connected: the Electron bridge can crash when `agent-desktop` is its
  only client.

`cu_ref` with `action: "launch"` injects `ACCESSIBILITY_ENABLED=1` and
`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` for you. Relaunching an app loses the
user's state, so ask before you do it.

## Reading results

- `delivery`: `delivered_verified` (the app confirmed the change),
  `delivered_unverified` (sent, not confirmed), `not_delivered` (safe to
  reconsider, not to blind-retry), `looked` (non-mutating observe/drill/wait).
- `changed: false` on a mutating turn means the screen fingerprint is identical
  after the Operation; three of those in a row stop the loop.
- `cu_run` streams each completed turn as a progress update, so the user sees
  the Goal advance live.

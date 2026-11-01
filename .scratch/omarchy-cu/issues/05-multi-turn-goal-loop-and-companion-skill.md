# 05: Multi-Turn Jev Goal Loop and Companion Skill (`cu_run` & Skill Documentation)

**What to build:** Deliver the `cu_run` tool and the companion `omarchy-cu` skill end-to-end so the Pi agent can hand a plain-language **Goal** to the extension and have it autonomously observe, decide, confirm when risky, act, and verify across turns until the Goal is satisfied (`stop: "done"`) or a stop condition is reached.

**Blocked by:** 04: Single-Step Jev Intent Resolution and Execution (`cu_act`)

**Status:** done

- [x] `cu_run` observes the target **Window** (using `--skeleton` overview first, or `--root` when drilled into a **Region**, and auto-switching to open **Overlay Surfaces**), constructs the per-Operation target lists (`CLICK`, `RIGHT_CLICK`, `TYPE_TEXT` via `set-value`, `CLEAR`, `SELECT`, `CHECK`, `UNCHECK`, `EXPAND`, `COLLAPSE`, `SCROLL_TO`, plus `DRILL`, `WIDEN`, `WAIT`, `DONE`, `BLOCKED`), and queries Jev for `operation` and `<operation>_target` in one call.
- [x] Whenever the chosen target's confidence is in `[0.55, 0.90)` or `confirmDestructive: true`, `cu_run` evaluates destructive risk via `rateRisk` before routing, ensuring any `ctx.ui.confirm` prompt displays both target confidence and destructive probability.
- [x] On a `confirm` **Route Decision**, `cu_run` prompts via `ctx.ui.confirm` when `ctx.hasUI` is true and `confirmPolicy !== "return"`; if approved, it executes the Operation with `confirmedByUser: true` and continues the loop; if declined or headless, it yields `{ stop: "confirm: ...", candidate }` and terminates cleanly.
- [x] Both `TYPE_TEXT` and `SELECT` consume from the caller's `text` queue (`string | string[]`), neither is offered when the queue is empty, `SELECT` option labels are never added to redaction secrets, and `TYPE_TEXT` values are redacted from model history when `noValues: true` or `redactText: true` (and from tool output when `redactText: true`).
- [x] `cu_run` streams each turn's summary via `onUpdate`, computes SHA-1 screen fingerprints after mutating turns to detect whether the Window changed, and stops cleanly on `done`, `blocked`, `action_failed`, `window_closed`, `root_outside_window`, `surface_outside_window`, `40` operations, `80` Jev calls, or `3` consecutive non-`WAIT` turns with `changed: false`.
- [x] Ship `skills/omarchy-cu/SKILL.md` and `README.md` documenting the 5 tools, `/cu` command, Intent/Goal phrasing rules, and Omarchy AT-SPI flags.
- [x] End-to-end tool-seam tests verify multi-turn Goal completion, `DRILL`/`WIDEN` Region navigation, `rateRisk` + `ctx.ui.confirm` approval/decline, `TYPE_TEXT` vs `SELECT` queue consumption and redaction, and all budget/error stop conditions.

## Comments
- 2026-11-01: Implemented and merged on `integration` (commit 51a5f75768df528d5442ec9c984863e2a71f6e92). Tests: `npm test` (110 pass), `npx tsc --noEmit` clean.

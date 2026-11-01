# 04: Single-Step Jev Intent Resolution and Execution (`cu_act`)

**What to build:** Deliver the `cu_act` tool end-to-end so the Pi agent can resolve and optionally execute one plain-language **Intent** against a live **Window** or **Overlay Surface** without loading the accessibility tree into Pi's context. `cu_act` observes the active surface, filters offerable **Ref** candidates, evaluates a 5-question Jev System One request (`target`, `command`, `present`, `destructive`, `needs_text`), reranks the top 5 candidates with richer descriptions when first-pass target confidence is below `0.70`, reconciles the chosen **Operation** against the node's **Advertised Actions** over the 11 Wayland-safe Operations, applies the deterministic **Route Decision** policy (`act`, `confirm`, `abstain`, `needs_text`), prompts via `ctx.ui.confirm` on `confirm` when `execute: true` and UI is available, and executes the resolved Operation.

**Blocked by:** 02: Window, Region, and Overlay Surface Observation (`cu_observe`), 03: Deterministic Ref Execution, App Launch, and Clipboard Operations (`cu_ref`)

**Status:** done

- [x] `cu_act` collects nodes with a `ref_id`, withholds `disabled`, `hidden`, action-less nodes, and `cell` nodes directly inside a `treeitem`, and caps candidates at 254 options (recording a truncation note when exceeded).
- [x] `cu_act` sends a single 5-question Jev System One request (`target` choice with `none`, `command` choice over the 11 Wayland-safe Operations, `present` noul, `destructive` noul, `needs_text` noul) and validates choice coherence.
- [x] When initial `target` confidence is below `0.70` (and not `none`), `cu_act` automatically re-queries Jev over the top 5 candidates using rich descriptions (including **Advertised Actions** and hidden child counts) and marks `reranked: true` in notes.
- [x] `cu_act` reconciles the chosen Operation against the selected node's **Advertised Actions** and caller-supplied `text`: if the Intent or supplied `text` requires text entry on a node that does not advertise `SetValue`, it returns `decision: "abstain"` with `why: "target does not advertise SetValue and keystroke typing is unsupported on Hyprland Wayland"`; if `set-value` or `select` is resolved without `text`, it returns `decision: "needs_text"`.
- [x] `cu_act` computes the deterministic **Route Decision** (`act` at `>= 0.70` or `>= 0.90` when `destructive >= 0.50`, `confirm` between `0.55` and the bar or when `confirmDestructive: true`, `abstain` below `0.55` or `present < 0.30` or `none`).
- [x] When `execute: true` and the **Route Decision** is `confirm`, `cu_act` prompts via `ctx.ui.confirm` (when `ctx.hasUI` is true and `confirmPolicy !== "return"`), executing and setting `confirmedByUser: true` on approval, or returning `NOT_EXECUTED` when declined or headless.
- [x] End-to-end tool-seam tests cover high-confidence `act`, top-5 reranking, verb reconciliation, missing-`SetValue` abstention, `needs_text`, and interactive vs headless `confirm` gating.

## Comments
- 2026-11-01: Implemented and merged on `integration` (commit 9bce979c000db46f18a24017665806bfcddb6af1). Tests: `npm test` (110 pass), `npx tsc --noEmit` clean.

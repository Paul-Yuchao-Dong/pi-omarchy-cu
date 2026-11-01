# 03: Deterministic Ref Execution, App Launch, and Clipboard Operations (`cu_ref`)

**What to build:** Deliver the `cu_ref` tool end-to-end so the Pi agent can execute deterministic AT-SPI operations on a known **Ref** (`click`, `right-click`, `check`, `uncheck`, `toggle`, `expand`, `collapse`, `select`, `set-value`, `clear`, `scroll-to`), synchronize with UI state (`wait`), read or mutate the Wayland clipboard (`clipboard-get`, `clipboard-set`, `clipboard-clear`), and launch desktop applications (`launch`) with AT-SPI accessibility environment variables automatically enabled.

**Blocked by:** 01: Readiness, AT-SPI Blind-Spot Diagnostics, and `/cu` Command (`cu_status` & `/cu`)

**Status:** done

- [x] `cu_ref` executes all 11 Wayland-safe **Ref** operations (`click`, `right-click`, `check`, `uncheck`, `toggle`, `expand`, `collapse`, `select`, `set-value`, `clear`, `scroll-to`) and returns the structured **Delivery Disposition** (`delivered_verified`, `delivered_unverified`, `not_delivered`), post-state, and step evidence.
- [x] When `set-value` fails because the target **Ref** does not advertise `SetValue` (`ACTION_NOT_SUPPORTED` or `POLICY_DENIED`), `cu_ref` enriches the error with an explicit Hyprland Wayland diagnostic explaining that semantic `SetValue` is not advertised by this element and physical keystroke input (`type`/`press`) is unsupported on Hyprland Wayland.
- [x] `cu_ref` supports `wait` (by milliseconds, `--element` predicate, `--window` title, `--text`, `--menu`, `--menu-closed`, or `--event`), sizing the subprocess timeout to accommodate the requested wait duration and honouring `AbortSignal`.
- [x] `cu_ref` supports `clipboard-get`, `clipboard-set`, and `clipboard-clear`.
- [x] `cu_ref` supports `launch` and automatically sets `ACCESSIBILITY_ENABLED=1` and `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` in the spawned environment (with optional extra arguments/flags).
- [x] End-to-end tool-seam tests verify every `cu_ref` operation, `set-value` diagnostic enrichment on Hyprland, `wait` timeout sizing, clipboard operations, and accessibility-enabled `launch`.

## Comments
- 2026-11-01: Implemented and merged on `integration` (commit 64810f86ffff7f568ff9eb1001e30f2aac83689e). Tests: `npm test` (110 pass), `npx tsc --noEmit` clean.

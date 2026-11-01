# 02: Window, Region, and Overlay Surface Observation (`cu_observe`)

**What to build:** Deliver the `cu_observe` tool end-to-end so the Pi agent can inspect a live **Window**, **Region**, or active **Overlay Surface** on the AT-SPI bus (`snapshot`, `find`, `get`, `is`, `list-surfaces`). By default, `snapshot` performs a compact, interactive-only, bounds-included shallow skeleton read (`-i --compact --include-bounds --skeleton`) and automatically shifts observation to an open **Overlay Surface** (`sheet`, `alert`, `menu`, `popover`) when no explicit `surface` or **Region** `root` **Ref** is specified.

**Blocked by:** 01: Readiness, AT-SPI Blind-Spot Diagnostics, and `/cu` Command (`cu_status` & `/cu`)

**Status:** ready-for-agent

- [ ] `cu_observe` with `action: "snapshot"` defaults to `-i --compact --include-bounds --skeleton` when no `root` **Ref** or `maxDepth` is provided, and respects explicit overrides for `interactiveOnly`, `compact`, `includeBounds`, `skeleton`, `maxDepth`, `root`, and `surface`.
- [ ] When `surface` and `root` are omitted on `snapshot`, `cu_observe` detects any open **Overlay Surface** (`sheet`, `alert`, `menu`, `popover`) in the initial Window tree and automatically snapshots that Overlay Surface, reporting the active surface in the returned metadata.
- [ ] When `windowId` is specified alongside `root` or an auto-detected **Overlay Surface**, `cu_observe` verifies window containment and fails with a clear `root_outside_window` or `surface_outside_window` error if the target belongs to a different Window.
- [ ] `cu_observe` supports `find` (by role, name/text, or state), `get` (property read on a **Ref**), `is` (state predicate check on a **Ref**), and `list-surfaces` for an application Window.
- [ ] End-to-end tool-seam tests verify default skeleton snapshots, explicit **Region** (`root`) snapshots, automatic **Overlay Surface** switching, cross-window containment rejection, and `find`/`get`/`is`/`list-surfaces` queries.

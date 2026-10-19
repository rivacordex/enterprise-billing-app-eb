# Billing Management — Update Overview

This file holds the in-flight update to the Billing Management module, and is folded into `billmgmt-project-overview.md` at that update's ship gate. **No update is in flight.** Until the next one is planned, it holds pointers only (workflow rules §7.8).

| Update | Units | Status | Where it lives now |
|---|---|---|---|
| Target Capacity Pricing | bm40–bm46 (+ bm42a) | Delivered | `billmgmt-project-overview.md` › Target Capacity Pricing update |
| Invoice Template (company profile, template, binder, CSV) | bm47–bm63 | Delivered, signed off 2026-10-11 | `billmgmt-project-overview.md` › Invoice Template update |
| Invoice Template Phase 3 — bill run uses the BAN's template | bm64–bm73 | Delivered, signed off by bm73 (2026-10-17) | `billmgmt-project-overview.md` › Invoice Template Phase 3 |

**Pointers:**
- Decisions: `_updatemodule-billing-invoice-template-phase3-billrun-plan.md` (D1–D60).
- Invariants: `billmgmt-architecture.md` §6 (#51–#58 and the 2026-10-15 amendments).
- Guardrails: `billmgmt-code-standards.md` items 57–67.
- Units and specs: `specs/bm00-build-plan.md` Part 5, `specs/bm64`–`bm73`.
- Status, the bm73 invariant audit and the run timings: `billmgmt-progress-tracker.md`.
- Deferred to the phase that adds a second family: the BAN family dropdown and the create/retire family screens (D45, D46).

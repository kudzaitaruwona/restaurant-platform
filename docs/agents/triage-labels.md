# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Other labels in this repo

| Label | Meaning |
| ----- | ------- |
| `chain:N-…` | The build chain (phase) the issue belongs to. Each chain has a parent issue with its tickets as sub-issues, listed in waves; tickets in the same wave can run in parallel. |
| `slice` / `decision` / `setup` | Ticket type. Slices are vertical (DB → server → UI) and demoable on their own. |
| `needs-confirmation` | Implements a **Proposed** item from the specs. Safe to build; confirm before going live. |
| `gate:before-first-venue` | Must ship before the first real venue is onboarded. Blocks nothing in the tracker. |
| `model:opus` | Execute with Claude Opus: sets patterns or protects seats, money, tenants or auth. |
| `model:sonnet` | Execute with Claude Sonnet: standard feature slice with a clear spec. |
| `model:haiku` | Execute with Claude Haiku: small, well-bounded UI, query or checklist work. |

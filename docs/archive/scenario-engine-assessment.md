# The legacy Scenario Engine: KEEP / ADAPT / MIGRATE / RETIRE

> **Archive.** This describes the pre-kernel application, which has been retired: the engines, pages and tables it discusses were replaced by the layers in [the architecture](../architecture/helm-architecture.md). It is kept as history and is not a description of HELM today.

**Phase 4** · Companion to [ADR-0019](../adr/0019-scenario-runtime.md)

Before Phase 4 HELM already had something called a scenario engine:
`src/domain/engines/scenario.ts`, a `helm_scenarios` table with `baseline` and
`variants` JSON columns, a `ScenariosPage` list and a `ScenarioDetailPage`.
The Phase 4 brief required an explicit assessment rather than a quiet rewrite,
so this is it: what the old thing actually was, and what happened to each part.

## What the legacy engine was

A **cost-volume-profit what-if calculator**. A `ScenarioBaseline` held four
numbers — unit price, units per period, variable cost per unit, fixed costs —
and a `ScenarioVariant` held percentage or absolute deltas against them. The
engine applied the deltas, ran `analyzeCvp`, and reported revenue, contribution
margin, operating profit, break-even units, and the change against baseline.

It was competent at what it did. What it was not:

| Property Phase 4 needs | Legacy engine |
| --- | --- |
| Branches the **enterprise model** | Branches four numbers in a JSON blob |
| Reaches the value graph | Never touches it |
| Uses the propagation engine | Has its own arithmetic (floats) |
| Traceable to explicit assumptions | Deltas have no author, rationale or confidence |
| Temporally bounded | No fork point, no periods, no lenses |
| Reproducible | Recomputes from live baseline JSON every render |
| Isolated per tenant at the store | RLS on the row, but no run record to isolate |
| Multi-period | Single unnamed "per period" |

The gap is not a feature gap. The two things answer different questions: "what
if this product's unit economics changed" versus "what happens to the
enterprise if we expedite this shipment".

## The assessment

| Part | Verdict | What happened |
| --- | --- | --- |
| `helm_scenarios` **table** | **MIGRATE** | Kept and extended in place. New columns `key`, `parent_scenario_id`, `scenario_entity_id`, `status`, `status_reason`, `metadata`; the lifecycle CHECK widened to the analytical lifecycle; a guard added for identity immutability and legal transitions. `baseline`, `variants` and `decision_id` are retained and `COMMENT`-marked RETIRED. A row is a kernel scenario exactly when it has both a key and an ontology entity (`helm_scenarios_kernel_coherent`); legacy rows have neither and keep their own (retired) rules. Nothing was dropped, nothing was rewritten. |
| `src/domain/engines/scenario.ts` | **RETIRE** | Deleted. Its CVP arithmetic is float-based and duplicates `analyzeCvp`, which stays for the Economics surface. |
| `ScenarioVariant` / `ScenarioBaseline` / `ScenarioDeltas` types | **RETIRE** | Deleted from `src/domain/types.ts`. Replaced by `ScenarioRevision` + `ScenarioOverride`, which carry the author, rationale, confidence and provenance the old shape had nowhere to put. |
| `ScenarioDetailPage` | **RETIRE** | Deleted. `/scenarios/:id` now redirects to `/scenarios`, so old links land somewhere sensible rather than on a 404. |
| `ScenariosPage` | **ADAPT** (route kept, contents replaced) | Same route, same place in the navigation; the page is now the Scenario Explorer over the kernel. |
| `mapScenario`, the store slice, `demoScenarios` | **RETIRE** | Deleted. The explorer reads through `ScenarioStore`, not the app store. |
| `analyzeCvp` (`src/domain/engines/cvp.ts`) | **KEEP** | Untouched. It is the Economics surface's break-even tool and was never a scenario engine; only its use *as* one is retired. |
| The Decision detail page's **Scenarios tab** | **ADAPT** | No longer renders CVP variants. It points at `/scenarios` and states plainly that attaching a scenario revision to a decision arrives with Decision Intelligence (Phase 5). |

## Why not a big-bang rewrite

Two things made the incremental path cheap enough to be obviously right:

1. **The table had no rows to migrate.** `helm_scenarios` is empty in the shared
   database, so extending it in place cost one additive migration and no data
   transformation. Dropping and recreating it would have been the same work plus
   a broken foreign key from `helm_decisions`.
2. **The retired code had one consumer each.** The CVP scenario engine was used
   only by `ScenarioDetailPage`; the store slice only by the two pages. Removing
   them is a deletion, not a refactor.

The one thing that was *not* incremental is the semantics. A legacy scenario and
a kernel scenario are not two versions of one concept, and pretending otherwise
— by writing a converter, say — would have produced kernel scenarios whose
overrides had no author, no rationale, no confidence and no fork point. The
legacy columns are retained so that no history is destroyed, and left unread.

## What a reader should check

- `verify:schema` lists `helm_scenario_revisions`, `helm_scenario_overrides` and
  `helm_scenario_runs` as append-only tables.
- `verify:scenario-schema` asserts the migration is additive, that the retired
  columns are still present and commented, and that `STRUCTURAL_OVERRIDE` is not
  storable.
- `grep -r "domain/engines/scenario" src/` returns nothing.

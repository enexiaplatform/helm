# Projection Decisions — which domain tables become ontology entities

Phase 2 §12's rule: **reference or project — do not duplicate operational state
unnecessarily.** The ontology is the semantic layer. It does not mean every
relational domain object disappears.

This document records the decision for each existing HELM table, so a future
engineer does not have to re-derive it.

## 1. The three options

| Option | Meaning | When it applies |
| --- | --- | --- |
| **Project** | Create a `helm_entities` row referencing the table row by `source_system='helm'` + `source_ref`. The table stays authoritative for its own columns. | The object participates in cross-functional value or management reasoning |
| **Reference only** | No entity. Other layers reach it through an existing relational foreign key. | The object is internal to one engine and never appears in a value chain |
| **Leave alone** | Neither. | Operational detail below the management altitude, or governance state that belongs in relational tables |

Projection never copies values. That is
[ADR-0007](../adr/0007-value-graph-projection.md), and
`verify:value-schema` asserts the value graph does not reintroduce copied
columns.

## 2. Decisions

| Table | Decision | Reasoning |
| --- | --- | --- |
| `helm_cost_objects` | **Project** (Phase 3) | A cost object is exactly what margin, revenue and working-capital nodes attach to. It becomes a `BusinessUnit` / `Product` / `Customer` entity depending on its `kind`, and `helm_economics` stays the authoritative source for its numbers. |
| `helm_inventory_items` | **Project** (Phase 3) | An inventory position is the contended resource in the canonical scenario. It becomes an `Inventory` entity; stock levels stay in the table and surface as `AvailableInventory` observations. |
| `helm_processes` / `helm_process_activities` | **Project the process, not the activities** (Phase 3) | A process is a `Capacity` pool that constrains service level. Individual activities are below management altitude — they are the capacity engine's internal detail and stay in their table. |
| `helm_economics` | **Leave alone** | Period economics per cost object is a fact table. Projecting every row would create entities in proportion to transaction volume, which §12 and the altitude rule both forbid. It feeds *observations*, not entities. |
| `helm_signals` | **Reference only** for now | A signal is already an ontology *type*, and Phase 5 will link signals to value nodes. Projecting existing rows adds nothing until that link exists. |
| `helm_decisions` and its children | **Leave alone** (governance stays relational) | [ADR-0011](../adr/0011-reconcile-decision-and-value-models.md): the graph models the enterprise, relational tables govern the process. A decision's lifecycle needs constraints, RLS and append-only guarantees that a generic graph cannot give. Phase 5 adds a `Decision` entity as a *projection* so decisions can appear in value chains, while `helm_decisions` stays authoritative. |
| `helm_scenarios` | **Bridge, not project** (Phase 4) | See [scenario-decision-integration.md](scenario-decision-integration.md). Value observations already reference a `Scenario` *entity*; the existing scenario engine keeps its own table and gains an adapter. |
| `helm_approval_rules` | **Leave alone** | Superseded by `helm_authority_rules` in Phase 6. Projecting a table about to be replaced would be waste. |
| `helm_org_settings` | **Leave alone** | Configuration, not an enterprise object. |
| `organizations`, `org_units` | **Project `org_units`** (Phase 3) | Units are the `Enterprise` / `Region` / `Country` / `BusinessUnit` spine. `organizations` is the tenant itself and stays outside the graph — an organization is not an entity *within* its own graph. |

## 3. Why Phase 2 projects nothing

All of the "Project (Phase 3)" rows above are deferred deliberately:

1. **There is nothing to project.** Every one of those tables is empty in the
   shared database. Projection code with no data to run against is untested
   code that will drift.
2. **Projection needs a consumer.** A projected cost object is useful when a
   calculation reads `helm_economics` through its value node — which is Phase 3.
   Building the projection first would mean guessing at the consumer's needs.
3. **The canonical scenario already proves the pattern.** The Phase 1 fixture
   creates entities carrying `source_system='helm'` and a `source_ref`, and the
   Phase 2 value nodes attach to them. The mechanism is exercised; only the
   bulk application is deferred.

`verify:value-schema` enforces the non-duplication rule now, so when projection
does run it cannot quietly become a copy.

## 4. The rule that governs future decisions

> If an object would generate entities in proportion to **transaction volume**,
> it is the wrong altitude. If it generates entities in proportion to the
> **management model**, project it.

`helm_economics` has one row per cost object per period per kind — volume.
`helm_cost_objects` has one row per thing management reasons about — model.

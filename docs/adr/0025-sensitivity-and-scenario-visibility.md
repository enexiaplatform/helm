# ADR-0025: Sensitivity classes, scenario visibility, private helpers and decision-type tenancy

**Status** accepted · **Date** 2026-09-29 · **Deciders** Architecture ·
**Phase** 7 · **Amends** [ADR-0022](0022-decision-authority-graph.md) ·
**Implements** [security-model §4.2](../architecture/security-model.md#42-sensitivity-classes)

## Context

Phase 6 scoped decisions by org unit, and left four gaps it named:

1. The model underneath a decision — scenarios, their runs, values and
   calculation steps — was still readable org-wide. A member could read a
   scenario bound to a decision they could not see.
2. There were no sensitivity classes: a margin and an operational lead time sat
   in one tier.
3. The SECURITY DEFINER visibility helpers lived in `public`, callable over the
   API like any RPC.
4. Decision types were global keys: one organization's type would collide with
   another's, or shadow a system type.

A digital twin makes each worse. It composes all of them into one snapshot, so
a snapshot is readable only if everything in it may be read by the viewer.

## Decision

### 1. Five sensitivity classes — compartments, not levels

`GENERAL_MANAGEMENT`, `FINANCIAL_SENSITIVE`, `COMMERCIAL_CONFIDENTIAL`,
`HR_RESTRICTED`, `STRATEGIC_RESTRICTED`.

- A class belongs to a **metric** (`helm_value_metrics.sensitivity`; 16
  metrics classified, the rest are general) and may be overridden per value
  node. Items inherit it: a twin item's class is its metric's.
- Classes are **compartments**. Holding `FINANCIAL_SENSITIVE` says nothing
  about `COMMERCIAL_CONFIDENTIAL`. There is no ordering to climb.
- `GENERAL_MANAGEMENT` needs no clearance. Admins hold every class. Anyone else
  needs an explicit, time-bounded **clearance**
  (`helm_sensitivity_clearances`: user, class, valid from/to, reason, granted
  by an admin). A member cannot grant themselves one.
- A container's label (a snapshot) is the **union** of its items' classes —
  derived from the contents, never declared. The database refuses a header
  whose label differs.

### 2. Visibility first, then sensitivity per item — and say what was withheld

Reading a snapshot is two independent gates:

1. **Visibility** — may this viewer see the snapshot at all? (admin, builder,
   or member of a granted unit or any unit above it.)
2. **Sensitivity** — for each item, is its class cleared?

`projectForViewer` returns the visible items **and a statement of what was
withheld** (how many items, of which classes). Nothing disappears silently; a
twin that hides a number without saying so is lying by omission.

### 3. Scenario visibility: capture by binding

A scenario is visible to: an admin ∨ its creator ∨ a member of a unit it is
explicitly shared with (subtree-inclusive) ∨ anyone who can see a decision one
of whose alternatives binds it ∨ everyone, **if** it is `ORG_WIDE` **and**
bound to no decision.

**Binding captures a scenario.** Once a restricted decision binds it, the
org-wide default stops applying. `RESTRICTED` scenarios are shared through
`helm_scenario_visibility` grants. Runs, calculation runs, steps and scenario
values follow their scenario, and a value additionally follows its class: a
step is readable only when every value it carries is.

### 4. Visibility is not authority

Seeing a decision does not let a person approve it, and being able to approve
does not widen what one can see. The helpers and the authority engine never
import each other; `verify:twin-security` and `verify:decision-visibility`
fail if they do. A clearance widens *which items* a person reads inside what is
already visible to them — never which snapshots.

### 5. Private helpers

The SECURITY DEFINER helpers move to a schema the API does not expose,
`helm_private`: `visible_org_units`, `can_see_decision`, `can_see_revision`,
`has_clearance`, `node_sensitivity`, `step_cleared`, `can_see_scenario`,
`can_see_scenario_entity`, `can_see_scenario_run`, `can_see_calculation_run`,
`can_see_twin_snapshot`. `EXECUTE` is revoked from `PUBLIC` and `anon`. Every
Phase 6 policy is re-pointed at them and the three public helpers are dropped.
The five shared-core helpers Memoire relies on are unchanged.

This is an architecture change to the security model (helpers were in
`public`); hence this ADR.

### 6. Occupancy end carries its record time

`helm_role_occupancies.ended_at` is stamped by the guard (`NEW.ended_at :=
now()`) when an occupancy is ended; a row cannot be inserted already ended.
Without it, a snapshot of "who held the seat as known on 23 Sep" would read a
later ending as if it were known then.

### 7. Decision-type tenancy: system canonical + organization extension

`helm_decision_types` gains `org_id` (NULL = system) and an `id` primary key,
with partial unique indexes: a system key is unique; an organization's key is
unique within it and may not equal a system key. Only admins extend the
registry. The two foreign keys onto `helm_decision_types(key)` are superseded
(not removed) by a key-format CHECK on each referencing table plus
`helm_decision_type_ref_guard`, which accepts a system type or one of the
row's own organization's — a condition a foreign key cannot express.

### 8. Minimal customer classification

A customer's account class (`STRATEGIC_ACCOUNT`, `KEY_ACCOUNT`,
`STANDARD_CUSTOMER`) is a `BELONGS_TO` relationship to a `Segment` entity with
that `segmentCode` — ontology data, valid-timed like any relationship. A
reclassification is a structural change in the twin delta. An unclassified
customer in scope is reported (`UNCLASSIFIED_CUSTOMER`), never assumed standard.
No tiering engine, no scoring.

## Consequences

- Scenarios, runs, values and steps are no longer org-wide by default once a
  decision binds them — proven server-side (Industrial loses a scenario the
  moment a Pharma decision binds it; the Country GM above both keeps it).
- The model's financial numbers are unreadable without a clearance even inside
  a visible snapshot. In the demo, the Country GM holds financial and
  commercial clearances; the Finance Director financial only.
- The helper warnings from Phase 6 are gone from the advisors.
- Field-level redaction exists for twin items (by class). Decision rows are
  still row-shaped: sharing a decision while hiding its amount remains a gap.
- Per-entity-type classes (e.g. HR entities) are not modelled yet — no HR data
  exists; the class is reserved.

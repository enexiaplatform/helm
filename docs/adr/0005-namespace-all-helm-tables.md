# ADR-0005: Namespace every HELM table `helm_*`

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

HELM and Memoire share one Postgres database
([ADR-0003](0003-supabase-postgres-system-of-record.md)). Memoire holds live
production data and its schema is untouchable.

The brief's Phase 1 (§10) names the ontology tables `entities` and
`relationships`.

**Both names are already taken.** Discovery found them as Memoire's user-scoped
semantic-capture tables, complete with pgvector embeddings:

```
public.entities(id, user_id, entity_type, name, description,
                attributes jsonb, tags[], created_at, updated_at,
                embedding vector)
public.relationships(id, user_id, source_entity_id, target_entity_id,
                     relationship_type, created_at)
```

Their semantics are incompatible with HELM's requirement in every dimension that
matters: scoped by `user_id` rather than `org_id`, no temporal validity, no
provenance, no confidence, no scenario overlay. They cannot be shared, extended,
or repurposed — and they cannot be renamed, because Memoire owns them.

This is not a hypothetical. Following the brief literally would have produced
either a migration failure or, worse, a `CREATE TABLE IF NOT EXISTS` that
silently succeeded against the wrong table and left HELM writing org data into a
user-scoped table with no `org_id` column.

## Problem

How does HELM name its tables so collisions with Memoire are impossible — now and
as both products grow independently?

## Options considered

1. **Follow the brief's names.** Impossible; the names exist with incompatible
   semantics.
2. **A separate Postgres schema, `helm.*`.** Clean namespacing and the most
   "correct" answer in the abstract. But Supabase's client API and RLS tooling are
   materially smoother on `public`; exposing another schema requires additional
   configuration and grants; and cross-schema references to `auth.users` and
   Memoire tables add friction to every migration. Real cost, modest benefit over
   option 3.
3. **Prefix every table `helm_*` in `public`.** Already the established
   convention for the 14 existing HELM tables. Zero new configuration. Collision
   becomes impossible by inspection, and a reader can tell at a glance which
   product owns a table.
4. **Prefix only where a collision exists.** Minimal churn, maximal confusion —
   ownership becomes a thing you have to remember rather than read.

## Decision

**Option 3**, applied without exception.

- Every HELM-owned table is `helm_*`. No case-by-case judgement.
- Ontology tables are therefore `helm_entities`, `helm_relationships`,
  `helm_entity_types`, `helm_relationship_types`.
- Value graph: `helm_value_metrics`, `helm_value_nodes`, `helm_value_links`,
  `helm_value_observations`, `helm_calculations`, `helm_calculation_runs`,
  `helm_calculation_trace`.
- HELM-owned functions are `helm_*` too (`helm_set_updated_at` already follows
  this).

**The four org-layer tables are the documented exception**, and they are not
HELM-owned. `organizations`, `organization_memberships`, `org_units` and
`org_unit_memberships` were deliberately created *unprefixed as new shared core*,
because Memoire is expected to adopt them when it gains multi-user support — its
`scope` seam exists for exactly that. Prefixing them would force a rename later,
which is the situation this ADR exists to prevent.

The RLS helpers `is_org_member`, `has_org_role` and `org_role_rank` are shared
core for the same reason.

## Consequences

**Good.** Collisions are impossible. Ownership is readable from a table name. No
extra Supabase configuration. Consistent with the 14 tables already shipped.

**Bad.** Table names are longer, and `helm_value_observations` in HELM's own
codebase carries a prefix that conveys nothing internally. The `helm_*` /
unprefixed split needs explaining to newcomers — which is what this ADR does.

**Risk — the shared-core exception grows by convenience.** Someone declares a
table "shared core" to avoid a prefix. Mitigation: a table is shared core only
when Memoire plausibly adopts it, and adding one requires an ADR.

## Migration implications

- No change to existing tables; all 14 already comply.
- Phase 1 migrations create `helm_entity_types`, `helm_relationship_types`,
  `helm_entities`, `helm_relationships`.
- `verify:table-namespace` asserts that every table created by a HELM migration is
  either `helm_*`-prefixed or on the explicit shared-core allowlist.
- Memoire's `entities` and `relationships` are **never** read by HELM. They are
  Memoire's internal capture mechanism, not a commercial interface. Only
  `opportunities`, `accounts` and `commercial_events` are in the integration
  contract ([helm-vs-memoire.md](../architecture/helm-vs-memoire.md)).

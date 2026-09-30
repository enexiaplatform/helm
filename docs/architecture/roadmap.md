# Roadmap and readiness

What is built, how far each part is proven, and what stands between HELM and a
pilot. Status as of **2026-09-30**. The system is described in
[helm-architecture.md](helm-architecture.md); this page says how finished it is.

## 1. Sequencing principle

**Kernel before surfaces.** Propagation needs a value graph; a value graph needs an
ontology; a decision needs scenarios; authority needs decisions; a twin, a causal graph
and a genome need all of them; a review needs the memory; AI and agents need something
governed to read. HELM was built in that order, and it is why the application is a set
of views over the layers rather than a dashboard with a database behind it.

## 2. Readiness by layer

Three levels: **in memory** (built, tested, contract-verified on the reference stores),
**schema live** (migration applied to the shared database and proven by a rolled-back
server-side proof with controls), **cloud proven** (conformance suite and the
end-to-end path run from authenticated clients in an isolated environment).

| Layer | In memory | Schema live | Cloud proven |
| --- | --- | --- | --- |
| ontology · graph store · value graph · propagation | ✅ | ✅ | ❌ |
| scenario runtime | ✅ | ✅ | ❌ |
| decision runtime | ✅ | ✅ | ❌ |
| authority runtime + trusted service | ✅ | ✅ | ❌ (service not deployed) |
| management twin | ✅ | ✅ | ❌ |
| causal graph | ✅ | ✅ | ❌ |
| counterfactual worlds | ✅ | ✅ | ❌ |
| management genome | ✅ | ✅ | ❌ |
| integration fabric (Memoire adapter, dry-run writeback) | ✅ | ✅ | ❌ |
| management reviews | ✅ | ✅ | ❌ |
| intelligence runtime (reference provider) | ✅ | ✅ (audit) | ❌ |
| agent council (reference composer) | ✅ | — (uses the audit table) | ❌ |
| applications (Cockpit, reviews, instrument pages) | ✅ demo mode, browser-verified | — | ❌ |

The "cloud proven" column is one blocker, not thirteen: see the
[deployment gate](trusted-runtime-deployment-gate.md).

## 3. Before a pilot

1. **Blocker B first** — an isolated authenticated environment, then run the 13
   Postgres conformance suites and the RLS checks from authenticated clients. It has
   already paid for itself once (it is what found the `INSERT … RETURNING` defect).
2. **Blocker A** — deploy `helm-authority` there, then run the cloud Decision →
   Commitment → Authority Evaluation → Approval path end to end, including spoofing
   refusals, and rehearse the rollback.
3. **An external-provider egress control** ([security-model §4](security-model.md)) and
   rate/cost limits, *before* a language-model provider is connected.
4. **A language-model adapter** for the provider ports (intelligence and council),
   evaluated against the same grounding contracts — the contracts prove the governance;
   they say nothing about the quality a model adds.
5. **Measured Postgres performance.** Every number in the benches is in memory.

## 4. After a pilot begins

- More source adapters through the same fabric — ERP, finance, SCM, HR — each one adapter,
  one declared contract, one drift policy. People data, if it ever exists, opens the People
  perspective and still never scores or ranks a person.
- A live write-back is a **separate, explicitly authorized decision** and a later
  migration; v1's schema pins `DRY_RUN`.
- Field-level redaction on decisions, functional visibility beyond units, entity-type
  classes.
- Entity resolution beyond identifiers ([identity-resolution](identity-resolution.md)).
- Tooling deferred by decision until a concrete blocker: pnpm/Turborepo/Vitest
  ([ADR-0012](../adr/0012-defer-pnpm-turborepo-and-vitest.md)), a graph database
  ([ADR-0004](../adr/0004-graph-abstraction-layer.md)), a standalone API service
  ([ADR-0003](../adr/0003-supabase-postgres-system-of-record.md)).

## 5. Not on the roadmap, ever

Recommendation, ranking or scoring of scenarios, decisions, perspectives or people; a
single health score; outcome prediction; automatic discovery of causes or patterns;
automated approval, commitment or execution; an AI or agent that writes enterprise
truth; a vote or consensus among perspectives. These are absences the build verifies
([helm-architecture §12](helm-architecture.md)).

## 6. History

How the layers were introduced, in order, is recorded in each layer reference under
[layers/](layers/) and in the [ADRs](../adr/README.md). The pre-kernel application that
preceded them — signal inbox, cost and economics pages, an approval workflow, a CVP
what-if — has been retired; [docs/archive](../archive/implemented-mvp.md) keeps its
records, marked as history.

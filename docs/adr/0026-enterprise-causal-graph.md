# ADR-0026: The Enterprise Causal Graph — evidence-backed causal claims, kept apart from dependency, correlation and coincidence

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Phase** 8 · **Depends on** [ADR-0014](0014-bitemporal-lite.md),
[ADR-0017](0017-calculation-semantics.md), [ADR-0023](0023-management-digital-twin.md),
[ADR-0025](0025-sensitivity-and-scenario-visibility.md) · **With** [ADR-0027](0027-causal-evidence-policy.md)

## Context

After Phase 7 HELM can say what existed, what was known, what changed, which
future was committed to, who had authority and what happened. It cannot say
**why**. The twin's difference explanation walks the calculation graph —
gross margin fell because fulfilment cost rose — and says, correctly, that this
is model dependency, not a causal claim.

HELM now holds three graphs that are easy to confuse:

| Graph | Answers | Nature |
| --- | --- | --- |
| Semantic (graph-store) | what exists and how it is related | fact |
| Calculation (propagation-engine) | which model input mathematically moves which output | deterministic inside the model |
| **Causal (this ADR)** | what the enterprise has **evidence** to believe influences real outcomes | belief, with evidence, scope and time |

The failure modes are familiar: a drawing tool where managers add arrows; a
system that turns every calculation dependency into a cause; one that reads
co-movement in a delta as influence; one that outputs "73 % of the variance was
caused by air freight".

## Decision

### 1. CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP

The causal graph is a separate package (`@helm/causal-runtime`, top of the
kernel) with separate storage. A calculation dependency is **reported beside**
a claim (`modelDependency`, "KNOWN VALUE DEPENDENCY") and never counted in its
evaluation. Adding a claim never adds a dependency, alters a formula, re-runs a
propagation or changes a scenario output; `verify:causal-vs-calculation` proves
the model is byte-identical after the whole causal story, and
`verify:phase-boundary` forbids any write method below the causal runtime.

### 2. A claim is authored, scoped and versioned

- **Identity (immutable)**: cause, effect, relationship, scope, conditions,
  applicable period. Different scope or conditions make a different claim;
  claims are never de-duplicated on cause and effect alone.
- **Vocabulary**: INCREASES, DECREASES, ENABLES, CONSTRAINS, DELAYS,
  ACCELERATES, MEDIATES, MODERATES. No unconditional CAUSES. MEDIATES and
  MODERATES name the claim they qualify.
- **Revisions (append-only)**: statement, mechanism (ordered steps, optionally
  naming variables), confounders, rationale, external validity, lineage links
  (twin snapshots, value nodes, entities, decisions, assumptions, scenarios).
  Retirement is a revision, by the author or an admin.
- **Variables** are the nodes: METRIC variables are bound to a value metric
  (and optionally a node); ACTION, CONDITION, EVENT and OUTCOME variables are
  named factors.

### 3. Status is derived, never stored

Status and confidence are computed at a lens from the evidence linked to the
claim, under the named policy of ADR-0027. The database has no status column.

### 4. Scope is structural; nothing is global by default

A claim is anchored on entities (business unit, customer, product, country …)
or explicitly ENTERPRISE_WIDE with a stated justification. Applicability to a
context is judged dimension by dimension against the structure at the lens
(the anchoring edges the authority engine and the twin use): APPLIES when every
anchor is covered, OUTSIDE when a context entity names another member of an
anchor's dimension, APPLIES_TO_PART otherwise. A claim supported for Vietnam
Pharma / Rohto is OUTSIDE Thailand Pharma and only APPLIES_TO_PART of Vietnam.

### 5. Two times, reused from the twin

Every read takes the twin's lens. Knowledge time filters claims, revisions,
evidence, links and corrections by their database-stamped record time; a link
is knowledge too. Business time says whether the claim's applicable period
covers the moment asked about. "What did management believe on 19 Jan?" is a
reconstruction, not a copy; the twin's `recordedThrough` is the causal
knowledge boundary of a snapshot.

### 6. Specialized storage, not the GraphStore

Claim status, evidence, stances, conditions, mechanism, revisions and
corrections are not entity/relationship semantics, and bitemporal claims with
append-only evidence do not fit the generic graph without turning it into a
belief store. Eight append-only tables (`helm_causal_*`,
`helm_correlation_findings`); references still point into the ontology, value
graph and twin. Record time is stamped by the database; nothing is updated or
deleted; signed-in clients hold no UPDATE/DELETE privilege.

### 7. Sensitivity and visibility: read whole or not at all

A claim's effective classes are its declared class ∪ its variables' classes ∪
the classes of all evidence behind it (corrections included). A claim resting
on a decision (by revision link, assumption pin or evidence ref) is readable
only by viewers who can see that decision. A withheld claim is withheld whole,
title included. RESTRICTED claims follow unit grants (subtree); admins read
everything. The rule is written once for rows (`causal_claim_row_visible`) so
policies never re-read their own row — a lesson learned live (§ Consequences).

### 8. Correlation is a different object

`CorrelationFinding` (method, population, period, estimate, uncertainty,
limitations) lives in its own table. Nothing converts it into a claim; a
person may cite it in evidence, which caps that evidence at LOW.

### 9. HELM never proposes a cause

Candidates for a causal question are claims people proposed for it, or existing
claims whose effect is the question's variable. A question with neither is
OPEN — "we do not know yet". The twin integration lists, for each input the
model says moved, the questions and claims people recorded, and says "no causal
knowledge" otherwise.

### 10. Cycles are allowed; traversal is bounded

Real enterprises have feedback loops, so the causal graph may contain cycles
(the calculation graph may not). Every traversal requires `maxDepth` (1–8);
an edge back to a visited variable is recorded (`closesCycle`), never followed.
A path is as supported as its weakest claim; confidences are never multiplied.

### 11. Promotion path (future, never automatic)

A well-supported claim MAY later inform the model: Causal claim → model review
→ an explicit calculation change → a new calculation version (ADR-0017). No
code path does this; `verify:causal-vs-calculation` fails if one appears.

## Consequences

- HELM can say what the enterprise believes about causes, on what evidence, in
  which scope and period, and what it believed earlier — and "unresolved".
- Status is never an opinion typed in; it is the policy applied to evidence.
- A live defect was found and fixed while applying this: SELECT policies that
  re-read their own row by id refuse `INSERT … RETURNING`. The causal policies
  use row rules. The same defect exists in Phase 7's
  `helm_save_twin_snapshot` (reported; not changed here).
- No causal discovery, inference engine, do-calculus, Bayesian network,
  structural equations, uplift model, counterfactual, genome, optimization or
  AI. Those are later phases, and `verify:phase-boundary` forbids them.

## Alternatives rejected

- **Causal edges in the GraphStore** — would mix belief with fact and lose
  evidence, status history and scope semantics.
- **Promote calculation dependencies to causal claims** — the exact confusion
  this phase exists to prevent.
- **A numeric confidence** — see ADR-0027.

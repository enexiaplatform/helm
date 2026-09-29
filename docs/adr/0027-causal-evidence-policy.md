# ADR-0027: The causal evidence policy — a hierarchy with ceilings, count never decides

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Phase** 8 · **With** [ADR-0026](0026-enterprise-causal-graph.md) ·
**Policy id** `helm-causal-evidence@1` (`packages/causal-runtime/src/policy.ts`)

## Context

A causal claim's status must come from explicit evidence and a documented
policy, not from "Claude thinks 0.82". Evidence is not equally strong, it may
support, challenge, contradict or only contextualize, it may conflict, and it
may arrive later. The policy has to be simple enough to explain on screen and
strict enough not to be gamed by volume.

## Decision

### 1. Evidence types and stances

Ten types; four stances (SUPPORTS, CHALLENGES, CONTRADICTS, CONTEXTUALIZES).
Every item carries provenance (source system, reference, method, who asserted
it and in what role). MANAGEMENT_EXPERTISE is always recorded as JUDGEMENT —
a person's view is never presented as a measurement, and vice versa. A
STATISTICAL_ANALYSIS states method, population, period, estimate, uncertainty
and limitations. A CONTRADICTORY_CASE can never support.

### 2. The hierarchy: a ceiling per type

| Ceiling | Types | Why |
| --- | --- | --- |
| HIGH | CONTROLLED_EXPERIMENT, NATURAL_EXPERIMENT | a comparison stands in for the counterfactual |
| MEDIUM | INTERVENTION, LONGITUDINAL_OBSERVATION, REPEATED_PATTERN, STATISTICAL_ANALYSIS, PROCESS_MECHANISM, EXTERNAL_RESEARCH, CONTRADICTORY_CASE | informative, but cannot exclude confounding (or, for external research, is from elsewhere) |
| LOW | MANAGEMENT_EXPERTISE | judgement, not measurement |

The assessor grades each item (LOW/MEDIUM/HIGH, with a rationale); the policy
counts `min(grade, ceiling)`. Evidence citing a correlation finding is capped
at LOW. This is a classification, not a universal formula.

### 3. Status rules (first match wins)

| Condition | Status |
| --- | --- |
| retired | RETIRED |
| a HIGH contradiction and no HIGH support | REFUTED |
| material (≥ MEDIUM) evidence against **and** material support | CONTESTED |
| material evidence against, no material support | WEAKENED |
| one HIGH support, or ≥ 2 MEDIUM supports of ≥ 2 **different** types | SUPPORTED |
| some support and some (LOW) evidence against | UNRESOLVED |
| some support only | HYPOTHESIS ("weakly supported") |
| only LOW evidence against, or only context | UNRESOLVED |
| no evidence | HYPOTHESIS |

Consequences of the rules, each tested:

- **Count never decides.** Any number of LOW supports stays a HYPOTHESIS; two
  MEDIUM items of the same kind are not independent; one HIGH controlled
  experiment can support a claim alone.
- **Contradiction is weighed, not outvoted.** Three supports against one
  credible contradiction is CONTESTED.
- **Order eliminates, it does not prove.** Where evidence states when the cause
  and the effect were observed, a cause after its effect is a TEMPORAL_CONFLICT
  and the item counts as a challenge, not a support. The right order is noted
  as necessary, not sufficient.
- **Corrections supersede.** A correction replaces an item from its record time
  on; earlier lenses read the original; the original is kept.

### 4. Confidence is categorical, with reasons

NONE, LOW, MODERATE, HIGH — derived with the status (SUPPORTED on HIGH evidence
with nothing against → HIGH; otherwise SUPPORTED → MODERATE; CONTESTED and weak
support → LOW; no support → NONE) and always accompanied by the reasons. No
number is computed, averaged or multiplied.

### 5. Attribution is not causation

Deterministic accounting decomposition (the model's arithmetic) is allowed and
shown as MODEL EXPLANATION. Causal attribution — "air freight caused 73 % of
the gap" — is not produced: a supported explanation is said to explain the
change *in part*, and "how much is not quantified", unless evidence quantifies
it.

## Consequences

- Status and confidence are explainable in one sentence each, on screen.
- The policy is versioned by id; a change of policy is a new id, and every
  evaluation names the policy it used.
- The policy is conservative: most early claims read HYPOTHESIS or UNRESOLVED.
  That is intended.

## Alternatives rejected

- **A numeric confidence (weighted average, Bayesian update)** — fake
  precision, and averaging lets volume beat strength.
- **Majority of stances** — lets three anecdotes outvote one experiment.
- **Manual status field** — would make status an opinion rather than a
  consequence of evidence.

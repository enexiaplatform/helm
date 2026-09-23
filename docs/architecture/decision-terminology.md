# Decision terminology

Nine words do most of the work in Phase 5, and several of them are words other
systems use for something meaningfully different. This page fixes what each one
means in HELM. The same definitions appear at the top of
`packages/decision-runtime/src/types.ts`, so code and prose cannot drift.

## The nine terms

| Term | Means | Does **not** mean |
| --- | --- | --- |
| **Decision** | The durable management object: one management *question*, its context, trigger, owner and horizons. It outlives the answer. | A chosen option. A scenario. A task. An approval request. |
| **Revision** | One preparation state of that decision — the alternatives, criteria, assumptions, evidence and challenges as they stood. Immutable once SEALED. | A draft that keeps changing under a commitment already made. |
| **Alternative** | A management option. It references a scenario revision and the run that computed its future, or declares itself UNMODELLED. | A container of economics. A proposal with its own numbers. |
| **Criterion** | What management says matters, and how it is to be judged: hard constraint, target, preference, qualitative, or a weighted input management itself defined. | A scoring dimension. A weight HELM chose. |
| **Assumption** | A management-level belief the decision rests on, with an **owner** who stands behind it. | A scenario override (that is a model input; an assumption is a claim about the world). |
| **Challenge** | Recorded disagreement with an assumption, criterion, alternative or the framing itself. Decision evidence. | A comment thread. A chat message. A task. |
| **Evidence** | Something outside the model that SUPPORTs, CHALLENGEs, CONTEXTUALIZEs or INVALIDATEs part of the decision. | Attachments. Everything a user uploaded. |
| **Readiness** | Procedural completeness: which named gaps remain. | Quality. A score. A verdict on the choice. A winner. |
| **Commitment** | "Management chose this, for these reasons, accepting these trade-offs." Immutable, fingerprinted. | An approval. An authorization. A statement that the decision was right. |

## Four words HELM is careful with

**Commitment is not approval.** A commitment records *what was decided and on
what grounds*. An approval records *that someone with the right to say yes said
yes*. HELM Phase 5 does the first and explicitly not the second: every
commitment carries `authorityStatus: NOT_EVALUATED`, pinned in the type and by
a database CHECK.

**An assumption is not an override.** A scenario override is a model input: "in
this future, lead time is 7 days." A decision assumption is a claim about the
world with a person's name on it: "Supplier A can deliver in seven days —
Supply Chain Director, confidence 0.70, source: verbal." A decision's lineage
passes through both, and the explanation shows them separately.

**A gap is not a failure.** `READY_WITH_GAPS` is the normal state of a real
decision: something is always unmodelled, unowned or still disputed. The gap
list exists so management sees it before committing, not so HELM can withhold
the commit.

**Dominance is not a recommendation.** "Under the current model, A is better
than C on every comparable criterion" is a fact about the comparable criteria.
It says nothing about the criteria that are not comparable, nothing about the
weight management gives each one, and nothing about what to do. HELM states it
and stops.

## Words used elsewhere that HELM avoids

| Word | Why it is avoided |
| --- | --- |
| *Recommendation* | HELM produces none. `verify:phase-boundary` fails the build if `recommendBest` or its relatives appear. |
| *Decision score* | A weighted total presented as judgement. Forbidden by the boundary contract; a weighted **view** exists only when management declares the method, and shows every contribution rather than a headline. |
| *Best option* / *winner* | Implies an ordering HELM does not compute. A structural walk over the whole workspace fails the contract if a key named `score`, `rank`, `best` or `winner` appears anywhere in it. |
| *Approval* | See above. It is Phase 6's word. |
| *Outcome score* | The pre-kernel model graded outcomes `better / as_expected / worse`. The kernel reports variance instead (see [decision quality vs outcome quality](decision-quality-vs-outcome.md)). |
| *Confidence* (in the choice) | `confidence` exists on assumptions and on modelled values, where it means a stated degree of belief in an input. There is no confidence in a decision. |

## Related vocabulary fixed by earlier phases

- **Scenario, revision, override, simulation, future state, comparison** —
  [scenario terminology](scenario-terminology.md).
- **Truth layers** SOURCE / MODEL / EXECUTION —
  [ADR-0017](../adr/0017-calculation-semantics.md).
- **The two lenses** `effectiveAsOf` and `recordedThrough` —
  [ADR-0014](../adr/0014-bitemporal-lite.md). A decision's **knowledge
  boundary** is a `recordedThrough`: what was known when it was decided.
- **Period** as a value with a grain and half-open bounds —
  [ADR-0020](../adr/0020-period-identity.md).

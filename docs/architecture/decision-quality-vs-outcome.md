# Decision quality is not outcome quality

**Phase 5** · Companion to [ADR-0021](../adr/0021-decision-runtime.md) §7

A decision can be made well and turn out badly. A decision can be made
carelessly and turn out brilliantly. Any system that records both and then
grades the first by the second will teach an organization the wrong lesson, and
it will teach it with a straight face and a number.

This is the single most important idea in HELM's decision memory, so it is
written here rather than left implicit in the code.

## The two things HELM records

| | **Decision quality** | **Outcome quality** |
| --- | --- | --- |
| Question | Was this decided well, given what was knowable then? | Did it work out? |
| Known when | At the moment of commitment | Only afterwards, sometimes much later |
| Made of | The question asked, the alternatives considered, the criteria stated, the evidence weighed, the assumptions named and owned, the dissent recorded, the trade-offs accepted explicitly | Expected against actual, per expected outcome, plus how each assumption turned out |
| HELM's record | The **commitment** and its frozen **snapshot** | The **outcome review** |
| HELM's judgement | none | none |

Both are preserved. Neither is scored.

## Why the outcome review reports and does not grade

The outcome review states, for each expected outcome, the expected value, the
actual value and the variance — all exact decimals — and for each assumption
whether it was `CONFIRMED`, `PARTIALLY_CONFIRMED`, `DISPROVED` or still
`UNKNOWN`. It carries a statement that says, in the record itself:

> Expected against actual, and how the assumptions turned out. This is not a
> verdict on the decision: a well-reasoned decision can produce a poor outcome,
> and a careless one can get lucky. HELM keeps the two apart.

`verify:decision-immutability` asserts that statement is there. The mutation
harness confirms the assertion bites: replace it with a sentence that grades the
decision and the contract fails.

The pre-kernel model did grade: `outcomeScore` was `better | as_expected |
worse` on the decision row. It was retired in Phase 5 — not because grading is
useless, but because grading *the decision* by *the outcome* is a category
error, and because that field was the input to a pattern detector that would
have generalized it.

## What this makes possible later

A Management Genome that learns from a decision record needs to be able to
distinguish:

1. **Reasoning errors** — an assumption nobody owned, a criterion nobody
   checked, an alternative nobody modelled, a challenge closed without a
   resolution. All visible at commitment time, all preserved in the snapshot.
2. **Estimation errors** — the reasoning held, the expected value was wrong.
   Visible in the variance.
3. **World errors** — the reasoning held, the estimate held, the world moved.
   Visible in the assumption outcomes: the assumption was DISPROVED by an event
   nobody could have known about.

Collapsing those three into one score destroys exactly the information that
would make learning possible. So Phase 5 keeps them apart and learns nothing:
pattern detection, base rates and any form of decision-quality inference are
out of scope by design (brief §36, §38, §70), and the phase-boundary contract
fails the build if they appear.

## What a reader should check

- `docs/architecture/decision-engine-assessment.md` — `outcomeScore` and
  `decisionMemory.ts` are listed as RETIRE, with why.
- `npm run verify:decision-immutability` — the outcome review is recorded
  against a sealed revision, changes nothing frozen, and passes no judgement.
- `npm run verify:phase-boundary` — no pattern learning, no causal inference,
  no decision score.
- The Decision Memory surface (`/memory`) shows the commitment, what was
  accepted, what was expected and what happened. It ranks nothing and says
  nothing about whether the decision was good.

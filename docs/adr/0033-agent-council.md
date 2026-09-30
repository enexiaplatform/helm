# ADR-0033: The council — perspectives over one truth; an Agent Perspective is not Decision Authority

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Depends on** [ADR-0022](0022-decision-authority-graph.md),
[ADR-0032](0032-governed-intelligence-runtime.md)

## Context

A decision touches several management functions at once — commercial, finance,
supply chain, operations, risk, strategy, people, enterprise value. Each looks at
the same facts and cares about different ones, and they often pull apart: the
alternative that protects service concedes cash. A tool that averages those
opinions into a recommendation replaces management's judgement with an
unaccountable one; a tool that hides the disagreement removes the point of asking.

## Decision

### 1. Perspectives, not personalities, and only where HELM has data

`@helm/agent-runtime` defines eight **perspectives** (`COMMERCIAL`, `FINANCE`,
`SUPPLY_CHAIN`, `OPERATIONS`, `RISK`, `STRATEGY`, `PEOPLE`, `ENTERPRISE_VALUE`).
A perspective is **instantiated only where the coverage of the enterprise state
shows readings for it**. **People is not instantiated**: HELM holds no people data,
and the council says so instead of speaking for it (and HELM never scores or ranks
a person). A perspective asked for by name that HELM cannot support is refused
with its reason. A perspective the data supports but the question does not touch
reports that it has nothing to say — none is silently absent.

### 2. One truth, gathered once, as the caller

The **orchestrator** gathers the evidence **once**, through the same governed
read-only tools and **as the caller** ([ADR-0032](0032-governed-intelligence-runtime.md)),
and hands each perspective only the subset **relevant** to it (by dimension and
metric first). Perspectives see different things because relevance differs — not
because they see a different world. A fact more than one perspective rests on is
reported once, as shared.

### 3. Structured, grounded output per perspective

Each perspective returns the same structure — observations, concerns, challenged
assumptions, trade-offs, supporting evidence, unknowns, questions — grounded
against **its own** evidence subset by the same `groundDraft` as any other AI
output. One that recommends, fabricates a figure or cites another perspective's
evidence is held to it: the statement is removed or downgraded.

### 4. Disagreement is a fact about an alternative

A **tension** exists where a scenario alternative gains for one perspective and
concedes for another. It is shown as the gains and concessions side by side, with
the line each stands on, and the statement *"nothing is netted, and HELM does not
say which is right"*. Perspectives appear in a fixed canonical order, never by
importance.

### 5. No vote, no consensus, no choice

There is **no consensus, vote, score, rank, weight, preference or recommendation**
anywhere in the output, at any depth (asserted structurally by
`verify:council` and by name by `verify:boundaries`), and the response says
`accountable: HUMAN_MANAGEMENT`. The orchestrator has **one method** — `convene` —
and calls no kernel write. A council leaves every kernel record byte-identical.

### 6. Audited like any AI run

One run per perspective and one for the orchestrator (`council-orchestrator`, its
tool calls and evidence references, **no statements of its own**), each in
`helm_ai_runs`, none with a reasoning trace.

## Consequences

- The Country GM asks one question and reads several considered views of the same
  evidence, sees where they conflict, and decides. The council is progressive
  disclosure — a brief first, the perspectives behind it.
- Adding a perspective is a definition (words, dimensions, metrics, a coverage
  rule); it cannot add authority.
- The reference perspective composer is rule-based and proves the governance; a
  language-model composer implements the same provider port.

## Alternatives rejected

- **Agents that debate to a conclusion.** Rejected: the conclusion would be the
  system's, not management's.
- **A weighted synthesis.** Rejected: any weighting is a hidden decision.
- **A People agent from job titles.** Rejected: role occupancy is governance, not
  people data.

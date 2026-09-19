# HELM — Product Vision

**HELM is the Enterprise Management Infrastructure.**

> Connect the enterprise. Model how value is created. Simulate what comes next.
> Govern decisions. Learn from every outcome.

## 1. The problem HELM exists to solve

Operational systems are solved. An enterprise running Memoire, an ERP, a WMS,
an EPM tool and an HRIS has excellent records of *what happened* in each
function. What it does not have is a system for *management*.

Management work is cross-functional by nature, and every enterprise system is
functional by design. So the integration happens in the least reliable place
available: a human being, in a meeting, holding four spreadsheets and a
recollection of what was decided last quarter.

The consequences are structural, not incidental:

- **Dependencies are invisible.** A commercial promise creates an inventory
  obligation, which creates a working-capital draw, which competes with a
  capex decision. No system holds that chain, so nobody sees it until it breaks.
- **Decisions are not objects.** They live in emails, decks and memories. Their
  reasoning is lost within weeks, which makes accountability theatre and
  learning impossible.
- **Consequences are unmodelled.** "What happens if we discount 10% to close
  this?" is answered with instinct, because the only alternative is a week of
  analyst time.
- **Authority is folklore.** Who can actually approve this, at this size, in
  this country, for this business unit? The answer lives in people's heads.
- **The organization does not compound.** The same mistake is available to be
  made again next quarter by a different manager, because nothing recorded what
  happened last time or why.

Reporting tools answer *what happened*. HELM answers *what to do about it, what
it will cost elsewhere, who may decide, and what we learned last time*.

## 2. What HELM is

The **management control plane** above enterprise systems. It consumes
operational truth and produces **Management Truth**.

| Source | Produces |
| --- | --- |
| Memoire | Commercial truth |
| ERP | Transactional truth |
| SCM / WMS / MES | Operational truth |
| Finance / EPM | Economic truth |
| HRIS | Organizational truth |
| Market / competitor / macro feeds | Environmental signals |
| **HELM** | **Management truth** |

The questions HELM is built to answer:

- What is happening across the enterprise, and why?
- Where is enterprise value being created or destroyed?
- What dependencies exist across functions?
- What requires management attention right now?
- What happens if we choose A, B or C — and what does each break downstream?
- Who has the authority to decide this?
- What happened the last time we faced this, and what should we conclude?

## 3. What HELM is not

Not a CRM. Not an ERP. Not a project manager. Not a BI dashboard. Not an FP&A
tool. Not a supply-chain application. Not a task manager. Not a chatbot. Not a
replacement for Memoire. Not a conventional SaaS product.

Two of these deserve emphasis, because they are the failure modes HELM is most
likely to drift into:

**Not a BI dashboard.** A dashboard shows metrics side by side and leaves the
connection to the reader. HELM models the connection itself: the edge between
an opportunity and a working-capital draw is a first-class object with a
formula, a confidence and a provenance. If a screen in HELM cannot explain how
its numbers reached each other, it is a dashboard and it does not belong.

**Not a replacement for Memoire.** The boundary is absolute and documented in
[helm-vs-memoire.md](../architecture/helm-vs-memoire.md). Commercial employees
work in Memoire. HELM never rebuilds accounts, contacts, pipeline, quotations
or activities. It consumes them.

## 4. Who HELM is for

BU Heads · Commercial Directors · Supply Chain Directors · Finance Directors
and FP&A Heads · Country Managers · General Managers · Regional Heads ·
C-suite.

Operational employees stay in their operational systems. If HELM finds itself
building a screen for a salesperson's daily work, the boundary has been
breached.

## 5. The central abstraction: Enterprise Value

The primitive is not a task, a process, a dashboard, a metric, a transaction, a
plan, or even a decision. It is **enterprise value** — and specifically, *how
the enterprise creates, destroys, transfers, protects and compounds it*.

```
Customer Demand
  → Commercial Opportunity
    → Revenue
      → Product Demand
        → Inventory Requirement
          → Procurement
            → Capacity
              → Logistics
                → Cost
                  → Margin
                    → Working Capital
                      → Cash
                        → Enterprise Value
```

This chain is not a diagram in a document. It is the data model
([domain-model.md](../architecture/domain-model.md)) and it is executable
([ADR-0007](../adr/0007-value-graph-projection.md)). Every entity HELM knows
about earns its place by connecting to value creation.

## 6. The decision as the unit of management work

A decision in HELM is a durable, auditable object with a full lifecycle:

```
Context → Options → Simulation → Recommendation → Decision → Approval
        → Action → Outcome → Learning
```

Expected outcome is recorded **before** approval. Actual outcome is recorded
after. The pairing of the two, plus the reasoning and assumptions that produced
the choice, is what lets an organization compound managerial judgement instead
of resetting it every time a manager changes role.

AI may prepare, explain, simulate and recommend. **AI never silently executes a
high-impact decision.** A named human with verified authority does.

## 7. Non-negotiable product standards

These are not aspirations; they are acceptance criteria, enforced by contract
tests ([ADR-0010](../adr/0010-test-and-contract-strategy.md)).

**Every number is traceable.** A manager clicking "why 4.2B revenue at risk?"
sees the source, the formula, the inputs, the timestamp, the assumptions, the
confidence, and the upstream dependencies. No number appears in HELM that
cannot answer that question.

**Every recommendation is explainable.** What happened, why, what is affected,
what happens if nothing is done, what options exist, what the trade-offs are,
what is assumed, how confident we are, who can decide, what to monitor
afterwards.

**Deterministic before probabilistic.** Rules, formulas and thresholds first;
models later, behind the same contracts. An LLM is never the source of a
business fact.

**The human remains accountable.** HELM makes authority explicit and
enforceable. It never dissolves it.

## 8. Where HELM is today

Honest status, from [discovery-findings.md](../architecture/discovery-findings.md):

HELM has a working decision workspace — eight deterministic engines, an
auditable decision lifecycle, a signal inbox, scenario comparison, and a real
Memoire bridge. What it does not yet have is the layer that makes it *enterprise
management infrastructure* rather than a very good management-accounting app:
the ontology, the value graph, and propagation across functions.

That foundation is Phases 1–3 and it comes before any new surface.
See [roadmap.md](../architecture/roadmap.md).

# V1 audit

An audit of the finished system against the standard it set for itself, done by reading
the code and running the contracts — not by re-reading the documents. Each section says
what was checked, what held, and what did not. Findings that are **open** are named as
such. Date: 2026-09-30. Companion: [helm-architecture.md](helm-architecture.md).

## Architecture

- **Direction.** `verify:boundaries` derives the import graph of all 16 packages and
  fails on any import of a higher layer, any relative cross-package import, any package
  importing the app or React, and any import of `integration-runtime` or `agent-runtime`
  from anywhere but the app. Held.
- **Homes.** The words of each concept (authority, twin, causal, counterfactual, genome,
  review, intelligence, council, integration) are confined to their package and the
  packages above it. Held; the integration fabric is lateral and excluded from the rank
  rule on purpose.
- **Dead code.** The pre-kernel engines (`src/domain/engines`), the signal, economics and
  operations pages, the attention components, `domain/format.ts`, five unit-test files and
  the store's signal/economics/inventory/process state were deleted, and
  `verify:boundaries` fails if any returns. The old routes redirect (`/attention`,
  `/economics`, `/operations`) so bookmarks land somewhere true. **Open, minor:** the
  legacy `helm_signals`, `helm_cost_objects`, `helm_economics`, `helm_inventory_items`,
  `helm_processes` and `helm_process_activities` tables still exist in the shared database.
  Migrations are additive and never drop; nothing reads them.
- **Docs.** The phase-by-phase records became layer references under `layers/`; the
  pre-kernel records moved to `archive/` and say so; `system-overview.md` was removed
  in favour of one architecture document; the vision, data-flow, domain-model, security
  model, roadmap, interfaces, repository structure and Memoire-boundary documents were
  rewritten where they contradicted the invariants (they described recommendations,
  a `commercial_events` write, automatic recalibration and planned packages that were
  built differently).

## Truth

- **Source ≠ model.** An adapter cannot emit `ESTIMATE` or `DERIVED`; a translation that
  tries is quarantined; a model estimate and a source actual sit side by side and
  `sourceAndModel` says HELM does not choose. Held (`verify:integration-runtime`).
- **No double entry.** Memoire restating what the seed already holds records nothing.
  The app contains no path that writes an observation: the only manual inputs are
  management assumptions, causal judgements and review questions, each with provenance.
- **Open, minor:** the seed ontology still defines `Outcome.score` (`better | as_expected
  | worse | mixed`) and `Supplier.reliabilityScore`. No code instantiates an `Outcome`
  entity and nothing reads either attribute, but an `Outcome.score` is a label HELM would
  refuse to compute. Removing it means changing seeded registry data in the live
  database; it is listed rather than done quietly.

## Time

Every reader takes a two-time lens, and later facts cannot change earlier readings:
twin snapshots replay; causal status at 19 and 20 January; an episode unknown before it
was opened; a counterfactual anchored before the decision; a closed review reproduces
after a terrible outcome, a new decision and a new claim are recorded
(`verify:review-runtime`, `verify:v1-loop`). **Bug found and fixed while building the
loop:** a twin snapshot became unbuildable when a commitment had not yet been evaluated;
governance items now start from a `COMMITMENT` reference.

## Lineage

A number traces to a source fact and the ingestion event that brought it; a review item
is a reference, never a copy; carry-forward is the same reference with the item it came
from; an AI statement cites run-local evidence ids that resolve to kernel objects; a
writeback request carries the commitment fingerprint and the intent it derives from.
**Bug found and fixed:** a pack's fingerprint moved when a source was connected later;
`unavailable` is no longer part of it.

## Decisions

Alternatives are bound to runs; the commitment is fingerprinted; authority is a separate
immutable evaluation written by the trusted service; a review binds and never decides
(asserted by comparing the decision state before and after adding items and closing);
the integration fabric refuses to write back for a commitment governance does not permit.
**Open (blocker A):** the trusted service is built but not deployed, so the cloud
decision → authority → approval path is unproven.

## Learning

Nothing learns by itself: no pattern is mined, no claim's status is changed by an outcome,
no link weight moves, no lesson is acted on (`verify:boundaries` names each of these).
Learning is authored records — evidence, episodes, patterns, lessons — read by the next
review, the AI and the council. Process and outcome stay apart in the episode; a terrible
outcome recorded later changes only the outcome section.

## AI governance

The catalogue is fifteen `READ_ONLY` tools; plans outside it, missing or extra arguments
are refused and audited; a plan is cut at eight calls; the provider is handed plain JSON;
grounding removes fabricated figures and recommendations and downgrades hypotheses and
mixed classes; the audit has no place for a reasoning trace; every task leaves the kernel
byte-identical. **Two real gaps found by mutation while writing the contracts:** the
clearance checks inside two tools were not covered by any assertion (a viewer whose
snapshot was visible but whose class was not) — now covered, with mutations for each.
**Open:** no external-provider egress control and no rate or cost limit exist; both are
required before a language-model provider is connected. The reference provider proves the
governance, not the quality.

## Multi-agent

People is never spoken for; perspectives see the subset relevant to them; tensions are
gains and concessions side by side; there is no vote, consensus, score, rank or choice at
any depth; the orchestrator has one method. **A weakness found by mutation:** the first
contract could not tell whether a perspective was handed its own subset or the whole pool
(the reference provider's caps hid it); it now asserts every cited item is relevant to
its perspective.

## Integration

Idempotent by content; a bad record holds the checkpoint; breaking drift blocks and writes
nothing; identity is never a name and a conflict is never merged; write-back is a dry run
in the schema and in the gateway. **Tightened during the audit:** `verify:memoire-boundary`
used to permit appending to `commercial_events` from the bridge — a write the bridge no
longer makes. It now forbids any write to a Memoire table from any file, and a mutation
proves it. (Its first version of the rule contained a regex whose `\b` had been turned into
a backspace character; the mutation is what showed the rule was not firing.)

## Manual entry

There is no form that types in a source fact. Reviews accept a question (the one thing a
review owns); the decision pages accept management's own framing, criteria, assumptions and
challenges; causal and genome records are judgements with provenance and a required stance
that must agree with HELM's own records.

## UX

Browser-verified in demo mode at desktop and narrow widths with no console errors on the
Cockpit, `/twin`, `/scenarios`, `/decisions`, `/governance`, `/causal`, `/genome`,
`/counterfactuals`, `/reviews` and `/sources`, including an AI question and a council. The
UI rules are enforced by review, not by a contract: there is no automated visual test.

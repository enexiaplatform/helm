# Management reviews — layer reference

`@helm/review-runtime` · [ADR-0031](../../adr/0031-management-reviews.md) ·
migration `20260930140000_helm_management_reviews.sql` ·
[architecture](../helm-architecture.md)

The management operating cadence as an object: weekly, monthly, quarterly and
strategic reviews that bind what already exists, close with a disposition for every
item, carry what is open forward by reference, and can always be reproduced.

## What exists

| Object | Meaning |
| --- | --- |
| `ManagementReview` | cadence, scope, period label, previous review, opening twin snapshot and lens, preparation-pack fingerprint, sensitivity classes (from the opening snapshot), visibility |
| `ReviewItem` | a **reference** (`ATTENTION` `DECISION` `COMMITMENT` `ASSUMPTION` `ACTION_INTENT` `EPISODE` `PATTERN` `LESSON` `COUNTERFACTUAL_CASE` `CAUSAL_CLAIM`) or a **`QUESTION`** (the only content a review owns), with a role (`RAISED` `FRAMED` `COMMITTED` `RECONSIDERED` `NOTED`) and, when carried forward, the item it came from |
| `ReviewClosure` | closing snapshot and lens, closing-pack fingerprint, summary, and exactly one disposition per item (`RESOLVED` `CARRIED_FORWARD` `DROPPED`), each with a reason |
| `ReviewPack` | computed, never stored: what changed since the previous review closed, what matters, what is off-track, what is uncertain, decisions needed, assumptions changed, outcomes arrived, learning (episodes, patterns, counterfactuals), causal changes, and `unavailable` |

Runtime port: `openReview`, `addItem`, `closeReview`, `getReview`, `listReviews`,
`prepare`, `closingPack`, `reproduce`, `preparedFor`, `projectForViewer`.
`meridianReviews.ts` is the canonical two-review driver.

## Behaviour worth knowing

- **One open review per scope and cadence**; a review follows a **closed** review of
  the same scope, by default the latest.
- **A review binds; it never decides.** Recording that a commitment was "committed in
  this review" references a commitment the decision runtime made earlier; adding an
  item changes no decision.
- **Fingerprints are content-only.** `unavailable` is excluded so that connecting a
  source later cannot rewrite a closed review; `reproduce` recomputes the pack at the
  review's own lens and reports `identical`.
- **Lens.** Before it closed a review reads `OPEN`; before it opened it is not known.
- **Read whole or not at all**, and items follow their decision (`preparedFor` and
  `projectForViewer`); the database mirrors it with row-based policies.
- **No ranking.** A pack says "nothing is ranked, weighted or totalled", lists in
  kernel order, and has no minutes, agenda or attendee field.

## The canonical proof

Review 1 is lived *inside* the twin story: it opens with the state before the
decision, records that management framed and committed (by reference), and closes
after governance with the change during the review. Review 2 follows the outcome, the
causal claims, the genome and the counterfactual review: it inherits what Review 1
carried forward (the same references), is prepared with what changed since Review 1
*closed*, and shows expected against actual (committed 32.3878 gross margin against
31.7) with no verdict; it closes carrying one question on.

## Proof

45 package tests (1 skipped) · `verify:review-schema`, `-runtime`, `-security` ·
mutations on closure coverage, read-whole, the previous-closed rule (both runtime and
store), nothing-hanging and clearance in both projections · live migration proven with
controls.

## Debt

Postgres conformance skipped (blocker B). Reviews are read-side heavy (a pack is
recomputed, ~10 ms in memory over the demo); no Postgres timing exists.

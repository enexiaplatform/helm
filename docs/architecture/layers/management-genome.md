# Management genome — layer reference

> **Layer reference.** This file began as the record of the build step that introduced the layer; "Phase N" in the text names that step, not a stage of the product. HELM is one system — read [the architecture](../helm-architecture.md) first. Anything the text says a later step would add now exists: see the other layer references and ADRs 0029–0033.

**Date** 2026-09-30 · **Status** complete in the kernel; pilot **blocked** by the
[trusted runtime deployment gate](../trusted-runtime-deployment-gate.md) (§10) ·
**ADR** [0028](../../adr/0028-management-genome.md) ·
**Previous** [phase 8](causal-graph.md)

Phase 8 let HELM say what the enterprise believes about why. Phase 9 lets it say
what the enterprise **remembers** of how it has met a situation — the beliefs it
held, how management decided and what happened — so a team can ask *have we
been here before?* and get an answer built from records, with its reasoning and
its limits on the page.

            Decision Process Quality ≠ Outcome Quality

It is memory a person curates. HELM verifies that a pattern is consistent with
the episodes it cites; it never finds one, never rates a decision, an outcome or
a person, and changes nothing because of a lesson.

---

## 1. The model

```
ManagementEpisode (immutable identity): the decision it wraps · commitment · situation features · decision boundary
   └─ references (append-only, bound once per role): SITUATION_SNAPSHOT · COMMITTED_FUTURE · OUTCOME_SNAPSHOT
                                                      CAUSAL_CONTEXT · GOVERNANCE_EVALUATION · OUTCOME_REVIEW
ManagementPattern (identity): scope · conditions · ONE observable characteristic
   ├─ revisions (append-only): statement · limitations (required) · retirement
   └─ links (append-only, one per pattern × episode): SUPPORTING | CONTRADICTORY | CONTEXTUAL
          the stance must agree with what HELM observed: SUPPORTS | CONTRADICTS | OUT_OF_SCOPE | NOT_OBSERVABLE
Lesson: a claim resting on ≥ 1 episode or pattern · reviews append-only · PROPOSED is the absence of a review
Pattern status, lesson status, episode OPEN/COMPLETED: DERIVED at a lens — never stored
```

Package **`@helm/genome-runtime`**, the new top of the kernel (it reads the
twin, the causal graph and the decision and authority runtimes; nothing below
imports it; it writes nothing below it).

| Module | Job |
| --- | --- |
| `types.ts` | vocabulary: features, episodes, references, patterns, revisions, links, lessons, reviews |
| `situation.ts` | situation features derived from kernel records **at the decision boundary**; hindsight refused; agreement per feature |
| `policy.ts` | `helm-genome-pattern@1`; `observeCharacteristic` (what an episode's own records say); `conditionsHold`; `stanceAgrees` |
| `runtime.ts` | episode assembly (process, outcome and beliefs kept apart), similarity, patterns, lessons, `viewAt`, `projectForViewer` |
| `inMemoryStore.ts` · `postgres.ts` · `conformance.ts` | two stores, one contract |
| `meridianGenome.ts` | the DEMO MANAGEMENT EPISODES story |

### What an episode shows

| Section | Holds | Never holds |
| --- | --- | --- |
| **situation** | decision type, trigger, reversibility, business unit, country, constraint kinds, expected and overridden metrics, customer class — read at the boundary; a feature the sources could not state is listed in `notStated` | anything recorded after the boundary; any person |
| **how management decided** | chosen alternative and those set aside, modelled and unmodelled counts, criteria, assumptions with owner and criticality, challenges and whether they were open at commitment, evidence | an outcome, a quality judgement |
| **what happened** | expected against actual, assumption results, governance state | a verdict on the decision |
| **what management believed** | causal claims known at the boundary (`atDecision`) | hindsight |
| **claimed since** | claims recorded after the boundary, shown apart | — |

### Pattern status — `helm-genome-pattern@1` (ADR-0028 §6)

RETIRED › CONTESTED (any contradictory episode; a majority never outvotes it) ›
SUPPORTED (≥ 3 supporting episodes of distinct decisions across ≥ 2 contexts) ›
RECURRING (≥ 2 distinct decisions) › EMERGING (one case or none, labelled weak).
Every status carries its reasons and its **coverage** — how many recorded
episodes match the conditions, how many are linked, which nobody has reviewed —
and the caveat that recurrence in *recorded* episodes is not a law.

## 2. Database

One additive migration, `20260930110000_helm_management_genome.sql`, applied to
the shared project in **five** named parts (`01_tables`, `02_guards`,
`03_rules_rls`, `04_writer_grants`, `05_review_index`).

| Object | |
| --- | --- |
| `helm_genome_episodes` | wraps a decision by reference; one per commitment; `boundary_effective ≤ boundary_recorded`; classes a checked subset of the five; scoped |
| `helm_genome_episode_refs` | six roles; one row per (episode, role, referenced id); a pointer only |
| `helm_genome_patterns` · `_pattern_revisions` | scoped or justified enterprise-wide; three observable characteristic kinds; limitations required; sequential revisions that stop at retirement; a pattern is recorded with its revision 1 (deferred guard) |
| `helm_genome_pattern_evidence` | one link per (pattern, episode); `stance_agrees` CHECK; a retired pattern takes none |
| `helm_genome_lessons` · `_lesson_reviews` | evidence of episodes or patterns only; an author cannot endorse their own lesson |
| guards | write-once; `NEW.recorded_at := now()` (the database's record time); same-org references |
| `helm_private` | row rules `genome_episode_row_visible`, `genome_pattern_row_visible`, `genome_lesson_row_visible` and by-id wrappers |
| `helm_record_genome_pattern(jsonb, jsonb)` | SECURITY INVOKER; pattern and revision 1 in one transaction |
| privileges | anon: none; authenticated: SELECT, INSERT only (UPDATE/DELETE/TRUNCATE revoked) |

No column stores a status, quality, score, rating, verdict, rank or probability,
and none is about a person; `verify:genome-schema` checks both.

### Applied to the shared database

| | before | after |
| --- | --- | --- |
| Memoire `accounts` / `opportunities` | 1 106 / 129 | 1 106 / 129 |
| Memoire functions · fingerprint | 9 · `eef6a68b…` | 9 · `eef6a68b…` (identical) |
| `helm_*` tables | 64 | 71 |
| public policies | 248 | 262 |
| `helm_private` functions | 24 | 30 |
| genome rows · fixture users · fixture orgs | — | 0 · 0 · 0 |

## 3. Server-side proof (rolled back)

**80 assertions: 52 refusals and 28 legal controls, 0 failures**, each refusal
matched against its *reason* (a refusal for the wrong reason is a failure). All
fixtures verified back at zero.

| Proved | |
| --- | --- |
| member `INSERT … RETURNING` reads its own row back for an episode (general and FINANCIAL), a reference, a pattern via the writer, a RESTRICTED pattern, a link, a revision, a lesson, a review | controls — the Phase 8 defect does not recur |
| Country GM above Pharma, cleared, reads the Pharma episodes, patterns (including the one RESTRICTED to Pharma), lessons and links; endorses a lesson (control) | subtree + compartments |
| a Pharma member without the FINANCIAL clearance reads the general episode, its pattern and lesson (controls) but **not** the FINANCIAL episode, **nor** the pattern, lesson, link or references resting on it | read whole or not at all |
| Industrial reads **none** of the Pharma episodes, references, patterns, RESTRICTED patterns, lessons or reviews, and cannot open an episode on a decision it cannot see | BU restriction, decision capture |
| an episode on an admin-only decision, and the pattern resting on it, are invisible to the GM and to the member who wrote the others | decision capture |
| an admin opens the episode, writes and links the pattern, retires **another author's** pattern (controls) | |
| impersonating an author or a binder · a non-author, non-admin retiring a pattern · opening a FINANCIAL episode uncleared | refused (RLS) |
| UPDATE / DELETE by a client (no privilege) · UPDATE and DELETE on each of the seven tables by the owner (guards) | refused |
| the same reference bound twice · the same episode linked twice · a stance HELM did not observe · a lesson resting on a decision · on an episode that does not exist · self-endorsement · a skipped revision · retirement without a reason · linking to a retired pattern · revising a retired pattern · a pattern without its first revision · another org's decision · an unknown class · a reversed boundary · an unscoped pattern · a characteristic HELM cannot observe | refused (guards, CHECKs) |
| record time stamped by the database though a back-dated value was supplied · `authenticated` holds no UPDATE, DELETE or TRUNCATE and `anon` no SELECT on any genome table | controls |

**What the proof taught.** Refusing an episode on an invisible decision came
from the *guard* (which reads the decision under the caller's RLS) before the
policy was consulted — both layers refuse; the proof's expected reason was
widened, not the rule. No database defect was found; the ones below were found
elsewhere.

**Advisors afterwards.** Security: no new findings (the helpers live in
`helm_private`; the writer is SECURITY INVOKER). Performance: 14
`unindexed_foreign_keys` INFOs and 2 `unused_index` INFOs on the empty genome
tables; the one real read path (`helm_genome_lesson_reviews.lesson_id`) is
indexed (part 5).

### Defects found on the way, and where

| Found by | Defect | Fix |
| --- | --- | --- |
| a runtime test | `classifyEpisode` classified patterns and episodes not yet known at the lens | `NOT_KNOWN_AT_LENS` refusal |
| `verify:genome-scope` | asking for a feature the situation does not state returned an empty list that read like "nothing like it" | `unstatedInTarget` on the result and a "cannot tell" statement (ADR-0028 §2) |
| the mutation suite | the stance invariant survived breaking its policy layer — because the store repeats it | both layers are broken together (`also:` mutations), and the contract catches it |
| the running app | the demo Country GM saw **nothing**: the demonstration decisions were shared with no unit, and decision visibility is a rule, not a courtesy | the story shares each decision with the Pharma unit (`shareWith`), as the governance demo does; a test proves the real `canSeeDecision` rule, shared and unshared |
| the running app | the demo twin has no `call-off` scenario (the test stack does) | the genome demo builds it beside the twin's canonical scenarios |

## 4. Canonical demo (DEMO MANAGEMENT EPISODES)

Five episodes, three patterns, two lessons over the Rohto decision and four
labelled demonstration decisions.

```
E1  Rohto Q4 allocation              COMPLETED  situation read at S0: KEY_ACCOUNT, INVENTORY breached
      process: chose B over 4 alternatives · 5 alternatives, 4 modelled · 1 CRITICAL assumption with nobody behind it
               · Finance's cost challenge OPEN at commitment
      outcome: GrossMarginPct expected 32.3878 · actual 31.7 · variance −0.6878 · "provincial tender" assumption DISPROVED
      beliefs: 0 at the decision · 4 fulfilment-cost claims since (SUPPORTED, UNRESOLVED ×2, HYPOTHESIS)
E2  Rohto Q1 call-off (planned)      COMPLETED  E3 Thailand Pharma tender   E4 second account, expedited   E5 freight priced in

P1  Margin lands below the committed margin on Vietnam Pharma allocations   CONTESTED
      2 supporting · 1 contradictory (E5: freight priced in) · 2 outside its scope (Thailand, planned call-off) · covers 3 of 3
P2  A finance cost challenge is left open at commitment on issue-triggered Vietnam Pharma allocations   RECURRING
P3  A material assumption is disproved on issue-triggered Rohto decisions   EMERGING (weak — "one case is a hint, not a pattern")

L1  "Ask Finance to confirm the freight premium is in the commitment"   ENDORSED by Finance (not its author)
L2  "Name an owner for every critical assumption before commitment"    PROPOSED
```

On **6 April, before the contradiction was linked**, P1 reads RECURRING (2
supporting, 0 contradictory) and stays that way for that lens; today it reads
CONTESTED. On 2 April no pattern existed.

Similarity: episodes agreeing on decision type, business unit and trigger →
E4 only; on decision type and business unit → E2, E4, E5 in the order they were
decided; Thailand + decision type → none, "not evidence the situation is new".

## 5. `/genome` (Kernel instrument)

Episodes, Patterns, Lessons; the aside opens an episode as *How did we decide,
and what happened?* (situation, process, outcome, beliefs then and since, the
patterns it bears on, and a "have we seen this before?" panel with a tick-box
per feature) or a pattern as *What the records say* (status with reasons,
coverage, supporting / contradictory / outside-its-scope episodes with HELM's
observation, limitations and the caveat). "Read as" and "As known on" select the
reader and the lens. Two notices are always on the page: **Process is not
outcome** and the demo label. Pills: RECURRING (cyan) and ENDORSED (lime) are new
tones, each fixed to one meaning.

Verified in the running demo: the Country GM (cleared) reads all five episodes;
the analyst without the FINANCIAL clearance and the Industrial head read none
and are told what was withheld and why; the 6 April lens shows P1 RECURRING and
no lessons; the console is clean.

## 6. Contracts and tests

`verify:genome-schema`, `-runtime`, `-temporality`, `-scope`, `-lineage`,
`-security`, `-process-outcome`, and `verify:phase-boundary` (updated: the genome
confined to its package and surfaces; **no pattern learning, decision-quality or
person score, outcome prediction, embedding or clustering anywhere**; the genome
writes nothing below it). `node scripts/lib/mutate.mjs` breaks **126 invariants**
across 36 contracts (27 of them Phase 9); every one is caught. Genome tests: 59
passing (14 canonical, 16 policy, 13 episodes, 11 security, 5 store conformance)
plus 1 SKIPPED Postgres conformance suite. `npm run check`: 672 tests, 663 pass,
9 skipped, 0 fail; 54 contracts ok.

## 7. Performance (in memory; no database timing is quoted)

`node scripts/lib/bench-genome.mjs`, five episodes and three patterns:

| | |
| --- | --- |
| episode retrieval, assembled from the kernel | 0.33 ms |
| all five episodes, each assembled | 1.80 ms |
| situation derivation (records nothing) | 0.14 ms |
| similarity, three required features | 0.36 ms |
| pattern retrieval, evaluated | 2.30 ms |
| all patterns, each over its links | 2.24 ms |
| one classification | 0.12 ms |
| historical view (6 April) reconstructed | 3.47 ms |
| per-viewer projection (uncleared GM · admin) | 4.13 ms · 4.71 ms |
| pattern policy alone, 500 supporting episodes | 0.02 ms |

## 8. Maturity, blockers and debt

| Layer | State |
| --- | --- |
| Kernel | Phase 9 complete |
| Shared database schema | Phase 9 migration applied and verified (80 assertions) |
| Postgres genome store | written; conformance suite **SKIPPED** (no isolated authenticated environment) |
| Trusted authority deployment | **NOT DEPLOYED** (unchanged) |
| Cloud end-to-end readiness | **NOT YET PROVEN** |
| Production / pilot readiness | **BLOCKED** by the deployment gate |

- **Blocker A** — unchanged.
- **Blocker B** — now 9 SKIPPED suites (the genome store joins them). The cloud
  path for episodes, patterns and lessons is unproven; the running demo is the
  only end-to-end exercise of the genome.
- Debt: no cloud UI to author episodes, patterns or lessons (the demo authors
  them through the kernel); the `COUNTERFACTUAL_CASE` reference role arrives
  with Phase 10; unindexed foreign keys (INFO); the genome is only as complete
  as the episodes someone recorded — coverage says so, and nothing opens an
  episode automatically.

## 9. What Phase 9 does not do

No pattern discovery or mining, no embeddings or clustering as similarity, no
decision-quality score, no ranking or rating of a person, no outcome prediction,
no automatic policy, calculation, belief or authority change from a lesson, no
counterfactual (Phase 10), no AI (Phase 11). Phase 10 has not been started.

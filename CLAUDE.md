# HELM — UI rules for Claude Code

It governs every UI change. How it is wired into this repo, and the deliberate deviations: [docs/product/visual-system.md](docs/product/visual-system.md).

## Stack
React 19 + Vite + TypeScript + Tailwind 3 + lucide-react. Tokens live ONLY in `tailwind.config.js`; fonts and base/component classes in `src/index.css` (fonts self-hosted from `public/fonts`). No other CSS files, no inline hex, no arbitrary colours (`bg-[#...]`).

## The look — "Chart room" (design system of 2026-10-13)
HELM is a system of record for management judgement: a ship's log for decisions. Calm, flat, exact.
- Workspace = `bg-paper` (ink-50 #f7f5f0). Sheets = white, 1px `border-ink-200`, `rounded-xl` (6px), `shadow-panel` (a 1px bottom tick). Inner blocks and table headers = `bg-sheet` (#fbfaf7).
- Rail = 232px paper rail on `bg-ink-100` with a hairline right edge; the current page is a white fill with a hairline and a teal icon. A sticky 48px breadcrumb bar (paper at 92%, 6px blur) carries the amber demo pill and, on instrument pages, the clocks.
- Navy (`bg-navy`) is the one night surface: Auth. Nowhere else.
- Accent = **sea teal** (`accent-*`): focus, the active place, modelled values, the mark's knobs, the rail's count pill (`accent-600`), links (`accent-700`). Emphasis — primary buttons, headlines — stays navy ink (`ink-950`).
- Status colours are muted and only for signals and outcomes: brick `red-*` (critical), ochre `amber-*` (warning), forest `emerald-*` (good). Violet is reserved for scenarios.
- **Truth layers** — never blur two into one figure; show both, with the variance between them. Always shape plus colour (`TruthMark`, `TruthShape`, and the truth tones of `Pill`):
  - actual ■ ink (`truth-actual`) — what is, from a source system
  - modelled ◆ teal mono (`truth-modelled`) — what the model computes
  - stated ○ slate (`truth-stated`) — what the business says: forecast, target, policy
  - scenario ⬚ dashed violet (`truth-scenario`) — what might happen
- Three typefaces, three jobs:
  - `font-serif` (Source Serif 4, semibold) = page titles, the decision question, questions in lists, section heads, chosen-alternative letters, quoted challenges (italic).
  - `font-sans` (Be Vietnam Pro) = every interface word: 14px body, 12px dense, 11px meta, eyebrows 11px semibold caps.
  - `font-mono` (JetBrains Mono) = rule codes, fingerprints, provenance lines, modelled values, loop hints.
- Use the named type scale (`text-display`, `text-title`, `text-instrument`, `text-signal`, `text-section`, `text-panel`, `text-figure`, `text-lede`, `text-read`, `text-base`, `text-ui`, `text-dense`, `text-meta`, `text-label`, `text-tag`). Tailwind's default `text-sm/lg/xl` do not exist here.
- Radii: 2px tags and bars · 4px buttons, inputs, nav items, notes · 6px sheets and modals · full for badges. This is a record, not a bubble.

## Layout principles
1. **Headlines answer, not label.** Management pages open with a serif sentence stating the situation ("Five conditions cannot wait. Three need a look this week."), not the page name.
2. **Section titles are questions or plain-language claims** ("What management committed to", "Is the preparation complete?"), with their caveat as a right-hand caption ("procedural completeness only, never a judgement of the choice").
3. **Severity decides treatment.** Conditions that cannot wait get a full row (serif title, cause, evidence); lesser ones get one scannable line. Never sum them into one score.
4. **Tables are ledgers:** paper caps header (`ledger-th`) on an ink-300 rule, hairline rows, totals on an accounting double rule, at most one teal-tinted decision column (`shadow-decision` on its head). Hatched (`hatch`) means "cannot be computed", not zero. Every bar sits next to its printed number.
5. **Two columns on management pages:** main + aside, wrapping on narrow screens. Content max width 1152px (`max-w-management`), padding 24px.
6. **One primary button per view.**

## Content rules
- HELM never ranks, scores or recommends. Say "nothing is ranked, weighted or totalled" where comparisons appear.
- HELM speaks about itself in the third person ("HELM records the intent"), never "we".
- Sentence case everywhere. UPPERCASE only via the eyebrow (`helm-label`, `ledger-th`). Kernel enums are rendered readable: `READY_FOR_DECISION` → "Ready for decision" (`Pill` does this).
- Metadata joined with " · ". True minus (−). Em dash for absent values. Percent deltas in "pts".
- Say BLOCKED, UNKNOWN, BREACHED, "nobody stands behind this" out loud — in `text-red-700`.
- No emoji, no exclamation marks, no marketing adjectives. Empty and loading states are honest and dry ("Nothing is on fire.", "Reading the record…").

## Components (src/components)
`brand/HelmLogo` (HelmLockup, HelmSymbol, HelmWordmark, HelmAppIcon) · `shell/AppShell` (`wide` for instrument pages) · `ui/{Button, Pill, TruthMark, PageHeader, SectionHead, FactRow, MetricList, Field, TextField, Modal, Notice, EmptyState}` · `decision/{CommitmentBanner, CriteriaMatrix, AssumptionList, ChallengeList, DecisionRow, GovernancePanel}` · `scenario/{ScenarioCompare, OverrideList, FeasibilityList, LineageTree}` · `review/PackView` · `intelligence/{AnswerView, IntelligencePanel, CouncilPanel, AskHelm}` · `memory/MemoryEntry` · `graph/{NodeIndex, NodeDetail}`. Compose pages from these; see `src/pages/CockpitPage.tsx` and `ReviewsPage.tsx` for management pages and `TwinPage.tsx` for an instrument page.
- Buttons: `primary` navy, `accent` teal, `secondary`, `ghost`, `danger`. Icons are Lucide, stroke 2: 16px in the rail, 13–14px in buttons.
- AI output is always rendered through `AnswerView`: statement class visible, evidence citable, what was removed and withheld said out loud, and the notice that it is interpretation, not enterprise truth. The council is progressive disclosure — the brief first, the perspectives behind it — and shows tensions side by side with no winner.

## Registers
- Management pages (Cockpit, Reviews, Decisions, Decision memory): 1152px cap, eyebrow "Management · …", headline = computed sentence (serif 28).
- Instrument pages (Scenarios, Value Graph, Ontology, Calculations, Governance, Twin, Causal, Genome, Counterfactuals, Sources): `AppShell wide`, eyebrow "Kernel instrument · …", serif 28 title naming the object, runs and fingerprints visible in mono.

## Logo
A six-spoke helm wheel: paper spokes and teal knobs on a navy tile; a tileless navy wheel for paper grounds. The wordmark is HELM in Source Serif 4 semibold caps, tracked 0.16em. Always render it from `HelmLogo.tsx` or `public/brand/*.svg`; never recolour the knobs, rotate the wheel, or add effects.

## Motion
150ms `ease-helm` on colour only. No press scale, no entrance animations, skeleton shimmer or bounce. Focus: inputs get a teal border plus a 3px teal ring at 15% (`shadow-field`); everything else a paper gap plus a 2px teal ring (`shadow-focus`).

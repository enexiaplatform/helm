# HELM — UI rules for Claude Code

It governs every UI change. How it is wired into this repo, and the deliberate deviations: [docs/product/visual-system.md](docs/product/visual-system.md).

## Stack
React 19 + Vite + TypeScript + Tailwind 3. Tokens live ONLY in `tailwind.config.js`; fonts in `src/index.css` (self-hosted from `public/fonts`). No other CSS files, no inline hex, no arbitrary colours (`bg-[#...]`).

## The look — "Chart room"
- Page = `bg-paper` (#f3f1eb). Sidebar, auth backdrop and the commitment banner = `bg-navy` (#0d1a2e). Panels = white with `border-ink-200`, `rounded-xl`.
- **Brass (`brass-400`) appears in exactly three places:** the logo, the active-nav dot, the Attention count pill. Nowhere else.
- One accent: Prussian `accent-800` for primary buttons, `accent-700` for links.
- Three typefaces, three jobs:
  - `font-serif` (Newsreader 500) = the management voice: page headlines, section heads, signal titles, headline figures, assumption statements, quoted challenges (italic), caveats (italic).
  - `font-sans` (Be Vietnam Pro) = interface: nav, buttons, labels, body.
  - `font-mono` (IBM Plex Mono) = every value, date, ID, rule code, fingerprint, enum.
- Use the named type scale (`text-display`, `text-title`, `text-signal`, `text-section`, `text-panel`, `text-figure`, `text-lede`, `text-read`, `text-base`, `text-ui`, `text-dense`, `text-meta`, `text-label`, `text-tag`). Don't use Tailwind's default `text-sm/lg/xl`.

## Layout principles (the v2 fix for "generic dashboard")
1. **Headlines answer, not label.** Management pages open with a serif sentence stating the situation ("Two signals cannot wait. Four need a look this week."), not the page name.
2. **Rules, not boxes.** Group content with `SectionHead` (serif title over a 2px `border-ink-950` rule) and rows separated by 1px `border-ink-200` hairlines. Never nest cards. White cards are only for: evidence grids, the metric side panel, link cards.
3. **Severity decides treatment.** Critical items get full editorial rows (`SignalArticle`); lesser items get one scannable line (`SignalLine`). Don't render everything at the same weight.
4. **Two columns on management pages:** main `flex-[1_1_560px]` + aside `max-w-[360px]`, gap 40px, wrapping below ~960px. Content max width 1240px, padding 36 × 40.
5. **One primary button per view.**

## Content rules (unchanged from v1)
- HELM never ranks, scores or recommends. Say "nothing is ranked, weighted or totalled" where comparisons appear.
- Sentence case. UPPERCASE only for `helm-label` and raw kernel enums. Metadata joined with " · ". True minus (−). Percent deltas in "pts".
- Say BLOCKED, UNKNOWN, BREACHED, "nobody stands behind this" out loud — in `text-red-700`.
- No emoji, no exclamation marks, no marketing adjectives. Loading = present-progressive sentence.

## Components (src/components)
`brand/HelmLogo` (HelmLockup, HelmSymbol, HelmWordmark, HelmAppIcon) · `shell/AppShell` (`wide` for instrument pages) · `ui/{Button, Pill, PageHeader, SectionHead, FactRow, MetricList, TextField}` · `attention/{SignalArticle, SignalLine, EvidenceGrid}` · `decision/{CommitmentBanner, CriteriaMatrix, AssumptionList, ChallengeList, DecisionRow}` · `scenario/{ScenarioCompare, OverrideList, FeasibilityList, LineageTree}` · `memory/MemoryEntry` · `graph/{NodeIndex, NodeDetail}`. Compose pages from these; see `src/pages/*.v2.example.tsx`.

## Registers
- Management pages: 1240px cap, kicker "Management · …", headline = computed sentence (serif 44).
- Instrument pages (Scenarios, Value Graph, Ontology, Calculations): `AppShell wide`, kicker "Kernel instrument · …", serif 28 title naming the object, raw enums, runs and fingerprints visible.
- Brand graphics (chart grid, brass heading line) appear only on Auth.

## Logo
Always render the logo from `HelmLogo.tsx` or `public/brand/*.svg`. Never type "HELM" in a font as a logo, recolour the needle, rotate the mark, or add effects. Min sizes: lockup 72px wide, symbol 16px (compact cut below 28px).

## Motion
160ms `ease-helm` on colour/border/shadow only. No entrance animations, skeleton shimmer or bounce.

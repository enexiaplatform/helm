# Visual system — HELM v2 ("Bearing")

The console reads as an editorial management briefing, not a dashboard: warm
chart paper, navy chrome, one Prussian accent, brass only for the mark. The
rules every UI change follows are in the repository's
[`CLAUDE.md`](../../CLAUDE.md); this page records how the v2 design handoff is
wired into the app and what is still to adopt.

## Where it lives

| What | Where |
|---|---|
| Every token (colour, type scale, radii, shadows, widths) | [`tailwind.config.js`](../../tailwind.config.js) — the only place |
| Self-hosted fonts and base styles | [`src/index.css`](../../src/index.css), files in [`public/fonts/`](../../public/fonts) |
| Logo ("Bearing": ring + needle at 012.5°, drawn wordmark) | [`src/components/brand/HelmLogo.tsx`](../../src/components/brand/HelmLogo.tsx), files in [`public/brand/`](../../public/brand), favicon [`public/favicon.svg`](../../public/favicon.svg) |
| Shell (navy sidebar, text nav, the two clocks) | [`src/components/shell/`](../../src/components/shell) |
| Primitives (Button, Pill, PageHeader, SectionHead, FactRow, MetricList, Field, Modal, Notice, EmptyState) | [`src/components/ui/`](../../src/components/ui) |
| Page components | `src/components/{attention,decision,scenario,memory,graph}/` |

The clock strip shows the scenario workspace's own fork point — the boundary
every future is computed from — never a time the kernel did not use.

## Adopted so far

Tokens, fonts, logo, favicon and shell; Attention, Decisions, the Decision
Workspace, Memory, Auth and Onboarding are rebuilt on the v2 components and
wired to the real runtimes.

Deliberate differences from the handoff, to keep product semantics:

- Challenge status and assumption outcomes use the kernel's own enums
  (`REJECTED`; `CONFIRMED`, `PARTIALLY_CONFIRMED`, `DISPROVED`…).
- Outcome variances are set in ink, not brick: HELM does not grade outcomes.
- Warning signals keep **Dismiss**, which v1 offered on every signal.

## Still to adopt

Scenarios, Value Graph, Ontology, Calculations, Economics, Operations and
Settings still use the v1 layout. They stay readable through a **temporary
bridge** — legacy text sizes in `tailwind.config.js` and `.btn-*`, `.field-*`,
`.table-*` recipes in `src/index.css`, both marked TEMPORARY — together with the
old `src/components/ui.tsx`. When those pages are rebuilt on the v2 components
(`ScenarioCompare`, `OverrideList`, `FeasibilityList`, `LineageTree`,
`NodeIndex`, `NodeDetail`), delete the bridge and `ui.tsx`.

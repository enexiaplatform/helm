# Visual system — HELM v2 ("Bearing")

The console reads as an editorial management briefing, not a dashboard: warm
chart paper, navy chrome, one Prussian accent, brass only for the mark. The
rules every UI change follows are in the repository's
[`CLAUDE.md`](../../CLAUDE.md); this page records how the v2 design handoff is
wired into the app.

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

## Adopted

Every screen is on v2.

- **Management register** (1240px, computed serif headline, two columns with an
  aside): Attention, Decisions, the Decision Workspace, Memory, Economics,
  Operations.
- **Instrument register** (full width, 28px title, raw enums): Scenarios, Value
  Graph, Ontology, Calculations.
- Settings, Auth and Onboarding follow the same grammar.

The v1 bridge (`ui.tsx`, legacy text sizes, `.btn-*` recipes) is gone.
`lucide-react` is no longer imported; it can be dropped from `package.json`
together with its chunk rule in `vite.config.ts`.

## Deliberate differences from the handoff

Kept to preserve product semantics:

- Challenge status, assumption outcomes and constraint status use the kernel's
  own enums (`REJECTED`; `CONFIRMED`, `PARTIALLY_CONFIRMED`, `DISPROVED`…;
  `SATISFIED` rather than MET).
- Outcome variances are set in ink, not brick: HELM does not grade outcomes.
- Warning signals keep **Dismiss**, which v1 offered on every signal.
- Pages the handoff did not draw keep every v1 capability — scenario drafting,
  overrides, sealing, rebase and replay; value-chain depth; ontology traversal;
  model runs — recomposed as section heads over hairline rows.
- Components gained small hooks the app needs: clickable values for lineage in
  `ScenarioCompare`, a per-row action in `OverrideList`, a `children` slot in
  `NodeDetail`, and real routes instead of `#` links.

# Visual system — HELM "Chart room" (2026-10-13)

HELM is a system of record for management judgement: a ship's log for
decisions. Warm paper workspace, white sheets, deep navy ink, one sea-teal
accent like a navigation instrument, muted status colours, and four truth
layers that are never blurred into one number. The rules every UI change
follows are in the repository's [`CLAUDE.md`](../../CLAUDE.md); this page
records how the design system package ("HELM Design System", synced from this
repository on 2026-10-13) is wired into the app. It supersedes v2 "Bearing"
(navy sidebar, Prussian accent, brass mark, Newsreader / IBM Plex Mono).

## Where it lives

| What | Where |
|---|---|
| Every token (colour ramps, truth layers, type scale, radii, shadows, widths) | [`tailwind.config.js`](../../tailwind.config.js) — the only place |
| Self-hosted fonts (Be Vietnam Pro, Source Serif 4, JetBrains Mono), base styles, `helm-label` / `ledger-th` / `hatch` classes | [`src/index.css`](../../src/index.css), files in [`public/fonts/`](../../public/fonts) |
| Logo (six-spoke helm wheel, serif wordmark tracked 0.16em) | [`src/components/brand/HelmLogo.tsx`](../../src/components/brand/HelmLogo.tsx), files in [`public/brand/`](../../public/brand), favicon [`public/favicon.svg`](../../public/favicon.svg) |
| Shell (paper rail with Lucide icons and loop hints, sticky breadcrumb bar, the two clocks) | [`src/components/shell/`](../../src/components/shell) |
| Primitives (Button, Pill, TruthMark, PageHeader, SectionHead, FactRow, MetricList, Field, TextField, Modal, Notice, EmptyState) | [`src/components/ui/`](../../src/components/ui) |
| Page components | `src/components/{cockpit,decision,scenario,review,intelligence,memory,graph}/` |

The bar's clocks show the scenario workspace's own fork point — the boundary
every future is computed from — never a time the kernel did not use. They
appear on instrument pages only.

## How the package maps onto the app

The package's components are inline-styled JSX over CSS variables; the app
expresses the same values as Tailwind tokens, so each package component maps to
an existing primitive rather than being copied in:

| Package | App |
|---|---|
| `tokens/*.css` | `tailwind.config.js` (ramps keep their names: ink, accent, red, amber, emerald, violet, slate) and `src/index.css` |
| `Button` (primary / accent / secondary / ghost / danger) | `ui/Button` |
| `Chip`, `Pill`, `SeverityBadge` | `ui/Pill` (2px chip, readable enums, truth shapes) and the severity dot of `ui/SectionHead` |
| `TruthMark` | `ui/TruthMark`, `TruthShape` in `ui/Pill` |
| `PanelCard`, `Stat`, `StatStrip` | `ui/MetricList`, `decision/CommitmentBanner`; sections elsewhere are `SectionHead` over hairline rows |
| `Field`, `Input`, `Select` | `ui/Field` (`controlClass`, `controlSmClass`), `ui/TextField` |
| `Modal`, `Notice`, `EmptyState` | `ui/Modal`, `ui/Notice`, `ui/EmptyState` |
| `Sidebar`, `Banner`, top bar | `shell/AppShell` |
| `DataTable` (ledger) | `ledger-th`, the `thead th` base rule, `shadow-decision`, `hatch`; used by `decision/CriteriaMatrix` |
| `HelmMark`, `HelmLockup` | `brand/HelmLogo` |

## Deliberate differences from the package

- **Navigation keeps the app's groups** (Management, Model, Learning, Setup —
  audit 2026-10-12) rather than the package's "Operating loop / Kernel" split,
  because the app has pages the package did not draw (Reviews, Twin, Causal,
  Counterfactuals, Genome, Sources, Governance). The loop stage is still shown
  as a mono hint on the items that serve one.
- **Icons come from `lucide-react`**, already a dependency, not the CDN build the
  package's `Icon` loads.
- **Header captions are ink-500, not ink-400**, so a caveat stays readable on
  paper (ink-400 is under 3:1 there).
- **Sections are not all wrapped in white sheets.** The package draws every
  section as a `PanelCard`; the app keeps `SectionHead` over hairline rows for
  most sections and uses sheets for the commitment, metric panels, evidence and
  link cards. Section heads carry the package's voice (questions, right-hand
  caveat) in a 17px serif over an ink-300 hairline.
- **The favicon is the new wheel on its navy tile**, not the package's carried-
  over blue favicon, so the tab and the rail show the same mark.
- Kept from v2 to preserve product semantics: kernel enum words for challenge,
  assumption and constraint status (now rendered readable); outcome variances
  in ink, not brick (HELM does not grade outcomes); Dismiss on warning signals;
  every capability on pages the package did not draw.

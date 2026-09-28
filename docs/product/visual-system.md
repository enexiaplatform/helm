# Visual system — "Chart room"

HELM's console is set like a navigator's chart table: warm chart paper, navy
ink, brass instruments. It should read as a well-set management briefing, not a
dashboard. This page records how the design system is wired into the app and
the rules the code relies on. The design system itself (brand book, component
kit, specimen cards) was delivered separately; its tokens are copied here
verbatim.

## Where it lives

| What | Where |
|---|---|
| Palette, the one source | [`src/styles/tokens/colors.css`](../../src/styles/tokens/colors.css) |
| Surfaces, text, borders, interaction | [`src/styles/tokens/semantic.css`](../../src/styles/tokens/semantic.css) |
| Truth grammar (severity, truth kind, origin, dimension, lifecycle) | [`src/styles/tokens/helm-semantics.css`](../../src/styles/tokens/helm-semantics.css) |
| Type roles, space, radii, shadows, motion | [`src/styles/tokens/typography.css`](../../src/styles/tokens/typography.css), [`spacing.css`](../../src/styles/tokens/spacing.css) |
| Self-hosted fonts (latin, latin-ext, vietnamese) | [`src/styles/fonts/`](../../src/styles/fonts), declared in [`fonts.css`](../../src/styles/tokens/fonts.css) |
| Component recipes (`.btn-*`, `.field-*`, `.table-*`, `helm-*`) | [`src/index.css`](../../src/index.css) |
| Shared primitives, `PageHeader` | [`src/components/ui.tsx`](../../src/components/ui.tsx) |
| Wordmark and symbol | [`src/components/HelmLogo.tsx`](../../src/components/HelmLogo.tsx), favicon [`public/helm.svg`](../../public/helm.svg) |

[`tailwind.config.js`](../../tailwind.config.js) **reads `colors.css`** to
build its palette, so `text-ink-500` in a page and `var(--ink-500)` in a
recipe are the same value by construction. Change a colour in `colors.css`
only; restart the dev server afterwards (Tailwind does not watch that file).
The hue families keep Tailwind's names (emerald, amber, red, violet, sky…)
but every value is HELM's own, muted to sit on paper.

## Rules the code relies on

- **Three typefaces, three jobs.** Newsreader (serif) is the management voice:
  page titles, the management question, panel titles, headline figures, and in
  italic the caveats. Be Vietnam Pro runs every control and sentence. IBM Plex
  Mono carries every value, key, fingerprint and formula (`font-mono`).
- **Two registers.** Management pages (Attention, Decisions, Memory, Economics,
  Operations) use `PageHeader` with a 34px title; kernel instruments
  (Scenarios, Value Graph, Ontology, Calculations) pass
  `register="instrument"` for 28px. The kicker says which register the reader
  is in.
- **Brass is the heading, nothing else**: the wordmark's crossbar, the active
  nav glyph, the Attention count.
- **One primary action per view.** Primary is Prussian (`btn-primary`); a
  per-row action such as *Frame a decision* is secondary.
- **Reading text is `ink-500` or darker.** `ink-400` does not clear 4.5:1 on
  white; it is for decoration (└, the dash of an empty cell) and placeholders.
- **A panel caveat is a string.** `PanelCard action="…"` sets it in italic
  serif; pass a node only for controls.
- **Words first, tint second.** Every semantic hue is fixed to one meaning in
  `helm-semantics.css`; never re-map a hue.
- No gradients, illustration, blur or emoji. Motion is 160ms on colour, border
  and shadow only.

## Adopted so far, and what is next

Adopted: tokens, fonts, radii, shadows, the component recipes, the navy shell
with grouped Management / Kernel navigation, `PageHeader` on every page, serif
panel titles and figures, the auth and onboarding screens, the wordmark and
favicon.

Not yet: the design system's truth-grammar components (`Value`, `Delta`,
`TruthTag`, `OriginTag`, `KnowledgeBoundary`, `TruthComparison`), `StatStrip`
with hairline dividers, `Segmented`, and the page-by-page layouts of its
console kit. Pages still carry their own tone maps (`bg-violet-50
text-violet-800`…); they already resolve to the new palette, and should move
to the `helm-semantics.css` tokens as each page is rebuilt.

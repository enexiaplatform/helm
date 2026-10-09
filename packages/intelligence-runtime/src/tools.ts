/**
 * The governed tools: HELM exposed to the AI through domain interfaces only.
 *
 *   - READ-ONLY: every tool is `access: 'READ_ONLY'` and the sources it is given
 *     are read facets. There is no tool that writes an observation, overwrites a
 *     forecast, changes a target, approves, commits, changes authority policy,
 *     rewrites a causal claim, alters a calculation or executes an action.
 *   - AS THE CALLER: every tool reads through the caller's own access — snapshot
 *     visibility, sensitivity clearance, decision visibility and each runtime's
 *     projection. The AI never sees what the person asking may not, and a withheld
 *     entry is counted and said, never silently dropped.
 *   - NO SQL: the AI cannot query a table. It can call a tool named here, with
 *     arguments the tool validates, or nothing.
 */

import { canSeeSnapshot, isCleared, sensitivityOfMetric, type TwinRuntime, type TwinViewer } from '@helm/twin-runtime';
import type { CausalGraph } from '@helm/causal-runtime';
import type { CounterfactualRuntime } from '@helm/counterfactual-runtime';
import type { DecisionRuntime } from '@helm/decision-runtime';
import type { ManagementGenome } from '@helm/genome-runtime';
import type { ReviewRuntime } from '@helm/review-runtime';
import type { AuthorityRuntime, OrgUnit } from '@helm/authority-runtime';
import { fail, ok, type Result, type Scope } from '@helm/shared';
import type { ToolArgSpec, ToolCatalogueEntry } from './provider.ts';
import { IntelligenceErrors, type EvidenceItem, type EvidenceKind, type Lens } from './types.ts';

export type ToolContext = {
  readonly scope: Scope;
  readonly viewer: TwinViewer;
  readonly units: readonly OrgUnit[];
  readonly facts: { decisionVisible: (decisionId: string) => boolean };
  readonly now: string;
};

/** Evidence as a tool builds it: the runtime assigns the run-local id and the tool name. */
export type RawEvidence = Omit<EvidenceItem, 'id' | 'tool'>;

export type ToolResult = {
  readonly evidence: readonly RawEvidence[];
  /** What the tool wants said out loud: a withheld entry, an empty result, a limit. */
  readonly notes: readonly string[];
  readonly withheld: number;
};

export type GovernedTool = ToolCatalogueEntry & {
  /** The only access there is. A tool that could write would not type-check against this. */
  readonly access: 'READ_ONLY';
  run(ctx: ToolContext, args: Readonly<Record<string, unknown>>): Promise<Result<ToolResult>>;
};

export interface ToolRegistry {
  catalogue(): readonly ToolCatalogueEntry[];
  get(name: string): GovernedTool | undefined;
  all(): readonly GovernedTool[];
}

/** Read facets of the kernel. Nothing here is handed to a provider. */
export type IntelligenceSources = {
  readonly twin: TwinRuntime;
  readonly decisions: DecisionRuntime;
  readonly authority: AuthorityRuntime;
  readonly causal: CausalGraph;
  readonly genome: ManagementGenome;
  readonly counterfactual: CounterfactualRuntime;
  readonly review: ReviewRuntime;
};

// ------------------------------------------------------------------ helpers

const MAX = { items: 30, changes: 40, claims: 20, patterns: 15, episodes: 10, rows: 20 };

const A = {
  str: (name: string, description: string, required = true): ToolArgSpec => ({ name, type: 'string', required, description }),
  strs: (name: string, description: string, required = false): ToolArgSpec => ({ name, type: 'string[]', required, description }),
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isAdmin = (c: ToolContext) => c.viewer.orgRole === 'admin';
const canSeeDecision = (c: ToolContext, id: string) => isAdmin(c) || c.facts.decisionVisible(id);
const cleared = (c: ToolContext, metricKey: string | null) => !metricKey || isCleared(c.viewer, sensitivityOfMetric(metricKey), c.now);
const lensOf = (l: { effectiveAsOf: string; recordedThrough: string }): Lens => ({ effectiveAsOf: l.effectiveAsOf, recordedThrough: l.recordedThrough });

const ev = (kind: EvidenceKind, ref: { kind: string; id: string; pin?: string | null }, label: string, values: readonly string[], opts: { status?: string | null; section?: string | null; lens?: Lens | null } = {}): RawEvidence => ({
  kind,
  ref,
  label,
  values: values.filter((v) => v.length > 0),
  status: opts.status ?? null,
  section: opts.section ?? null,
  lens: opts.lens ?? null,
});

const done = (evidence: RawEvidence[], notes: string[] = [], withheld = 0): Result<ToolResult> => ok({ evidence, notes, withheld });
const withheldNote = (n: number, what: string) => (n > 0 ? [`${n} ${what} withheld: they exist and are above your clearance or rest on something you may not see.`] : []);

type ItemLike = { key: string; kind: string; label: string; layer: string | null; status: string; sensitivity: string; categories: readonly string[]; state: Readonly<Record<string, unknown>>; reason: string | null };

/** A twin item as evidence, classed by what it IS: a source claim, a model result, a management record. */
function evidenceOfItem(item: ItemLike, lens: Lens, section: string | null): RawEvidence {
  const st = item.state;
  const ref = { kind: 'TWIN_ITEM', id: item.key };
  if (item.kind === 'VALUE') {
    const value = st['value'] === null || st['value'] === undefined ? 'no reading' : `${String(st['value'])}${st['unit'] ? ` ${String(st['unit'])}` : ''}${st['currency'] ? ` ${String(st['currency'])}` : ''}`;
    const source = st['sourceSystem'] ? String(st['sourceSystem']) : null;
    const obs = String(st['observationType'] ?? '');
    const layer = String(item.layer ?? '');
    const kind: EvidenceKind = obs === 'ASSUMPTION' || obs === 'TARGET' || layer === 'TARGET' ? 'MANAGEMENT_ASSUMPTION' : layer === 'MODELLED' || obs === 'DERIVED' || obs === 'ESTIMATE' || !source || source === 'helm' ? 'MODEL_RESULT' : 'SOURCE_FACT';
    // The position's own label names its subject ("Opportunity Value — Talin AST / Tailin / Instrument"); the metric name
    // alone ("Opportunity Value") made thirty answers indistinguishable (audit 2026-10-09).
    return { ...ev(kind, ref, item.label || String(st['metricName'] ?? ''), [value, `layer ${layer}`, source ? `source ${source}` : 'computed by HELM', st['period'] ? `period ${String(st['period'])}` : ''], { status: layer || null, section, lens }), dimension: st['dimension'] ? String(st['dimension']) : null, metricKey: st['metricKey'] ? String(st['metricKey']) : null };
  }
  if (item.kind === 'ATTENTION') return ev('MODEL_RESULT', ref, item.label, [String(st['statement'] ?? item.reason ?? '')], { status: String(st['condition'] ?? ''), section, lens });
  if (item.kind === 'ASSUMPTION') return ev('MANAGEMENT_ASSUMPTION', ref, item.label, [String(st['statement'] ?? '')], { status: String(st['outcome'] ?? st['status'] ?? ''), section, lens });
  return ev('MANAGEMENT_RECORD', ref, item.label, [String(st['statement'] ?? item.reason ?? `${item.kind} ${item.status}`)], { status: item.status, section, lens });
}

async function latestVisibleSnapshot(ctx: ToolContext, twin: TwinRuntime, snapshotId: string | null, scopeKey: string | null) {
  if (snapshotId) {
    const s = await twin.getSnapshot(ctx.scope, snapshotId);
    if (!s.ok) return s;
    return canSeeSnapshot(ctx.viewer, s.value.snapshot, ctx.units).visible ? s : fail(IntelligenceErrors.NOT_VISIBLE, 'That snapshot is not visible to you.');
  }
  const all = await twin.listSnapshots(ctx.scope, { kind: 'CURRENT', ...(scopeKey ? { scopeKey } : {}) });
  if (!all.ok) return all;
  const visible = all.value.filter((s) => canSeeSnapshot(ctx.viewer, s, ctx.units).visible);
  const last = visible.at(-1);
  if (!last) return fail(IntelligenceErrors.NOT_VISIBLE, 'No current enterprise state is visible to you.');
  return twin.getSnapshot(ctx.scope, last.id);
}

// -------------------------------------------------------------------- tools

export function createGovernedTools(src: IntelligenceSources): ToolRegistry {
  const tools: GovernedTool[] = [];
  const tool = (t: Omit<GovernedTool, 'access'>) => tools.push({ ...t, access: 'READ_ONLY' });

  tool({
    name: 'getEnterpriseState',
    description: 'The current management state as you may read it: attention, objectives and value readings, each classed as a source fact, a model result or an assumption.',
    args: [A.str('snapshotId', 'A specific twin snapshot. Default: the latest current state you can see.', false)],
    async run(ctx, args) {
      const s = await latestVisibleSnapshot(ctx, src.twin, str(args['snapshotId']), null);
      if (!s.ok) return s;
      const lens = lensOf(s.value.snapshot.spec.lens);
      const proj = await src.twin.projectForViewer(ctx.scope, s.value.snapshot.id, ctx.viewer, ctx.units);
      if (!proj.ok) return proj;
      const items = proj.value.items as unknown as ItemLike[];
      const pick = [...items.filter((i) => i.kind === 'ATTENTION'), ...items.filter((i) => i.categories.includes('OBJECTIVES') && i.kind !== 'ATTENTION'), ...items.filter((i) => i.kind === 'VALUE' && /^Enterprise Value/i.test(i.label)), ...items.filter((i) => i.kind === 'VALUE' && i.layer === 'ACTUAL' && !/^Enterprise Value/i.test(i.label))].slice(0, MAX.items);
      const withheld = proj.value.withheld.reduce((n, w) => n + w.count, 0);
      return done(pick.map((i) => evidenceOfItem(i, lens, i.kind === 'ATTENTION' ? 'What matters?' : null)), [`Read from twin snapshot ${s.value.snapshot.id} (${s.value.snapshot.spec.label}).`, ...withheldNote(withheld, 'item(s)')], withheld);
    },
  });

  tool({
    name: 'getDataCoverage',
    description: 'What HELM actually holds data about in the current state, by value dimension — so that nobody speaks for a function HELM knows nothing about.',
    args: [A.str('snapshotId', 'A specific twin snapshot. Default: the latest current state you can see.', false)],
    async run(ctx, args) {
      const s = await latestVisibleSnapshot(ctx, src.twin, str(args['snapshotId']), null);
      if (!s.ok) return s;
      const lens = lensOf(s.value.snapshot.spec.lens);
      const proj = await src.twin.projectForViewer(ctx.scope, s.value.snapshot.id, ctx.viewer, ctx.units);
      if (!proj.ok) return proj;
      const items = proj.value.items as unknown as ItemLike[];
      const byDim = new Map<string, number>();
      for (const i of items.filter((x) => x.kind === 'VALUE')) {
        const d = String(i.state['dimension'] ?? 'UNCLASSIFIED');
        byDim.set(d, (byDim.get(d) ?? 0) + 1);
      }
      const hr = items.filter((i) => i.sensitivity === 'HR_RESTRICTED').length;
      const evN = items.filter((i) => i.kind === 'VALUE' && /^Enterprise Value/i.test(i.label)).length;
      const out: RawEvidence[] = [...byDim.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => ev('MANAGEMENT_RECORD', { kind: 'TWIN_SNAPSHOT', id: s.value.snapshot.id }, `Data coverage: ${d}`, [`${n} value reading(s) in dimension ${d}`], { status: d, section: 'coverage', lens }));
      if (evN > 0) out.push(ev('MANAGEMENT_RECORD', { kind: 'TWIN_SNAPSHOT', id: s.value.snapshot.id }, 'Data coverage: enterprise value', [`${evN} enterprise-value reading(s) in this state`], { status: 'ENTERPRISE_VALUE', section: 'coverage', lens }));
      out.push(ev('MANAGEMENT_RECORD', { kind: 'TWIN_SNAPSHOT', id: s.value.snapshot.id }, 'Data coverage: HR-restricted', [`${hr} HR-restricted item(s) in this state`], { status: 'HR_RESTRICTED', section: 'coverage', lens }));
      const withheld = proj.value.withheld.reduce((n, w) => n + w.count, 0);
      return done(out, ['Coverage counts what HELM holds and you may read; a dimension with no reading is one HELM knows nothing about.', ...withheldNote(withheld, 'item(s)')], withheld);
    },
  });

  tool({
    name: 'getManagementAttention',
    description: 'The conditions that require management attention in the current state, each with its named rule — never a ranking.',
    args: [A.str('snapshotId', 'A specific twin snapshot. Default: the latest current state you can see.', false)],
    async run(ctx, args) {
      const s = await latestVisibleSnapshot(ctx, src.twin, str(args['snapshotId']), null);
      if (!s.ok) return s;
      const lens = lensOf(s.value.snapshot.spec.lens);
      const proj = await src.twin.projectForViewer(ctx.scope, s.value.snapshot.id, ctx.viewer, ctx.units);
      if (!proj.ok) return proj;
      const att = (proj.value.items as unknown as ItemLike[]).filter((i) => i.kind === 'ATTENTION');
      const withheld = proj.value.withheld.reduce((n, w) => n + w.count, 0);
      return done(att.slice(0, MAX.items).map((i) => evidenceOfItem(i, lens, 'What matters?')), att.length === 0 ? ['No attention condition holds in this state.'] : withheldNote(withheld, 'item(s)'), withheld);
    },
  });

  tool({
    name: 'compareTwinSnapshots',
    description: 'What changed between two twin snapshots, item by item, within your clearance.',
    args: [A.str('fromId', 'The earlier snapshot.'), A.str('toId', 'The later snapshot.')],
    async run(ctx, args) {
      const fromId = str(args['fromId']);
      const toId = str(args['toId']);
      if (!fromId || !toId) return fail(IntelligenceErrors.BAD_ARGS, 'compareTwinSnapshots needs fromId and toId.');
      for (const id of [fromId, toId]) {
        const s = await latestVisibleSnapshot(ctx, src.twin, id, null);
        if (!s.ok) return s;
      }
      const d = await src.twin.compareSnapshots(ctx.scope, fromId, toId);
      if (!d.ok) return d;
      const lens = lensOf(d.value.to.spec.lens);
      const all = [...d.value.valueChanges, ...d.value.knowledgeChanges, ...d.value.decisionChanges, ...d.value.assumptionChanges, ...d.value.governanceChanges, ...d.value.constraintChanges, ...d.value.attentionChanges, ...d.value.structuralChanges];
      const visible = all.filter((c) => isCleared(ctx.viewer, (c.after ?? c.before)!.sensitivity, ctx.now));
      const out = visible.slice(0, MAX.changes).map((c) => {
        const item = (c.after ?? c.before) as unknown as ItemLike;
        const base = evidenceOfItem(item, lens, 'What changed?');
        return { ...base, label: c.label, values: [c.statement, c.delta !== null ? `change ${c.delta}${c.deltaUnit ? ` ${c.deltaUnit}` : ''}` : '', `${c.change} in ${c.category}`].filter((x) => x.length > 0), ref: { kind: 'TWIN_ITEM', id: c.itemKey } };
      });
      return done(out, [d.value.statement, ...(visible.length > MAX.changes ? [`Showing ${MAX.changes} of ${visible.length} changes, in kernel order — not the most important.`] : []), ...withheldNote(all.length - visible.length, 'change(s)')], all.length - visible.length);
    },
  });

  tool({
    name: 'explainValue',
    description: 'Where one value in a snapshot came from: its calculation, its inputs and the source system, step by step.',
    args: [A.str('snapshotId', 'The snapshot.'), A.str('itemKey', 'The twin item key of the value.')],
    async run(ctx, args) {
      const snapshotId = str(args['snapshotId']);
      const itemKey = str(args['itemKey']);
      if (!snapshotId || !itemKey) return fail(IntelligenceErrors.BAD_ARGS, 'explainValue needs snapshotId and itemKey.');
      const s = await latestVisibleSnapshot(ctx, src.twin, snapshotId, null);
      if (!s.ok) return s;
      const item = s.value.items.find((i) => i.key === itemKey);
      if (!item) return fail(IntelligenceErrors.BAD_ARGS, `No item ${itemKey} in that snapshot.`);
      if (!isCleared(ctx.viewer, item.sensitivity, ctx.now)) return done([], [`That value is ${item.sensitivity}; it is above your clearance.`], 1);
      const ex = await src.twin.explainItem(ctx.scope, snapshotId, itemKey);
      if (!ex.ok) return ex;
      const lens = lensOf(s.value.snapshot.spec.lens);
      const head = evidenceOfItem(item as unknown as ItemLike, lens, null);
      const steps = ex.value.chain.map((st) =>
        ev(/OBSERVATION|SOURCE/i.test(st.ref?.kind ?? '') && /memoire|erp|finance|scm|source/i.test(st.detail) ? 'SOURCE_FACT' : 'MODEL_RESULT', { kind: st.ref?.kind ?? 'TWIN_ITEM', id: st.ref?.id ?? itemKey }, st.label, [st.detail], { lens }),
      );
      return done([head, ...steps], [ex.value.statement]);
    },
  });

  tool({
    name: 'getValueDependencies',
    description: 'What a value depends on and what depends on it in HELM\'s calculation model. A value dependency is not a causal claim.',
    args: [A.str('snapshotId', 'The snapshot.'), A.str('itemKey', 'The twin item key of the value.')],
    async run(ctx, args) {
      const snapshotId = str(args['snapshotId']);
      const itemKey = str(args['itemKey']);
      if (!snapshotId || !itemKey) return fail(IntelligenceErrors.BAD_ARGS, 'getValueDependencies needs snapshotId and itemKey.');
      const s = await latestVisibleSnapshot(ctx, src.twin, snapshotId, null);
      if (!s.ok) return s;
      const d = await src.twin.getDependencies(ctx.scope, snapshotId, itemKey);
      if (!d.ok) return d;
      const lens = lensOf(s.value.snapshot.spec.lens);
      const line = (dir: string, x: { label: string; via: string; itemKey: string | null }) => ev('MODEL_RESULT', { kind: 'TWIN_ITEM', id: x.itemKey ?? itemKey }, x.label, [`${dir} via ${x.via}`, 'a calculation dependency in the model, not a causal claim'], { status: 'CALCULATION_DEPENDENCY', lens });
      return done([...d.value.upstream.slice(0, MAX.items).map((x) => line('upstream', x)), ...d.value.downstream.slice(0, MAX.items).map((x) => line('downstream', x))], ['These are calculation dependencies in the model. Correlation and calculation are not causality.']);
    },
  });

  tool({
    name: 'getScenarioComparison',
    description: 'The trade-offs between the alternatives of a decision, from its scenario futures: what each gains and concedes, never a ranking.',
    args: [A.str('decisionId', 'A decision you may see.')],
    async run(ctx, args) {
      const decisionId = str(args['decisionId']);
      if (!decisionId) return fail(IntelligenceErrors.BAD_ARGS, 'getScenarioComparison needs decisionId.');
      if (!canSeeDecision(ctx, decisionId)) return done([], ['That decision is not visible to you.'], 1);
      const w = await src.decisions.getWorkspace(ctx.scope, decisionId);
      if (!w.ok) return w;
      const space = w.value.tradeOffs;
      if (!space) return done([], ['This decision has no scenario comparison yet.']);
      let hidden = 0;
      const out: RawEvidence[] = [];
      for (const col of space.columns) {
        const lines = [...col.gains, ...col.concessions, ...col.unresolved].filter((l) => {
          const okc = cleared(ctx, l.metricKey);
          if (!okc) hidden += 1;
          return okc;
        });
        out.push(ev('SCENARIO', { kind: 'DECISION_ALTERNATIVE', id: col.alternativeId }, col.alternativeLabel, lines.slice(0, MAX.rows).map((l) => `${l.kind} ${l.label}: ${l.referenceValue ?? '—'} → ${l.alternativeValue ?? '—'}${l.delta !== null ? ` (${l.delta})` : ''}`), { status: col.status, section: null }));
      }
      return done(out, [space.statement, 'Nothing is ranked, weighted or totalled.', ...withheldNote(hidden, 'line(s)')], hidden);
    },
  });

  tool({
    name: 'getDecision',
    description: 'A decision: its management question, state, alternatives and stated assumptions — if you may see it.',
    args: [A.str('decisionId', 'The decision.')],
    async run(ctx, args) {
      const decisionId = str(args['decisionId']);
      if (!decisionId) return fail(IntelligenceErrors.BAD_ARGS, 'getDecision needs decisionId.');
      if (!canSeeDecision(ctx, decisionId)) return done([], ['That decision is not visible to you.'], 1);
      const w = await src.decisions.getWorkspace(ctx.scope, decisionId);
      if (!w.ok) return w;
      const d = w.value.decision;
      const out: RawEvidence[] = [
        ev('MANAGEMENT_RECORD', { kind: 'DECISION', id: d.id }, d.title, [d.managementQuestion, `state ${d.state}`, ...w.value.alternatives.map((a) => `alternative ${a.label} (${a.status})`)], { status: d.state, section: 'What decisions are required?' }),
        ...w.value.assumptions.map((a) => ev('MANAGEMENT_ASSUMPTION', { kind: 'ASSUMPTION', id: a.id }, a.statement, [`criticality ${a.criticality}`, `outcome ${a.outcome}`], { status: a.outcome, section: 'What assumptions are challenged?' })),
      ];
      return done(out.slice(0, MAX.items), []);
    },
  });

  tool({
    name: 'explainDecision',
    description: 'Why management chose what it chose: the rationale, accepted trade-offs and assumptions — for a committed decision you may see.',
    args: [A.str('decisionId', 'A committed decision.')],
    async run(ctx, args) {
      const decisionId = str(args['decisionId']);
      if (!decisionId) return fail(IntelligenceErrors.BAD_ARGS, 'explainDecision needs decisionId.');
      if (!canSeeDecision(ctx, decisionId)) return done([], ['That decision is not visible to you.'], 1);
      const x = await src.decisions.explainDecision(ctx.scope, decisionId);
      if (!x.ok) return x;
      const e = x.value;
      const out: RawEvidence[] = [
        ev('MANAGEMENT_RECORD', { kind: 'COMMITMENT', id: e.commitment.id, pin: e.commitment.fingerprint }, `Management chose ${e.chosen.label}`, [e.commitment.summary, ...e.rejected.map((r) => `not chosen: ${r.label}`)], { status: 'COMMITTED' }),
        ...e.rationale.map((r) => ev('MANAGEMENT_RECORD', { kind: 'DECISION', id: decisionId }, r.label, [r.statement], { status: r.kind })),
        ...e.acceptedTradeOffs.map((t) => ev('MANAGEMENT_RECORD', { kind: 'DECISION', id: decisionId }, `Accepted trade-off: ${(t as { label?: string }).label ?? 'trade-off'}`, [String((t as { statement?: string }).statement ?? '')], { status: 'ACCEPTED_TRADE_OFF' })),
        ...e.assumptions.map((a) => ev('MANAGEMENT_ASSUMPTION', { kind: 'ASSUMPTION', id: a.id }, a.statement, [`criticality ${a.criticality}`, `outcome ${a.outcome}`], { status: a.outcome })),
      ];
      return done(out.slice(0, MAX.items), [e.statement]);
    },
  });

  tool({
    name: 'getGovernanceState',
    description: 'Where a decision\'s commitment stands in governance: authorized, pending, escalated — a fact about authority, never permission to act.',
    args: [A.str('decisionId', 'A decision with a commitment.')],
    async run(ctx, args) {
      const decisionId = str(args['decisionId']);
      if (!decisionId) return fail(IntelligenceErrors.BAD_ARGS, 'getGovernanceState needs decisionId.');
      if (!canSeeDecision(ctx, decisionId)) return done([], ['That decision is not visible to you.'], 1);
      const w = await src.decisions.getWorkspace(ctx.scope, decisionId);
      if (!w.ok) return w;
      if (!w.value.commitment) return done([], ['This decision has no commitment yet, so there is nothing to govern.']);
      const g = await src.authority.getGovernanceState(ctx.scope, w.value.commitment.id);
      if (!g.ok) return g;
      const pending = g.value.requirements.filter((r) => !r.satisfied).map((r) => r.requirement.roleLabel);
      return done([ev('MANAGEMENT_RECORD', { kind: 'COMMITMENT', id: g.value.commitmentId, pin: g.value.commitmentFingerprint }, `Governance of ${w.value.decision.title}`, [g.value.statement, `approval progress ${g.value.approvalProgress}`, pending.length > 0 ? `awaiting ${pending.join(', ')}` : 'no approval outstanding'], { status: g.value.state })], []);
    },
  });

  tool({
    name: 'getCausalClaims',
    description: 'Causal beliefs people have recorded, each with its OWN evidence status. A hypothesis stays a hypothesis.',
    args: [A.str('causeKey', 'Filter by cause variable key.', false), A.str('effectKey', 'Filter by effect variable key.', false)],
    async run(ctx, args) {
      const p = await src.causal.projectForViewer(ctx.scope, ctx.viewer, ctx.units, ctx.facts);
      if (!p.ok) return p;
      const ck = str(args['causeKey']);
      const ek = str(args['effectKey']);
      const claims = p.value.claims.filter((v) => (!ck || v.claim.causeKey === ck) && (!ek || v.claim.effectKey === ek));
      return done(
        claims.slice(0, MAX.claims).map((v) => ev('CAUSAL_CLAIM', { kind: 'CAUSAL_CLAIM', id: v.claim.id, pin: String(v.revision.revision) }, v.revision.statement, [`${v.cause.label} → ${v.effect.label}`, `type ${v.claim.relationshipType}`, `confidence ${v.evaluation.confidence}`, `evidence: ${v.evaluation.counts.supporting} supporting, ${v.evaluation.counts.challenging + v.evaluation.counts.contradicting} against`], { status: v.evaluation.status, section: 'What is uncertain?', lens: lensOf(v.evaluation.lens) })),
        withheldNote(p.value.withheld, 'claim(s)'),
        p.value.withheld,
      );
    },
  });

  tool({
    name: 'getGenomePatterns',
    description: 'Recurring management patterns people proposed and HELM checked, with their status and caveat — recurrence is described, never certified.',
    args: [],
    async run(ctx) {
      const g = await src.genome.projectForViewer(ctx.scope, ctx.viewer, ctx.units, ctx.facts);
      if (!g.ok) return g;
      return done(
        g.value.patterns.slice(0, MAX.patterns).map((p) => ev('MANAGEMENT_RECORD', { kind: 'MANAGEMENT_PATTERN', id: p.pattern.id }, p.pattern.title, [p.revision.statement, `${p.supporting.length} supporting, ${p.contradictory.length} contradicting episode(s)`, p.caveat], { status: p.status, lens: lensOf(p.lens) })),
        withheldNote(g.value.withheld.patterns, 'pattern(s)'),
        g.value.withheld.patterns,
      );
    },
  });

  tool({
    name: 'getSimilarEpisodes',
    description: 'Earlier management situations that agree with a given episode on the features you name — chronological, not ranked.',
    args: [A.str('episodeId', 'The episode to compare from.'), A.strs('require', 'Feature names that must agree (e.g. decisionType, businessUnit).', false)],
    async run(ctx, args) {
      const episodeId = str(args['episodeId']);
      if (!episodeId) return fail(IntelligenceErrors.BAD_ARGS, 'getSimilarEpisodes needs episodeId.');
      const proj = await src.genome.projectForViewer(ctx.scope, ctx.viewer, ctx.units, ctx.facts);
      if (!proj.ok) return proj;
      const readable = new Set(proj.value.episodes.map((e) => e.episode.id));
      if (!readable.has(episodeId)) return done([], ['That episode is not readable by you.'], 1);
      const require = (Array.isArray(args['require']) ? (args['require'] as unknown[]).map(String) : ['decisionType']) as never;
      const sim = await src.genome.findSimilar(ctx.scope, { episodeId, require });
      if (!sim.ok) return sim;
      const visible = sim.value.episodes.filter((e) => readable.has(e.view.episode.id));
      const hidden = sim.value.episodes.length - visible.length;
      return done(
        visible.slice(0, MAX.episodes).map((e) => ev('MANAGEMENT_RECORD', { kind: 'MANAGEMENT_EPISODE', id: e.view.episode.id }, e.view.episode.title, [`agrees on ${e.agreements.filter((x) => x.agrees).map((x) => x.feature).join(', ') || 'nothing required'}`, `episode ${e.view.status}`], { status: e.view.status })),
        [sim.value.statement, ...(sim.value.unstatedInTarget.length > 0 ? [`The target situation does not state ${sim.value.unstatedInTarget.join(', ')}: an empty result says nothing about novelty.`] : []), ...withheldNote(hidden, 'episode(s)')],
        hidden,
      );
    },
  });

  tool({
    name: 'runCounterfactual',
    description: 'The counterfactual comparison HELM already holds for a case: expected, actual and the alternative at each lens, with its causal support. It reads; computing a new world is a person\'s act.',
    args: [A.str('caseId', 'A counterfactual case you may see.')],
    async run(ctx, args) {
      const caseId = str(args['caseId']);
      if (!caseId) return fail(IntelligenceErrors.BAD_ARGS, 'runCounterfactual needs caseId.');
      const p = await src.counterfactual.projectForViewer(ctx.scope, ctx.viewer, ctx.units, ctx.facts);
      if (!p.ok) return p;
      if (!p.value.cases.some((c) => c.case.id === caseId)) return done([], ['That counterfactual case is not visible to you.'], 1);
      const cmp = await src.counterfactual.compare(ctx.scope, caseId);
      if (!cmp.ok) return cmp;
      const c = cmp.value;
      const lens = lensOf(c.case.boundary);
      const cell = (x: { status: string; value: string | null }) => (x.status === 'READ' && x.value !== null ? x.value : 'not read');
      const out = c.rows.slice(0, MAX.rows).map((r) => ev('COUNTERFACTUAL_RESULT', { kind: 'COUNTERFACTUAL_CASE', id: caseId, pin: c.fingerprint }, `${r.metric.label}: a model estimate under ${c.intervention.label}`, [`expected at commitment ${cell(r.expected)}`, `actual ${cell(r.actual)}`, `alternative as known then (estimated) ${cell(r.alternativeThen)}`, `alternative with hindsight (estimated) ${cell(r.alternativeWithHindsight)}`, r.alternativeThenMinusExpected !== null ? `alternative-then minus expected ${r.alternativeThenMinusExpected}` : '', r.alternativeWithHindsightMinusActual !== null ? `alternative-with-hindsight minus actual ${r.alternativeWithHindsightMinusActual}` : ''], { status: c.worlds.withHindsight?.causal.level ?? c.worlds.asKnownThen?.causal.level ?? 'MODEL_ONLY', lens }));
      return done(out, [c.important, 'This is a model estimate under stated assumptions — not what would have happened, and not a verdict on the decision.']);
    },
  });

  tool({
    name: 'getReviewPack',
    description: 'What a management review is prepared with — what changed, attention, decisions needed, commitments off-track, assumptions challenged, outcomes arrived, learning — as you may read it.',
    args: [A.str('reviewId', 'A review you may read.')],
    async run(ctx, args) {
      const reviewId = str(args['reviewId']);
      if (!reviewId) return fail(IntelligenceErrors.BAD_ARGS, 'getReviewPack needs reviewId.');
      const r = await src.review.preparedFor(ctx.scope, reviewId, ctx.viewer, ctx.units, ctx.facts);
      if (!r.ok) return r.error.code === 'review.not_found' ? done([], ['That review is not visible to you.'], 1) : r;
      const p = r.value.pack;
      const lens = lensOf(p.lens);
      const sum = (section: string, n: number, what: string, extra: string[] = []) => ev('MODEL_RESULT', { kind: 'REVIEW_PACK', id: reviewId }, `${section} — summary`, [`${n} ${what}`, ...extra], { status: 'SUMMARY', section, lens });
      const out: RawEvidence[] = [
        sum('What changed?', p.changed.changes.length, 'change(s) since the previous review', Object.entries(p.changed.counts).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`)),
        sum('What matters?', p.attention.items.length, 'attention condition(s)'),
        sum('What is off-track?', p.commitmentsOffTrack.items.length, 'commitment(s) beyond materiality of the committed future'),
        sum('What decisions are required?', p.decisionsNeeded.items.length, 'decision(s) opened and not yet committed'),
        sum('What assumptions are challenged?', p.assumptionsChanged.items.length, 'assumption result(s) recorded in the window'),
        sum('What outcomes arrived?', p.outcomesArrived.items.length, 'outcome review(s) recorded in the window'),
        ...p.changed.changes.slice(0, MAX.changes).map((c) => ev('MODEL_RESULT', { kind: 'TWIN_ITEM', id: c.itemKey }, c.label, [c.statement, `${c.change} in ${c.category}`], { status: c.category, section: 'What changed?', lens })),
        ...p.attention.items.slice(0, MAX.items).map((a) => ev('MODEL_RESULT', { kind: 'TWIN_ITEM', id: a.itemKey }, a.label, [a.statement], { status: a.condition, section: 'What matters?', lens })),
        ...p.commitmentsOffTrack.items.flatMap((o) => o.lines.map((l) => ev('MODEL_RESULT', { kind: 'COMMITMENT', id: o.commitmentId }, `${o.title}: ${l.label}`, [`committed ${l.committed ?? '—'}`, `current ${l.current ?? '—'}`, `difference ${l.difference ?? '—'}${l.unit ? ` ${l.unit}` : ''}`], { status: o.relation, section: 'What is off-track?', lens }))),
        ...p.decisionsNeeded.items.map((d) => ev('MANAGEMENT_RECORD', { kind: 'DECISION', id: d.decisionId }, d.title, [d.question, `opened ${d.openedAt}`], { status: 'AWAITING_COMMITMENT', section: 'What decisions are required?', lens })),
        ...p.assumptionsChanged.items.map((a) => ev('MANAGEMENT_ASSUMPTION', { kind: 'ASSUMPTION', id: a.assumptionId }, a.statement, [`outcome ${a.outcome}`, `reviewed ${a.reviewedAt}`], { status: a.outcome, section: 'What assumptions are challenged?', lens })),
        ...p.outcomesArrived.items.flatMap((o) => o.variances.map((v) => ev('MODEL_RESULT', { kind: 'OUTCOME_REVIEW', id: o.outcomeReviewId }, `${v.label}: expected against actual`, [`expected ${v.expected ?? '—'}`, `actual ${v.actual ?? '—'}`, `variance ${v.variance ?? '—'}`], { status: 'OUTCOME', section: 'What outcomes arrived?', lens }))),
        ...p.causalChanges.items.filter((c) => c.status !== 'SUPPORTED').map((c) => ev('CAUSAL_CLAIM', { kind: 'CAUSAL_CLAIM', id: c.claimId, pin: String(c.revision) }, c.statement, [`revision ${c.revision}`], { status: c.status, section: 'What is uncertain?', lens })),
      ];
      return done(out, [p.statement, ...p.unavailable.map((u) => `Not available to this pack: ${u}.`), r.value.statement], r.value.withheld);
    },
  });

  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    catalogue: () => tools.map((t) => ({ name: t.name, description: t.description, args: t.args })),
    get: (name) => byName.get(name),
    all: () => tools,
  };
}

/** Arguments are validated against the tool's own spec: unknown names and wrong types are refused. */
export function validateArgs(t: ToolCatalogueEntry, args: Readonly<Record<string, unknown>>): string | null {
  const known = new Set(t.args.map((a) => a.name));
  for (const k of Object.keys(args)) if (!known.has(k)) return `${t.name} has no argument "${k}".`;
  for (const a of t.args) {
    const v = args[a.name];
    if (v === undefined || v === null) {
      if (a.required) return `${t.name} needs ${a.name}.`;
      continue;
    }
    if (a.type === 'string' && typeof v !== 'string') return `${a.name} must be text.`;
    if (a.type === 'number' && typeof v !== 'number') return `${a.name} must be a number.`;
    if (a.type === 'string[]' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return `${a.name} must be a list of text.`;
  }
  return null;
}

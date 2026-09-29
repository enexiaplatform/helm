/**
 * "Why is this here?" and "why did it change?" — answered through the kernel.
 *
 *   explainItem        snapshot → item → kernel object → calculation / scenario /
 *                      decision / governance → source fact
 *   explainDifference  the same for both sides, separately, and then the
 *                      DEPENDENCY ATTRIBUTION between them: which inputs of the
 *                      calculation moved, recursively, down to the facts,
 *                      overrides and assumptions that differ.
 *
 * Attribution walks the calculation traces the propagation engine recorded; it
 * never recomputes and never infers. It says "the model's value moved because
 * these model inputs moved" and not one word about what caused what in the
 * world — that is the Phase 8 causal graph's question (ADR-0023 §9).
 */

import { ok, parsePeriodKey, type Result, type Scope } from '@helm/shared';
import { canonicalNumeric, type CalculationStep, type Explanation, type TracedInput } from '@helm/propagation-engine';
import { difference, unitSuffix } from './attention.ts';
import type { TwinSources } from './compose.ts';
import {
  ATTRIBUTION_DISCLAIMER,
  type AttributionNode,
  type ComposedSnapshot,
  type DifferenceExplanation,
  type KernelRef,
  type LineageStep,
  type TwinItem,
  type TwinItemExplanation,
} from './types.ts';

const ref = (kind: KernelRef['kind'], id: string, pin: string | null = null, label: string | null = null): KernelRef => ({ kind, id, pin, label });
const readable = (v: string | null | undefined): string => (v === null || v === undefined ? '—' : canonicalNumeric(v));

function flatten(e: Explanation, depth: number, out: LineageStep[], limit = 40): void {
  if (out.length >= limit) return;
  const what = e.derivation
    ? `${e.derivation.calculationKey}@${e.derivation.calculationVersion}: ${e.derivation.renderedExpression ?? e.derivation.expression}`
    : e.override
      ? `scenario override ${e.override.operation} ${e.override.value} (${e.override.provenanceKind})`
      : `${e.observationType} from ${e.source?.system ?? 'unknown source'}${e.source?.sourceObjectType ? ` · ${e.source.sourceObjectType} ${e.source.sourceObjectId ?? ''}` : ''}`;
  out.push({
    depth,
    label: `${e.nodeLabel} = ${readable(e.value)} ${e.unit === 'currency' ? (e.currency ?? '') : e.unit}`.trimEnd(),
    ref: e.derivation ? ref('CALCULATION_RUN', e.derivation.runId, null, e.derivation.calculationKey) : ref('OBSERVATION', e.observationId, null, e.observationType),
    detail: what,
  });
  for (const input of e.inputs) flatten(input, depth + 1, out, limit);
}

export function createExplainer(sources: TwinSources) {
  async function lineageOf(scope: Scope, composed: ComposedSnapshot, item: TwinItem, depth: number, visited: Set<string>): Promise<LineageStep[]> {
    if (visited.has(item.key)) return [];
    visited.add(item.key);
    const out: LineageStep[] = [{ depth, label: item.label, ref: ref('TWIN_ITEM', item.key, null, item.kind), detail: `${item.kind}${item.layer ? ` · ${item.layer}` : ''} · ${item.status}` }];
    const s = item.state;
    const d = depth + 1;

    if (item.kind === 'VALUE') {
      const observationId = s.observationId as string | null;
      if ((item.layer === 'SCENARIO' || item.layer === 'COMMITTED_FUTURE') && typeof s.scenarioRunId !== 'string') {
        const runRef = item.refs.find((r) => r.kind === 'SCENARIO_RUN');
        const period = typeof s.period === 'string' ? parsePeriodKey(s.period) : null;
        if (runRef) {
          const ex = await sources.scenarios.explain(scope, runRef.id, String(s.nodeId), period && period.ok ? period.value : undefined);
          out.push({ depth: d, label: `Scenario run ${runRef.label ?? runRef.id}`, ref: runRef, detail: `fork ${ex.ok ? ex.value.fork.effectiveAsOf : '—'}; fingerprint ${runRef.pin ?? '—'}` });
          if (ex.ok && ex.value.lineage) flatten(ex.value.lineage, d + 1, out);
        }
      } else if (item.layer === 'COMMITTED_FUTURE') {
        // A committed-future value in a CURRENT snapshot: frozen in the commitment, computed by its run.
        const commitmentRef = item.refs.find((r) => r.kind === 'COMMITMENT');
        if (commitmentRef) out.push({ depth: d, label: 'Frozen in the commitment', ref: commitmentRef, detail: `fingerprint ${commitmentRef.pin}` });
        const runId = s.scenarioRunId as string | null;
        const period = typeof s.period === 'string' ? parsePeriodKey(s.period) : null;
        if (runId) {
          const ex = await sources.scenarios.explain(scope, runId, String(s.nodeId), period && period.ok ? period.value : undefined);
          out.push({ depth: d + 1, label: 'Computed by the chosen future', ref: ref('SCENARIO_RUN', runId), detail: ex.ok ? `${ex.value.state.label} · ${ex.value.value.origin}` : 'the run could not be read' });
          if (ex.ok && ex.value.lineage) flatten(ex.value.lineage, d + 2, out);
        }
      } else if (observationId && item.layer === 'MODELLED') {
        const ex = await sources.engine.explain(scope, observationId, 12);
        if (ex.ok) flatten(ex.value, d, out);
      } else if (observationId) {
        const provenance = await sources.valueGraph.getObservationProvenance(scope, observationId);
        out.push({
          depth: d,
          label: `${String(s.observationType)} observation, recorded ${String(s.recordedAt)}`,
          ref: ref('OBSERVATION', observationId, String(s.recordedAt), String(s.observationType)),
          detail: `source ${String(s.sourceSystem)}`,
        });
        for (const p of provenance.ok ? provenance.value : []) {
          out.push({ depth: d + 1, label: `Provenance: ${p.system}${p.connector ? ` via ${p.connector}` : ''}`, ref: null, detail: `${p.method}${p.sourceObjectType ? ` · ${p.sourceObjectType} ${p.sourceObjectId ?? ''}` : ''}` });
        }
      }
    } else if (item.kind === 'OBJECTIVE' || item.kind === 'ATTENTION') {
      const causeKeys = item.kind === 'ATTENTION' ? ((s.causeItemKeys as string[]) ?? []) : item.refs.filter((r) => r.kind === 'TWIN_ITEM').map((r) => r.id);
      if (item.kind === 'ATTENTION') out.push({ depth: d, label: `Rule ${String(s.rule)}`, ref: null, detail: 'a stated condition — not a score, not a priority' });
      for (const key of causeKeys) {
        const cause = composed.items.find((i) => i.key === key);
        if (cause) out.push(...(await lineageOf(scope, composed, cause, d, visited)));
      }
    } else if (item.kind === 'GOVERNANCE') {
      const evaluation = item.refs.find((r) => r.kind === 'EVALUATION');
      if (evaluation) {
        const ex = await sources.authority.explain(scope, evaluation.id);
        out.push({ depth: d, label: `Authority evaluation: ${evaluation.label}`, ref: evaluation, detail: ex.ok ? ex.value.why.slice(0, 3).join(' ') : 'the evaluation could not be read' });
      }
      const act = [...item.refs].reverse().find((r) => r.kind === 'APPROVAL_ACT');
      if (act) {
        const lineage = await sources.authority.explainApproval(scope, act.id);
        if (lineage.ok) {
          out.push({ depth: d, label: `Approval act by ${lineage.value.act.approverLabel} (${lineage.value.act.approverRoleLabel})`, ref: act, detail: lineage.value.statement });
          out.push({ depth: d + 1, label: `Rule ${lineage.value.basisRule.key} of ${lineage.value.basisPolicy.reference} v${lineage.value.basisPolicy.version}`, ref: ref('POLICY', lineage.value.basisPolicy.id, `v${lineage.value.basisPolicy.version}`), detail: lineage.value.basisRule.rationale });
          for (const l of lineage.value.valueLineage as { lineage?: Explanation | null }[]) if (l.lineage) flatten(l.lineage, d + 2, out, 30);
        }
      }
      for (const p of item.refs.filter((r) => r.kind === 'POLICY')) out.push({ depth: d, label: `Policy ${p.label} ${p.pin}`, ref: p, detail: 'the authority policy version in force at the act' });
    } else {
      for (const r of item.refs) out.push({ depth: d, label: `${r.kind.replaceAll('_', ' ').toLowerCase()}${r.label ? `: ${r.label}` : ''}`, ref: r, detail: r.pin ? `pinned at ${r.pin}` : 'kernel record' });
      if (item.kind === 'ENTITY') {
        const p = await sources.graph.getProvenance(scope, 'entity', item.subjectEntityId ?? '');
        for (const x of p.ok ? p.value : []) out.push({ depth: d + 1, label: `Provenance: ${x.system}`, ref: null, detail: `${x.method}${x.sourceObjectType ? ` · ${x.sourceObjectType} ${x.sourceObjectId ?? ''}` : ''}` });
      }
    }
    return out;
  }

  async function explainItem(scope: Scope, composed: ComposedSnapshot, itemKey: string): Promise<Result<TwinItemExplanation | null>> {
    const item = composed.items.find((i) => i.key === itemKey);
    if (!item) return ok(null);
    const { spec, fingerprint } = composed.snapshot;
    const chain: LineageStep[] = [
      { depth: 0, label: `${spec.kind} snapshot "${spec.label}"`, ref: null, detail: `effective ${spec.lens.effectiveAsOf} · known through ${spec.lens.recordedThrough} · ${fingerprint}` },
      ...(await lineageOf(scope, composed, item, 1, new Set())),
    ];
    const sourceFacts = chain.filter((c) => c.ref?.kind === 'OBSERVATION' || c.label.startsWith('Provenance')).length;
    return ok({
      snapshot: composed.snapshot,
      item,
      chain,
      statement:
        `${item.label} is in this snapshot because ${item.refs.length} kernel record${item.refs.length === 1 ? '' : 's'} put it there; ` +
        `the chain reaches ${sourceFacts} source fact${sourceFacts === 1 ? '' : 's'}.`,
    });
  }

  // --------------------------------------------------------- attribution

  type StepContext = { steps: readonly CalculationStep[]; byObservation: ReadonlyMap<string, CalculationStep> };

  async function stepContext(scope: Scope, runId: string): Promise<StepContext> {
    const t = await sources.engine.getTrace(scope, runId);
    const steps = t.ok ? t.value : [];
    return { steps, byObservation: new Map(steps.filter((s) => s.outputObservationId).map((s) => [s.outputObservationId!, s])) };
  }

  const sourceOf = (t: TracedInput): string =>
    t.override
      ? `scenario override ${t.override.operation} ${t.override.value}${t.override.baseline ? ` on ${readable(t.override.baseline.value)}` : ''} (${t.override.provenanceKind})`
      : t.boundTo === 'RUN_OUTPUT'
        ? `computed in the run`
        : t.boundTo === 'MIXED'
          ? `a sum of ${t.components?.length ?? 0} claims`
          : `${t.observationType} observation (${t.sourceSystem})`;

  const refOf = (t: TracedInput, ctx: StepContext): KernelRef | null =>
    t.override
      ? ref('SCENARIO_REVISION', t.override.revisionId, null, `override ${t.override.overrideId}`)
      : t.boundTo === 'RUN_OUTPUT'
        ? (() => {
            const s = ctx.byObservation.get(t.observationId);
            return s ? ref('CALCULATION_STEP', s.id, null, `${s.calculationKey}@${s.calculationVersion}`) : null;
          })()
        : ref('OBSERVATION', t.observationId, null, t.observationType);

  function attribute(a: CalculationStep, ca: StepContext, b: CalculationStep, cb: StepContext, depth: number): AttributionNode[] {
    if (depth > 8) return [];
    const names = [...new Set([...a.inputs.map((i) => i.name), ...b.inputs.map((i) => i.name)])].sort();
    const out: AttributionNode[] = [];
    for (const name of names) {
      const ta = a.inputs.find((i) => i.name === name) ?? null;
      const tb = b.inputs.find((i) => i.name === name) ?? null;
      if (ta && tb && canonicalNumeric(ta.value) === canonicalNumeric(tb.value)) continue;
      let because: AttributionNode[] = [];
      if (ta?.boundTo === 'RUN_OUTPUT' && tb?.boundTo === 'RUN_OUTPUT') {
        const sa = ca.byObservation.get(ta.observationId);
        const sb = cb.byObservation.get(tb.observationId);
        if (sa && sb) because = attribute(sa, ca, sb, cb, depth + 1);
      }
      out.push({
        input: name,
        metricKey: (tb ?? ta)!.metricKey,
        nodeId: (tb ?? ta)!.nodeId,
        before: ta ? canonicalNumeric(ta.value) : null,
        after: tb ? canonicalNumeric(tb.value) : null,
        beforeSource: ta ? sourceOf(ta) : 'absent',
        afterSource: tb ? sourceOf(tb) : 'absent',
        beforeRef: ta ? refOf(ta, ca) : null,
        afterRef: tb ? refOf(tb, cb) : null,
        changedBecause: because,
      });
    }
    return out;
  }

  const stepIdentity = (i: TwinItem | null): { runId: string; stepId: string } | null =>
    i && typeof i.state.calculationRunId === 'string' && typeof i.state.calculationStepId === 'string'
      ? { runId: i.state.calculationRunId, stepId: i.state.calculationStepId }
      : null;

  /** The model's reading of the same node and period, when the item itself has no calculation. */
  function modelCounterpart(composed: ComposedSnapshot, item: TwinItem | null): TwinItem | null {
    if (!item || stepIdentity(item)) return item;
    return (
      composed.items.find(
        (i) => i.kind === 'VALUE' && (i.layer === 'MODELLED' || i.layer === 'SCENARIO' || i.layer === 'COMMITTED_FUTURE') && i.state.nodeId === item.state.nodeId && (i.state.period ?? null) === (item.state.period ?? null) && stepIdentity(i),
      ) ?? null
    );
  }

  function describeTree(nodes: readonly AttributionNode[], indent = ''): string[] {
    return nodes.flatMap((n) => [
      `${indent}${n.input} (${n.metricKey}): ${readable(n.before)} [${n.beforeSource}] → ${readable(n.after)} [${n.afterSource}]`,
      ...describeTree(n.changedBecause, `${indent}  `),
    ]);
  }

  async function explainDifference(
    scope: Scope,
    from: ComposedSnapshot,
    to: ComposedSnapshot,
    fromKey: string,
    toKey: string = fromKey,
  ): Promise<Result<DifferenceExplanation>> {
    const a = from.items.find((i) => i.key === fromKey) ?? null;
    const b = to.items.find((i) => i.key === toKey) ?? null;
    const [la, lb] = await Promise.all([
      a ? explainItem(scope, from, a.key) : Promise.resolve(ok(null)),
      b ? explainItem(scope, to, b.key) : Promise.resolve(ok(null)),
    ]);
    const va = a?.state.value;
    const vb = b?.state.value;
    const delta = typeof va === 'string' && typeof vb === 'string' ? difference(vb, va) : null;
    const deltaUnit = b ? unitSuffix(b.state.unit as string | null, b.state.currency as string | null) : null;

    // Attribution needs a calculation on both sides; a reported fact is paired with the model's reading.
    const ma = modelCounterpart(from, a);
    const mb = modelCounterpart(to, b);
    let attribution: AttributionNode[] = [];
    const notes: string[] = [];
    const ia = stepIdentity(ma);
    const ib = stepIdentity(mb);
    if (ia && ib) {
      const [ca, cb] = await Promise.all([stepContext(scope, ia.runId), stepContext(scope, ib.runId)]);
      const sa = ca.steps.find((s) => s.id === ia.stepId);
      const sb = cb.steps.find((s) => s.id === ib.stepId);
      if (sa && sb) attribution = attribute(sa, ca, sb, cb, 0);
      if (ma !== a) notes.push(`The earlier side is a reported ${a?.layer?.toLowerCase()} value; attribution uses the model's reading of the same position (${readable(ma?.state.value as string)}).`);
      if (mb !== b) notes.push(`The later side is a reported ${b?.layer?.toLowerCase()} value; attribution uses the model's reading of the same position (${readable(mb?.state.value as string)}).`);
    } else {
      notes.push('No calculation connects the two readings, so no dependency can be attributed; both lineages are shown separately.');
    }
    const label = (b ?? a)?.label ?? fromKey;
    const statement = [
      `${label}: ${readable(va as string)} (${a?.layer?.toLowerCase() ?? 'absent'}) → ${readable(vb as string)} (${b?.layer?.toLowerCase() ?? 'absent'})${delta ? `, ${delta.startsWith('-') ? '−' + delta.slice(1) : '+' + delta}${deltaUnit ?? ''}` : ''}.`,
      ...notes,
      ...(attribution.length > 0 ? ['Through the model:', ...describeTree(attribution, '  ')] : []),
    ].join('\n');
    return ok({
      itemKey: toKey,
      from: { snapshot: from.snapshot, item: a, lineage: la.ok && la.value ? la.value.chain : [] },
      to: { snapshot: to.snapshot, item: b, lineage: lb.ok && lb.value ? lb.value.chain : [] },
      delta,
      deltaUnit,
      attribution,
      statement,
      disclaimer: ATTRIBUTION_DISCLAIMER,
    });
  }

  return { explainItem, explainDifference };
}

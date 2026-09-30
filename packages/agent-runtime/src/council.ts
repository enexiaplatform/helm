/**
 * The council orchestrator.
 *
 * It MAY assemble the management question, gather evidence once through the
 * governed tools as the caller, invoke the perspectives that are supported by data
 * and have something to say, deduplicate the facts they share, and surface
 * agreement, disagreement and missing evidence as they are.
 *
 * It MUST NOT vote, rank, weigh, pick a winner, choose a decision, authorize,
 * approve, commit or execute: it has no method that does, and nothing in its result
 * is a score, a consensus or a recommendation. Human management stays accountable.
 */

import { fnv1a64, fail, ok, type Clock, type Result, type Scope } from '@helm/shared';
import {
  gatherEvidence,
  groundDraft,
  groundQuestions,
  outputClasses,
  promptHash,
  type AiProvider,
  type AiRunStore,
  type Caller,
  type EvidenceItem,
  type GroundedStatement,
  type ToolCall,
  type ToolContext,
  type ToolRegistry,
} from '@helm/intelligence-runtime';
import { PERSPECTIVES, coverageOf, relevantTo, type PerspectiveDef } from './perspectives.ts';
import {
  AgentErrors,
  COUNCIL_NOTICE,
  outputSections,
  type CouncilRequest,
  type CouncilResult,
  type NotInstantiated,
  type OutputSection,
  type PerspectiveId,
  type PerspectiveOutput,
  type Silent,
  type Tension,
  type TensionSide,
} from './types.ts';

export const COUNCIL_TEMPLATE_VERSION = '1';

export type CouncilOptions = { provider: AiProvider; tools: ToolRegistry; store: AiRunStore; clock: Clock };

export interface Council {
  /** Opens the council on a management question. Read-only; returns perspectives, tensions and what is missing — never a decision. */
  convene(scope: Scope, caller: Caller, request: CouncilRequest): Promise<Result<CouncilResult>>;
}

export function planFor(r: CouncilRequest): readonly ToolCall[] {
  const plan: ToolCall[] = [
    { tool: 'getDataCoverage', args: r.snapshotId ? { snapshotId: r.snapshotId } : {} },
    { tool: 'getManagementAttention', args: r.snapshotId ? { snapshotId: r.snapshotId } : {} },
    { tool: 'getEnterpriseState', args: r.snapshotId ? { snapshotId: r.snapshotId } : {} },
    { tool: 'getCausalClaims', args: {} },
  ];
  if (r.decisionId) plan.push({ tool: 'getDecision', args: { decisionId: r.decisionId } }, { tool: 'getScenarioComparison', args: { decisionId: r.decisionId } }, { tool: 'getGovernanceState', args: { decisionId: r.decisionId } });
  if (r.reviewId) plan.push({ tool: 'getReviewPack', args: { reviewId: r.reviewId } });
  if (!r.decisionId && !r.reviewId) plan.push({ tool: 'getGenomePatterns', args: {} });
  return plan;
}

/** Where perspectives pull apart, as a FACT about an alternative — never netted, never ranked. */
export function tensionsOf(evidence: readonly EvidenceItem[], instantiated: readonly PerspectiveDef[]): Tension[] {
  const out: Tension[] = [];
  for (const e of evidence.filter((x) => x.kind === 'SCENARIO')) {
    const gains: TensionSide[] = [];
    const concessions: TensionSide[] = [];
    for (const line of e.values) {
      const m = /^(GAIN|CONCESSION) (.*)$/.exec(line);
      if (!m) continue;
      for (const p of instantiated) {
        if (!p.words.test(m[2]!)) continue;
        const side: TensionSide = { perspective: p.id, name: p.name, line: line, evidenceId: e.id };
        (m[1] === 'GAIN' ? gains : concessions).push(side);
      }
    }
    const crossing = gains.some((g) => concessions.some((c) => c.perspective !== g.perspective));
    if (!crossing) continue;
    const names = (xs: readonly TensionSide[]) => [...new Set(xs.map((x) => x.name))].join(', ');
    out.push({
      alternative: e.label,
      gains,
      concessions,
      statement: `${e.label} gains on what ${names(gains)} attend${new Set(gains.map((g) => g.perspective)).size === 1 ? 's' : ''} to and concedes on what ${names(concessions)} attend${new Set(concessions.map((g) => g.perspective)).size === 1 ? 's' : ''} to. The two are shown side by side: nothing is netted, and HELM does not say which is right.`,
    });
  }
  return out;
}

export function createCouncil(opts: CouncilOptions): Council {
  const { provider, tools, store } = opts;

  return {
    async convene(scope, caller, request) {
      const question = request.question?.trim() ?? '';
      if (question.length < 8) return fail(AgentErrors.INVALID, 'Put the management question in a sentence.');
      const ctx: ToolContext = { scope, viewer: caller.viewer, units: caller.units, facts: caller.facts, now: opts.clock.now().toISOString() };

      // ---- the shared truth: gathered ONCE, as the caller
      const plan = planFor(request);
      const g = await gatherEvidence(tools, ctx, plan);
      const evidence = g.evidence;
      const cov = coverageOf(evidence);

      // ---- which perspectives HELM has data for, and which have anything to say
      const asked = request.perspectives && request.perspectives.length > 0 ? new Set(request.perspectives) : null;
      const notInstantiated: NotInstantiated[] = [];
      const silent: Silent[] = [];
      const instantiated: PerspectiveDef[] = [];
      for (const p of PERSPECTIVES) {
        if (asked && !asked.has(p.id)) continue;
        const s = p.supported(cov);
        if (!s.supported) {
          notInstantiated.push({ perspective: p.id, name: p.name, reason: s.reason });
          continue;
        }
        instantiated.push(p);
      }

      const outputs: PerspectiveOutput[] = [];
      const cited = new Map<string, Set<PerspectiveId>>();
      const providerUnknowns: string[] = [];
      for (const p of instantiated) {
        const subset = evidence.filter((e) => relevantTo(p, e));
        if (subset.length === 0) {
          silent.push({ perspective: p.id, name: p.name, reason: `Nothing the kernel returned for this question is relevant to ${p.name.toLowerCase()}.` });
          continue;
        }
        const input = JSON.parse(JSON.stringify({ task: 'COUNCIL', templateId: `council-${p.id.toLowerCase()}`, templateVersion: COUNCIL_TEMPLATE_VERSION, instructions: `Take the ${p.name} perspective on the management question. ${p.focus} Return observations, concerns, challenged assumptions and trade-offs, each grounded in the evidence given; say what is unknown; ask questions. Do not recommend, vote, rank or choose. Say only what the evidence says.`, question, evidence: subset, outputClasses, perspective: { id: p.id, name: p.name, focus: p.focus, sections: outputSections } })) as Parameters<AiProvider['synthesize']>[0];
        let raw;
        try {
          raw = await provider.synthesize(input);
        } catch (e) {
          providerUnknowns.push(`The ${p.name} perspective could not be drawn: ${(e as Error).message}`);
          continue;
        }
        const draft = {
          statements: (Array.isArray(raw?.statements) ? raw.statements : []).map((s) => ({ text: String(s?.text ?? ''), class: s?.class, evidenceIds: Array.isArray(s?.evidenceIds) ? s.evidenceIds.map(String) : [], section: typeof s?.section === 'string' ? s.section : null })),
          questions: Array.isArray(raw?.questions) ? raw.questions.map(String) : [],
          unknowns: Array.isArray(raw?.unknowns) ? raw.unknowns.map(String) : [],
        };
        // A perspective may cite only the evidence it was given: ids are matched against ITS subset.
        const { statements, report } = groundDraft(draft, subset);
        const sections = Object.fromEntries(outputSections.map((s) => [s, [] as GroundedStatement[]])) as Record<OutputSection, GroundedStatement[]>;
        for (const st of statements) {
          const sec = (outputSections as readonly string[]).includes(st.section ?? '') ? (st.section as OutputSection) : 'OBSERVATIONS';
          sections[sec].push(st);
          for (const id of st.evidenceIds) cited.set(id, (cited.get(id) ?? new Set()).add(p.id));
        }
        const usedIds = new Set(statements.flatMap((s) => s.evidenceIds));
        const questions = groundQuestions(draft.questions);
        const unknowns = draft.unknowns.filter((u) => u.trim());
        const run = await store.insertRun(scope, {
          userId: caller.viewer.userId,
          task: 'COUNCIL',
          templateId: `council-${p.id.toLowerCase()}`,
          templateVersion: COUNCIL_TEMPLATE_VERSION,
          promptHash: promptHash({ p: p.id, q: question, e: subset.map((e) => [e.id, e.ref, e.label, e.values]) }),
          provider: { id: provider.id, model: provider.model, modelVersion: provider.modelVersion },
          toolCalls: g.calls,
          evidenceRefs: subset.map((e) => ({ id: e.id, kind: e.kind, tool: e.tool, ref: e.ref })),
          grounding: report,
          output: { statements, questions, unknowns },
          resultMeta: { statementsByClass: countBy(statements), evidenceCount: subset.length, fingerprint: `air_${fnv1a64(JSON.stringify(statements.map((s) => [s.class, s.text])))}` },
        });
        if (!run.ok) return run;
        outputs.push({ perspective: p.id, name: p.name, sections, supportingEvidence: subset.filter((e) => usedIds.has(e.id)), unknowns, questions, grounding: report, runId: run.value.id });
      }

      const sharedEvidence = evidence
        .filter((e) => (cited.get(e.id)?.size ?? 0) > 1)
        .map((e) => ({ evidence: e, perspectives: [...cited.get(e.id)!].sort() as PerspectiveId[] }));
      const tensions = tensionsOf(evidence, instantiated);
      const missingEvidence = [
        ...new Set([
          ...g.unknowns,
          ...providerUnknowns,
          ...outputs.flatMap((o) => o.unknowns),
          ...silent.map((s) => s.reason),
          ...notInstantiated.map((n) => `${n.name}: ${n.reason}`),
        ]),
      ];
      const questions = [...new Set(outputs.flatMap((o) => o.questions))].slice(0, 10);

      // The orchestrator's own run: what it gathered and for whom. It makes no statement of its own.
      const orch = await store.insertRun(scope, {
        userId: caller.viewer.userId,
        task: 'COUNCIL',
        templateId: 'council-orchestrator',
        templateVersion: COUNCIL_TEMPLATE_VERSION,
        promptHash: promptHash({ q: question, plan }),
        provider: { id: provider.id, model: provider.model, modelVersion: provider.modelVersion },
        toolCalls: g.calls,
        evidenceRefs: evidence.map((e) => ({ id: e.id, kind: e.kind, tool: e.tool, ref: e.ref })),
        grounding: { proposed: 0, kept: 0, reclassified: 0, downgradedToInference: 0, removed: 0, removals: [] },
        output: { statements: [], questions, unknowns: missingEvidence },
        resultMeta: { statementsByClass: {}, evidenceCount: evidence.length, fingerprint: `air_${fnv1a64(JSON.stringify([outputs.map((o) => o.runId), tensions.length]))}` },
      });
      if (!orch.ok) return orch;

      return ok({
        question,
        perspectives: outputs,
        notInstantiated,
        silent,
        sharedEvidence,
        tensions,
        missingEvidence,
        questions,
        evidence,
        provider: { id: provider.id, model: provider.model, modelVersion: provider.modelVersion },
        orchestratorRunId: orch.value.id,
        accountable: 'HUMAN_MANAGEMENT' as const,
        notice: COUNCIL_NOTICE,
      });
    },
  };
}

const countBy = (xs: readonly GroundedStatement[]): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const x of xs) o[x.class] = (o[x.class] ?? 0) + 1;
  return o;
};

/**
 * createIntelligenceRuntime — the governed AI layer.
 *
 *   plan (fixed for a contextual task; proposed-then-held-to-the-catalogue for Ask HELM)
 *   → call READ-ONLY tools as the caller → collect evidence
 *   → provider.synthesize(JSON only) → ground → audit → answer
 *
 * The provider is handed data and nothing else, so it has nothing to write with.
 * Whatever it proposes is checked against what the tools returned; whatever it
 * returns beyond statements, questions and unknowns is discarded and never stored.
 */

import { fail, fnv1a64, ok, type Clock, type Scope } from '@helm/shared';
import { groundDraft, groundQuestions, promptHash } from './grounding.ts';
import type { AiProvider } from './provider.ts';
import type { AiRunStore, AskRequest, Caller, IntelligenceRuntime } from './port.ts';
import { BRIEF_SECTIONS, TEMPLATES, type Template } from './templates.ts';
import { gatherEvidence } from './gather.ts';
import type { ToolContext, ToolRegistry } from './tools.ts';
import {
  AI_NOTICE,
  IntelligenceErrors,
  outputClasses,
  type AiRun,
  type Draft,
  type EvidenceItem,
  type GroundedStatement,
  type IntelligenceAnswer,
  type ToolCall,
  type ToolCallRecord,
} from './types.ts';

export type IntelligenceRuntimeOptions = { provider: AiProvider; tools: ToolRegistry; store: AiRunStore; clock: Clock };


export function createIntelligenceRuntime(opts: IntelligenceRuntimeOptions): IntelligenceRuntime {
  const { provider, tools, store } = opts;

  async function audit(scope: Scope, caller: Caller, a: { task: string; template: Template; phash: string; calls: ToolCallRecord[]; evidence: EvidenceItem[]; statements: readonly GroundedStatement[]; questions: string[]; unknowns: string[]; report: AiRun['grounding'] }) {
    const byClass: Record<string, number> = {};
    for (const s of a.statements) byClass[s.class] = (byClass[s.class] ?? 0) + 1;
    return store.insertRun(scope, {
      userId: caller.viewer.userId,
      task: a.task,
      templateId: a.template.id,
      templateVersion: a.template.version,
      promptHash: a.phash,
      provider: { id: provider.id, model: provider.model, modelVersion: provider.modelVersion },
      toolCalls: a.calls,
      evidenceRefs: a.evidence.map((e) => ({ id: e.id, kind: e.kind, tool: e.tool, ref: e.ref })),
      grounding: a.report,
      output: { statements: a.statements, questions: a.questions, unknowns: a.unknowns },
      resultMeta: { statementsByClass: byClass, evidenceCount: a.evidence.length, fingerprint: `air_${fnv1a64(JSON.stringify(a.statements.map((s) => [s.class, s.text])))}` },
    });
  }

  return {
    catalogue: () => tools.catalogue(),

    async run(scope, caller, request: AskRequest) {
      const template = (TEMPLATES as Record<string, Template>)[request.task];
      if (!template) return fail(IntelligenceErrors.UNKNOWN_TASK, `No such task "${request.task}".`);
      const params = request.params ?? {};
      for (const n of template.needs) if (!params[n]?.trim()) return fail(IntelligenceErrors.INVALID, `The task "${request.task}" needs ${n}.`);
      const ctx: ToolContext = { scope, viewer: caller.viewer, units: caller.units, facts: caller.facts, now: opts.clock.now().toISOString() };

      // ---- plan
      let plan: readonly ToolCall[];
      if (template.plan) plan = template.plan(params);
      else {
        if (!provider.plan) return fail(IntelligenceErrors.PROVIDER_FAILED, `${provider.id} cannot plan tool calls; an open-ended ask needs a provider that can.`);
        try {
          plan = await provider.plan({ question: params['question']!, tools: tools.catalogue() });
        } catch (e) {
          return fail(IntelligenceErrors.PROVIDER_FAILED, `The provider failed while planning: ${(e as Error).message}`);
        }
      }

      // ---- read, as the caller, through the catalogue and nothing else
      const { calls, evidence, notes, unknowns } = await gatherEvidence(tools, ctx, plan);

      // ---- synthesize: JSON in, a draft out
      const input = JSON.parse(JSON.stringify({ task: request.task, templateId: template.id, templateVersion: template.version, instructions: template.instructions, question: params['question'] ?? null, evidence, outputClasses })) as Parameters<AiProvider['synthesize']>[0];
      const phash = promptHash({ t: template.id, v: template.version, i: template.instructions, q: params['question'] ?? null, e: evidence.map((e) => [e.id, e.kind, e.ref, e.label, e.values]) });
      let draft: Draft;
      try {
        const raw = await provider.synthesize(input);
        // Keep ONLY what the contract names. A reasoning trace, a tool request or any other field is dropped here and never stored.
        draft = {
          statements: (Array.isArray(raw?.statements) ? raw.statements : []).map((s) => ({ text: String(s?.text ?? ''), class: s?.class, evidenceIds: Array.isArray(s?.evidenceIds) ? s.evidenceIds.map(String) : [], section: typeof s?.section === 'string' ? s.section : null })),
          questions: Array.isArray(raw?.questions) ? raw.questions.map(String) : [],
          unknowns: Array.isArray(raw?.unknowns) ? raw.unknowns.map(String) : [],
        };
      } catch (e) {
        const empty = { proposed: 0, kept: 0, reclassified: 0, downgradedToInference: 0, removed: 0, removals: [] };
        await audit(scope, caller, { task: request.task, template, phash, calls, evidence, statements: [], questions: [], unknowns: [`The provider failed: ${(e as Error).message}`], report: empty });
        return fail(IntelligenceErrors.PROVIDER_FAILED, `The provider failed: ${(e as Error).message}`);
      }

      // ---- ground
      const { statements: grounded, report } = groundDraft(draft, evidence);
      let statements = grounded;
      if (request.task === 'DRAFT_MANAGEMENT_BRIEF') {
        const order = (s: GroundedStatement) => {
          const i = BRIEF_SECTIONS.indexOf((s.section ?? '') as (typeof BRIEF_SECTIONS)[number]);
          return i < 0 ? BRIEF_SECTIONS.length : i;
        };
        statements = [...grounded].sort((a, b) => order(a) - order(b));
      }
      const questions = groundQuestions(draft.questions);
      const allUnknowns = [...new Set([...unknowns, ...(draft.unknowns ?? []).filter((u) => u.trim())])];
      const run = await audit(scope, caller, { task: request.task, template, phash, calls, evidence, statements, questions, unknowns: allUnknowns, report });
      if (!run.ok) return run;

      const answer: IntelligenceAnswer = {
        runId: run.value.id,
        task: request.task,
        templateId: template.id,
        templateVersion: template.version,
        statements,
        questions,
        unknowns: allUnknowns,
        notes: [...new Set(notes)],
        evidence,
        toolCalls: calls,
        grounding: report,
        provider: { id: provider.id, model: provider.model, modelVersion: provider.modelVersion },
        notice: AI_NOTICE,
      };
      return ok(answer);
    },

    async listRuns(scope, caller) {
      const all = await store.listRuns(scope);
      if (!all.ok) return all;
      return ok(caller.viewer.orgRole === 'admin' ? all.value : all.value.filter((r) => r.userId === caller.viewer.userId));
    },

    async getRun(scope, caller, id) {
      const r = await store.getRun(scope, id);
      if (!r.ok) return r;
      if (!r.value || (caller.viewer.orgRole !== 'admin' && r.value.userId !== caller.viewer.userId)) return fail(IntelligenceErrors.NOT_VISIBLE, 'That run is not yours to read.');
      return ok(r.value);
    },
  };
}

/**
 * Task templates: what the AI is asked to do, and — for a contextual task —
 * exactly which read-only tools it reads through. The plan of a contextual task
 * is fixed here, not chosen by the model. Only the open-ended "Ask HELM" lets the
 * provider propose tool calls, and those are held to the catalogue.
 */

import type { ToolCall } from './types.ts';

export const TEMPLATE_VERSION = '1';

export type TaskParams = Readonly<Record<string, string | undefined>>;

export type Template = {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  /** Null: the provider proposes the calls (open-ended ask). */
  readonly plan: ((p: TaskParams) => readonly ToolCall[]) | null;
  readonly needs: readonly string[];
};

const COMMON =
  'Say only what the evidence says, in the class the evidence carries. Cite evidence for every statement about the enterprise. ' +
  'Mark your own reading as inference. Never recommend a choice, approve, commit or execute. Say what is unknown. ' +
  'A causal claim keeps its evidence status; a counterfactual is a model estimate; a model result is not a cause.';

export const TEMPLATES = {
  /** Inside the Twin: explain what changed. */
  EXPLAIN_TWIN_CHANGE: {
    id: 'explain-twin-change',
    version: TEMPLATE_VERSION,
    instructions: `Explain what changed between two twin snapshots. ${COMMON}`,
    needs: ['fromId', 'toId'],
    plan: (p) => [{ tool: 'compareTwinSnapshots', args: { fromId: p['fromId'] ?? '', toId: p['toId'] ?? '' } }],
  },
  /** Inside a Decision: summarize unresolved assumptions. */
  SUMMARIZE_ASSUMPTIONS: {
    id: 'summarize-assumptions',
    version: TEMPLATE_VERSION,
    instructions: `Summarize the assumptions of a decision that are unresolved or challenged, and draft the questions that would settle them. ${COMMON}`,
    needs: ['decisionId'],
    plan: (p) => [{ tool: 'getDecision', args: { decisionId: p['decisionId'] ?? '' } }],
  },
  /** Inside a Decision: the reasoning behind a commitment. */
  EXPLAIN_DECISION: {
    id: 'explain-decision',
    version: TEMPLATE_VERSION,
    instructions: `Explain why management chose what it chose, with its accepted trade-offs and assumptions. ${COMMON}`,
    needs: ['decisionId'],
    plan: (p) => [
      { tool: 'explainDecision', args: { decisionId: p['decisionId'] ?? '' } },
      { tool: 'getGovernanceState', args: { decisionId: p['decisionId'] ?? '' } },
    ],
  },
  /** Inside Causal: evidence for and against a claim. */
  SUMMARIZE_CAUSAL_EVIDENCE: {
    id: 'summarize-causal-evidence',
    version: TEMPLATE_VERSION,
    instructions: `Summarize the evidence for and against the causal claims about a cause and effect. Keep each claim's own status. Do not state a hypothesis as fact. ${COMMON}`,
    needs: [],
    plan: (p) => [{ tool: 'getCausalClaims', args: { ...(p['causeKey'] ? { causeKey: p['causeKey'] } : {}), ...(p['effectKey'] ? { effectKey: p['effectKey'] } : {}) } }],
  },
  /** Inside the Genome: find similar management situations. */
  FIND_SIMILAR_SITUATIONS: {
    id: 'find-similar-situations',
    version: TEMPLATE_VERSION,
    instructions: `Find earlier management situations that agree with an episode on the named features, and the patterns they belong to. Recurrence is described, never certified. ${COMMON}`,
    needs: ['episodeId'],
    plan: (p) => [
      { tool: 'getSimilarEpisodes', args: { episodeId: p['episodeId'] ?? '', require: (p['require'] ?? 'decisionType').split(',').map((x) => x.trim()) } },
      { tool: 'getGenomePatterns', args: {} },
    ],
  },
  /** Inside Counterfactuals: read a case. */
  EXPLAIN_COUNTERFACTUAL: {
    id: 'explain-counterfactual',
    version: TEMPLATE_VERSION,
    instructions: `Explain a counterfactual comparison: what was expected, what happened, and the model's estimate of the alternative at each lens. It is a model estimate, not a verdict. ${COMMON}`,
    needs: ['caseId'],
    plan: (p) => [{ tool: 'runCounterfactual', args: { caseId: p['caseId'] ?? '' } }],
  },
  /** Inside a Review: draft the management brief. */
  DRAFT_MANAGEMENT_BRIEF: {
    id: 'draft-management-brief',
    version: TEMPLATE_VERSION,
    instructions: `Draft a management brief for a review: what changed, what matters, what is off-track, what is uncertain, what decisions are required, what assumptions are challenged, what outcomes arrived. Every factual statement is grounded. ${COMMON}`,
    needs: ['reviewId'],
    plan: (p) => [{ tool: 'getReviewPack', args: { reviewId: p['reviewId'] ?? '' } }],
  },
  /** Anywhere: a general question. The provider proposes the read-only tools; the runtime holds it to the catalogue. */
  ASK_HELM: {
    id: 'ask-helm',
    version: TEMPLATE_VERSION,
    instructions: `Answer a management question from what the tools return. ${COMMON}`,
    needs: ['question'],
    plan: null,
  },
} as const satisfies Record<string, Template>;

export type TaskName = keyof typeof TEMPLATES;

/** The order of a management brief's sections. */
export const BRIEF_SECTIONS = ['What changed?', 'What matters?', 'What is off-track?', 'What is uncertain?', 'What decisions are required?', 'What assumptions are challenged?', 'What outcomes arrived?'] as const;

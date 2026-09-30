/**
 * The AI intelligence vocabulary (ADR-0032).
 *
 *     HELM KERNEL → GOVERNED READ-ONLY TOOLS → AI RUNTIME → EXPLANATION / SYNTHESIS
 *
 * The AI sits ABOVE kernel truth. It never writes enterprise truth: it reads
 * through tools that respect the caller's access, and what it says is classified
 * and grounded, or it is removed, qualified or marked as inference.
 *
 *     AI interpretation ≠ Enterprise truth
 */

import type { KernelRefLike } from './refs.ts';

export const IntelligenceErrors = {
  INVALID: 'intelligence.invalid_input',
  UNKNOWN_TASK: 'intelligence.unknown_task',
  UNKNOWN_TOOL: 'intelligence.unknown_tool',
  BAD_ARGS: 'intelligence.bad_tool_arguments',
  TOO_MANY_CALLS: 'intelligence.too_many_tool_calls',
  PROVIDER_FAILED: 'intelligence.provider_failed',
  NOT_VISIBLE: 'intelligence.not_visible',
} as const;

/** What an output statement IS. Nothing is promoted from one class to another. */
export const outputClasses = [
  'SOURCE_FACT', // what a source system says (Memoire's probability)
  'MODEL_RESULT', // what HELM's model computes (a calculated margin)
  'SCENARIO', // a computed possible future
  'CAUSAL_CLAIM', // a claim people made, with its own evidence status
  'COUNTERFACTUAL_RESULT', // a model estimate of an ex-post alternative
  'MANAGEMENT_ASSUMPTION', // an assumption management stated
  'MANAGEMENT_RECORD', // what management did and HELM recorded: a decision, a commitment, a governance state, an episode
  'AI_INFERENCE', // the model's own reading — not a kernel fact
  'SUGGESTION', // a question to ask or evidence to gather — never a choice
  'UNKNOWN', // what HELM does not know, or may not show
] as const;
export type OutputClass = (typeof outputClasses)[number];

/** The classes a piece of evidence can carry: every class that is grounded in the kernel. */
export const evidenceKinds = ['SOURCE_FACT', 'MODEL_RESULT', 'SCENARIO', 'CAUSAL_CLAIM', 'COUNTERFACTUAL_RESULT', 'MANAGEMENT_ASSUMPTION', 'MANAGEMENT_RECORD'] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

export type Lens = { readonly effectiveAsOf: string; readonly recordedThrough: string };

/** One thing the kernel said, as a tool returned it. `values` are the ONLY figures and words a grounded statement may quote. */
export type EvidenceItem = {
  /** Run-local: 'ev-1'. */
  readonly id: string;
  readonly kind: EvidenceKind;
  /** Where in the kernel it came from — a reference, so a person can go and look. */
  readonly ref: KernelRefLike;
  readonly label: string;
  readonly values: readonly string[];
  /** A claim's evidence status, a decision's state — the qualifier a statement may not drop. */
  readonly status: string | null;
  /** The brief section this evidence belongs to, when the task has sections. */
  readonly section: string | null;
  /** The value dimension a reading belongs to (FINANCIAL, OPERATIONAL, RISK…), when it is a value reading. */
  readonly dimension?: string | null;
  /** The value metric a reading is of, when it is a value reading. */
  readonly metricKey?: string | null;
  readonly tool: string;
  readonly lens: Lens | null;
};

/** What a provider proposes. The runtime keeps ONLY these fields: anything else (a reasoning trace, say) is discarded, never stored. */
export type DraftStatement = { readonly text: string; readonly class: OutputClass; readonly evidenceIds: readonly string[]; readonly section?: string | null };
export type Draft = { readonly statements: readonly DraftStatement[]; readonly questions?: readonly string[]; readonly unknowns?: readonly string[] };

export type GroundedStatement = {
  readonly text: string;
  readonly class: OutputClass;
  readonly evidenceIds: readonly string[];
  readonly section: string | null;
  /** True when the statement was not accepted as proposed: it was reclassified or downgraded to inference. */
  readonly qualified: boolean;
  readonly reclassifiedFrom: OutputClass | null;
  readonly note: string | null;
};

export type GroundingReport = {
  readonly proposed: number;
  readonly kept: number;
  readonly reclassified: number;
  readonly downgradedToInference: number;
  readonly removed: number;
  readonly removals: readonly { readonly text: string; readonly reason: string }[];
};

export type ToolCall = { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };

export type ToolCallRecord = {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly outcome: 'OK' | 'REFUSED' | 'WITHHELD' | 'ERROR';
  readonly evidenceIds: readonly string[];
  readonly note: string | null;
};

export type ProviderIdentity = { readonly id: string; readonly model: string; readonly modelVersion: string };

export type IntelligenceAnswer = {
  readonly runId: string;
  readonly task: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly statements: readonly GroundedStatement[];
  /** Questions a person might ask next. Never decisions. */
  readonly questions: readonly string[];
  /** What HELM does not know or may not show to this reader. */
  readonly unknowns: readonly string[];
  /** What the tools said about themselves: a statement of method, a limit. Not evidence. */
  readonly notes: readonly string[];
  readonly evidence: readonly EvidenceItem[];
  readonly toolCalls: readonly ToolCallRecord[];
  readonly grounding: GroundingReport;
  readonly provider: ProviderIdentity;
  /** Always present: what an AI reading is not. */
  readonly notice: string;
};

export const AI_NOTICE =
  'AI interpretation is not enterprise truth. Every statement is classed and points at kernel evidence; a statement the kernel does not support is marked as inference or removed. The AI approves, commits and executes nothing.';

/** The audit record of one run: what it was, who asked, what it touched — never a reasoning trace. */
export type AiRun = {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly task: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly promptHash: string;
  readonly provider: ProviderIdentity;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly evidenceRefs: readonly { readonly id: string; readonly kind: EvidenceKind; readonly tool: string; readonly ref: KernelRefLike }[];
  readonly grounding: GroundingReport;
  readonly output: { readonly statements: readonly GroundedStatement[]; readonly questions: readonly string[]; readonly unknowns: readonly string[] };
  readonly resultMeta: { readonly statementsByClass: Readonly<Record<string, number>>; readonly evidenceCount: number; readonly fingerprint: string };
  readonly recordedAt: string;
};

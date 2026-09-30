/**
 * The multi-agent vocabulary (ADR-0033).
 *
 * A perspective is an analytical LENS over the one enterprise truth — not another
 * AI world, not a personality, not a decision-maker. Every perspective reads the
 * same evidence through the same governed tools as the same caller; what differs
 * is which of it is relevant, and what each one notices.
 *
 *     Agent Perspective ≠ Decision Authority
 */

import type { EvidenceItem, GroundedStatement, GroundingReport, ProviderIdentity } from '@helm/intelligence-runtime';

export const AgentErrors = {
  INVALID: 'agents.invalid_input',
  NO_EVIDENCE: 'agents.no_evidence',
  PROVIDER_FAILED: 'agents.provider_failed',
} as const;

export const perspectiveIds = ['COMMERCIAL', 'FINANCE', 'SUPPLY_CHAIN', 'OPERATIONS', 'RISK', 'STRATEGY', 'PEOPLE', 'ENTERPRISE_VALUE'] as const;
export type PerspectiveId = (typeof perspectiveIds)[number];

/** The seven parts of every perspective's output. */
export const outputSections = ['OBSERVATIONS', 'CONCERNS', 'CHALLENGED_ASSUMPTIONS', 'TRADE_OFFS'] as const;
export type OutputSection = (typeof outputSections)[number];

export type PerspectiveOutput = {
  readonly perspective: PerspectiveId;
  readonly name: string;
  /** Observations, concerns, challenged assumptions, trade-offs: each statement classed and grounded. */
  readonly sections: Readonly<Record<OutputSection, readonly GroundedStatement[]>>;
  /** The kernel evidence this perspective's statements rest on. */
  readonly supportingEvidence: readonly EvidenceItem[];
  readonly unknowns: readonly string[];
  readonly questions: readonly string[];
  readonly grounding: GroundingReport;
  readonly runId: string;
};

export type NotInstantiated = { readonly perspective: PerspectiveId; readonly name: string; readonly reason: string };
export type Silent = { readonly perspective: PerspectiveId; readonly name: string; readonly reason: string };

/** A side of a tension: a perspective and the trade-off line it stands on. */
export type TensionSide = { readonly perspective: PerspectiveId; readonly name: string; readonly line: string; readonly evidenceId: string };

/**
 * Where perspectives pull apart, stated as a FACT about a scenario alternative: it
 * gains on what one perspective cares about and concedes on what another does.
 * Nobody wins; nothing is netted; HELM does not say which side is right.
 */
export type Tension = {
  readonly alternative: string;
  readonly gains: readonly TensionSide[];
  readonly concessions: readonly TensionSide[];
  readonly statement: string;
};

export type CouncilRequest = {
  /** The management question, in management's words. */
  readonly question: string;
  readonly decisionId?: string;
  readonly reviewId?: string;
  readonly snapshotId?: string;
  /** Ask only some perspectives. Default: every one HELM has data for and that has something to say. */
  readonly perspectives?: readonly PerspectiveId[];
};

export type CouncilResult = {
  readonly question: string;
  readonly perspectives: readonly PerspectiveOutput[];
  readonly notInstantiated: readonly NotInstantiated[];
  readonly silent: readonly Silent[];
  /** What more than one perspective rests on: the shared truth, once. */
  readonly sharedEvidence: readonly { readonly evidence: EvidenceItem; readonly perspectives: readonly PerspectiveId[] }[];
  readonly tensions: readonly Tension[];
  /** What is missing, said out loud: withheld entries, unread sources, perspectives with no data. */
  readonly missingEvidence: readonly string[];
  readonly questions: readonly string[];
  readonly evidence: readonly EvidenceItem[];
  readonly provider: ProviderIdentity;
  readonly orchestratorRunId: string;
  /** Always the same, and always present. */
  readonly accountable: 'HUMAN_MANAGEMENT';
  readonly notice: string;
};

export const COUNCIL_NOTICE =
  'The council does not vote, rank, weigh or choose, and it has no consensus to report: where perspectives differ the difference is shown as it is. ' +
  'Human management stays accountable. A perspective is a lens, not an authority; it approves, commits and executes nothing.';

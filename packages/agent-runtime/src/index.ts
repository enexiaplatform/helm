/**
 * @helm/agent-runtime — Multi-Agent Management.
 *
 * Specialised management perspectives over the SAME enterprise truth: commercial,
 * finance, supply chain, operations, risk, strategy, people and enterprise value —
 * each instantiated only where HELM holds data for it. Each returns observations,
 * concerns, supporting evidence, challenged assumptions, trade-offs, unknowns and
 * questions. The council orchestrator gathers the evidence once as the caller,
 * deduplicates shared facts and surfaces agreement, disagreement and what is
 * missing; it does not vote, rank, choose, authorize, approve, commit or execute.
 *
 *     Agent Perspective ≠ Decision Authority
 */

export * from './types.ts';
export { PERSPECTIVES, perspectiveOf, coverageOf, relevantTo } from './perspectives.ts';
export type { PerspectiveDef, Coverage } from './perspectives.ts';
export { createReferencePerspectiveProvider, sectionOf } from './provider.ts';
export { createCouncil, planFor, tensionsOf, COUNCIL_TEMPLATE_VERSION } from './council.ts';
export type { Council, CouncilOptions } from './council.ts';

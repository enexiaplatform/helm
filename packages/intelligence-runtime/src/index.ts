/**
 * @helm/intelligence-runtime — the governed AI layer.
 *
 *     HELM KERNEL → GOVERNED READ-ONLY TOOLS → AI RUNTIME → EXPLANATION / SYNTHESIS
 *
 * Provider-neutral; deterministic fakes for every test; no credentials needed.
 * The AI retrieves, explains, compares and drafts through tools that read as the
 * caller. Every enterprise statement it makes is classed and grounded in kernel
 * evidence, or removed, qualified or marked as inference. It writes no enterprise
 * truth, approves, commits or executes nothing — and no reasoning trace is stored.
 *
 *     AI interpretation ≠ Enterprise truth
 */

export * from './types.ts';
export * from './port.ts';
export type { KernelRefLike } from './refs.ts';
export { groundDraft, groundQuestions, numbersIn, RECOMMENDATION, promptHash } from './grounding.ts';
export { createReferenceProvider } from './provider.ts';
export type { AiProvider, PlanInput, SynthesisInput, ToolArgSpec, ToolCatalogueEntry } from './provider.ts';
export { createGovernedTools, validateArgs } from './tools.ts';
export type { GovernedTool, IntelligenceSources, RawEvidence, ToolContext, ToolRegistry, ToolResult } from './tools.ts';
export { TEMPLATES, TEMPLATE_VERSION, BRIEF_SECTIONS } from './templates.ts';
export type { Template, TaskName, TaskParams } from './templates.ts';
export { createIntelligenceRuntime } from './runtime.ts';
export { gatherEvidence, MAX_TOOL_CALLS } from './gather.ts';
export type { Gathered } from './gather.ts';
export type { IntelligenceRuntimeOptions } from './runtime.ts';
export { createInMemoryAiRunStore } from './inMemoryStore.ts';
export type { InMemoryAiRunStoreOptions } from './inMemoryStore.ts';

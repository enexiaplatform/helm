/**
 * The AiRunStore port and the IntelligenceRuntime interface (ADR-0032).
 *
 * The store keeps the audit of every run — append-only, record time stamped by
 * the store. It never keeps a reasoning trace: a run is what was asked, by whom,
 * through which provider and template, which tools were called, which kernel
 * objects were cited and what was said after grounding.
 */

import type { Result, Scope } from '@helm/shared';
import type { OrgUnit } from '@helm/authority-runtime';
import type { TwinViewer } from '@helm/twin-runtime';
import type { ToolCatalogueEntry } from './provider.ts';
import type { TaskName, TaskParams } from './templates.ts';
import type { AiRun, IntelligenceAnswer } from './types.ts';

export type NewAiRun = Omit<AiRun, 'id' | 'orgId' | 'recordedAt'>;

export interface AiRunStore {
  /** Write-once. */
  insertRun(scope: Scope, input: NewAiRun): Promise<Result<AiRun>>;
  getRun(scope: Scope, id: string): Promise<Result<AiRun | null>>;
  listRuns(scope: Scope, filter?: { userId?: string; task?: string }): Promise<Result<readonly AiRun[]>>;
}

/** Who is asking, and what they may see. Every tool reads through this — the AI has no access of its own. */
export type Caller = {
  readonly viewer: TwinViewer;
  readonly units: readonly OrgUnit[];
  readonly facts: { decisionVisible: (decisionId: string) => boolean };
};

export type AskRequest = { readonly task: TaskName; readonly params?: TaskParams };

export interface IntelligenceRuntime {
  /** Runs one task for one caller: read through governed tools, synthesize through the provider, ground the result, audit the run. */
  run(scope: Scope, caller: Caller, request: AskRequest): Promise<Result<IntelligenceAnswer>>;
  /** The audit trail. A user reads their own runs; an admin reads all. */
  listRuns(scope: Scope, caller: Caller): Promise<Result<readonly AiRun[]>>;
  getRun(scope: Scope, caller: Caller, id: string): Promise<Result<AiRun>>;
  catalogue(): readonly ToolCatalogueEntry[];
}

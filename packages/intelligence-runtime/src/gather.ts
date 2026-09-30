/**
 * Reading the kernel through the catalogue, as the caller — shared by a single AI
 * task and by the multi-perspective council, so that both read the same way and
 * neither can read more than the person asking.
 */

import { IntelligenceErrors, type EvidenceItem, type ToolCall, type ToolCallRecord } from './types.ts';
import { validateArgs, type ToolContext, type ToolRegistry } from './tools.ts';

export const MAX_TOOL_CALLS = 8;

const UNKNOWN_NOTE = /withheld|not visible|above your clearance|not readable/i;

export type Gathered = {
  readonly calls: ToolCallRecord[];
  readonly evidence: EvidenceItem[];
  /** What the tools said about themselves: a method, a limit. */
  readonly notes: string[];
  /** What HELM does not know or may not show. */
  readonly unknowns: string[];
};

export async function gatherEvidence(tools: ToolRegistry, ctx: ToolContext, plan: readonly ToolCall[]): Promise<Gathered> {
  const calls: ToolCallRecord[] = [];
  const evidence: EvidenceItem[] = [];
  const notes: string[] = [];
  const unknowns: string[] = [];
  const seen = new Set<string>();
  for (const call of plan.slice(0, MAX_TOOL_CALLS)) {
    const t = tools.get(call.tool);
    if (!t) {
      calls.push({ tool: String(call.tool), args: call.args, outcome: 'REFUSED', evidenceIds: [], note: 'Not a governed tool. The AI reads HELM through the catalogue only; it cannot query a table.' });
      unknowns.push(`A request for "${String(call.tool)}" was refused: it is not a governed tool.`);
      continue;
    }
    const bad = validateArgs(t, call.args);
    if (bad) {
      calls.push({ tool: t.name, args: call.args, outcome: 'REFUSED', evidenceIds: [], note: bad });
      unknowns.push(`${t.name} was refused: ${bad}`);
      continue;
    }
    const r = await t.run(ctx, call.args);
    if (!r.ok) {
      calls.push({ tool: t.name, args: call.args, outcome: r.error.code === IntelligenceErrors.NOT_VISIBLE ? 'WITHHELD' : 'ERROR', evidenceIds: [], note: r.error.message });
      unknowns.push(`${t.name}: ${r.error.message}`);
      continue;
    }
    const ids: string[] = [];
    for (const raw of r.value.evidence) {
      const key = `${raw.kind}|${raw.ref.kind}|${raw.ref.id}|${raw.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item: EvidenceItem = { ...raw, id: `ev-${evidence.length + 1}`, tool: t.name };
      evidence.push(item);
      ids.push(item.id);
    }
    for (const n of r.value.notes) (UNKNOWN_NOTE.test(n) ? unknowns : notes).push(n);
    calls.push({ tool: t.name, args: call.args, outcome: r.value.withheld > 0 && ids.length === 0 ? 'WITHHELD' : 'OK', evidenceIds: ids, note: r.value.withheld > 0 ? `${r.value.withheld} withheld` : null });
  }
  if (plan.length > MAX_TOOL_CALLS) unknowns.push(`Only the first ${MAX_TOOL_CALLS} tool calls were made.`);
  return { calls, evidence, notes, unknowns };
}

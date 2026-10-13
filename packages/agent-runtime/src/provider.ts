/**
 * The reference perspective composer: no model, no network, no randomness.
 *
 * Given the evidence relevant to one perspective, it sorts each item into what a
 * perspective returns — an observation, a concern, a challenged assumption, a
 * trade-off — and drafts the questions that would settle what is unresolved. It
 * takes no side and expresses no preference: a language-model adapter implementing
 * the same provider port replaces it, and the council does not change.
 */

import { createReferenceProvider, type AiProvider, type Draft, type EvidenceItem, type OutputClass, type SynthesisInput } from '@helm/intelligence-runtime';
import { perspectiveOf } from './perspectives.ts';
import type { OutputSection, PerspectiveId } from './types.ts';

const CONCERN = /BREACH|BLOCKED|UNKNOWN|SHORT|FALLS|DISPROVED|CONTESTED|HYPOTHESIS|NOT_EVALUATED|AWAITING|PENDING|NOT_AUTHORIZED|ESCALATED|OFF_TRACK|STALE|UNAVAILABLE/i;
const ASSUMPTION_CHALLENGED = /DISPROVED|CHALLENGED|OPEN|PENDING|UNCHECKED/i;
const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Cut at a word, never inside one: a question that ends "NOT EVALUAT…?" reads as broken (audit 2026-10-13). */
const clipWords = (s: string, n = 90) => (s.length > n ? `${s.slice(0, s.lastIndexOf(' ', n - 1) > n / 2 ? s.lastIndexOf(' ', n - 1) : n - 1).replace(/[,;:\s]+$/, '')}…` : s);

/**
 * The question a concern raises, asked of the concern itself. Each is a question to gather evidence for — never a
 * choice — and one kind of condition asks one question, however many commitments it names.
 */
export function concernQuestion(e: { label: string; status: string | null }): string {
  const label = e.label.trim();
  const authority = label.match(/^Authority over (.+?) is (?:NOT EVALUATED|INDETERMINATE)\.?$/);
  if (authority || e.status === 'AUTHORITY_UNRESOLVED') return 'Who records the authority verdict for the commitments that carry none?';
  if (e.status === 'COMMITTED_FUTURE_OFF_TRACK') return `What explains the distance between what was committed and what happened: ${clipWords(label.split(':')[0]!, 70)}?`;
  if (e.status === 'OBJECTIVE_OFF_TRACK') return `What would bring ${clipWords(label.split(':')[0]!, 70)} back to its target?`;
  if (e.status === 'CRITICAL_ASSUMPTION_DISPROVED') {
    const quoted = label.match(/"([^"]+)"/)?.[1];
    return `What does the disproved assumption change for the commitment it supported${quoted ? `: “${clipWords(quoted.replace(/\.$/, ''), 70)}”` : ''}?`;
  }
  return `What would resolve: ${clipWords(label).replace(/[.?:]+$/, '')}?`;
}
const body = (e: { label: string; values: readonly string[] }) => (e.values.length === 0 ? e.label : e.values[0]!.toLowerCase().startsWith(e.label.toLowerCase()) ? e.values.join('; ') : `${e.label}: ${e.values.join('; ')}`);

export function sectionOf(e: EvidenceItem): OutputSection {
  if (e.kind === 'SCENARIO') return 'TRADE_OFFS';
  if (e.kind === 'MANAGEMENT_ASSUMPTION' && ASSUMPTION_CHALLENGED.test(e.status ?? '')) return 'CHALLENGED_ASSUMPTIONS';
  if (e.tool === 'getManagementAttention' || e.section === 'What matters?' || e.section === 'What is off-track?' || CONCERN.test(e.status ?? '')) return 'CONCERNS';
  return 'OBSERVATIONS';
}

export function createReferencePerspectiveProvider(base: AiProvider = createReferenceProvider()): AiProvider {
  return {
    id: 'helm-reference-perspectives',
    model: 'rule-based-composer',
    modelVersion: '1.0.0',
    ...(base.plan ? { plan: base.plan.bind(base) } : {}),

    async synthesize(input: SynthesisInput): Promise<Draft> {
      const p = input.perspective;
      if (!p) return base.synthesize(input);
      const def = perspectiveOf(p.id as PerspectiveId);
      const statements: { text: string; class: OutputClass; evidenceIds: string[]; section: string }[] = [];
      const questions: string[] = [];
      for (const e of input.evidence) {
        const section = sectionOf(e);
        if (section === 'TRADE_OFFS') {
          // Only the lines this perspective attends to: the others belong to another lens.
          for (const line of e.values.filter((v) => /^(GAIN|CONCESSION|UNRESOLVED) /.test(v) && def.words.test(v))) {
            statements.push({ text: clip(`${e.label} — ${line}`), class: e.kind, evidenceIds: [e.id], section });
          }
          continue;
        }
        statements.push({ text: clip(`${body(e)}${e.status ? ` [${e.status}]` : ''}`), class: e.kind, evidenceIds: [e.id], section });
        if (section === 'CHALLENGED_ASSUMPTIONS') questions.push(`What would confirm or disprove: ${clipWords(e.label).replace(/[.?]+$/, '')}?`);
        if (section === 'CONCERNS' && new Set(questions).size < 4) questions.push(concernQuestion(e));
      }
      // A perspective states what it notices in kernel order, and says how much it leaves out — never "the most important".
      const CAP = 6;
      const kept: typeof statements = [];
      const unknowns: string[] = [];
      for (const sec of ['OBSERVATIONS', 'CONCERNS', 'CHALLENGED_ASSUMPTIONS', 'TRADE_OFFS']) {
        const mine = statements.filter((x) => x.section === sec);
        kept.push(...mine.slice(0, CAP));
        if (mine.length > CAP) unknowns.push(`${p.name}, ${sec.toLowerCase().replaceAll('_', ' ')}: ${mine.length - CAP} more in kernel order are not shown here.`);
      }
      if (input.evidence.length < 3) unknowns.push(`Little of what the kernel returned for this question speaks to the ${p.name.toLowerCase()} perspective.`);
      return { statements: kept, questions: [...new Set(questions)].slice(0, 5), unknowns };
    },
  };
}

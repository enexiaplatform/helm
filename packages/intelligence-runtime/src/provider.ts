/**
 * The provider port — vendor-neutral by construction.
 *
 * A provider receives DATA (JSON evidence, a question, instructions) and returns
 * a draft. It is never handed a runtime, a store, a client or a function: there is
 * nothing for it to call, so nothing for it to write. HELM depends structurally on
 * no model vendor; an adapter for one is a class implementing this interface, and
 * every test runs on deterministic fakes with no credentials.
 */

import type { Draft, EvidenceItem, OutputClass, ProviderIdentity, ToolCall } from './types.ts';

export type ToolArgSpec = { readonly name: string; readonly type: 'string' | 'number' | 'string[]'; readonly required: boolean; readonly description: string };

export type ToolCatalogueEntry = { readonly name: string; readonly description: string; readonly args: readonly ToolArgSpec[] };

export type PlanInput = {
  readonly question: string;
  /** What the provider may ask for. Nothing else exists as far as it is concerned. */
  readonly tools: readonly ToolCatalogueEntry[];
};

export type SynthesisInput = {
  readonly task: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly instructions: string;
  readonly question: string | null;
  /** Everything it may say anything about. Plain JSON. */
  readonly evidence: readonly EvidenceItem[];
  readonly outputClasses: readonly OutputClass[];
  /** Set when the synthesis is one management perspective over shared evidence (the council). */
  readonly perspective?: { readonly id: string; readonly name: string; readonly focus: string; readonly sections: readonly string[] };
};

export interface AiProvider extends ProviderIdentity {
  /** Only for open-ended asks: which of the catalogued tools to call. Contextual tasks use a fixed plan and never call it. */
  plan?(input: PlanInput): Promise<readonly ToolCall[]>;
  synthesize(input: SynthesisInput): Promise<Draft>;
}

// ------------------------------------------------------------------ reference

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The reference provider: no model, no network, no randomness. It states what the
 * evidence says, one statement per item, in the class the evidence carries, and
 * drafts management questions from what is unresolved or contested. It is what HELM
 * ships and what the demonstration runs; a language-model adapter replaces it
 * without changing anything above the port.
 */
export function createReferenceProvider(): AiProvider {
  return {
    id: 'helm-reference-provider',
    model: 'rule-based-composer',
    modelVersion: '1.0.0',

    async plan(input) {
      // A deterministic router: which read-only tools speak to the words of the question.
      const q = input.question.toLowerCase();
      const has = (t: string) => input.tools.some((x) => x.name === t);
      const calls: ToolCall[] = [];
      const want = (tool: string, re: RegExp, args: Record<string, unknown> = {}) => {
        if (has(tool) && re.test(q)) calls.push({ tool, args });
      };
      want('getManagementAttention', /attention|matters|off-track|risk|issue/, {});
      want('getEnterpriseState', /state|now|current|where are we/, {});
      want('getCausalClaims', /caus|why|evidence|hypothes/, {});
      want('getGenomePatterns', /pattern|recurr|learn|lesson/, {});
      want('getSimilarEpisodes', /similar|before|seen this|precedent/, {});
      if (calls.length === 0 && has('getManagementAttention')) calls.push({ tool: 'getManagementAttention', args: {} });
      return calls;
    },

    async synthesize(input) {
      // A value that already opens with the label is not prefixed by it again.
      const body = (e: { label: string; values: readonly string[] }) => (e.values.length === 0 ? e.label : e.values[0]!.toLowerCase().startsWith(e.label.toLowerCase()) ? e.values.join('; ') : `${e.label}: ${e.values.join('; ')}`);
      // A brief is a summary, not a dump: each section states its summary (when the evidence carries one) and its first entries
      // in KERNEL order — never the "most important" — and says how many more the pack holds.
      const CAP = 5;
      const bySection = new Map<string | null, typeof input.evidence[number][]>();
      for (const e of input.evidence) bySection.set(e.section, [...(bySection.get(e.section) ?? []), e]);
      const shown: (typeof input.evidence[number])[] = [];
      const omitted: string[] = [];
      for (const [sec, list] of bySection) {
        const summaries = list.filter((e) => e.status === 'SUMMARY');
        const details = list.filter((e) => e.status !== 'SUMMARY');
        shown.push(...summaries, ...details.slice(0, input.task === 'DRAFT_MANAGEMENT_BRIEF' ? CAP : details.length));
        if (input.task === 'DRAFT_MANAGEMENT_BRIEF' && details.length > CAP) omitted.push(`${sec ?? 'The pack'}: ${details.length - CAP} more entries are in the review pack, in kernel order — not the most important; they are not shown here.`);
      }
      const statements = shown.map((e) => ({
        text: clip(`${body(e)}${e.status && e.status !== 'SUMMARY' ? ` [${e.status}]` : ''}`),
        class: e.kind as OutputClass,
        evidenceIds: [e.id],
        section: e.section,
      }));
      const questions: string[] = [];
      for (const e of input.evidence) {
        if (e.kind === 'MANAGEMENT_ASSUMPTION' && /PENDING|UNCHECKED|OPEN/i.test(e.status ?? '')) questions.push(`What would confirm or disprove: ${clip(e.label, 90).replace(/[.?]+$/, '')}?`);
        if (e.kind === 'CAUSAL_CLAIM' && /HYPOTHESIS|CONTESTED|CHALLENGED/i.test(e.status ?? '')) questions.push(`What evidence would settle whether: ${clip(e.label, 90).replace(/[.?]+$/, '')}?`);
      }
      const unknowns = input.evidence.length === 0 ? ['The kernel returned no evidence for this request: HELM has nothing to say about it, and the AI will not invent it.'] : omitted;
      return { statements, questions: [...new Set(questions)].slice(0, 6), unknowns };
    },
  };
}

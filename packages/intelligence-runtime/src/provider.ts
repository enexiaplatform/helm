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
  /** The instant the ask is answered at, so "this quarter" names a period. Never a reason to call more tools. */
  readonly now?: string;
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
/** A capitalised word of three letters or more with no digit: a name, not "Q1" or "2027". */
const NAMES_SOMETHING = /(?:^|[\s"“(])\p{Lu}\p{L}{2,}/u;
/** The first word of a question is capitalised whatever it is; it names something only when it is not one of these. */
const OPENS_A_QUESTION = /^(which|what|how|who|whom|where|when|why|is|are|was|were|do|does|did|can|could|will|would|should|show|list|give|tell|find|top|compare|any|all|the|my|our|me|please|deal|deals|opportunities)\b/i;

const STAGE_WORDS = ['lead', 'discovery', 'qualification', 'technical discussion', 'proposal', 'negotiation', 'procurement'];

/**
 * The words of a pipeline question that name a filter or an order (audit 2026-10-13: "Which opportunities are in stage
 * Lost or Won?" came back with Discovery deals; "Top 5 largest deals" was refused). An order is only ever the one the
 * question asks for. A dimension HELM does not hold — a rep, a region, a segment, a margin — is said back as not
 * understood, never silently dropped.
 */
export function pipelineWords(q: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const states: string[] = [];
  if (/\blost\b|\bthua\b|đã mất|mất deal/.test(q)) states.push('LOST');
  if (/\bwon\b|\bthắng\b|đã thắng/.test(q)) states.push('WON');
  if (/on[\s-]?hold|tạm dừng/.test(q)) states.push('ON_HOLD');
  if (/\bopen\b|\bactive\b|đang mở|đang chạy/.test(q)) states.push('OPEN');
  if (states.length > 0) out['state'] = states.join(',');
  const stages = STAGE_WORDS.filter((w) => q.includes(w));
  if (stages.length > 0) out['stage'] = stages.join('|');
  const brand = q.match(/(?:brand|hãng)\s+([\p{L}\d&.-]{2,})/u);
  if (brand && !['is', 'are', 'of', 'the', 'nào'].includes(brand[1]!)) out['brand'] = brand[1];
  const top = q.match(/\btop\s*(\d{1,3})\b/) ?? q.match(/\b(\d{1,3})\s+(?:largest|biggest|highest|smallest|lowest)\b/) ?? q.match(/(\d{1,3})\s+(?:deal|cơ hội)[^?]*(?:lớn nhất|cao nhất)/);
  const wantsOrder = top || /largest|biggest|highest|smallest|lowest|lớn nhất|cao nhất|nhỏ nhất|thấp nhất|sorted by|sort by|order by|sắp xếp/.test(q);
  if (wantsOrder) {
    out['sortBy'] = /weighted|có trọng số/.test(q) ? 'weighted' : /probab|xác suất/.test(q) ? 'probability' : /close date|closing (?:soon|first)|sớm nhất/.test(q) ? 'close' : 'value';
    if (/smallest|lowest|nhỏ nhất|thấp nhất|soonest|sớm nhất/.test(q)) out['order'] = 'asc';
    out['limit'] = top ? Number(top[1]) : /largest|biggest|highest|lớn nhất|cao nhất|smallest|lowest|nhỏ nhất|thấp nhất/.test(q) ? 5 : undefined;
    if (out['limit'] === undefined) delete out['limit'];
  }
  const unknown = [
    /\b(rep|reps|owner|salesperson|account manager)\b|người phụ trách|nhân viên/.test(q) && 'a sales rep (HELM reads only your own deals)',
    /\bregion\b|\bvùng\b|miền/.test(q) && 'a region',
    /\bsegment\b|phân khúc|\bindustry\b|ngành/.test(q) && 'a segment',
    /\bmargin\b|biên lợi nhuận|lợi nhuận gộp/.test(q) && 'a margin (no cost is connected)',
    /\btarget\b|\bquota\b|chỉ tiêu/.test(q) && 'a target (none is recorded)',
    /last week|tuần trước|since monday/.test(q) && 'a change since last week',
    // Live audit 2026-10-16: "which deals have not moved for 30 days?" came back with every deal and no word of why.
    /not moved|not been touched|untouched|not touched|no activity|inactive|stale|idle|chưa (được )?(chạm|cập nhật)|không có hoạt động/.test(q) && 'time since the last touch (a touch date is read only where Memoire records one on the deal)',
    /this year|last year|năm nay|năm ngoái/.test(q) && 'a year (ask by quarter, for example 2026-Q3)',
  ].filter((x): x is string => typeof x === 'string');
  if (unknown.length > 0) out['notUnderstood'] = unknown.join('; ');
  return out;
}

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
      // A question about commitments, targets or what is waiting on management is a question about attention, whatever else it asks.
      // A deal's "risk" is a pipeline condition, not an attention one (audit 2026-10-13: "which deals are at risk this quarter?"
      // came back with nine authority and margin conditions).
      const aboutDeals = /pipeline|opportunit|deal|clos|customer|account|probab|forecast|revenue|sales|khách|cơ hội|doanh|chốt|xác suất/.test(q);
      want('getManagementAttention', aboutDeals ? /attention|matters|off.?track|commit|target|objective|behind|short of|decision|approv|breach|challeng|chú ý|quan trọng|cần làm|quyết định|mục tiêu/ : /attention|matters|off.?track|risk|issue|commit|target|objective|behind|short of|furthest|gap|decision|approv|breach|challeng|chú ý|quan trọng|cần làm|quyết định|mục tiêu/, {});
      want('getEnterpriseState', /state|now|current|where are we/, {});
      want('getCausalClaims', /caus|why|evidence|hypothes/, {});
      want('getGenomePatterns', /pattern|recurr|learn|lesson/, {});
      want('getSimilarEpisodes', /similar|before|seen this|precedent/, {});
      // A question about deals reads the pipeline itself (audit 2026-10-12: "which opportunities are at risk of not closing
      // this quarter?" read only attention, which held nothing). Words become NAMED conditions the answer states back —
      // a stated probability at most 25%, a close period — never a ranking of which deal is "most" at risk.
      if (has('getPipelinePositions') && /pipeline|opportunit|deal|clos|quarter|customer|account|probab|forecast|revenue|sales|stage|brand|won|lost|largest|biggest|top|khách|cơ hội|doanh|chốt|quý|xác suất|hãng|lớn nhất/.test(q)) {
        const args: Record<string, unknown> = { ...pipelineWords(q) };
        const explicit = q.match(/\b(20\d\d)[-\s]?q([1-4])\b/) ?? q.match(/\bq([1-4])[-\s/]?(20\d\d)\b/);
        if (explicit) args['closePeriod'] = explicit[1]!.length === 4 ? `${explicit[1]}-Q${explicit[2]}` : `${explicit[2]}-Q${explicit[1]}`;
        // A bare quarter ("due in Q4", "quý 4") is this year's, as Memoire's own bare quarters are read.
        else if ((q.match(/\bq([1-4])\b/) ?? q.match(/quý\s*([1-4])\b/)) && input.now) {
          const bare = (q.match(/\bq([1-4])\b/) ?? q.match(/quý\s*([1-4])\b/))!;
          args['closePeriod'] = `${new Date(input.now).getUTCFullYear()}-Q${bare[1]}`;
        } else if (/this quarter|current quarter|quý này/.test(q) && input.now) {
          const d = new Date(input.now);
          args['closePeriod'] = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        }
        if (/risk|not clos|unlikely|low probab|weak|slip|rủi ro|khó chốt/.test(q)) args['probabilityAtMost'] = 0.25;
        // A question about what will close, or what is at risk, is about open deals: a lost deal neither closes nor is at risk.
        if (!args['state'] && (args['closePeriod'] || args['probabilityAtMost'] !== undefined || /forecast|will close|going to close|dự báo|sẽ chốt/.test(q))) args['state'] = 'OPEN';
        if (/zero|value of 0|\b0 (sgd|vnd|usd)|giá trị 0|giá trị bằng 0/.test(q)) args['condition'] = 'ZERO_VALUE';
        else if (/no value|without a value|chưa có giá trị/.test(q)) args['condition'] = 'NO_VALUE';
        else if (/no probab|without a probab|chưa có xác suất/.test(q)) args['condition'] = 'NO_PROBABILITY';
        else if (/no (expected )?close|without a close|no close period|chưa có (kỳ|thời điểm) chốt/.test(q)) args['condition'] = 'NO_CLOSE_PERIOD';
        // The question may name a customer or a deal — a capitalised word past its first ("… with Rohto Vietnam?"); the
        // tool reads which names the state holds. A question that names nothing keeps exactly its named conditions.
        // The opening word counts too unless it only opens the question (live audit 2026-10-16: "Tailin deals due in Q4" lost Tailin).
        const asked = input.question.trim();
        if (NAMES_SOMETHING.test(OPENS_A_QUESTION.test(asked) ? asked.replace(/^\S+\s*/, '') : asked)) args['mentioning'] = input.question;
        calls.push({ tool: 'getPipelinePositions', args });
      }
      if (calls.length === 0) {
        // No word of the question routes it. It may still name a customer or a deal ("How is Rohto doing?"): read what
        // the state holds about that name — its pipeline and the conditions that name it — before the general attention.
        if (has('getPipelinePositions')) calls.push({ tool: 'getPipelinePositions', args: { mentioning: input.question, onlyIfMentioned: 'yes' } });
        if (has('getManagementAttention')) calls.push({ tool: 'getManagementAttention', args: { mentioning: input.question } });
      }
      return calls;
    },

    async synthesize(input) {
      // A value that already opens with the label is not prefixed by it again.
      const body = (e: { label: string; values: readonly string[] }) => (e.values.length === 0 ? e.label : e.values[0]!.toLowerCase().startsWith(e.label.toLowerCase()) ? e.values.join('; ') : `${e.label.replace(/[.:;]+$/, '')}: ${e.values.join('; ')}`);
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
      // The same sentence twice in one section says nothing more the second time: it is said once, citing both.
      const statements: { text: string; class: OutputClass; evidenceIds: string[]; section: string | null }[] = [];
      for (const e of shown) {
        const text = clip(`${body(e)}${e.status && e.status !== 'SUMMARY' ? ` [${e.status}]` : ''}`);
        const same = statements.find((x) => x.text === text && x.section === e.section && x.class === e.kind);
        if (same) same.evidenceIds.push(e.id);
        else statements.push({ text, class: e.kind as OutputClass, evidenceIds: [e.id], section: e.section });
      }
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

/**
 * Grounding: what a provider proposes is checked against what the tools returned.
 *
 * Pure, deterministic, provider-neutral. For every proposed statement:
 *
 *   - a class that claims kernel truth (source fact, model result, scenario, causal
 *     claim, counterfactual result, management assumption, management record)
 *     must cite evidence that exists in THIS run, of a kind that class may rest on;
 *   - a statement may not be promoted: cited as a source fact but resting on a model
 *     result, it is reclassified to what the evidence is; resting on mixed kinds, it
 *     is downgraded to inference;
 *   - every figure it quotes must appear in the evidence it cites — a number the
 *     kernel did not return is a fabricated number, and the statement is removed;
 *   - a causal claim keeps the status its evidence carries (a hypothesis is not
 *     stated as fact), a counterfactual stays an estimate, a model result is not a
 *     cause (Calculation Dependency ≠ Causality);
 *   - a suggestion is a question or a request for evidence — never a choice, an
 *     approval or a recommendation, and a recommendation anywhere is removed.
 *
 * Unsupported claims are removed, qualified or marked as inference; none passes as fact.
 */

import { fnv1a64 } from '@helm/shared';
import type { Draft, EvidenceItem, EvidenceKind, GroundedStatement, GroundingReport, OutputClass } from './types.ts';
import { evidenceKinds } from './types.ts';

/** Which evidence kinds a class may rest on. `primary` must be present; `also` may accompany it. */
const RULES: Partial<Record<OutputClass, { primary: readonly EvidenceKind[]; also: readonly EvidenceKind[] }>> = {
  SOURCE_FACT: { primary: ['SOURCE_FACT'], also: [] },
  MODEL_RESULT: { primary: ['MODEL_RESULT'], also: ['SOURCE_FACT'] },
  SCENARIO: { primary: ['SCENARIO'], also: ['MODEL_RESULT', 'SOURCE_FACT'] },
  CAUSAL_CLAIM: { primary: ['CAUSAL_CLAIM'], also: [] },
  COUNTERFACTUAL_RESULT: { primary: ['COUNTERFACTUAL_RESULT'], also: ['MODEL_RESULT', 'SOURCE_FACT', 'SCENARIO', 'MANAGEMENT_ASSUMPTION'] },
  MANAGEMENT_ASSUMPTION: { primary: ['MANAGEMENT_ASSUMPTION'], also: [] },
  MANAGEMENT_RECORD: { primary: ['MANAGEMENT_RECORD'], also: [] },
};

const isEvidenceClass = (c: OutputClass): boolean => (evidenceKinds as readonly string[]).includes(c);

/** HELM never recommends. A recommendation is removed wherever it appears. */
export const RECOMMENDATION = /\b(?:we|you|management|the (?:board|team))\s+(?:should|must|ought to|need to)\s+(?:choose|select|pick|approve|commit|adopt|go with|reject|proceed|expedite|reallocate)\b|\brecommend(?:s|ed|ation|ations)?\b|\b(?:the )?best (?:option|alternative|choice|scenario|decision)\b|\bwe suggest (?:that )?(?:you|management|we) (?:choose|approve|commit)\b|\bshould be approved\b|\bapprove (?:it|this|the)\b|\bcommit to\b/i;

const CAUSAL_VERBS = /\b(?:caused|causes|causing|because of|due to|as a result of|resulted from|was driven by|led to|leads to)\b/i;

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;
const norm = (s: string) => s.replace(/,/g, '').toLowerCase();

const SUGGESTION_OK = /\?\s*$|^(?:gather|ask|check|confirm|find out|request|obtain|collect|review the)\b/i;

/** Every figure quoted in `text`, normalised: digits, sign and decimal point. */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => norm(n)).filter((n) => n.length > 0);
}

export function groundDraft(draft: Draft, evidence: readonly EvidenceItem[]): { statements: readonly GroundedStatement[]; report: GroundingReport } {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const kept: GroundedStatement[] = [];
  const removals: { text: string; reason: string }[] = [];
  let reclassified = 0;
  let downgraded = 0;

  for (const s of draft.statements) {
    const text = String(s.text ?? '').trim();
    if (!text) {
      removals.push({ text: '(empty)', reason: 'An empty statement says nothing.' });
      continue;
    }
    if (RECOMMENDATION.test(text)) {
      removals.push({ text, reason: 'A recommendation. HELM shows evidence and trade-offs; management chooses.' });
      continue;
    }
    const cls = s.class;
    const section = s.section ?? null;
    const cited = (s.evidenceIds ?? []).map((id) => byId.get(id));
    const emit = (c: OutputClass, over: Partial<GroundedStatement> = {}) => kept.push({ text, class: c, evidenceIds: [...(s.evidenceIds ?? [])], section, qualified: false, reclassifiedFrom: null, note: null, ...over });
    const infer = (why: string) => {
      downgraded += 1;
      emit('AI_INFERENCE', { qualified: true, reclassifiedFrom: cls, note: why });
    };

    // ---- classes that carry no kernel claim
    if (cls === 'UNKNOWN') {
      emit('UNKNOWN');
      continue;
    }
    if (cls === 'SUGGESTION') {
      if (!SUGGESTION_OK.test(text)) removals.push({ text, reason: 'A suggestion is a question to ask or evidence to gather — not a choice.' });
      else emit('SUGGESTION');
      continue;
    }
    if (cls === 'AI_INFERENCE') {
      emit('AI_INFERENCE', { qualified: true, note: 'The model\'s own reading; not a kernel fact.' });
      continue;
    }
    if (!isEvidenceClass(cls)) {
      removals.push({ text, reason: `"${String(cls)}" is not an output class.` });
      continue;
    }

    // ---- classes that claim kernel truth
    if (cited.length === 0) {
      infer('It claimed kernel truth and cited no evidence.');
      continue;
    }
    if (cited.some((e) => e === undefined)) {
      infer('It cited evidence this run never retrieved.');
      continue;
    }
    const ev = cited as EvidenceItem[];
    const kinds = [...new Set(ev.map((e) => e.kind))];
    const rule = RULES[cls]!;
    const fits = rule.primary.some((k) => kinds.includes(k)) && kinds.every((k) => rule.primary.includes(k) || rule.also.includes(k));
    let finalClass: OutputClass = cls;
    let note: string | null = null;
    if (!fits) {
      if (kinds.length === 1) {
        // The evidence is one thing and the statement called it another: say what it is. Never up.
        finalClass = kinds[0]!;
        reclassified += 1;
        note = `Reclassified from ${cls}: the evidence it rests on is a ${kinds[0]}.`;
      } else {
        infer(`Its evidence mixes ${kinds.join(' and ')}, so it cannot be stated as ${cls}.`);
        continue;
      }
    }

    // ---- every figure must be one the evidence returned
    const corpus = norm(ev.map((e) => `${e.label} ${e.values.join(' ')} ${e.status ?? ''} ${e.ref.id}`).join(' '));
    const ungrounded = numbersIn(text).filter((n) => !corpus.includes(n));
    if (ungrounded.length > 0) {
      removals.push({ text, reason: `Figure(s) ${ungrounded.join(', ')} appear in no cited evidence: a number the kernel did not return is a fabricated number.` });
      continue;
    }

    // ---- no accidental promotion by wording
    if (finalClass === 'CAUSAL_CLAIM') {
      const statuses = ev.map((e) => e.status).filter((x): x is string => !!x);
      if (statuses.length > 0 && !statuses.some((st) => text.toLowerCase().includes(st.toLowerCase().replaceAll('_', ' ')) || text.toUpperCase().includes(st.toUpperCase()))) {
        infer(`A causal claim keeps the status its evidence carries (${[...new Set(statuses)].join(', ')}); this statement dropped it.`);
        continue;
      }
    }
    if (finalClass === 'COUNTERFACTUAL_RESULT' && !/estimate|model/i.test(text)) {
      infer('A counterfactual is a model estimate; this statement did not say so.');
      continue;
    }
    if ((finalClass === 'MODEL_RESULT' || finalClass === 'SCENARIO') && CAUSAL_VERBS.test(text)) {
      infer('A model result or a scenario is not a cause (a calculation is not causality).');
      continue;
    }
    if (finalClass === 'SOURCE_FACT' && /\bwill\b/i.test(text)) {
      infer('A source fact states what the source says now; a prediction is not one.');
      continue;
    }
    kept.push({ text, class: finalClass, evidenceIds: [...(s.evidenceIds ?? [])], section, qualified: finalClass !== cls, reclassifiedFrom: finalClass !== cls ? cls : null, note });
  }

  return {
    statements: kept,
    report: { proposed: draft.statements.length, kept: kept.length, reclassified, downgradedToInference: downgraded, removed: removals.length, removals },
  };
}

/** Questions are questions, and none of them is a recommendation in disguise. */
export function groundQuestions(qs: readonly string[] | undefined): string[] {
  return [...new Set((qs ?? []).map((q) => String(q).trim()).filter((q) => q.endsWith('?') && q.length > 8 && !RECOMMENDATION.test(q)))];
}

export const promptHash = (parts: unknown): string => `pmt_${fnv1a64(JSON.stringify(parts))}`;

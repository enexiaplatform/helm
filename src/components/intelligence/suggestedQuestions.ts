import type { TwinItem } from '@helm/twin-runtime';

/**
 * Questions a manager can ask with one click (audit 2026-10-12: an empty box asked them to guess what HELM can answer).
 * Each one is read by the reference router into a governed tool. They are questions about management — attention,
 * commitments, authority, what was learned — never about deals one by one: finding and sorting deals is Memoire's
 * (2026-10-16, docs/architecture/helm-vs-memoire.md). A question is offered only when the state holds what it asks
 * about; the order is the order below — nothing is ranked.
 */
export function suggestedQuestions(items: readonly TwinItem[]): readonly string[] {
  const has = (kind: TwinItem['kind']) => items.some((i) => i.kind === kind);
  const out = [
    'What needs my attention?',
    has('DECISION') && 'Which commitments are off track?',
    has('GOVERNANCE') && 'Which decisions are waiting on approval?',
    has('DECISION') && 'What have we learned from past decisions?',
    !has('DECISION') && 'What is the current state of the enterprise?',
  ].filter((x): x is string => typeof x === 'string');
  return out.slice(0, 4);
}

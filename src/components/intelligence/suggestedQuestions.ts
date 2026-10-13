import { closesIn, pipelineFacts, readPipeline, type TwinItem } from '@helm/twin-runtime';

/**
 * Questions a manager can ask with one click (audit 2026-10-12: an empty box asked them to guess what HELM can answer).
 * Each one is read by the reference router into a governed tool; the governed suite holds that true.
 */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  'Which deals are at risk this quarter?',
  'Which opportunities have a value of 0?',
  'Which opportunities have no probability?',
  'What needs my attention?',
];

const quarterOf = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

/** "2026-Q4", "Q4 2026" or "2026-11" → "2026-Q4"; anything else (a bare "Q4") names no quarter. */
const toQuarter = (p: string | null): string | null => {
  if (!p) return null;
  const q = p.trim().match(/^(\d{4})[-\s]?Q([1-4])$/i) ?? p.trim().match(/^Q([1-4])[-\s/]?(\d{4})$/i);
  if (q) return q[1]!.length === 4 ? `${q[1]}-Q${q[2]}` : `${q[2]}-Q${q[1]}`;
  const m = p.trim().match(/^(\d{4})-(\d{1,2})$/);
  return m ? `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}` : null;
};

/**
 * The questions offered are ones this state can answer (audit 2026-10-13: the first suggestion, "at risk this quarter",
 * read a quarter none of the demo's deals closes in and came back empty). A quarter is named when the state's own
 * quarter holds no deal; a customer is named from the state; a gap is offered only when the data has it. The order
 * is the order of the checks below — nothing is ranked.
 */
export function suggestedQuestions(items: readonly TwinItem[], now: string): readonly string[] {
  const rows = readPipeline(items);
  if (rows.length === 0) return ['What needs my attention?', 'What changed since the last review?'];
  const f = pipelineFacts(rows);
  const here = quarterOf(now);
  const quarter = rows.some((r) => closesIn(r.expectedClosePeriod, here) === 'YES') ? 'this quarter' : rows.map((r) => toQuarter(r.expectedClosePeriod)).find((q) => q !== null) ?? null;
  const customer = rows.find((r) => r.customer)?.customer ?? null;
  const out = [
    quarter && `Which deals close ${quarter === 'this quarter' ? quarter : `in ${quarter}`}?`,
    customer && `What is open with ${customer}?`,
    f.zeroValue > 0 && 'Which opportunities have a value of 0?',
    f.noProbability > 0 && 'Which opportunities have no probability?',
    f.noClosePeriod > 0 && 'Which opportunities have no close period?',
    'What needs my attention?',
  ].filter((q): q is string => typeof q === 'string');
  return out.slice(0, 4);
}

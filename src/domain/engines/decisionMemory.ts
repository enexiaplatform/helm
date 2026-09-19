import type { Decision } from '../types.ts';

/**
 * Decision-memory engine: deterministic pattern detection over closed
 * decisions. This is the seed of the long-term moat — the system noticing
 * that an organization's decisions err in consistent directions.
 */

export type DecisionPattern = {
  code: string;
  title: string;
  detail: string;
  /** Ids of the closed decisions supporting the pattern. */
  evidenceDecisionIds: string[];
};

const MIN_SAMPLE = 3;

export function detectPatterns(decisions: Decision[]): DecisionPattern[] {
  const closed = decisions.filter((d) => d.status === 'closed' && d.outcomeScore !== null);
  const patterns: DecisionPattern[] = [];

  // Systematic optimism/pessimism by decision type.
  const byType = new Map<string, Decision[]>();
  for (const d of closed) {
    const list = byType.get(d.decisionType) ?? [];
    list.push(d);
    byType.set(d.decisionType, list);
  }
  for (const [type, list] of byType) {
    if (list.length < MIN_SAMPLE) continue;
    const worse = list.filter((d) => d.outcomeScore === 'worse');
    const better = list.filter((d) => d.outcomeScore === 'better');
    if (worse.length / list.length >= 2 / 3) {
      patterns.push({
        code: 'MEM-OPTIMISM',
        title: `${type.replace(/_/g, ' ')} decisions systematically under-deliver`,
        detail:
          `${worse.length} of ${list.length} closed ${type.replace(/_/g, ' ')} decisions came in worse than ` +
          `expected. Expected outcomes in this category deserve a haircut, or their assumptions deserve ` +
          `harder validation before approval.`,
        evidenceDecisionIds: worse.map((d) => d.id),
      });
    }
    if (better.length / list.length >= 2 / 3) {
      patterns.push({
        code: 'MEM-SANDBAG',
        title: `${type.replace(/_/g, ' ')} decisions systematically over-deliver`,
        detail:
          `${better.length} of ${list.length} closed ${type.replace(/_/g, ' ')} decisions beat expectations. ` +
          `Targets in this category may be set too conservatively, hiding capacity for bolder allocation.`,
        evidenceDecisionIds: better.map((d) => d.id),
      });
    }
  }

  // Assumption-quality pattern: lessons repeatedly blaming forecasts.
  const forecastMentions = closed.filter((d) => /forecast|demand estimate|optimistic/i.test(d.lesson));
  if (forecastMentions.length >= MIN_SAMPLE) {
    patterns.push({
      code: 'MEM-FORECAST',
      title: 'Forecast quality keeps appearing in lessons learned',
      detail:
        `${forecastMentions.length} closed decisions cite forecast or demand-estimate problems in their ` +
        `lessons. Demand assumptions should be treated as high-sensitivity by default and stress-tested ` +
        `in scenarios before approval.`,
      evidenceDecisionIds: forecastMentions.map((d) => d.id),
    });
  }

  return patterns;
}

export type OutcomeLedgerRow = {
  decisionId: string;
  title: string;
  decisionType: Decision['decisionType'];
  closedAt: string | null;
  expectedOutcome: string;
  actualOutcome: string;
  outcomeScore: NonNullable<Decision['outcomeScore']> | null;
  lesson: string;
};

export function buildOutcomeLedger(decisions: Decision[]): OutcomeLedgerRow[] {
  return decisions
    .filter((d) => d.status === 'closed')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    .map((d) => ({
      decisionId: d.id,
      title: d.title,
      decisionType: d.decisionType,
      closedAt: d.closedAt,
      expectedOutcome: d.expectedOutcome,
      actualOutcome: d.actualOutcome,
      outcomeScore: d.outcomeScore,
      lesson: d.lesson,
    }));
}

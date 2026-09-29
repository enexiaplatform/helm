/**
 * The authority evaluation fingerprint.
 *
 * One deterministic identity for "this judgement, of this commitment, under
 * this authority". It is built from the commitment fingerprint it judged, the
 * act and the actor, the act time, the decision type, the policy versions in
 * force, the scope HELM derived, the consequence values it read, how every
 * rule came out, and the verdict with its required authorities — and nothing
 * else. Two evaluations of the same commitment under the same authority carry
 * the same fingerprint; a different policy version, a different value or a
 * different commitment never does.
 */

import { fnv1a64, periodKey } from '@helm/shared';
import type { EvaluationDraft } from './engine.ts';

export function evaluationFingerprint(input: { commitmentFingerprint: string } & EvaluationDraft): string {
  const lines: string[] = [
    'helm-authority-evaluation/v1',
    `commitment=${input.commitmentFingerprint}`,
    `act=${input.act}`,
    `actor=${input.actorUserId ?? ''}`,
    `at=${new Date(input.actAt).toISOString()}`,
    `type=${input.decisionTypeKey ?? ''}`,
    `result=${input.result}`,
    `basis=${input.basisRuleId ?? ''}|${input.basisDelegationId ?? ''}`,
  ];
  lines.push(...input.actorRoles.map((r) => `role|${r.roleId}|${r.kind}`).sort());
  lines.push(...input.policies.map((p) => `policy|${p.policyId}|${p.key}|${p.version}`).sort());
  lines.push(
    ...input.scope.touched
      .map((t) =>
        [
          'touch',
          t.entityId,
          t.origin,
          ...Object.entries(t.coordinates)
            .map(([d, refs]) => `${d}:${(refs ?? []).map((r) => r.entityId).sort().join('+')}`)
            .sort(),
        ].join('|'),
      )
      .sort(),
  );
  lines.push(
    ...input.consequences
      .map((c) => ['value', c.metricKey, c.nodeId ?? '', c.runId ?? '', c.period ? periodKey(c.period) : '', c.value ?? '', c.unit ?? '', c.currency ?? ''].join('|'))
      .sort(),
  );
  lines.push(...input.rules.map((r) => `rule|${r.ruleId}|${r.outcome}|${r.deciding ? 'D' : ''}`).sort());
  lines.push(...input.delegations.map((d) => `delegation|${d.delegationId}|${d.outcome}`).sort());
  lines.push(
    ...input.requiredAuthorities
      .map((r) => `requires|${r.roleId}|${r.kind}|${r.sequence}|${r.basisRuleId}|${r.independentOfUserId ?? ''}`)
      .sort(),
  );
  lines.push(...input.gaps.map((g) => `gap|${g.code}|${g.blocking ? 'B' : ''}`).sort());
  const text = lines.join('\n');
  return `aev_${fnv1a64(text)}_${text.length}`;
}

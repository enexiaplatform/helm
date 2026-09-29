/**
 * The CausalGraph runtime (ADR-0026).
 *
 * Every read takes a lens. What is returned is reconstructed from the records
 * KNOWN at the lens's knowledge boundary (recordedThrough): the claim as it was
 * then worded, the evidence linked by then, each piece of evidence as it stood
 * after the corrections made by then. Evidence learned later never rewrites
 * what management believed earlier. The lens's business time says whether the
 * claim's applicable period covers the moment asked about.
 *
 * What this runtime never does:
 *   - create a claim, a link or a candidate on its own initiative — from a
 *     calculation dependency, a correlation, a twin delta or a coincidence;
 *   - count a calculation dependency as evidence (modelDependency is reported
 *     beside a claim, never inside its evaluation);
 *   - call a write method of any lower layer: a causal claim does not change a
 *     formula, a propagation or a scenario output (verify:causal-vs-calculation);
 *   - score, average, multiply or rank.
 */

import { fail, ok, type Clock, type Result, type Scope } from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { ValueMetricRegistry } from '@helm/value-graph';
import type { CalculationRegistry } from '@helm/propagation-engine';
import { DIMENSION_OF_ENTITY_TYPE, canSeeDecision } from '@helm/authority-runtime';
import { isCleared, readStructure, sensitivityClasses, sensitivityOfMetric, type SensitivityClass, type StructureView } from '@helm/twin-runtime';
import { CAUSAL_EVIDENCE_POLICY, assess, decide } from './policy.ts';
import { applicabilityOf } from './scope.ts';
import type {
  Applicability,
  CandidateView,
  CausalGraph,
  CausalPath,
  CausalStore,
  ClaimExplanation,
  ClaimView,
  CreateClaimInput,
  ModelDependency,
  NewRevision,
  RecordEvidenceInput,
  Traversal,
  TraversalEdge,
} from './port.ts';
import {
  CausalErrors,
  QUALIFYING_TYPES,
  evidenceStances,
  evidenceTypes,
  relationshipTypes,
  strengthLevels,
  variableKinds,
  type CausalClaim,
  type CausalEvidence,
  type CausalLens,
  type CausalQuestion,
  type CausalScope,
  type CausalVariable,
  type ClaimEvaluation,
  type ClaimRevision,
  type ClaimStatus,
  type CorrelationFinding,
  type EvidenceLink,
  type KernelRef,
  type QuestionCandidate,
} from './types.ts';

export type CausalGraphOptions = {
  store: CausalStore;
  graph: GraphStore;
  metrics: ValueMetricRegistry;
  /** Read only: to REPORT known value dependencies beside claims. Never written. */
  calculations: CalculationRegistry;
  clock: Clock;
};

type Records = {
  variables: readonly CausalVariable[];
  claims: readonly CausalClaim[];
  revisions: readonly ClaimRevision[];
  evidence: readonly CausalEvidence[];
  links: readonly EvidenceLink[];
  correlations: readonly CorrelationFinding[];
  questions: readonly CausalQuestion[];
  candidates: readonly QuestionCandidate[];
};

const ms = (t: string) => Date.parse(t);
const known = <T extends { recordedAt: string }>(xs: readonly T[], T: number): T[] => xs.filter((x) => ms(x.recordedAt) <= T);
const invalid = (msg: string) => fail(CausalErrors.INVALID, msg);
const MAX_DEPTH = 8;

/** The version of an evidence item in force at the boundary: follow its corrections. */
function headOf(e: CausalEvidence, evidenceAtT: readonly CausalEvidence[]): CausalEvidence {
  let head = e;
  for (let guard = 0; guard < 64; guard += 1) {
    const next = evidenceAtT.find((x) => x.supersedesId === head.id);
    if (!next) break;
    head = next;
  }
  return head;
}

function inPeriod(period: { from: string | null; to: string | null }, at: string): boolean {
  const t = ms(at);
  return (period.from === null || ms(period.from) <= t) && (period.to === null || t < ms(period.to));
}

export function evaluateAt(claim: CausalClaim, r: Records, lens: CausalLens): ClaimEvaluation {
  const T = ms(lens.recordedThrough);
  const revisions = known(r.revisions, T).filter((x) => x.claimId === claim.id).sort((a, b) => a.revision - b.revision);
  const latest = revisions[revisions.length - 1];
  const evidenceAtT = known(r.evidence, T);
  const links = known(r.links, T)
    .filter((l) => l.claimId === claim.id)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
  const assessments = links.flatMap((l) => {
    const original = evidenceAtT.find((e) => e.id === l.evidenceId);
    return original ? [assess(l, headOf(original, evidenceAtT))] : [];
  });
  const { status, confidence, reasons } = decide(assessments, { retired: latest?.retired ?? false, reason: latest?.retirementReason ?? null });
  const applicableAtEffective = inPeriod(claim.applicablePeriod, lens.effectiveAsOf);
  const allReasons = applicableAtEffective
    ? reasons
    : [...reasons, `The claim is about ${claim.applicablePeriod.from ?? '…'} – ${claim.applicablePeriod.to ?? '…'}; ${lens.effectiveAsOf} is outside that period.`];
  return {
    claimId: claim.id,
    lens,
    policy: CAUSAL_EVIDENCE_POLICY,
    status,
    confidence,
    reasons: allReasons,
    assessments,
    counts: {
      supporting: assessments.filter((a) => a.countedAs === 'SUPPORT').length,
      challenging: assessments.filter((a) => a.countedAs === 'CHALLENGE').length,
      contradicting: assessments.filter((a) => a.countedAs === 'CONTRADICTION').length,
      contextual: assessments.filter((a) => a.countedAs === 'CONTEXT').length,
    },
    temporalConflicts: assessments.filter((a) => a.temporal === 'TEMPORAL_CONFLICT').length,
    applicableAtEffective,
  };
}

const STATUS_ORDER: readonly ClaimStatus[] = ['REFUTED', 'RETIRED', 'WEAKENED', 'CONTESTED', 'UNRESOLVED', 'HYPOTHESIS', 'SUPPORTED'];

export function createCausalGraph(opts: CausalGraphOptions): CausalGraph {
  const { store, clock } = opts;

  const currentLens = (): CausalLens => {
    const n = clock.now().toISOString();
    return { effectiveAsOf: n, recordedThrough: n };
  };
  const checkLens = (lens: CausalLens | undefined): Result<CausalLens> => {
    const l = lens ?? currentLens();
    if (Number.isNaN(ms(l.effectiveAsOf)) || Number.isNaN(ms(l.recordedThrough))) return invalid('A lens states effectiveAsOf and recordedThrough as instants.');
    if (ms(l.recordedThrough) > clock.now().getTime()) {
      return fail(CausalErrors.KNOWLEDGE_IN_FUTURE, 'A causal view cannot know what has not been recorded yet: recordedThrough is in the future.');
    }
    return ok(l);
  };

  async function load(scope: Scope): Promise<Result<Records>> {
    const [variables, claims, revisions, evidence, links, correlations, questions, candidates] = await Promise.all([
      store.listVariables(scope),
      store.listClaims(scope),
      store.listRevisions(scope),
      store.listEvidence(scope),
      store.listLinks(scope),
      store.listCorrelations(scope),
      store.listQuestions(scope),
      store.listCandidates(scope),
    ]);
    for (const x of [variables, claims, revisions, evidence, links, correlations, questions, candidates]) if (!x.ok) return x;
    return ok({
      variables: variables.ok ? variables.value : [],
      claims: claims.ok ? claims.value : [],
      revisions: revisions.ok ? revisions.value : [],
      evidence: evidence.ok ? evidence.value : [],
      links: links.ok ? links.value : [],
      correlations: correlations.ok ? correlations.value : [],
      questions: questions.ok ? questions.value : [],
      candidates: candidates.ok ? candidates.value : [],
    });
  }

  function viewOf(claim: CausalClaim, r: Records, lens: CausalLens): Result<ClaimView> {
    const T = ms(lens.recordedThrough);
    if (ms(claim.recordedAt) > T) {
      return fail(CausalErrors.NOT_KNOWN_AT_LENS, `This claim was first recorded on ${claim.recordedAt}, after the knowledge boundary ${lens.recordedThrough}.`);
    }
    const revs = known(r.revisions, T).filter((x) => x.claimId === claim.id).sort((a, b) => a.revision - b.revision);
    const cause = r.variables.find((v) => v.key === claim.causeKey);
    const effect = r.variables.find((v) => v.key === claim.effectKey);
    if (!cause || !effect || revs.length === 0) return fail(CausalErrors.NOT_FOUND, 'The claim is incomplete in this organization.');
    return ok({ claim, revision: revs[revs.length - 1], cause, effect, evaluation: evaluateAt(claim, r, lens) });
  }

  function viewsAt(r: Records, lens: CausalLens): ClaimView[] {
    const T = ms(lens.recordedThrough);
    return known(r.claims, T)
      .map((c) => viewOf(c, r, lens))
      .flatMap((v) => (v.ok ? [v.value] : []))
      .sort((a, b) => a.claim.recordedAt.localeCompare(b.claim.recordedAt) || a.claim.id.localeCompare(b.claim.id));
  }

  async function claimView(scope: Scope, id: string, lens?: CausalLens): Promise<Result<ClaimView>> {
    const l = checkLens(lens);
    if (!l.ok) return l;
    const r = await load(scope);
    if (!r.ok) return r;
    const claim = r.value.claims.find((c) => c.id === id);
    if (!claim) return fail(CausalErrors.NOT_FOUND, 'No such claim in this organization.');
    return viewOf(claim, r.value, l.value);
  }

  // A causal scope is checked against the structure; anchors carry their dimension.
  async function checkScope(scope: Scope, s: CausalScope): Promise<Result<CausalScope>> {
    if (s.kind === 'ENTERPRISE_WIDE') {
      if (!s.justification || s.justification.trim().length < 12) {
        return fail(CausalErrors.UNSCOPED, 'An enterprise-wide claim must say why it holds everywhere. Claims are scoped by default.');
      }
      return ok(s);
    }
    if (!Array.isArray(s.anchors) || s.anchors.length === 0) {
      return fail(CausalErrors.UNSCOPED, 'A causal claim names where it holds (a country, business unit, customer, product …). Nothing is global by default.');
    }
    const anchors = [];
    for (const a of s.anchors) {
      const e = await opts.graph.getEntity(scope, a.entityId as never);
      if (!e.ok) return e;
      if (!e.value) return invalid(`The scope names ${a.label}, which is not an entity of this organization.`);
      anchors.push({ entityId: e.value.id, label: a.label || e.value.name, dimension: DIMENSION_OF_ENTITY_TYPE[e.value.entityTypeKey] ?? e.value.entityTypeKey.toUpperCase() });
    }
    return ok({ kind: 'ANCHORED', anchors });
  }

  const checkClass = (c: unknown): c is SensitivityClass => (sensitivityClasses as readonly string[]).includes(c as string);

  function modelDependencyOf(from: CausalVariable, to: CausalVariable): ModelDependency | null {
    if (from.kind !== 'METRIC' || to.kind !== 'METRIC' || !from.metricKey || !to.metricKey) return null;
    // Breadth-first over the calculation graph, from the effect's metric back through its inputs.
    type Step = { metric: string; chain: string[] };
    let frontier: Step[] = [{ metric: to.metricKey, chain: [] }];
    const seen = new Set<string>([to.metricKey]);
    for (let depth = 0; depth < 6 && frontier.length > 0; depth += 1) {
      const next: Step[] = [];
      for (const s of frontier) {
        for (const calc of opts.calculations.findByOutputMetric(s.metric)) {
          const label = `${calc.key}@${calc.version}`;
          for (const input of calc.inputs) {
            const chain = [label, ...s.chain];
            if (input.metricKey === from.metricKey) {
              return {
                kind: 'KNOWN_VALUE_DEPENDENCY',
                fromMetricKey: from.metricKey,
                toMetricKey: to.metricKey,
                calculations: chain,
                statement:
                  `In HELM's model, ${from.label} is an input of ${chain.join(' → ')}, which computes ${to.label}. ` +
                  'That is arithmetic inside the model. It is not evidence that one influences the other in the world, ' +
                  'and it does not count towards any causal claim.',
              };
            }
            if (!seen.has(input.metricKey)) {
              seen.add(input.metricKey);
              next.push({ metric: input.metricKey, chain });
            }
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  async function evidenceInput(scope: Scope, input: RecordEvidenceInput, supersedesId: string | null): Promise<Result<Omit<CausalEvidence, 'id' | 'orgId' | 'recordedAt'>>> {
    if (!(evidenceTypes as readonly string[]).includes(input.type)) return invalid(`Unknown evidence type "${input.type}".`);
    if (!(strengthLevels as readonly string[]).includes(input.assessedStrength)) return invalid('Evidence strength is LOW, MEDIUM or HIGH.');
    if (!input.statement?.trim()) return invalid('Evidence states what it shows.');
    if (!input.strengthRationale?.trim()) return invalid('Evidence says why it was graded as it was.');
    const p = input.provenance;
    if (!p || !p.sourceSystem?.trim() || !p.sourceReference?.trim() || !p.assertedByLabel?.trim()) {
      return invalid('Evidence answers where it came from (source system and reference) and who asserted it.');
    }
    if (input.type === 'MANAGEMENT_EXPERTISE' && p.method !== 'JUDGEMENT') {
      return invalid('Management expertise is recorded as JUDGEMENT: a person\'s view is never presented as a measurement.');
    }
    if (p.method === 'JUDGEMENT' && input.type !== 'MANAGEMENT_EXPERTISE') {
      return invalid('A judgement is MANAGEMENT_EXPERTISE evidence, whatever it is about.');
    }
    for (const t of [input.causeObservedAt, input.effectObservedAt]) if (t && Number.isNaN(ms(t))) return invalid('Observation times are instants.');
    const sensitivity = input.sensitivity ?? 'GENERAL_MANAGEMENT';
    if (!checkClass(sensitivity)) return invalid(`Unknown sensitivity class "${sensitivity}".`);
    return ok({
      type: input.type,
      statement: input.statement.trim(),
      assessedStrength: input.assessedStrength,
      strengthRationale: input.strengthRationale.trim(),
      provenance: {
        sourceSystem: p.sourceSystem,
        sourceReference: p.sourceReference,
        method: p.method,
        assertedBy: (p.assertedBy ?? scope.actorId) as never,
        assertedByLabel: p.assertedByLabel,
        assertedRole: p.assertedRole ?? null,
      },
      causeObservedAt: input.causeObservedAt ?? null,
      effectObservedAt: input.effectObservedAt ?? null,
      statistical: input.statistical ?? null,
      correlationFindingId: input.correlationFindingId ?? null,
      refs: input.refs ?? [],
      sensitivity,
      supersedesId,
      recordedBy: scope.actorId,
    });
  }

  async function traverseImpl(scope: Scope, input: { from: string; direction: 'UPSTREAM' | 'DOWNSTREAM'; maxDepth: number; lens?: CausalLens }): Promise<Result<Traversal>> {
    if (!Number.isInteger(input.maxDepth) || input.maxDepth < 1 || input.maxDepth > MAX_DEPTH) {
      return fail(CausalErrors.TRAVERSAL_UNBOUNDED, `Causal traversal needs an explicit maxDepth between 1 and ${MAX_DEPTH}: the causal graph may contain feedback loops.`);
    }
    const l = checkLens(input.lens);
    if (!l.ok) return l;
    const r = await load(scope);
    if (!r.ok) return r;
    const views = viewsAt(r.value, l.value);
    if (!r.value.variables.some((v) => v.key === input.from)) return fail(CausalErrors.NOT_FOUND, `No causal variable "${input.from}".`);
    const reached = new Map<string, number>([[input.from, 0]]);
    const edges: TraversalEdge[] = [];
    let frontier = [input.from];
    let truncated = false;
    let cycles = 0;
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const key of frontier) {
        const out = views.filter((v) => (input.direction === 'DOWNSTREAM' ? v.claim.causeKey === key : v.claim.effectKey === key));
        if (depth > input.maxDepth) {
          if (out.length > 0) truncated = true;
          continue;
        }
        for (const v of out) {
          const other = input.direction === 'DOWNSTREAM' ? v.claim.effectKey : v.claim.causeKey;
          const closesCycle = reached.has(other);
          if (closesCycle) cycles += 1;
          edges.push({
            claimId: v.claim.id,
            from: v.claim.causeKey,
            to: v.claim.effectKey,
            relationshipType: v.claim.relationshipType,
            status: v.evaluation.status,
            confidence: v.evaluation.confidence,
            depth,
            closesCycle,
          });
          if (!closesCycle) {
            reached.set(other, depth);
            next.push(other);
          }
        }
      }
      if (depth > input.maxDepth) break;
      frontier = next;
    }
    return ok({
      from: input.from,
      direction: input.direction,
      maxDepth: input.maxDepth,
      variables: [...reached].map(([key, depth]) => ({ key, depth })),
      edges,
      truncated,
      cycles,
    });
  }

  const self: CausalGraph = {
    async defineVariable(scope, input) {
      if (!/^[A-Z][A-Z0-9_]{1,62}$/.test(input.key ?? '')) return invalid('A causal variable key is UPPER_SNAKE_CASE.');
      if (!(variableKinds as readonly string[]).includes(input.kind)) return invalid(`Unknown variable kind "${input.kind}".`);
      if (!input.label?.trim()) return invalid('A causal variable has a label.');
      let sensitivity: SensitivityClass = input.sensitivity ?? 'GENERAL_MANAGEMENT';
      if (input.kind === 'METRIC') {
        const metric = input.metricKey ? opts.metrics.metric(input.metricKey) : null;
        if (!metric) return invalid('A METRIC variable names a value metric that exists.');
        sensitivity = input.sensitivity ?? sensitivityOfMetric(metric.key);
      } else if (input.metricKey) {
        return invalid('Only a METRIC variable is bound to a value metric.');
      }
      if (!checkClass(sensitivity)) return invalid(`Unknown sensitivity class "${sensitivity}".`);
      return store.insertVariable(scope, {
        key: input.key,
        label: input.label.trim(),
        kind: input.kind,
        metricKey: input.kind === 'METRIC' ? input.metricKey! : null,
        description: input.description ?? '',
        sensitivity,
        refs: input.refs ?? [],
        recordedBy: scope.actorId,
      });
    },
    listVariables: (scope) => store.listVariables(scope),

    async createClaim(scope, input: CreateClaimInput) {
      if (!(relationshipTypes as readonly string[]).includes(input.relationshipType)) {
        return invalid(`Unknown relationship "${input.relationshipType}". The vocabulary is ${relationshipTypes.join(', ')}; there is no unconditional CAUSES.`);
      }
      const qualifying = QUALIFYING_TYPES.includes(input.relationshipType);
      if (qualifying && !input.targetClaimId) return invalid(`A ${input.relationshipType} claim names the claim it qualifies.`);
      if (!qualifying && input.targetClaimId) return invalid('Only a MEDIATES or MODERATES claim qualifies another claim.');
      if (input.causeKey === input.effectKey) return invalid('A claim relates two different variables.');
      if (!input.statement?.trim() || !input.rationale?.trim() || !input.authoredByLabel?.trim()) {
        return invalid('A claim is stated, says why its author holds it, and names its author.');
      }
      const s = await checkScope(scope, input.scope);
      if (!s.ok) return s;
      const period = input.applicablePeriod ?? { from: null, to: null };
      if (period.from && period.to && ms(period.from) >= ms(period.to)) return invalid('An applicable period ends after it starts.');
      const sensitivity = input.sensitivity ?? 'GENERAL_MANAGEMENT';
      if (!checkClass(sensitivity)) return invalid(`Unknown sensitivity class "${sensitivity}".`);
      const variables = await store.listVariables(scope);
      if (!variables.ok) return variables;
      for (const k of [input.causeKey, input.effectKey, ...(input.mechanism ?? []).flatMap((m) => (m.variableKey ? [m.variableKey] : [])), ...(input.confounders ?? []).map((c) => c.variableKey)]) {
        if (!variables.value.some((v) => v.key === k)) return invalid(`"${k}" is not a causal variable of this organization; define it first.`);
      }
      const created = await store.insertClaim(
        scope,
        {
          causeKey: input.causeKey,
          effectKey: input.effectKey,
          relationshipType: input.relationshipType,
          targetClaimId: input.targetClaimId ?? null,
          scope: s.value,
          conditions: (input.conditions ?? []).map((c) => ({ statement: c.statement, refs: c.refs ?? [] })),
          applicablePeriod: { from: period.from ?? null, to: period.to ?? null },
          sensitivity,
          visibility: input.visibility ?? 'ORG_WIDE',
          grantedUnitIds: [...(input.grantedUnitIds ?? [])].sort(),
          authoredBy: scope.actorId,
          authoredByLabel: input.authoredByLabel,
        },
        {
          statement: input.statement.trim(),
          mechanism: input.mechanism ?? [],
          confounders: input.confounders ?? [],
          rationale: input.rationale.trim(),
          externalValidity: input.externalValidity ?? 'Supported, if at all, only in this scope; external validity unknown.',
          links: input.links ?? [],
          retired: false,
          retirementReason: null,
          recordedBy: scope.actorId,
        },
      );
      if (!created.ok) return created;
      return claimView(scope, created.value.claim.id);
    },

    async reviseClaim(scope, claimId, input) {
      const current = await claimView(scope, claimId);
      if (!current.ok) return current;
      const prev = current.value.revision;
      const next: NewRevision = {
        statement: input.statement ?? prev.statement,
        mechanism: input.mechanism ?? prev.mechanism,
        confounders: input.confounders ?? prev.confounders,
        rationale: input.rationale ?? prev.rationale,
        externalValidity: input.externalValidity ?? prev.externalValidity,
        links: input.links ?? prev.links,
        retired: false,
        retirementReason: null,
        recordedBy: scope.actorId,
      };
      const r = await store.insertRevision(scope, claimId, next);
      if (!r.ok) return r;
      return claimView(scope, claimId);
    },

    async retireClaim(scope, claimId, reason) {
      if (!reason?.trim()) return invalid('Retiring a claim says why.');
      const current = await claimView(scope, claimId);
      if (!current.ok) return current;
      if (scope.role !== 'admin' && current.value.claim.authoredBy !== scope.actorId) {
        return fail(CausalErrors.FORBIDDEN, "Only the claim's author or an organization admin retires a claim; anyone may challenge it with evidence.");
      }
      const prev = current.value.revision;
      const r = await store.insertRevision(scope, claimId, { ...prev, retired: true, retirementReason: reason.trim(), recordedBy: scope.actorId });
      if (!r.ok) return r;
      return claimView(scope, claimId);
    },

    async recordEvidence(scope, input) {
      const e = await evidenceInput(scope, input, null);
      return e.ok ? store.insertEvidence(scope, e.value) : e;
    },
    async correctEvidence(scope, evidenceId, input) {
      const e = await evidenceInput(scope, input, evidenceId);
      return e.ok ? store.insertEvidence(scope, e.value) : e;
    },
    async linkEvidence(scope, claimId, evidenceId, stance, rationale) {
      if (!(evidenceStances as readonly string[]).includes(stance)) return invalid(`Unknown stance "${stance}".`);
      if (!rationale?.trim()) return invalid('Linking evidence says why it bears on the claim.');
      const l = await store.insertLink(scope, { claimId, evidenceId, stance, rationale: rationale.trim(), linkedBy: scope.actorId });
      if (!l.ok) return l;
      return claimView(scope, claimId);
    },
    supportClaim: (scope, claimId, evidenceId, rationale) => self.linkEvidence(scope, claimId, evidenceId, 'SUPPORTS', rationale),
    challengeClaim: (scope, claimId, evidenceId, rationale) => self.linkEvidence(scope, claimId, evidenceId, 'CHALLENGES', rationale),

    async recordCorrelation(scope, input) {
      for (const k of ['method', 'population', 'period', 'effectEstimate', 'uncertainty', 'limitations'] as const) {
        if (!input[k]?.trim()) return invalid(`A correlation finding states its ${k}.`);
      }
      const s = await checkScope(scope, input.scope);
      if (!s.ok) return s;
      return store.insertCorrelation(scope, {
        ...input,
        scope: s.value,
        refs: input.refs ?? [],
        sensitivity: input.sensitivity ?? 'GENERAL_MANAGEMENT',
        recordedBy: scope.actorId,
      });
    },
    listCorrelations: (scope) => store.listCorrelations(scope),

    async askQuestion(scope, input) {
      if (!input.statement?.trim()) return invalid('A causal question is stated.');
      const s = await checkScope(scope, input.scope);
      if (!s.ok) return s;
      return store.insertQuestion(scope, {
        statement: input.statement.trim(),
        target: {
          variableKey: input.target.variableKey,
          metricKey: input.target.metricKey ?? null,
          nodeId: input.target.nodeId ?? null,
          fromSnapshotId: input.target.fromSnapshotId ?? null,
          toSnapshotId: input.target.toSnapshotId ?? null,
          itemKey: input.target.itemKey ?? null,
          observedChange: input.target.observedChange ?? null,
          unit: input.target.unit ?? null,
        },
        scope: s.value,
        period: input.period ?? { from: null, to: null },
        grantedUnitIds: [...(input.grantedUnitIds ?? [])].sort(),
        askedBy: scope.actorId,
      });
    },
    async proposeCandidate(scope, questionId, claimId, rationale) {
      if (!rationale?.trim()) return invalid('Proposing an explanation says why it might explain the change.');
      return store.insertCandidate(scope, { questionId, claimId, rationale: rationale.trim(), proposedBy: scope.actorId });
    },
    listQuestions: (scope) => store.listQuestions(scope),

    async investigate(scope, questionId, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const r = await load(scope);
      if (!r.ok) return r;
      const T = ms(l.value.recordedThrough);
      const question = r.value.questions.find((q) => q.id === questionId);
      if (!question) return fail(CausalErrors.NOT_FOUND, 'No such question in this organization.');
      if (ms(question.recordedAt) > T) return fail(CausalErrors.NOT_KNOWN_AT_LENS, 'The question was asked after the knowledge boundary.');
      const views = viewsAt(r.value, l.value);
      const proposed = known(r.value.candidates, T).filter((c) => c.questionId === questionId);
      const structure = await structureAt(scope, l.value);
      if (!structure.ok) return structure;
      const context = question.scope.kind === 'ANCHORED' ? question.scope.anchors.map((a) => a.entityId) : null;
      const place = (v: ClaimView) => (context ? applicabilityOf(structure.value, v.claim.scope, context) : null);
      const candidates: CandidateView[] = [];
      for (const c of proposed) {
        const v = views.find((x) => x.claim.id === c.claimId);
        if (v) candidates.push({ candidate: c, via: 'QUESTION', view: v, applicability: place(v) });
      }
      for (const v of views) {
        if (v.claim.effectKey !== question.target.variableKey || candidates.some((c) => c.view.claim.id === v.claim.id)) continue;
        const a = place(v);
        if (a && (a.verdict === 'OUTSIDE' || a.verdict === 'UNPLACEABLE')) continue;
        candidates.push({ candidate: null, via: 'CLAIM_ON_TARGET', view: v, applicability: a });
      }
      const supported = candidates.filter((c) => c.view.evaluation.status === 'SUPPORTED');
      const status = candidates.length === 0 ? 'OPEN' : supported.length > 0 ? 'SUPPORTED_EXPLANATION_EXISTS' : 'UNRESOLVED';
      const statement =
        status === 'OPEN'
          ? 'No explanation has been proposed and HELM holds no claim about this variable. HELM does not infer one; "we do not know yet" is the answer.'
          : status === 'UNRESOLVED'
            ? `${candidates.length} candidate explanation(s), none SUPPORTED. The cause is UNRESOLVED.`
            : `${supported.length} of ${candidates.length} candidate explanation(s) SUPPORTED. HELM does not apportion the change among them: ` +
              'no evidence quantifies how much of it each explains.';
      return ok({ question, lens: l.value, candidates, status, statement });
    },

    getClaim: (scope, id, lens) => claimView(scope, id, lens),

    async listClaims(scope, filter = {}) {
      const l = checkLens(filter.lens);
      if (!l.ok) return l;
      const r = await load(scope);
      if (!r.ok) return r;
      return ok(
        viewsAt(r.value, l.value).filter(
          (v) =>
            (filter.causeKey === undefined || v.claim.causeKey === filter.causeKey) &&
            (filter.effectKey === undefined || v.claim.effectKey === filter.effectKey) &&
            (filter.status === undefined || v.evaluation.status === filter.status),
        ),
      );
    },

    async evaluateClaim(scope, id, lens) {
      const v = await claimView(scope, id, lens);
      return v.ok ? ok(v.value.evaluation) : v;
    },

    async explainClaim(scope, id, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const r = await load(scope);
      if (!r.ok) return r;
      const claim = r.value.claims.find((c) => c.id === id);
      if (!claim) return fail(CausalErrors.NOT_FOUND, 'No such claim in this organization.');
      const v = viewOf(claim, r.value, l.value);
      if (!v.ok) return v;
      const T = ms(l.value.recordedThrough);
      // History: the status as of each moment something about the claim was learned.
      const events: { at: string; event: string }[] = [{ at: claim.recordedAt, event: `Claim recorded by ${claim.authoredByLabel}.` }];
      for (const rev of known(r.value.revisions, T).filter((x) => x.claimId === id && x.revision > 1)) {
        events.push({ at: rev.recordedAt, event: rev.retired ? `Retired: ${rev.retirementReason}` : `Revision ${rev.revision} recorded.` });
      }
      const linked = known(r.value.links, T).filter((x) => x.claimId === id);
      for (const link of linked) {
        const e = r.value.evidence.find((x) => x.id === link.evidenceId);
        events.push({ at: link.recordedAt, event: `${link.stance} — ${e?.type ?? 'evidence'}: ${e?.statement ?? ''}` });
      }
      for (const e of known(r.value.evidence, T)) {
        if (e.supersedesId && linked.some((x) => headOf(r.value.evidence.find((y) => y.id === x.evidenceId)!, known(r.value.evidence, T)).id === e.id)) {
          events.push({ at: e.recordedAt, event: `Evidence corrected: ${e.statement}` });
        }
      }
      events.sort((a, b) => a.at.localeCompare(b.at));
      const history = events.map((ev) => {
        const at = evaluateAt(claim, r.value, { effectiveAsOf: l.value.effectiveAsOf, recordedThrough: ev.at });
        return { recordedAt: ev.at, event: ev.event, status: at.status, confidence: at.confidence };
      });
      const a = v.value.evaluation.assessments;
      const lineage: KernelRef[] = [
        ...v.value.revision.links,
        ...v.value.cause.refs,
        ...v.value.effect.refs,
        ...a.flatMap((x) => x.evidence.refs),
      ];
      const ev = v.value.evaluation;
      return ok({
        view: v.value,
        question: `Why do we believe ${v.value.cause.label} ${claim.relationshipType.toLowerCase()} ${v.value.effect.label}?`,
        mechanism: v.value.revision.mechanism,
        supporting: a.filter((x) => x.countedAs === 'SUPPORT'),
        challenging: a.filter((x) => x.countedAs === 'CHALLENGE'),
        contradicting: a.filter((x) => x.countedAs === 'CONTRADICTION'),
        contextual: a.filter((x) => x.countedAs === 'CONTEXT'),
        scope: claim.scope,
        conditions: claim.conditions,
        applicablePeriod: claim.applicablePeriod,
        confounders: v.value.revision.confounders,
        externalValidity: v.value.revision.externalValidity,
        history,
        modelDependency: modelDependencyOf(v.value.cause, v.value.effect),
        lineage,
        statement:
          `${ev.status} (${ev.confidence} confidence) under ${ev.policy}: ${ev.counts.supporting} supporting, ` +
          `${ev.counts.challenging} challenging, ${ev.counts.contradicting} contradicting. ${ev.reasons.join(' ')}`,
      } satisfies ClaimExplanation);
    },

    listEvidence: (scope) => store.listEvidence(scope),

    async getCauses(scope, variableKey, lens) {
      return self.listClaims(scope, { lens, effectKey: variableKey });
    },
    async getEffects(scope, variableKey, lens) {
      return self.listClaims(scope, { lens, causeKey: variableKey });
    },

    traverse: traverseImpl,

    async paths(scope, input) {
      const t = await traverseImpl(scope, { from: input.from, direction: 'DOWNSTREAM', maxDepth: input.maxDepth, lens: input.lens });
      if (!t.ok) return t;
      const edges = t.value.edges;
      const out: CausalPath[] = [];
      const walk = (at: string, visited: string[], steps: TraversalEdge[]) => {
        if (steps.length >= input.maxDepth) return;
        for (const e of edges.filter((x) => x.from === at)) {
          if (visited.includes(e.to)) continue; // a loop is not a path
          const nextSteps = [...steps, e];
          if (e.to === input.to) {
            const weakest = nextSteps.map((s) => s.status).sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))[0];
            out.push({
              variables: [...visited, e.to],
              steps: nextSteps,
              weakest,
              statement:
                `${nextSteps.length} claim(s) in sequence. A path is as well supported as its weakest claim (${weakest}); ` +
                'HELM does not multiply confidences into a path probability.',
            });
          } else {
            walk(e.to, [...visited, e.to], nextSteps);
          }
        }
      };
      walk(input.from, [input.from], []);
      return ok(out);
    },

    async applicability(scope, claimId, context, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const c = await store.getClaim(scope, claimId);
      if (!c.ok) return c;
      if (!c.value) return fail(CausalErrors.NOT_FOUND, 'No such claim in this organization.');
      const s = await structureAt(scope, l.value);
      if (!s.ok) return s;
      return ok(applicabilityOf(s.value, c.value.scope, context));
    },

    async claimsFor(scope, input) {
      const l = checkLens(input.lens);
      if (!l.ok) return l;
      const all = await self.listClaims(scope, { lens: l.value, effectKey: input.effectKey });
      if (!all.ok) return all;
      const s = await structureAt(scope, l.value);
      if (!s.ok) return s;
      const placed = all.value.map((v) => ({ ...v, applicability: applicabilityOf(s.value, v.claim.scope, input.context) as Applicability }));
      return ok({
        applicable: placed.filter((p) => p.applicability.verdict === 'APPLIES' || p.applicability.verdict === 'APPLIES_TO_PART'),
        notApplicable: placed.filter((p) => p.applicability.verdict === 'OUTSIDE' || p.applicability.verdict === 'UNPLACEABLE'),
      });
    },

    async modelDependency(scope, causeKey, effectKey) {
      const v = await store.listVariables(scope);
      if (!v.ok) return v;
      const from = v.value.find((x) => x.key === causeKey);
      const to = v.value.find((x) => x.key === effectKey);
      if (!from || !to) return fail(CausalErrors.NOT_FOUND, 'Both variables must exist.');
      return ok(modelDependencyOf(from, to));
    },

    async viewAt(scope, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const r = await load(scope);
      if (!r.ok) return r;
      return ok({ lens: l.value, claims: viewsAt(r.value, l.value) });
    },

    async projectForViewer(scope, viewer, units, facts, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const r = await load(scope);
      if (!r.ok) return r;
      const views = viewsAt(r.value, l.value);
      const at = l.value.recordedThrough;
      const T = ms(at);
      const knownRecords = { revisions: known(r.value.revisions, T), evidence: known(r.value.evidence, T), links: known(r.value.links, T) };
      const shown: ClaimView[] = [];
      for (const v of views) {
        const classes = claimClasses(v, knownRecords);
        const decisions = referencedDecisions(v, knownRecords);
        const unitOk =
          viewer.orgRole === 'admin' ||
          v.claim.visibility === 'ORG_WIDE' ||
          canSeeDecision({ userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds }, { createdBy: v.claim.authoredBy, grantedUnitIds: v.claim.grantedUnitIds }, units).visible;
        const cleared = classes.every((c) => isCleared(viewer, c, at));
        const decisionsOk = viewer.orgRole === 'admin' || decisions.every((d) => facts.decisionVisible(d));
        if (unitOk && cleared && decisionsOk) shown.push(v);
      }
      const withheld = views.length - shown.length;
      return ok({
        claims: shown,
        withheld,
        statement:
          withheld === 0
            ? 'Every causal claim known at this lens is visible to you.'
            : `${withheld} causal claim(s) withheld: they are restricted to other units, carry a sensitivity class you are not cleared for, ` +
              'or rest on a decision you cannot see. A withheld claim is withheld whole — its title too.',
      });
    },
  };

  async function structureAt(scope: Scope, lens: CausalLens): Promise<Result<StructureView>> {
    return readStructure(opts.graph, scope, lens, { kind: 'ENTERPRISE', label: 'Enterprise' });
  }

  return self;
}

/** Every piece of evidence behind a claim at the boundary: what is linked, and every correction of it. */
function evidenceChain(claimId: string, r: { evidence: readonly CausalEvidence[]; links: readonly EvidenceLink[] }): CausalEvidence[] {
  const out = new Map<string, CausalEvidence>();
  let frontier = r.links.filter((l) => l.claimId === claimId).map((l) => l.evidenceId);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const e = r.evidence.find((x) => x.id === id);
      if (!e || out.has(e.id)) continue;
      out.set(e.id, e);
      for (const c of r.evidence) if (c.supersedesId === e.id) next.push(c.id);
    }
    frontier = next;
  }
  return [...out.values()];
}

/**
 * A claim's effective classes (ADR-0026 §7) — the kernel statement of
 * helm_private.causal_claim_classes(): what its author declared, its
 * variables' classes, and the class of every piece of evidence behind it,
 * corrections included. Evidence restricts the claim: a viewer who may not read
 * a piece of evidence may not read a claim whose status rests on it.
 */
export function claimClasses(v: ClaimView, r: { evidence: readonly CausalEvidence[]; links: readonly EvidenceLink[] }): SensitivityClass[] {
  const out = new Set<SensitivityClass>([v.claim.sensitivity, v.cause.sensitivity, v.effect.sensitivity]);
  for (const e of evidenceChain(v.claim.id, r)) out.add(e.sensitivity);
  return [...out].sort();
}

/**
 * Decisions a claim rests on — helm_private.causal_claim_decisions(): named
 * by ANY of its revisions (an ASSUMPTION ref pins its decision), or by the
 * evidence behind it.
 */
export function referencedDecisions(
  v: ClaimView,
  r: { revisions: readonly ClaimRevision[]; evidence: readonly CausalEvidence[]; links: readonly EvidenceLink[] },
): string[] {
  const refs = [
    ...r.revisions.filter((x) => x.claimId === v.claim.id).flatMap((x) => x.links),
    ...evidenceChain(v.claim.id, r).flatMap((e) => e.refs.filter((ref) => ref.kind === 'DECISION')),
  ];
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === 'DECISION') ids.add(ref.id);
    if (ref.kind === 'ASSUMPTION' && ref.pin) ids.add(ref.pin);
  }
  return [...ids].sort();
}

/**
 * The ScenarioStore conformance suite.
 *
 * ONE contract, run against EVERY adapter (ADR-0015's discipline, now for
 * scenarios). The properties that matter are the ones a database must enforce
 * as well as the in-memory store: sealed revisions and their overrides are
 * immutable, a simulation completes once, a scenario run executes its
 * revision's own fork, terminal statuses stay terminal, and nothing crosses a
 * tenant boundary.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import { quarterPeriod, type EntityId, type Result, type Scope } from '@helm/shared';
import type { ScenarioStore } from './port.ts';
import type { ForkPoint, ModelRef } from './types.ts';

export type ScenarioTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type ScenarioStoreHarness = {
  name: string;
  /**
   * A fresh store, two organizations, and — in organization A — one Scenario
   * ontology entity per key the suite asks for and one real value node an
   * override can target (the database enforces both as foreign keys).
   */
  create(): Promise<{
    store: ScenarioStore;
    scopeA: Scope;
    scopeB: Scope;
    scenarioEntity(key: string): Promise<EntityId>;
    targetNodeId: string;
    targetMetricKey: string;
    /**
     * A calculation run a simulation may attach: in the database it must exist
     * and have executed the given revision (null for a baseline).
     */
    calculationRun(revisionId: string | null, scenarioEntityId: EntityId | null, fork: ForkPoint): Promise<string>;
    /** Latest instant the fork may claim knowledge through. */
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

const MODEL: ModelRef = { engineVersion: '4.0.0', calculations: ['a@1.0.0', 'b@1.0.0'] };
const Q4 = quarterPeriod(2026, 4);
const Q1 = quarterPeriod(2027, 1);

export function runScenarioStoreConformanceSuite(api: ScenarioTestApi, harness: ScenarioStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`ScenarioStore conformance — ${harness.name}`, () => {
    const setup = async (key: string) => {
      const h = await harness.create();
      const fork: ForkPoint = {
        effectiveAsOf: '2026-09-19T12:00:00.000Z',
        recordedThrough: new Date(h.now().getTime() - 60_000).toISOString(),
        policy: 'SOURCE_TRUTH',
      };
      const entity = await h.scenarioEntity(key);
      const scenario = expectOk(
        await h.store.createScenario(h.scopeA, {
          key, name: `Scenario ${key}`, description: 'conformance', parentScenarioId: null,
          scenarioEntityId: entity, metadata: { suite: true }, createdBy: h.scopeA.actorId,
        }),
        'createScenario',
      );
      const revision = expectOk(
        await h.store.createRevision(h.scopeA, {
          scenarioId: scenario.id, reason: 'CREATED', basedOnRevisionId: null, parentRevisionId: null,
          fork, periods: [Q4, Q1], notes: null, createdBy: h.scopeA.actorId,
        }),
        'createRevision',
      );
      const override = (value: string, period: typeof Q4 | null = null) =>
        h.store.addOverride(h.scopeA, {
          scenarioId: scenario.id, revisionId: revision.id, overrideType: 'VALUE_OVERRIDE',
          targetNodeId: h.targetNodeId, metricKey: h.targetMetricKey, subjectEntityId: null,
          operation: 'SET', value, unit: 'units', currency: null, period,
          provenanceKind: 'MANAGEMENT_ASSUMPTION', sourceSystem: 'manual',
          rationale: 'conformance override', confidence: 0.75, createdBy: h.scopeA.actorId,
        });
      return { h, fork, scenario, revision, override };
    };

    it('creates, reads and lists a scenario; keys are unique per organization', async () => {
      const { h, scenario } = await setup('conf-create');
      try {
        const read = expectOk(await h.store.getScenario(h.scopeA, scenario.id), 'get');
        assert.equal(read?.key, 'conf-create');
        assert.equal(read?.status, 'DRAFT');
        assert.deepEqual(read?.metadata, { suite: true });
        const byKey = expectOk(await h.store.getScenarioByKey(h.scopeA, 'conf-create'), 'byKey');
        assert.equal(byKey?.id, scenario.id);
        const again = await h.store.createScenario(h.scopeA, {
          key: 'conf-create', name: 'dup', description: '', parentScenarioId: null,
          scenarioEntityId: scenario.scenarioEntityId, metadata: {}, createdBy: h.scopeA.actorId,
        });
        assert.equal(again.ok, false, 'a duplicate key is refused');
      } finally {
        await h.cleanup?.();
      }
    });

    it('enforces the lifecycle, and terminal states stay terminal', async () => {
      const { h, scenario } = await setup('conf-life');
      try {
        expectOk(await h.store.setScenarioStatus(h.scopeA, scenario.id, 'READY'), 'READY');
        expectOk(await h.store.setScenarioStatus(h.scopeA, scenario.id, 'RUNNING'), 'RUNNING');
        expectOk(await h.store.setScenarioStatus(h.scopeA, scenario.id, 'COMPUTED'), 'COMPUTED');
        expectOk(await h.store.setScenarioStatus(h.scopeA, scenario.id, 'ARCHIVED'), 'ARCHIVED');
        const back = await h.store.setScenarioStatus(h.scopeA, scenario.id, 'DRAFT');
        assert.equal(back.ok, false, 'ARCHIVED is terminal');
      } finally {
        await h.cleanup?.();
      }
    });

    it('numbers revisions, allows one draft, and round-trips fork and periods exactly', async () => {
      const { h, fork, scenario, revision } = await setup('conf-rev');
      try {
        assert.equal(revision.revisionNumber, 1);
        assert.deepEqual(revision.fork, fork);
        assert.deepEqual(revision.periods.map((p) => p.start), [Q4.start, Q1.start]);
        assert.equal(revision.periods[1].grain, 'QUARTER');
        const second = await h.store.createRevision(h.scopeA, {
          scenarioId: scenario.id, reason: 'EDITED', basedOnRevisionId: revision.id, parentRevisionId: null,
          fork, periods: [Q4], notes: null, createdBy: h.scopeA.actorId,
        });
        assert.equal(second.ok, false, 'a second draft is refused');
      } finally {
        await h.cleanup?.();
      }
    });

    it('overrides round-trip exactly, and a sealed revision refuses every change', async () => {
      const { h, revision, override } = await setup('conf-seal');
      try {
        const o = expectOk(await override('12', Q1), 'addOverride');
        assert.equal(o.value, '12');
        assert.equal(o.period?.start, Q1.start);
        assert.equal(o.confidence, 0.75);
        assert.equal(o.provenanceKind, 'MANAGEMENT_ASSUMPTION');
        const listed = expectOk(await h.store.listOverrides(h.scopeA, revision.id), 'list');
        assert.equal(listed.length, 1);

        const sealed = expectOk(
          await h.store.sealRevision(h.scopeA, revision.id, { modelRef: MODEL, fingerprint: 'sfp_conformance' }),
          'seal',
        );
        assert.equal(sealed.state, 'SEALED');
        assert.deepEqual(sealed.modelRef, MODEL);
        assert.equal(sealed.fingerprint, 'sfp_conformance');
        assert.equal((await h.store.sealRevision(h.scopeA, revision.id, { modelRef: MODEL, fingerprint: 'x' })).ok, false);
        assert.equal((await override('13', Q4)).ok, false, 'no override into a sealed revision');
        assert.equal((await h.store.removeOverride(h.scopeA, o.id)).ok, false, 'none removed from it');
      } finally {
        await h.cleanup?.();
      }
    });

    it('a scenario run executes its sealed revision\'s own fork; a simulation completes once', async () => {
      const { h, fork, scenario, revision } = await setup('conf-run');
      try {
        const unsealed = await h.store.createRun(h.scopeA, {
          stateKind: 'SCENARIO', scenarioId: scenario.id, revisionId: revision.id, kind: 'EXECUTE',
          replayOfRunId: null, fork, periods: [Q4], fingerprint: 'sfp', modelRef: MODEL,
          createdBy: h.scopeA.actorId, notes: null,
        });
        assert.equal(unsealed.ok, false, 'a draft revision cannot be simulated');
        expectOk(await h.store.sealRevision(h.scopeA, revision.id, { modelRef: MODEL, fingerprint: 'sfp' }), 'seal');
        const wrongFork = await h.store.createRun(h.scopeA, {
          stateKind: 'SCENARIO', scenarioId: scenario.id, revisionId: revision.id, kind: 'EXECUTE',
          replayOfRunId: null, fork: { ...fork, recordedThrough: '2026-01-01T00:00:00.000Z' },
          periods: [Q4], fingerprint: 'sfp', modelRef: MODEL, createdBy: h.scopeA.actorId, notes: null,
        });
        assert.equal(wrongFork.ok, false, 'a run cannot claim a revision and use another fork');

        const run = expectOk(
          await h.store.createRun(h.scopeA, {
            stateKind: 'SCENARIO', scenarioId: scenario.id, revisionId: revision.id, kind: 'EXECUTE',
            replayOfRunId: null, fork, periods: [Q4], fingerprint: 'sfp', modelRef: MODEL,
            createdBy: h.scopeA.actorId, notes: null,
          }),
          'createRun',
        );
        assert.equal(run.status, 'RUNNING');
        const calcRun = await h.calculationRun(revision.id, scenario.scenarioEntityId, fork);
        const attached = expectOk(
          await h.store.attachPeriodRun(h.scopeA, run.id, { period: Q4, calculationRunId: calcRun }),
          'attach',
        );
        assert.equal(attached.periodRuns[0].calculationRunId, calcRun);
        assert.equal(attached.periodRuns.length, 1);
        assert.equal(attached.periodRuns[0].period.start, Q4.start);
        const done = expectOk(
          await h.store.completeRun(h.scopeA, run.id, { status: 'PARTIAL', completeness: 'PARTIAL' }),
          'complete',
        );
        assert.equal(done.completeness, 'PARTIAL');
        assert.ok(done.completedAt);
        assert.equal((await h.store.completeRun(h.scopeA, run.id, { status: 'COMPLETED', completeness: 'COMPLETE' })).ok, false);
        assert.equal(
          (await h.store.attachPeriodRun(h.scopeA, run.id, { period: Q1, calculationRunId: calcRun })).ok,
          false,
          'a completed simulation gains no periods',
        );
        const listed = expectOk(await h.store.listRuns(h.scopeA, { scenarioId: scenario.id }), 'listRuns');
        assert.equal(listed.length, 1);
        assert.deepEqual(listed[0].modelRef, MODEL);
      } finally {
        await h.cleanup?.();
      }
    });

    it('a baseline run carries no scenario; constraint results are recorded once', async () => {
      const { h, fork } = await setup('conf-base');
      try {
        const run = expectOk(
          await h.store.createRun(h.scopeA, {
            stateKind: 'BASELINE', scenarioId: null, revisionId: null, kind: 'EXECUTE', replayOfRunId: null,
            fork, periods: [Q4], fingerprint: 'sfp_base', modelRef: MODEL, createdBy: h.scopeA.actorId, notes: null,
          }),
          'baseline run',
        );
        const early = await h.store.recordConstraintResults(h.scopeA, run.id, []);
        assert.equal(early.ok, false, 'a running simulation is not judged yet');
        expectOk(await h.store.completeRun(h.scopeA, run.id, { status: 'COMPLETED', completeness: 'COMPLETE' }), 'complete');
        const result = {
          constraintKey: 'k', constraintVersion: '1.0.0', name: 'K', kind: 'INVENTORY' as const, period: Q4,
          status: 'BREACHED' as const, threshold: '8', actual: '12', breachAmount: '4', unit: 'units' as const,
          severity: 'HIGH' as const, explanation: 'Requires 12 units; 8 available — breached by 4 units.',
        };
        expectOk(await h.store.recordConstraintResults(h.scopeA, run.id, [result]), 'record');
        const back = expectOk(await h.store.listConstraintResults(h.scopeA, run.id), 'list');
        assert.equal(back.length, 1);
        assert.equal(back[0].breachAmount, '4');
        assert.equal(back[0].period.start, Q4.start);
        assert.equal((await h.store.recordConstraintResults(h.scopeA, run.id, [result])).ok, false);
      } finally {
        await h.cleanup?.();
      }
    });

    it('nothing crosses a tenant boundary', async () => {
      const { h, fork, scenario, revision, override } = await setup('conf-tenant');
      try {
        expectOk(await override('4'), 'override');
        expectOk(await h.store.sealRevision(h.scopeA, revision.id, { modelRef: MODEL, fingerprint: 'sfp' }), 'seal');
        const run = expectOk(
          await h.store.createRun(h.scopeA, {
            stateKind: 'SCENARIO', scenarioId: scenario.id, revisionId: revision.id, kind: 'EXECUTE',
            replayOfRunId: null, fork, periods: [Q4], fingerprint: 'sfp', modelRef: MODEL,
            createdBy: h.scopeA.actorId, notes: null,
          }),
          'run',
        );
        const B = h.scopeB;
        assert.equal(expectOk(await h.store.getScenario(B, scenario.id), 'B get'), null);
        assert.equal(expectOk(await h.store.getScenarioByKey(B, 'conf-tenant'), 'B key'), null);
        assert.equal(expectOk(await h.store.listScenarios(B), 'B list').some((x) => x.id === scenario.id), false);
        assert.equal(expectOk(await h.store.getRevision(B, revision.id), 'B rev'), null);
        assert.equal(expectOk(await h.store.listOverrides(B, revision.id), 'B overrides').length, 0);
        assert.equal(expectOk(await h.store.getRun(B, run.id), 'B run'), null);
        assert.equal(expectOk(await h.store.listConstraintResults(B, run.id), 'B constraints').length, 0);
        assert.equal((await h.store.setScenarioStatus(B, scenario.id, 'ARCHIVED')).ok, false);
        assert.equal((await h.store.completeRun(B, run.id, { status: 'COMPLETED', completeness: 'COMPLETE' })).ok, false);
      } finally {
        await h.cleanup?.();
      }
    });
  });
}

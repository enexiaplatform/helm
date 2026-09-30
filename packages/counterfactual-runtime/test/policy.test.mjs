/**
 * The counterfactual policy (ADR-0029): pure rules, so every statement HELM
 * makes about a world is tested without a runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  causalSupportLevel,
  classesOf,
  comparisonFingerprint,
  differenceOf,
  pairNote,
  readingStatement,
  uncertaintyOf,
  variableBindsTo,
  worldFingerprint,
} from '../src/index.ts';

const pairs = (...states) => states.map((state) => ({ state }));

describe('causalSupportLevel — a statement about EVIDENCE, never a probability', () => {
  it('no pairs: the model\'s alone; every pair supported: CAUSALLY_SUPPORTED — and still a model result', () => {
    const none = causalSupportLevel([]);
    assert.equal(none.level, 'MODEL_ONLY');
    const all = causalSupportLevel(pairs('SUPPORTED_PATH', 'SUPPORTED_PATH'));
    assert.equal(all.level, 'CAUSALLY_SUPPORTED');
    assert.match(all.statement, /not identification of the effect: the value stays a model result/);
  });

  it('some supported: PARTIALLY_SUPPORTED, and it says how many', () => {
    const r = causalSupportLevel(pairs('SUPPORTED_PATH', 'NO_PATH', 'NO_CAUSAL_KNOWLEDGE'));
    assert.equal(r.level, 'PARTIALLY_SUPPORTED');
    assert.match(r.statement, /1 of 3/);
  });

  it('none supported: CONTESTED only if a claim counts against the link; otherwise MODEL_ONLY', () => {
    assert.equal(causalSupportLevel(pairs('CONTESTED_PATH', 'NO_PATH')).level, 'CONTESTED');
    assert.equal(causalSupportLevel(pairs('UNSUPPORTED_PATH', 'OUTSIDE_SCOPE', 'NO_PATH')).level, 'MODEL_ONLY');
  });

  it('a supported path that does not apply to the whole scope is not support', () => {
    assert.equal(causalSupportLevel(pairs('OUTSIDE_SCOPE')).level, 'MODEL_ONLY');
    assert.match(pairNote('OUTSIDE_SCOPE', 'A', 'B'), /does not apply to this case's whole scope/);
  });

  it('carries no number: no probability, weight or confidence product', () => {
    const r = causalSupportLevel(pairs('SUPPORTED_PATH', 'NO_PATH'));
    for (const key of Object.keys(r)) assert.doesNotMatch(key, /score|probab|weight|confidence/i, key);
  });
});

describe('uncertaintyOf — a list, never an interval', () => {
  const base = { lens: 'AS_KNOWN_THEN', estimability: 'ESTIMATED', notEstimableReasons: [], movedInputs: [], hindsightInputs: [], completeness: 'COMPLETE', blockedReadings: 0, unavailableReadings: 0 };
  const moved = (label, confidence, provenanceKind = 'MANAGEMENT_ASSUMPTION') => ({ nodeId: label, nodeLabel: label, metricKey: 'X', period: null, source: 'INTERVENTION', baselineValue: '1', value: '2', rationale: 'r', provenanceKind, confidence });

  it('always names the method, and what the model does not represent', () => {
    const u = uncertaintyOf(base);
    assert.match(u[0], /MODEL_COUNTERFACTUAL/);
    assert.match(u[u.length - 1], /customer response/);
  });

  it('names the least confident stated input and never multiplies confidences', () => {
    const u = uncertaintyOf({ ...base, movedInputs: [moved('Freight', 0.85), moved('Lead time', 0.7)] });
    assert.ok(u.some((x) => /least confident is Lead time at 0\.7/.test(x) && /never multiplied/.test(x)));
    assert.ok(u.some((x) => /management assumptions/.test(x)));
  });

  it('a hindsight world says each input is a person\'s statement HELM cannot verify', () => {
    const u = uncertaintyOf({ ...base, lens: 'WITH_HINDSIGHT', hindsightInputs: [{ label: 'x' }] });
    assert.ok(u.some((x) => /1 fact\(s\) learned after the decision boundary/.test(x) && /cannot verify that/.test(x)));
  });

  it('blocked values are shown as unavailable, not estimated; a partial simulation says so', () => {
    const u = uncertaintyOf({ ...base, completeness: 'PARTIAL', blockedReadings: 2 });
    assert.ok(u.some((x) => /PARTIAL/.test(x)));
    assert.ok(u.some((x) => /2 compared value\(s\) are BLOCKED/.test(x)));
  });

  it('a world that cannot be estimated lists why and says HELM invents no future', () => {
    const u = uncertaintyOf({ ...base, estimability: 'NOT_ESTIMABLE', notEstimableReasons: ['never modelled'] });
    assert.deepEqual(u.slice(0, 1), ['never modelled']);
    assert.match(u[1], /does not invent a future/);
  });
});

describe('wording — under a model, on stated assumptions, estimated', () => {
  const model = { engineVersion: 'v1.1', calculations: ['a@1', 'b@1'] };
  it('a value is estimated under a named model and assumptions, and is not what would have happened', () => {
    const s = readingStatement({ label: 'Gross margin %', value: '30.5', unit: 'percentage', currency: null, model, assumptions: 3, lens: 'AS_KNOWN_THEN' });
    assert.match(s, /^Under model v1\.1 \(2 calculations\), and the 3 stated assumption\(s\) listed, the estimated counterfactual value of Gross margin % is 30\.5 percentage \(as known then\)/);
    assert.match(s, /not what would have happened/);
    assert.doesNotMatch(s, /would definitely|profit would have been/);
  });

  it('an unavailable value is unavailable, not guessed', () => {
    assert.match(readingStatement({ label: 'Cash', value: null, unit: null, currency: null, model, assumptions: 3, lens: 'WITH_HINDSIGHT' }), /HELM does not estimate what the model does not compute/);
  });
});

describe('differenceOf — exact decimals, or nothing', () => {
  it('subtracts exactly and returns null when either side was not read', () => {
    assert.equal(differenceOf('30.517', '32.3878'), '-1.8708');
    assert.equal(differenceOf('0.3', '0.1'), '0.2');
    assert.equal(differenceOf(null, '1'), null);
    assert.equal(differenceOf('1', null), null);
    assert.equal(differenceOf('not a number', '1'), null);
  });
});

describe('fingerprints — content, not the day it was read', () => {
  const w = { caseId: 'c', lens: 'AS_KNOWN_THEN', method: 'MODEL_COUNTERFACTUAL', estimability: 'ESTIMATED', scenario: { scenarioId: 's', revisionId: 'r', runId: 'x' }, model: { engineVersion: 'v', calculations: [] }, readings: [{ metricKey: 'M', nodeId: 'n', status: 'READ', value: '1' }], movedInputs: [], hindsightInputs: [], anchorFork: { effectiveAsOf: 'a', recordedThrough: 'b', policy: 'SOURCE_TRUTH' }, knowledge: { effectiveAsOf: 'a', recordedThrough: 'b' } };
  it('a world fingerprint is stable and changes with a reading', () => {
    assert.equal(worldFingerprint(w), worldFingerprint({ ...w }));
    assert.notEqual(worldFingerprint(w), worldFingerprint({ ...w, readings: [{ ...w.readings[0], value: '2' }] }));
    assert.match(worldFingerprint(w), /^cfw_/);
  });

  it('a comparison fingerprint has no clock in it', () => {
    const parts = { caseId: 'c', worldFingerprints: ['cfw_1', null], rows: [['M', '1', null, '2', null]] };
    assert.equal(comparisonFingerprint(parts), comparisonFingerprint({ ...parts }));
    assert.notEqual(comparisonFingerprint(parts), comparisonFingerprint({ ...parts, worldFingerprints: ['cfw_1', 'cfw_2'] }));
    assert.doesNotMatch(JSON.stringify(Object.keys(parts)), /lens|at|time/i);
  });
});

describe('variables and classes', () => {
  const v = (metricKey, refs = [], kind = 'METRIC') => ({ kind, metricKey, refs });
  it('a variable binds a metric, and a node only where it names nodes', () => {
    assert.equal(variableBindsTo(v('Opex'), 'Opex', 'n1'), true);
    assert.equal(variableBindsTo(v('Opex', [{ kind: 'VALUE_NODE', id: 'n1' }]), 'Opex', 'n1'), true);
    assert.equal(variableBindsTo(v('Opex', [{ kind: 'VALUE_NODE', id: 'n2' }]), 'Opex', 'n1'), false);
    assert.equal(variableBindsTo(v('Opex'), 'Other', 'n1'), false);
    assert.equal(variableBindsTo(v('Opex', [], 'ACTION'), 'Opex', 'n1'), false);
  });

  it('classes derive from the metrics compared', () => {
    assert.deepEqual(classesOf(['DemandCoverage']), ['GENERAL_MANAGEMENT']);
    assert.ok(classesOf(['GrossMarginPct']).includes('FINANCIAL_SENSITIVE'));
  });
});

/**
 * The Phase 1–7 stack with the canonical twin story, for the verify:twin-*
 * contracts. It is the test harness's story, so a contract and a test can
 * never disagree about what was built; every claim lives in the contract.
 */

export { buildStory, buildTwinStack, item, itemsOf, valueKey, unwrap, USERS, MEMBERSHIP, UNITS, ADMIN } from '../../packages/twin-runtime/test/harness.mjs';

/** A contract's failure list and reporter, in the house style. */
export function contract(name) {
  const failures = [];
  return {
    check: (rule, cond, detail) => {
      if (!cond) failures.push({ rule, detail });
    },
    finish: (okLine) => {
      if (failures.length === 0) {
        console.log(`${name} — ok (${okLine})`);
        process.exit(0);
      }
      console.error(`${name} — ${failures.length} problem(s):\n`);
      for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
      process.exit(1);
    },
  };
}

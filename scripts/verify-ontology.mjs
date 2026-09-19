/**
 * verify:ontology — the seed ontology's structural integrity.
 *
 * A broken ontology is worse than a missing one: it validates bad data. These
 * checks run against the TypeScript seed, which is the single source of truth
 * for both the migration and the in-memory store.
 *
 *   1. No duplicate keys; no dangling parents; no inheritance cycles.
 *   2. Inverse relationship pairs are symmetric.
 *   3. Every relationship type's category constraints name real categories.
 *   4. Naming conventions hold (PascalCase types, SCREAMING_SNAKE relationships).
 *   5. Every type carries a description a manager could actually read.
 *   6. Causal relationship types are absent — the Causal Graph is Phase 8.
 *   7. The seeded subset covers what the canonical scenario needs.
 *   8. The committed migration matches the TypeScript seed (no drift).
 */

import { execFileSync } from 'node:child_process';
import {
  buildSeedRegistry,
  validateOntology,
  seedEntityTypes,
  seedRelationshipTypes,
  entityCategories,
  relationshipCategories,
} from '../packages/ontology/src/index.ts';
import {
  canonicalEntitySpecs,
  canonicalRelationshipSpecs,
} from '../packages/graph-store/src/canonicalScenario.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });

const registry = buildSeedRegistry();

// --------------------------------------------- 1 & 2: structural integrity

for (const p of validateOntology(registry)) {
  fail(p.kind, p.detail);
}

// ------------------------------------------------ 3: category constraints

for (const t of seedRelationshipTypes) {
  for (const side of ['sourceCategories', 'targetCategories']) {
    const cats = t[side];
    if (cats === null || cats === undefined) continue;
    for (const c of cats) {
      if (!entityCategories.includes(c)) {
        fail('unknown-category', `${t.key}.${side} references unknown category "${c}"`);
      }
    }
  }
  if (!relationshipCategories.includes(t.category)) {
    fail('unknown-category', `${t.key}.category "${t.category}" is not a relationship category`);
  }
}

for (const t of seedEntityTypes) {
  if (!entityCategories.includes(t.category)) {
    fail('unknown-category', `${t.key}.category "${t.category}" is not an entity category`);
  }
}

// -------------------------------------------------- 4 & 5: conventions

for (const t of seedEntityTypes) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(t.key)) {
    fail('naming', `entity type key "${t.key}" must be PascalCase`);
  }
  if (!t.description || t.description.trim().length < 16) {
    fail('thin-description', `entity type "${t.key}" needs a real description`);
  }
  if (t.attributeSchema && t.attributeSchema.properties) {
    for (const [prop, def] of Object.entries(t.attributeSchema.properties)) {
      if (!def.description) {
        fail('undocumented-attribute', `${t.key}.${prop} has no description`);
      }
      if (def.minimum !== undefined && def.maximum !== undefined && def.minimum > def.maximum) {
        fail('bad-bounds', `${t.key}.${prop} has minimum > maximum`);
      }
    }
  }
}

for (const t of seedRelationshipTypes) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(t.key)) {
    fail('naming', `relationship type key "${t.key}" must be SCREAMING_SNAKE_CASE`);
  }
  if (!t.description || t.description.trim().length < 16) {
    fail('thin-description', `relationship type "${t.key}" needs a real description`);
  }
}

// ------------------------------------------ 6: causality stays in Phase 8

for (const reserved of ['CAUSES', 'INFLUENCES', 'CORRELATES_WITH', 'CAUSED_BY']) {
  if (registry.relationshipType(reserved)) {
    fail(
      'causal-leak',
      `"${reserved}" is in the generic ontology. Causal assertions belong to the ` +
        `Causal Graph (Phase 8); mixing them here destroys the distinction between ` +
        `correlation and management causal hypothesis.`,
    );
  }
}

// ------------------------------------- 7: coverage for the canonical scenario

for (const spec of canonicalEntitySpecs) {
  if (!registry.entityType(spec.type)) {
    fail('canonical-coverage', `canonical scenario uses unseeded entity type "${spec.type}"`);
  }
}
for (const spec of canonicalRelationshipSpecs) {
  if (!registry.relationshipType(spec.type)) {
    fail(
      'canonical-coverage',
      `canonical scenario uses unseeded relationship type "${spec.type}"`,
    );
  }
}

// A weight can only be stored on a type that declares it carries one.
for (const spec of canonicalRelationshipSpecs) {
  if (spec.weight === undefined || spec.weight === null) continue;
  const def = registry.relationshipType(spec.type);
  if (def && !def.carriesWeight) {
    fail(
      'weight-on-weightless-type',
      `canonical scenario puts a weight on "${spec.type}", which does not carry one`,
    );
  }
}

// The concepts the brief named as the minimum meaningful set.
const REQUIRED = [
  'Enterprise', 'Region', 'Country', 'BusinessUnit', 'Function', 'Team', 'Role', 'Person',
  'Market', 'Segment', 'Customer', 'Opportunity', 'Product', 'Portfolio', 'Channel',
  'Distributor', 'Revenue',
  'Supplier', 'Inventory', 'Warehouse', 'Capacity', 'Shipment', 'ServiceLevel',
  'Cost', 'Margin', 'WorkingCapital', 'Cash', 'EBITDA', 'Investment',
  'Objective', 'KPI', 'Constraint', 'Assumption', 'Risk', 'Signal', 'Issue',
  'Scenario', 'Decision', 'Action', 'Outcome', 'Lesson',
];
for (const key of REQUIRED) {
  if (!registry.entityType(key)) fail('missing-required-type', `entity type "${key}"`);
}

const REQUIRED_RELS = [
  'BELONGS_TO', 'OWNS', 'SERVES', 'SUPPLIES', 'SELLS', 'CONSUMES', 'GENERATES',
  'DEPENDS_ON', 'AFFECTS', 'REQUIRES', 'CONSTRAINS', 'SUPPORTS', 'EXPOSED_TO',
  'RESPONSIBLE_FOR', 'ALIGNS_WITH', 'DERIVED_FROM',
];
for (const key of REQUIRED_RELS) {
  if (!registry.relationshipType(key)) {
    fail('missing-required-type', `relationship type "${key}"`);
  }
}

// ------------------------------------------- 8: migration matches the seed

try {
  execFileSync(process.execPath, ['scripts/generate-ontology-migration.mjs', '--check'], {
    stdio: 'pipe',
    cwd: process.cwd(),
  });
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  fail('migration-drift', out || 'the generated migration no longer matches seed.ts');
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:ontology — ok (${seedEntityTypes.length} entity types, ` +
      `${seedRelationshipTypes.length} relationship types, migration in sync)`,
  );
  process.exit(0);
}

console.error(`verify:ontology — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);

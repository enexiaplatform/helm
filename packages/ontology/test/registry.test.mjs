import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSeedRegistry,
  canonicalKey,
  createRegistry,
  isValidCanonicalKey,
  normalizeAlias,
  seedTypeId,
  validateOntology,
} from '../src/registry.ts';
import { seedEntityTypes, seedRelationshipTypes } from '../src/seed.ts';

const registry = buildSeedRegistry();

const entityInput = (over = {}) => ({
  entityTypeKey: 'Opportunity',
  canonicalKey: 'memoire:opportunity:opp-1',
  name: 'Pharma tender',
  sourceSystem: 'memoire',
  attributes: {},
  ...over,
});

describe('seed ontology integrity', () => {
  test('the shipped ontology is structurally sound', () => {
    const problems = validateOntology(registry);
    assert.deepEqual(problems, [], `ontology problems: ${JSON.stringify(problems, null, 2)}`);
  });

  test('seeds the concepts the canonical scenario needs', () => {
    const required = [
      'Enterprise', 'Region', 'Country', 'BusinessUnit', 'Function', 'Team', 'Role', 'Person',
      'Market', 'Segment', 'Customer', 'Opportunity', 'Product', 'Portfolio', 'Channel',
      'Distributor', 'Revenue',
      'Supplier', 'Inventory', 'Warehouse', 'Capacity', 'Shipment', 'ServiceLevel',
      'Cost', 'Margin', 'WorkingCapital', 'Cash', 'EBITDA', 'Investment',
      'Objective', 'KPI', 'Constraint', 'Assumption', 'Risk', 'Signal', 'Issue',
      'Scenario', 'Decision', 'Action', 'Outcome', 'Lesson',
    ];
    for (const key of required) {
      assert.ok(registry.entityType(key), `missing seeded entity type: ${key}`);
    }
  });

  test('seeds the relationship semantics the brief specified', () => {
    const required = [
      'BELONGS_TO', 'OWNS', 'SERVES', 'SUPPLIES', 'SELLS', 'CONSUMES', 'GENERATES',
      'DEPENDS_ON', 'AFFECTS', 'REQUIRES', 'CONSTRAINS', 'SUPPORTS', 'EXPOSED_TO',
      'RESPONSIBLE_FOR', 'ALIGNS_WITH', 'DERIVED_FROM',
    ];
    for (const key of required) {
      assert.ok(registry.relationshipType(key), `missing seeded relationship type: ${key}`);
    }
  });

  test('causal relationship types are NOT in the generic ontology', () => {
    // Phase 8 owns causality. Mixing it in here would destroy the distinction
    // between correlation and management causal hypothesis.
    for (const key of ['CAUSES', 'INFLUENCES', 'CORRELATES_WITH']) {
      assert.equal(
        registry.relationshipType(key),
        null,
        `${key} must wait for the Causal Graph layer`,
      );
    }
  });

  test('every seeded type carries a description a manager could read', () => {
    for (const t of [...seedEntityTypes, ...seedRelationshipTypes]) {
      assert.ok(t.description && t.description.length > 15, `thin description on ${t.key}`);
    }
  });

  test('entity type keys are PascalCase and relationship keys SCREAMING_SNAKE', () => {
    for (const t of seedEntityTypes) {
      assert.match(t.key, /^[A-Z][A-Za-z0-9]*$/, `bad entity type key: ${t.key}`);
    }
    for (const t of seedRelationshipTypes) {
      assert.match(t.key, /^[A-Z][A-Z0-9_]*$/, `bad relationship type key: ${t.key}`);
    }
  });
});

describe('inheritance', () => {
  test('a Distributor is a Customer', () => {
    assert.equal(registry.isA('Distributor', 'Customer'), true);
    assert.equal(registry.isA('Distributor', 'Distributor'), true, 'a type is itself');
    assert.equal(registry.isA('Customer', 'Distributor'), false, 'not the other way');
    assert.equal(registry.isA('Product', 'Customer'), false);
  });

  test('a Tender is an Opportunity', () => {
    assert.equal(registry.isA('Tender', 'Opportunity'), true);
    assert.deepEqual(registry.ancestry('Tender'), ['Tender', 'Opportunity']);
  });

  test('ancestry of a root type is just itself', () => {
    assert.deepEqual(registry.ancestry('Enterprise'), ['Enterprise']);
  });

  test('an unknown type has empty ancestry rather than throwing', () => {
    assert.deepEqual(registry.ancestry('Nonsense'), []);
    assert.equal(registry.isA('Nonsense', 'Customer'), false);
  });
});

describe('entity validation', () => {
  test('accepts a well-formed entity', () => {
    const r = registry.validateEntity(
      entityInput({ attributes: { value: 4.2e9, currency: 'VND', probability: 0.7 } }),
    );
    assert.equal(r.ok, true);
  });

  test('rejects an unknown type', () => {
    const r = registry.validateEntity(entityInput({ entityTypeKey: 'Nope' }));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ontology.unknown_entity_type');
  });

  test('rejects a canonical key missing its namespace', () => {
    for (const bad of ['opp-1', 'memoire:opp-1', '', 'a:b:']) {
      const r = registry.validateEntity(entityInput({ canonicalKey: bad }));
      assert.equal(r.ok, false, `should reject "${bad}"`);
      assert.equal(r.error.code, 'ontology.invalid_canonical_key');
    }
  });

  test('rejects a blank name', () => {
    const r = registry.validateEntity(entityInput({ name: '   ' }));
    assert.equal(r.ok, false);
  });

  test('enforces attribute types from the schema', () => {
    const r = registry.validateEntity(entityInput({ attributes: { value: 'lots' } }));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ontology.invalid_attributes');
    assert.match(r.error.message, /expected number/);
  });

  test('enforces numeric bounds — probability is a proportion, not a percentage', () => {
    const r = registry.validateEntity(entityInput({ attributes: { probability: 70 } }));
    assert.equal(r.ok, false);
    assert.match(r.error.message, /must be <= 1/);
  });

  test('enforces enums', () => {
    const r = registry.validateEntity({
      entityTypeKey: 'Cost',
      canonicalKey: 'helm:cost:freight',
      name: 'Freight',
      sourceSystem: 'helm',
      attributes: { behaviour: 'semi_variable' },
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /must be one of/);
  });

  test('inherited schemas apply to subtypes', () => {
    // Tender inherits Opportunity's probability bound.
    const r = registry.validateEntity({
      entityTypeKey: 'Tender',
      canonicalKey: 'memoire:tender:t-1',
      name: 'Next month tender',
      sourceSystem: 'memoire',
      attributes: { probability: 5 },
    });
    assert.equal(r.ok, false, 'a Tender must obey Opportunity rules');
    assert.match(r.error.message, /must be <= 1/);
  });

  test('rejects out-of-range confidence', () => {
    const r = registry.validateEntity(entityInput({ confidence: 1.5 }));
    assert.equal(r.ok, false);
  });

  test('unknown attributes are permitted — the ontology is extensible', () => {
    const r = registry.validateEntity(entityInput({ attributes: { localField: 'x' } }));
    assert.equal(r.ok, true, 'additionalProperties is open by design');
  });
});

describe('relationship validation', () => {
  const relInput = (over = {}) => ({
    relationshipTypeKey: 'SELLS',
    sourceEntityId: 'e1',
    targetEntityId: 'e2',
    sourceSystem: 'helm',
    ...over,
  });

  test('accepts an allowed pairing', () => {
    const r = registry.validateRelationship(relInput({ weight: 12 }), 'Opportunity', 'Product');
    assert.equal(r.ok, true);
  });

  test('rejects a disallowed category pairing', () => {
    const r = registry.validateRelationship(
      relInput({ relationshipTypeKey: 'CONVERTS_TO' }),
      'Opportunity',
      'Product',
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ontology.domain_constraint_violated');
  });

  test('category constraints are inheritance-aware', () => {
    // HELD_BY is commercial→commercial; Distributor inherits Customer (commercial).
    const r = registry.validateRelationship(
      relInput({ relationshipTypeKey: 'HELD_BY' }),
      'Tender',
      'Distributor',
    );
    assert.equal(r.ok, true, 'subtypes satisfy their ancestor category');
  });

  test('rejects an unknown relationship type', () => {
    const r = registry.validateRelationship(
      relInput({ relationshipTypeKey: 'FROBNICATES' }),
      'Opportunity',
      'Product',
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ontology.unknown_relationship_type');
  });

  test('rejects self-reference', () => {
    const r = registry.validateRelationship(
      relInput({ targetEntityId: 'e1' }),
      'Opportunity',
      'Opportunity',
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'graph.self_reference');
  });

  test('rejects a weight on a weightless type', () => {
    const r = registry.validateRelationship(
      relInput({ relationshipTypeKey: 'BELONGS_TO', weight: 3 }),
      'Country',
      'Enterprise',
    );
    assert.equal(r.ok, false);
    assert.match(r.error.message, /does not carry a weight/);
  });
});

describe('ontology self-check catches real breakage', () => {
  test('detects a dangling parent', () => {
    const broken = createRegistry(
      [
        {
          id: 'et_orphan',
          orgId: null,
          key: 'Orphan',
          name: 'Orphan',
          description: 'x',
          category: 'commercial',
          parentTypeId: 'et_missing',
          attributeSchema: {},
          version: 1,
          status: 'active',
          isSystem: false,
        },
      ],
      [],
    );
    const problems = validateOntology(broken);
    assert.ok(
      problems.some((p) => p.kind === 'dangling_parent'),
      `expected dangling_parent, got ${JSON.stringify(problems)}`,
    );
  });

  test('detects an asymmetric inverse pair', () => {
    const mk = (key, inverseKey) => ({
      id: seedTypeId('relationship', key),
      orgId: null,
      key,
      name: key,
      description: 'x',
      category: 'structural',
      isDirected: true,
      carriesWeight: false,
      sourceCategories: null,
      targetCategories: null,
      inverseKey,
      version: 1,
      status: 'active',
      isSystem: false,
    });
    const problems = validateOntology(createRegistry([], [mk('A_REL', 'B_REL'), mk('B_REL', null)]));
    assert.ok(problems.some((p) => p.kind === 'asymmetric_inverse'));
  });

  test('detects cyclic inheritance', () => {
    const mk = (key, parentKey) => ({
      id: seedTypeId('entity', key),
      orgId: null,
      key,
      name: key,
      description: 'x',
      category: 'commercial',
      parentTypeId: seedTypeId('entity', parentKey),
      attributeSchema: {},
      version: 1,
      status: 'active',
      isSystem: false,
    });
    const problems = validateOntology(createRegistry([mk('X', 'Y'), mk('Y', 'X')], []));
    assert.ok(
      problems.some((p) => p.kind === 'cyclic_inheritance'),
      `expected cyclic_inheritance, got ${JSON.stringify(problems)}`,
    );
  });
});

describe('canonical keys and aliases', () => {
  test('builds and validates namespaced keys', () => {
    assert.equal(canonicalKey('memoire', 'opportunity', 'opp-1'), 'memoire:opportunity:opp-1');
    assert.equal(isValidCanonicalKey('memoire:opportunity:opp-1'), true);
    assert.equal(isValidCanonicalKey('helm:inventory:SKU-X@WH-HCMC'), true);
    assert.equal(isValidCanonicalKey('nonamespace'), false);
  });

  test('alias normalization defeats case and whitespace noise', () => {
    assert.equal(normalizeAlias('  ROHTO-VN-001 '), 'rohto-vn-001');
    assert.equal(normalizeAlias('Rohto   Vietnam'), 'rohto vietnam');
  });
});

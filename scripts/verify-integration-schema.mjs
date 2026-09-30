/**
 * verify:integration-schema — the database says what ADR-0030 says.
 *
 *   - two append-only tables (sync ledger, dry-run writeback ledger), record time stamped by the database;
 *   - a blocked or failed run leaves the checkpoint exactly where it was, and a clean run has no quarantine;
 *   - v1 has no live writeback: the mode is pinned to DRY_RUN, a dry run states that nothing was sent, and a write
 *     is only "would write" for a commitment the governance state permits (recorded with the state it was judged in);
 *   - there is no request without an explicit action intent OF THAT commitment, and a request is unique on its key;
 *   - a write request is read by whoever can see the decision it derives from — visibility, never authority;
 *   - nothing here touches a Memoire object.
 */

import { contract } from './lib/twinStack.mjs';
import { appendOnly, loadMigration, noVerdictColumns } from './lib/schemaContract.mjs';

const c = contract('verify:integration-schema');
const m = loadMigration(c, '20260930130000_helm_integration_fabric.sql', 'integration fabric');
const TABLES = ['helm_integration_syncs', 'helm_writeback_requests'];
appendOnly(c, m, TABLES, 'helm_integration_record_guard');
noVerdictColumns(c, m, TABLES);

const syncs = m.table('helm_integration_syncs');
c.check('checkpoint', /helm_integration_syncs_checkpoint_holds CHECK \(\s*outcome NOT IN \('BLOCKED_BY_DRIFT', 'FAILED'\) OR cursor_after IS NOT DISTINCT FROM cursor_before/.test(syncs), 'a blocked or failed run can move the checkpoint: HELM would guess at a changed source');
c.check('checkpoint', /helm_integration_syncs_success_is_clean CHECK \(\s*outcome <> 'SUCCEEDED' OR jsonb_array_length\(quarantined\) = 0/.test(syncs), 'a run that quarantined a record can be recorded as SUCCEEDED');
c.check('outcomes', /outcome text NOT NULL CHECK \(outcome IN \('SUCCEEDED', 'PARTIAL', 'BLOCKED_BY_DRIFT', 'FAILED'\)\)/.test(syncs), 'the sync outcomes are not the four the runtime derives');
c.check('checkpoint-derived', !/\bcursor\s+text\b|checkpoint\s+text/.test(syncs) && /cursor_after text/.test(syncs), 'the checkpoint is stored as a mutable value instead of derived from the ledger');

const wb = m.table('helm_writeback_requests');
c.check('dry-run-only', /mode text NOT NULL CHECK \(mode = 'DRY_RUN'\)/.test(wb), 'the schema can store a live writeback: v1 writes nothing to an operational system');
c.check('nothing-sent', /helm_writeback_requests_nothing_sent CHECK \(\s*outcome <> 'WOULD_WRITE' OR \(receipt->>'sent' = 'false'/.test(wb), 'a dry run can claim that something was sent');
c.check('governed', /helm_writeback_requests_governed CHECK \(\s*outcome <> 'WOULD_WRITE' OR governance_state IN \('AUTHORIZED', 'APPROVED'\)/.test(wb), 'a request can be recorded as writable for a commitment governance does not permit');
c.check('refusal-says-why', /helm_writeback_requests_refusal_says_why CHECK/.test(wb), 'a refusal can be recorded without its reason');
c.check('idempotent', /helm_writeback_requests_unique_key UNIQUE \(org_id, idempotency_key\)/.test(wb), 'a request is not unique on its idempotency key');
c.check('explicit-intent', /action_intent_id uuid NOT NULL REFERENCES public\.helm_actions\(id\)/.test(wb), 'a request can exist without an explicit action intent');
c.check('by-reference', /commitment_id uuid NOT NULL REFERENCES public\.helm_decision_commitments\(id\) ON DELETE RESTRICT/.test(wb) && /decision_id uuid NOT NULL REFERENCES public\.helm_decisions\(id\) ON DELETE RESTRICT/.test(wb), 'a request does not reference the commitment and the decision it derives from');
const guard = m.fn('public\\.helm_writeback_requests_guard');
c.check('intent-of-commitment', /a\.commitment_id = NEW\.commitment_id/.test(guard) && /RAISE EXCEPTION/.test(guard), 'a write can derive from an intent of another commitment');
c.check('commitment-of-decision', /c\.decision_id = NEW\.decision_id/.test(guard), 'a request can name a commitment of another decision');

c.check('visibility', /helm_private\.can_see_decision\(decision_id\)/.test(m.policy('Scoped read writeback requests')), 'a writeback request is readable without seeing its decision');
c.check('insert-as-self', /requested_by = \(select auth\.uid\(\)\)/.test(m.sql) && /started_by = \(select auth\.uid\(\)\)/.test(m.sql), 'a sync or request can be recorded in someone else\'s name');
c.check('visibility-not-authority', !/authority_evaluation|can_approve|helm_authority/.test(m.sql.replace(/helm_private\.can_see_decision/g, '')), 'the writeback policies mix visibility with authority');
for (const ref of m.sql.matchAll(/REFERENCES public\.([a-z_]+)/g)) {
  c.check('memoire', ref[1].startsWith('helm_') || ref[1] === 'organizations', `the integration schema references ${ref[1]}, which HELM does not own: source systems are referenced by id, never by foreign key`);
}
c.check('additive', !/\b(DROP TABLE|DROP COLUMN|TRUNCATE\s+public)/i.test(m.sql) && !/ALTER TABLE public\.(?!helm_)/.test(m.sql), 'the migration alters or drops a table it does not own');

c.finish('2 append-only tables with database record time; a blocked run holds the checkpoint; DRY_RUN is the only mode and says nothing was sent; a write derives from an intent of its commitment, governed and idempotent; read by visibility, not authority');

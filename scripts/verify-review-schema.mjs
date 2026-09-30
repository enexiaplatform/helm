/**
 * verify:review-schema — the database says what ADR-0031 says.
 *
 *   - three append-only tables (review, item, closure), record time stamped by the database, RLS on;
 *   - a review is opened at a twin snapshot (two times, ordered) and fingerprinted; nothing is stored that the
 *     pack derives (no status, no score, no verdict, no summary of the enterprise);
 *   - an item is a REFERENCE to what already exists; only a QUESTION owns content; a role fits its kind;
 *   - a closure covers every item with exactly one disposition — resolved, carried forward or dropped — and says why;
 *   - a review follows a CLOSED review of the same scope; a closed review takes no more items;
 *   - a review is read whole or not at all: its classes are those of its opening snapshot, and an item follows the
 *     decision it belongs to;
 *   - row-based policy helpers only (INSERT … RETURNING works); nothing UPDATE-able by the client.
 */

import { contract } from './lib/twinStack.mjs';
import { appendOnly, loadMigration, noVerdictColumns } from './lib/schemaContract.mjs';

const c = contract('verify:review-schema');
const m = loadMigration(c, '20260930140000_helm_management_reviews.sql', 'management reviews');
const TABLES = ['helm_management_reviews', 'helm_management_review_items', 'helm_management_review_closures'];
appendOnly(c, m, TABLES, 'helm_review_record_guard');
noVerdictColumns(c, m, TABLES);

const reviews = m.table('helm_management_reviews');
c.check('cadence', /cadence text NOT NULL CHECK \(cadence IN \('WEEKLY', 'MONTHLY', 'QUARTERLY', 'STRATEGIC'\)\)/.test(reviews), 'the cadences are not weekly, monthly, quarterly and strategic');
c.check('two-times', /helm_management_reviews_opening_ordered CHECK \(opening_effective <= opening_recorded\)/.test(reviews), 'a review can be opened at a state that was not yet recorded');
c.check('opening-snapshot', /opening_snapshot_id uuid NOT NULL REFERENCES public\.helm_twin_snapshots\(id\) ON DELETE RESTRICT/.test(reviews), 'a review is not bound to the twin snapshot it opened at');
c.check('fingerprint', /preparation_fingerprint text NOT NULL/.test(reviews), 'a review does not store the fingerprint of its preparation pack');
c.check('scope', /scope jsonb NOT NULL CHECK \(scope->>'kind' IN \('ENTERPRISE', 'ENTITY'\)\)/.test(reviews), 'a review can be stored unscoped');
c.check('chain', /previous_review_id uuid REFERENCES public\.helm_management_reviews\(id\) ON DELETE RESTRICT/.test(reviews), 'reviews do not chain');
c.check('classes-derived', /sensitivity_classes text\[\] NOT NULL CHECK \(sensitivity_classes <@ ARRAY\['GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'\]\)/.test(reviews), 'a review can carry a class outside the five');
c.check('owner-is-a-label', /opened_by_label text NOT NULL/.test(reviews) && !/\b(chair|owner_id|attendees?)\b/i.test(reviews), 'a review stores who attended or who chairs it as data HELM could rank');
for (const forbidden of ['summary', 'agenda', 'minutes', 'health', 'outcome']) {
  c.check('no-narrative', !new RegExp(`^\\s*${forbidden}\\b`, 'm').test(reviews), `a review stores its own ${forbidden}: a review is a pack of references, not a second account of the enterprise`);
}

const items = m.table('helm_management_review_items');
c.check('by-reference', /ref jsonb CHECK \(ref IS NULL OR \(jsonb_typeof\(ref\) = 'object' AND ref \? 'id'\)\)/.test(items), 'an item can hold something other than a reference');
c.check('question-owns-content', /helm_management_review_items_question_owns_content CHECK \(\s*\(kind = 'QUESTION' AND ref IS NULL AND char_length\(btrim\(note\)\) >= 8 AND role = 'RAISED'\)\s*OR \(kind <> 'QUESTION' AND ref IS NOT NULL\)/.test(items), 'something other than a question can own content, or a reference can be empty');
c.check('role-fits-kind', /helm_management_review_items_role_fits CHECK/.test(items), 'a role can be attached to a kind it does not fit');
c.check('carry-forward', /carried_from_item_id uuid REFERENCES public\.helm_management_review_items\(id\) ON DELETE RESTRICT/.test(items), 'a carried-forward item does not point at the item it came from');
c.check('kinds', ['ATTENTION', 'DECISION', 'COMMITMENT', 'ASSUMPTION', 'ACTION_INTENT', 'EPISODE', 'PATTERN', 'LESSON', 'COUNTERFACTUAL_CASE', 'CAUSAL_CLAIM', 'QUESTION'].every((k) => items.includes(`'${k}'`)), 'the item kinds are not the eleven the kernel layers provide');
c.check('decision-follows', /decision_id uuid REFERENCES public\.helm_decisions\(id\) ON DELETE RESTRICT/.test(items), 'an item does not carry the decision its reference belongs to, so visibility could not follow it');

const closures = m.table('helm_management_review_closures');
c.check('one-closure', /review_id uuid NOT NULL UNIQUE REFERENCES public\.helm_management_reviews\(id\) ON DELETE RESTRICT/.test(closures), 'a review can be closed twice');
c.check('two-times', /helm_management_review_closures_closing_ordered CHECK \(closing_effective <= closing_recorded\)/.test(closures), 'a review can close at a state that was not yet recorded');
c.check('fingerprint', /closing_fingerprint text NOT NULL/.test(closures) && /closing_snapshot_id uuid NOT NULL REFERENCES public\.helm_twin_snapshots/.test(closures), 'a closure is not bound to a closing snapshot and fingerprint');
const closureGuard = m.fn('public\\.helm_management_review_closures_guard');
c.check('every-item-once', /<> 1/.test(closureGuard) && /d->>'itemId' = i\.id::text/.test(closureGuard), 'a closure can leave an item without a disposition, or give one two');
c.check('dispositions', /'RESOLVED', 'CARRIED_FORWARD', 'DROPPED'/.test(closureGuard) && /d->>'reason'/.test(closureGuard), 'a disposition can be something else, or come without a reason');
c.check('no-time-travel', /closing_recorded < rev\.opening_recorded/.test(closureGuard), 'a review can close before it opened');
const itemsGuard = m.fn('public\\.helm_management_review_items_guard');
c.check('closed-is-memory', /helm_management_review_closures c WHERE c\.review_id = NEW\.review_id/.test(itemsGuard) && /RAISE EXCEPTION/.test(itemsGuard), 'a closed review takes more items');
const reviewsGuard = m.fn('public\\.helm_management_reviews_guard');
c.check('chain-of-closed', /a review follows a closed review/.test(reviewsGuard) && /helm_management_review_closures c WHERE c\.review_id = prev\.id/.test(reviewsGuard), 'a review can follow one that is still open');
c.check('chain-same-scope', /prev\.scope->>'kind'/.test(reviewsGuard) && /entityId/.test(reviewsGuard), 'a review can follow a review of another scope');

// Read whole, by row — never by re-reading its own row by id in a policy.
const helper = m.fn('helm_private\\.review_row_visible');
c.check('read-whole', /NOT EXISTS \(SELECT 1 FROM unnest\(p_classes\) k WHERE NOT helm_private\.has_clearance\(p_org, k\)\)/.test(helper), 'a review is readable without holding every class it carries');
c.check('admin-reads-all', /has_org_role\(p_org, 'admin'\)/.test(helper), 'admins do not read every review');
const readReviews = m.policy('Scoped read management reviews');
c.check('row-based', /review_row_visible\(org_id, visibility, opened_by, granted_unit_ids, sensitivity_classes\)/.test(readReviews) && !/can_see_management_review\(id\)/.test(readReviews), 'the review read policy re-reads its own row by id (INSERT … RETURNING would fail)');
const readItems = m.policy('Scoped read management review items');
c.check('item-follows-review', /can_see_management_review\(review_id\)/.test(readItems) && /decision_id IS NULL OR helm_private\.can_see_decision\(decision_id\)/.test(readItems), 'an item is readable without its review, or without its decision');
c.check('opener-clearance', /NOT EXISTS \(SELECT 1 FROM unnest\(sensitivity_classes\) k WHERE NOT helm_private\.has_clearance\(org_id, k\)\)/.test(m.policy('Members open management reviews')), 'someone can open a review carrying a class they are not cleared for');
c.check('insert-as-self', /opened_by = \(select auth\.uid\(\)\)/.test(m.sql) && /added_by = \(select auth\.uid\(\)\)/.test(m.sql) && /closed_by = \(select auth\.uid\(\)\)/.test(m.sql), 'a review, item or closure can be recorded in someone else\'s name');
c.check('helpers-sealed', /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon/.test(m.sql), 'the private helpers are reachable by anon');
c.check('additive', !/\b(DROP TABLE|DROP COLUMN)\b/i.test(m.sql) && !/ALTER TABLE public\.(?!helm_)/.test(m.sql), 'the migration alters or drops a table it does not own');

c.finish('3 append-only tables with database record time; a review of references opened at a twin snapshot; only a question owns content; a closure covers every item once, resolved, carried forward or dropped, and says why; follows a closed review of the same scope; read whole or not at all; visibility follows the decision');

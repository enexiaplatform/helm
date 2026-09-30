/**
 * Shared checks for the schema contracts of the layers above the kernel (integration, reviews, AI audit).
 * They all state the same six things about their tables, so a layer cannot quietly weaken one:
 *   append-only · record time stamped by the database · RLS on · no UPDATE/DELETE/ALL policy ·
 *   authenticated holds SELECT and INSERT only · nothing is granted to anon or PUBLIC.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadMigration(c, file, what) {
  const path = join(process.cwd(), 'supabase', 'migrations', file);
  c.check('migration', existsSync(path), `the ${what} migration (${file}) is missing`);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const sql = raw.replace(/--[^\r\n]*/g, ' ');
  const table = (name) => new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${name} \\(([\\s\\S]*?)\\r?\\n\\);`).exec(sql)?.[1] ?? '';
  const fn = (name) => new RegExp(`FUNCTION ${name}\\([\\s\\S]*?\\$fn\\$([\\s\\S]*?)\\$fn\\$`).exec(sql)?.[1] ?? '';
  const policy = (name) => new RegExp(`CREATE POLICY "${name}"[\\s\\S]*?;`).exec(sql)?.[0] ?? '';
  return { raw, sql, table, fn, policy };
}

/** The properties every append-only HELM record table shares. */
export function appendOnly(c, m, tables, recordGuard) {
  for (const t of tables) {
    c.check('tables', m.table(t).length > 0, `${t} is not created`);
    c.check('rls', new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(m.sql), `${t} does not enable RLS`);
    c.check('append-only', new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${t} FOR EACH ROW EXECUTE FUNCTION public\\.${recordGuard}\\(\\)`).test(m.sql), `${t} is not guarded write-once`);
    c.check('record-time', /recorded_at timestamptz NOT NULL DEFAULT now\(\)/.test(m.table(t)), `${t} has no record time defaulted by the database`);
    c.check('no-mutating-policy', !new RegExp(`ON public\\.${t}\\s+FOR (DELETE|UPDATE|ALL)`).test(m.sql), `${t} has an UPDATE, DELETE or ALL policy`);
    c.check('grants', new RegExp(`REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE[^;]*\\bpublic\\.${t}\\b[^;]*FROM authenticated`).test(m.sql), `${t} lets authenticated UPDATE, DELETE or TRUNCATE`);
    c.check('grants', new RegExp(`GRANT SELECT, INSERT ON TABLE[^;]*\\bpublic\\.${t}\\b[^;]*TO authenticated`).test(m.sql), `${t} does not grant authenticated exactly SELECT and INSERT`);
    c.check('grants', new RegExp(`REVOKE ALL ON TABLE[^;]*\\bpublic\\.${t}\\b[^;]*FROM anon, PUBLIC`).test(m.sql), `${t} is reachable by anon or PUBLIC`);
  }
  const guard = m.fn(`public\\.${recordGuard}`);
  c.check('append-only', /TG_OP <> 'INSERT'[\s\S]*RAISE EXCEPTION/.test(guard), `${recordGuard} does not refuse UPDATE and DELETE`);
  c.check('record-time', /NEW\.recorded_at := now\(\);/.test(guard), `${recordGuard} does not stamp the record time: a client could back-date memory`);
}

/** Columns that would make a table hold a verdict, a score or a stored derived status. */
export function noVerdictColumns(c, m, tables, extra = []) {
  for (const t of tables) {
    for (const col of ['status', 'quality', 'score', 'rating', 'verdict', 'rank', 'regret', 'probability', 'winner', ...extra]) {
      c.check('derived-not-stored', !new RegExp(`^\\s*${col}\\b`, 'm').test(m.table(t)), `${t} stores a ${col}: it is derived at a lens, or it is not HELM's to say`);
    }
    c.check('no-person-dimension', !/\b(performance|rated_by|ranking|leaderboard)\b/i.test(m.table(t)), `${t} has a column about a person's standing`);
  }
}

import type { Scope } from '@helm/shared';
import { resolveIntelligenceContext } from './intelligenceRuntime.ts';
import { resolveGovernanceContext } from './authorityRuntime.ts';
import { resolveIntegrationContext } from './integrationRuntime.ts';

/**
 * The demo organization is built once per tab, whole, before any page reads it.
 *
 * Each layer of the demo story records its own decisions and acts when it is first resolved, so a page that resolved
 * only part of the stack saw part of the story (audit 2026-10-13: Decisions opened by its address listed one decision;
 * opened from the Cockpit, five; Memory said "one commitment on record"). Building it in one order, the order the
 * Cockpit always used, makes every page read the same organization however it is reached.
 */
let ready: Promise<void> | null = null;

export function prepareDemoWorld(scope: Scope): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await resolveIntelligenceContext('demo', scope);
      await resolveGovernanceContext('demo', scope);
      await resolveIntegrationContext('demo', scope).catch(() => null);
    })();
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

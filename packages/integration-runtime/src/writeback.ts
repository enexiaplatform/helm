/**
 * Governed writeback — HELM → an operational system, DRY_RUN only in v1.
 *
 *   HELM commitment → action intent → (governance permits) → writeback request
 *
 * A request can only derive from an ACTION INTENT of a committed decision; there
 * is no way to ask the gateway to write something that was not first a
 * management intent. It is refused unless the commitment's governance state
 * permits execution (AUTHORIZED or APPROVED) — visibility is not authority, and
 * an intent is not permission. The request carries an idempotency key, so
 * dispatching twice is one request.
 *
 * Nothing is ever sent. A DRY_RUN records what a live write WOULD have been, in
 * the target's own words. The action intent's status and hand-off reference are
 * not touched: nothing was handed over.
 */

import type { DecisionStore } from '@helm/decision-runtime';
import type { AuthorityRuntime } from '@helm/authority-runtime';
import { fail, fnv1a64, ok, type Result, type Scope, type SourceSystem } from '@helm/shared';
import type { IntegrationStore, WritebackAdapter, WritebackDescription } from './port.ts';
import { IntegrationErrors, type WritebackRequest } from './types.ts';

const EXECUTABLE_STATES = ['AUTHORIZED', 'APPROVED'] as const;

export type DispatchInput = {
  readonly commitmentId: string;
  /** Only this intent; default: every intent of the commitment whose target has an adapter. */
  readonly actionIntentId?: string;
  /** Anything but DRY_RUN is refused in v1. */
  readonly mode?: string;
};

export type DispatchResult = {
  readonly requests: readonly (WritebackRequest & { readonly replayed: boolean })[];
  /** Intents left alone, and why. An intent aimed at a system with no adapter is not an error. */
  readonly skipped: readonly { readonly actionIntentId: string; readonly targetSystem: string; readonly reason: string }[];
};

export interface WritebackGateway {
  dispatch(scope: Scope, input: DispatchInput): Promise<Result<DispatchResult>>;
  list(scope: Scope, commitmentId?: string): Promise<Result<readonly WritebackRequest[]>>;
}

export type WritebackGatewayDeps = {
  readonly decisions: DecisionStore;
  readonly authority: AuthorityRuntime;
  readonly store: IntegrationStore;
  readonly adapters: readonly WritebackAdapter[];
};

export function createWritebackGateway(deps: WritebackGatewayDeps): WritebackGateway {
  const { decisions, authority, store, adapters } = deps;
  return {
    async dispatch(scope, input) {
      if ((input.mode ?? 'DRY_RUN') !== 'DRY_RUN') {
        return fail(IntegrationErrors.LIVE_WRITEBACK_DISABLED, 'HELM v1 writes nothing to an operational system. Only DRY_RUN is available; a live mode is a separate, explicitly authorized decision.');
      }
      const commitment = await decisions.getCommitment(scope, input.commitmentId);
      if (!commitment.ok) return commitment;
      if (!commitment.value) return fail(IntegrationErrors.NOT_FOUND, 'No such commitment.');
      const gov = await authority.getGovernanceState(scope, input.commitmentId);
      if (!gov.ok) return gov;
      const intents = await decisions.listActionIntents(scope, input.commitmentId);
      if (!intents.ok) return intents;
      const chosen = input.actionIntentId ? intents.value.filter((i) => i.id === input.actionIntentId) : intents.value;
      if (input.actionIntentId && chosen.length === 0) return fail(IntegrationErrors.NO_INTENT, 'That action intent is not part of this commitment: a write derives only from an explicit execution intent.');
      if (chosen.length === 0) return fail(IntegrationErrors.NO_INTENT, 'This commitment records no action intent: there is nothing to derive a request from.');

      const requests: (WritebackRequest & { replayed: boolean })[] = [];
      const skipped: { actionIntentId: string; targetSystem: string; reason: string }[] = [];
      for (const intent of chosen) {
        const adapter = adapters.find((a) => a.system === (intent.targetSystem as SourceSystem));
        if (!adapter) {
          skipped.push({ actionIntentId: intent.id, targetSystem: intent.targetSystem, reason: `No writeback adapter is connected for "${intent.targetSystem}".` });
          continue;
        }
        const operation = 'CREATE_ACTION';
        const payload = {
          title: intent.title,
          detail: intent.detail,
          owner: intent.ownerLabel,
          dueDate: intent.dueDate,
          helm: { decisionId: intent.decisionId, commitmentId: intent.commitmentId, actionIntentId: intent.id, commitmentFingerprint: commitment.value.fingerprint },
        };
        const payloadHash = fnv1a64(JSON.stringify(payload));
        const idempotencyKey = `wb_${fnv1a64(`${intent.id}|${adapter.system}|${operation}|${payloadHash}`)}`;
        const prior = await store.findWriteback(scope, idempotencyKey);
        if (!prior.ok) return prior;
        if (prior.value) {
          requests.push({ ...prior.value, replayed: true });
          continue;
        }
        let outcome: WritebackRequest['outcome'] = 'WOULD_WRITE';
        let refusalReason: string | null = null;
        let receipt: Record<string, unknown> = {};
        if (!(EXECUTABLE_STATES as readonly string[]).includes(gov.value.state)) {
          outcome = 'REFUSED';
          refusalReason = `Governance state is ${gov.value.state}: a commitment that is not authorized or approved cannot be executed in another system.`;
        } else if (!adapter.supportedOperations.includes(operation)) {
          outcome = 'REFUSED';
          refusalReason = `${adapter.system} does not support ${operation}.`;
        } else {
          const d = adapter.describe(operation, payload);
          if (!d.ok) {
            outcome = 'REFUSED';
            refusalReason = d.error.message;
          } else {
            const desc: WritebackDescription = d.value;
            receipt = { dryRun: true, sent: false, endpoint: desc.endpoint, method: desc.method, body: desc.body, note: 'Nothing was sent. This is what a live write would have been.' };
          }
        }
        const inserted = await store.insertWriteback(scope, {
          commitmentId: intent.commitmentId,
          decisionId: intent.decisionId,
          actionIntentId: intent.id,
          targetSystem: adapter.system,
          operation,
          payload,
          payloadHash,
          idempotencyKey,
          mode: 'DRY_RUN',
          outcome,
          refusalReason,
          receipt,
          governanceState: gov.value.state,
          requestedBy: scope.actorId,
        });
        if (!inserted.ok) {
          // A racing dispatch of the same key: the ledger held the first; return it.
          if (inserted.error.code === IntegrationErrors.DUPLICATE) {
            const again = await store.findWriteback(scope, idempotencyKey);
            if (again.ok && again.value) {
              requests.push({ ...again.value, replayed: true });
              continue;
            }
          }
          return inserted;
        }
        requests.push({ ...inserted.value, replayed: false });
      }
      return ok({ requests, skipped });
    },

    list: (scope, commitmentId) => store.listWritebacks(scope, commitmentId ? { commitmentId } : undefined),
  };
}

/** Memoire as a write TARGET: describes the action a live write would create in Memoire's `actions`. Sends nothing. */
export function createMemoireWritebackAdapter(): WritebackAdapter {
  return {
    system: 'memoire',
    supportedOperations: ['CREATE_ACTION'],
    describe(operation, payload) {
      if (operation !== 'CREATE_ACTION') return fail(IntegrationErrors.INVALID, `Memoire does not support ${operation}.`);
      return ok({
        endpoint: 'memoire.actions',
        method: 'INSERT',
        body: { title: payload['title'], notes: payload['detail'], owner_label: payload['owner'], due_date: payload['dueDate'], origin: 'helm', origin_ref: payload['helm'] },
      });
    },
  };
}

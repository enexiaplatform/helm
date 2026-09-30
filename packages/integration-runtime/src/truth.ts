/**
 * Source Truth beside Model Truth.
 *
 * One value node can hold what the source system said (ACTUAL, FORECAST,
 * TARGET — each naming its system) and what HELM's model estimated or derived
 * (ESTIMATE, DERIVED). This read lays them side by side. It never picks one,
 * never averages them and never says which is "right": a Memoire probability of
 * 45% and a model estimate of 20% are two statements by two different parties.
 */

import type { ValueGraph, ObservationType, ValueObservation } from '@helm/value-graph';
import { ok, type Result, type Scope } from '@helm/shared';

export type TruthReading = {
  readonly type: ObservationType;
  readonly value: string | null;
  readonly unit: string;
  readonly currency: string | null;
  readonly sourceSystem: string;
  readonly observedAt: string | null;
  readonly observationId: string;
  /** Where in the source the fact came from, when recorded by an ingestion. */
  readonly sourceField: string | null;
};

export type SourceAndModel = {
  readonly nodeId: string;
  readonly source: readonly TruthReading[];
  readonly model: readonly TruthReading[];
  readonly assumption: TruthReading | null;
  readonly statement: string;
};

const SOURCE_TYPES: readonly ObservationType[] = ['ACTUAL', 'FORECAST', 'TARGET'];
const MODEL_TYPES: readonly ObservationType[] = ['ESTIMATE', 'DERIVED'];

const reading = (o: ValueObservation): TruthReading => ({
  type: o.observationType,
  value: o.numericValue === null ? o.textValue : String(o.numericValue),
  unit: o.unitType,
  currency: o.currency,
  sourceSystem: o.sourceSystem,
  observedAt: o.observedAt,
  observationId: o.id,
  sourceField: typeof o.metadata?.['sourceField'] === 'string' ? (o.metadata['sourceField'] as string) : null,
});

export async function sourceAndModel(valueGraph: ValueGraph, scope: Scope, nodeId: string, asOf?: string): Promise<Result<SourceAndModel>> {
  const latest = async (type: ObservationType) => {
    const r = await valueGraph.getLatestObservation(scope, { nodeId, type, scenarioEntityId: null, ...(asOf ? { asOf } : {}) });
    return r.ok && r.value ? reading(r.value) : null;
  };
  const source = (await Promise.all(SOURCE_TYPES.map(latest))).filter((x): x is TruthReading => x !== null);
  const model = (await Promise.all(MODEL_TYPES.map(latest))).filter((x): x is TruthReading => x !== null);
  const assumption = await latest('ASSUMPTION');
  return ok({
    nodeId,
    source,
    model,
    assumption,
    statement:
      source.length > 0 && model.length > 0
        ? 'The source system and the model each say something about this value. They are shown side by side: neither overwrites the other, and HELM does not say which is right.'
        : source.length > 0
          ? 'Only the source system says anything about this value; it is source truth, not a model result.'
          : model.length > 0
            ? 'Only a model result exists for this value; no source system has stated it.'
            : 'Nothing has been recorded for this value.',
  });
}

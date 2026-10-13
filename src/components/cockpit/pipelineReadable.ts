import { isCleared, sensitivityOfMetric, type PipelineReadable, type TwinViewer } from '@helm/twin-runtime';

/** Which commercial readings this reader is cleared for at this instant: a reading above clearance is withheld, not absent. */
export function pipelineReadable(viewer: TwinViewer | null, at: string): PipelineReadable {
  if (!viewer) return { value: true, probability: true };
  return {
    value: isCleared(viewer, sensitivityOfMetric('OpportunityValue'), at),
    probability: isCleared(viewer, sensitivityOfMetric('OpportunityProbability'), at),
  };
}

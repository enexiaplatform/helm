import type { Process, ProcessActivity } from '../types.ts';

/**
 * Capacity engine: process-level managerial diagnosis. Capacity per activity,
 * utilization against demand, the bottleneck, achievable throughput, and
 * Little's Law flow time. This is diagnosis, not BPM.
 */

export type ActivityAnalysis = {
  activityId: string;
  name: string;
  ownerLabel: string;
  /** Units the activity can complete per week given its resources. */
  weeklyCapacity: number;
  /** Demand ÷ capacity. Above 1 the activity cannot keep up. */
  utilization: number | null;
  isBottleneck: boolean;
};

export type ProcessAnalysis = {
  processId: string;
  activities: ActivityAnalysis[];
  /** Weekly units the whole process can deliver = bottleneck capacity. */
  processCapacityPerWeek: number | null;
  bottleneckActivityId: string | null;
  /** min(demand, capacity): what actually flows. */
  flowRatePerWeek: number | null;
  utilization: number | null;
  /** Sum of processing + waiting minutes across the path. */
  totalFlowTimeMinutes: number;
  /** Little's Law: average WIP = flow rate × flow time. */
  avgWorkInProcess: number | null;
};

export function analyzeProcess(process: Process, activities: ProcessActivity[]): ProcessAnalysis {
  const sorted = [...activities].sort((a, b) => a.sort - b.sort);

  const analyzed: ActivityAnalysis[] = sorted.map((a) => {
    const weeklyCapacity =
      a.processingMinutes > 0
        ? (a.availableMinutesPerWeek * a.resourcesCount) / a.processingMinutes
        : Infinity;
    return {
      activityId: a.id,
      name: a.name,
      ownerLabel: a.ownerLabel,
      weeklyCapacity,
      utilization:
        weeklyCapacity > 0 && Number.isFinite(weeklyCapacity)
          ? process.demandPerWeek / weeklyCapacity
          : null,
      isBottleneck: false,
    };
  });

  const finite = analyzed.filter((a) => Number.isFinite(a.weeklyCapacity));
  let bottleneckActivityId: string | null = null;
  let processCapacity: number | null = null;
  if (finite.length > 0) {
    const min = finite.reduce((m, a) => (a.weeklyCapacity < m.weeklyCapacity ? a : m));
    bottleneckActivityId = min.activityId;
    processCapacity = min.weeklyCapacity;
    for (const a of analyzed) a.isBottleneck = a.activityId === bottleneckActivityId;
  }

  const flowRate =
    processCapacity !== null ? Math.min(process.demandPerWeek, processCapacity) : process.demandPerWeek;

  const totalFlowTimeMinutes = sorted.reduce(
    (s, a) => s + a.processingMinutes + a.waitMinutes,
    0,
  );

  // Little's Law with consistent units: WIP = throughput/week × flow time in weeks.
  const minutesPerWeek = 7 * 24 * 60;
  const avgWorkInProcess =
    flowRate > 0 ? flowRate * (totalFlowTimeMinutes / minutesPerWeek) : null;

  return {
    processId: process.id,
    activities: analyzed,
    processCapacityPerWeek: processCapacity,
    bottleneckActivityId,
    flowRatePerWeek: flowRate,
    utilization: processCapacity !== null && processCapacity > 0 ? process.demandPerWeek / processCapacity : null,
    totalFlowTimeMinutes,
    avgWorkInProcess,
  };
}

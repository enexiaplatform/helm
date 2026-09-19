import type { InventoryItem } from '../types.ts';

/**
 * Inventory-as-capital engine: service level, stock-out and expiry risk,
 * order policy, and the working-capital arithmetic (DOI/DSO/DPO → CCC).
 */

/** Inverse standard normal CDF (Acklam's rational approximation, |err| < 1.2e-9). */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be in (0,1)');
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export type InventoryAnalysis = {
  safetyStock: number;
  reorderPoint: number;
  daysOfInventory: number | null;
  daysUntilStockout: number | null;
  /** True when projected stock (on hand + inbound) cannot cover lead-time demand. */
  stockoutRisk: boolean;
  /** Days of demand that stock exceeds remaining shelf life — expiry exposure. */
  expiryExposureUnits: number | null;
  expiryExposureValue: number | null;
  eoq: number | null;
  capitalTiedUp: number;
};

export function analyzeInventoryItem(
  item: InventoryItem,
  defaultServiceLevel = 0.95,
  today = new Date(),
): InventoryAnalysis {
  const serviceLevel = item.serviceLevel ?? defaultServiceLevel;
  const z = inverseNormalCdf(serviceLevel);

  // Demand uncertainty over the replenishment lead time.
  const safetyStock =
    item.leadTimeDays > 0 ? z * item.demandStddev * Math.sqrt(item.leadTimeDays) : 0;
  const reorderPoint = item.avgDailyDemand * item.leadTimeDays + safetyStock;

  const daysOfInventory =
    item.avgDailyDemand > 0 ? item.stockOnHand / item.avgDailyDemand : null;
  const daysUntilStockout =
    item.avgDailyDemand > 0
      ? (item.stockOnHand + item.stockInbound) / item.avgDailyDemand
      : null;

  const stockoutRisk =
    item.avgDailyDemand > 0 &&
    item.stockOnHand + item.stockInbound < reorderPoint;

  let expiryExposureUnits: number | null = null;
  let expiryExposureValue: number | null = null;
  if (item.expiryDate && item.avgDailyDemand > 0) {
    const msPerDay = 24 * 3600 * 1000;
    const daysToExpiry = Math.max(
      0,
      Math.floor((new Date(item.expiryDate).getTime() - today.getTime()) / msPerDay),
    );
    const sellableBeforeExpiry = daysToExpiry * item.avgDailyDemand;
    expiryExposureUnits = Math.max(0, item.stockOnHand - sellableBeforeExpiry);
    expiryExposureValue = expiryExposureUnits * item.unitCost;
  }

  // EOQ needs an order cost and a holding cost; both optional inputs.
  let eoq: number | null = null;
  const annualDemand = item.avgDailyDemand * 365;
  const holdingCostPerUnit = (item.holdingCostRate ?? 0) * item.unitCost;
  if (item.orderCost && holdingCostPerUnit > 0 && annualDemand > 0) {
    eoq = Math.sqrt((2 * annualDemand * item.orderCost) / holdingCostPerUnit);
  }

  return {
    safetyStock,
    reorderPoint,
    daysOfInventory,
    daysUntilStockout,
    stockoutRisk,
    expiryExposureUnits,
    expiryExposureValue,
    eoq,
    capitalTiedUp: item.stockOnHand * item.unitCost,
  };
}

export type WorkingCapitalInputs = {
  annualRevenue: number;
  annualCogs: number;
  inventoryValue: number;
  receivables: number;
  payables: number;
};

export type WorkingCapitalResult = {
  doi: number | null;
  dso: number | null;
  dpo: number | null;
  cashConversionCycleDays: number | null;
  inventoryTurnover: number | null;
  workingCapital: number;
};

export function analyzeWorkingCapital(i: WorkingCapitalInputs): WorkingCapitalResult {
  const doi = i.annualCogs > 0 ? (i.inventoryValue / i.annualCogs) * 365 : null;
  const dso = i.annualRevenue > 0 ? (i.receivables / i.annualRevenue) * 365 : null;
  const dpo = i.annualCogs > 0 ? (i.payables / i.annualCogs) * 365 : null;
  const ccc = doi !== null && dso !== null && dpo !== null ? doi + dso - dpo : null;
  return {
    doi,
    dso,
    dpo,
    cashConversionCycleDays: ccc,
    inventoryTurnover: i.inventoryValue > 0 && i.annualCogs > 0 ? i.annualCogs / i.inventoryValue : null,
    workingCapital: i.inventoryValue + i.receivables - i.payables,
  };
}

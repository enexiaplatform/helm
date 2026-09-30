/**
 * Tenancy: who the organization is and who is in it.
 *
 * Everything else HELM shows is a view of the kernels (@helm/*): decisions, scenarios, the twin, the
 * causal graph, the genome, counterfactual worlds, reviews, sources and the AI layer. The pre-kernel
 * management apps — signals, cost objects, economics rows, inventory and process maps — are retired:
 * attention is HELM's rules over the twin, margins are the value graph's, capacity and inventory are the
 * twin's. No page invents its own meaning for those things.
 */

export const orgRoles = ['admin', 'manager', 'member', 'viewer'] as const;
export type OrgRole = (typeof orgRoles)[number];

export const orgRoleRank: Record<OrgRole, number> = {
  admin: 4,
  manager: 3,
  member: 2,
  viewer: 1,
};

export type Organization = {
  id: string;
  name: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  role: OrgRole;
};

export const orgUnitTypes = [
  'company',
  'business_unit',
  'division',
  'department',
  'region',
  'country',
  'territory',
  'team',
] as const;
export type OrgUnitType = (typeof orgUnitTypes)[number];

export type OrgUnit = {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  unitType: OrgUnitType;
};

export type OrgMember = {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
};

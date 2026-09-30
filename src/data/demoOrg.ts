import type { OrgMember, OrgUnit, Organization } from '../domain/types.ts';

/**
 * The demo organization shell: Meridian Life Sciences Vietnam, a B2B life-science and food-ingredient
 * distributor. Deterministic, in-memory, and never synced to the cloud (the ecosystem's sample-data rule).
 *
 * This is only WHO the tenant is. The demonstration enterprise itself — its value graph, the Rohto decision,
 * its twin, causal claims, genome, counterfactual worlds, reviews, connected Memoire and AI readings — is
 * built by the kernels, labelled DEMO at its source (packages/*\/src/meridian*.ts and src/services/*Runtime.ts).
 */

export const DEMO_ORG_ID = 'demo-org';
export const DEMO_USER_ID = 'demo-user';

export const demoOrganization: Organization = {
  id: DEMO_ORG_ID,
  name: 'Meridian Life Sciences Vietnam',
  baseCurrency: 'VND',
  fiscalYearStartMonth: 1,
  role: 'admin',
};

export const demoMembers: OrgMember[] = [
  { userId: DEMO_USER_ID, email: 'you@meridian.example', displayName: 'You — Country Manager', role: 'admin' },
  { userId: 'demo-lan', email: 'lan.pham@meridian.example', displayName: 'Lan Pham — Pharma Sales Manager', role: 'manager' },
  { userId: 'demo-minh', email: 'minh.tran@meridian.example', displayName: 'Minh Tran — Technical Service Lead', role: 'manager' },
  { userId: 'demo-thu', email: 'thu.nguyen@meridian.example', displayName: 'Thu Nguyen — Finance', role: 'member' },
];

export const demoUnits: OrgUnit[] = [
  { id: 'unit-vn', orgId: DEMO_ORG_ID, parentId: null, name: 'Vietnam', unitType: 'country' },
  { id: 'unit-pharma', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Pharma Sales', unitType: 'team' },
  { id: 'unit-fnb', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'F&B Ingredients Sales', unitType: 'team' },
  { id: 'unit-service', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Technical Service', unitType: 'team' },
  { id: 'unit-ops', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Operations', unitType: 'department' },
];

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

// The same people and units the demo's governance, twin and reviews are read as (audit 2026-10-13: Settings listed a
// different cast and different units from Governance and the "Read as" readers of the same organization).
export const demoMembers: OrgMember[] = [
  { userId: DEMO_USER_ID, email: 'you@meridian.example', displayName: 'You — Organization admin (demo)', role: 'admin' },
  { userId: 'demo-mai', email: 'mai.nguyen@meridian.example', displayName: 'Nguyen Thi Mai — Country GM Vietnam', role: 'manager' },
  { userId: 'demo-hoa', email: 'hoa.le@meridian.example', displayName: 'Le Thi Hoa — Finance Director Vietnam', role: 'manager' },
  { userId: 'demo-trang', email: 'trang.hoang@meridian.example', displayName: 'Hoang Thu Trang — Commercial Director Vietnam', role: 'manager' },
  { userId: 'demo-huy', email: 'huy.vo@meridian.example', displayName: 'Vo Quang Huy — Industrial BU Head Vietnam', role: 'manager' },
  { userId: 'demo-chau', email: 'chau.pham@meridian.example', displayName: 'Pham Minh Chau — Pharma Commercial Analyst Vietnam', role: 'member' },
];

export const demoUnits: OrgUnit[] = [
  { id: 'unit-meridian', orgId: DEMO_ORG_ID, parentId: null, name: 'Meridian Life Sciences', unitType: 'company' },
  { id: 'unit-sea', orgId: DEMO_ORG_ID, parentId: 'unit-meridian', name: 'Southeast Asia', unitType: 'region' },
  { id: 'unit-vn', orgId: DEMO_ORG_ID, parentId: 'unit-sea', name: 'Vietnam', unitType: 'country' },
  { id: 'unit-vn-pharma', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Vietnam Pharma BU', unitType: 'business_unit' },
  { id: 'unit-vn-industrial', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Vietnam Industrial BU', unitType: 'business_unit' },
  { id: 'unit-vn-finance', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Vietnam Finance', unitType: 'department' },
  { id: 'unit-vn-commercial', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Vietnam Commercial', unitType: 'department' },
];

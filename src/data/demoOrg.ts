import { MERIDIAN_DEMO_PEOPLE, MERIDIAN_DEMO_USERS } from '@helm/authority-runtime';
import type { OrgMember, OrgUnit, OrgUnitMembership, Organization } from '../domain/types.ts';

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
// 2026-10-17: the members carry the same user ids the demo's decisions, governance and readers are recorded under, so
// the Organization page can say who stands behind what (they were 'demo-mai'…, and the commercial director had another name).
const P = MERIDIAN_DEMO_PEOPLE;
const U = MERIDIAN_DEMO_USERS;
export const demoMembers: OrgMember[] = [
  { userId: DEMO_USER_ID, email: 'you@meridian.example', displayName: 'You — Organization admin (demo)', role: 'admin' },
  { userId: U.countryGM, email: 'mai.nguyen@meridian.example', displayName: `${P.countryGM} — Country GM Vietnam`, role: 'manager' },
  { userId: U.commercialDirector, email: 'binh.tran@meridian.example', displayName: `${P.commercialDirector} — Commercial Director Vietnam`, role: 'manager' },
  { userId: U.financeDirector, email: 'hoa.le@meridian.example', displayName: `${P.financeDirector} — Finance Director Vietnam`, role: 'manager' },
  { userId: U.regionalMD, email: 'daniel.tan@meridian.example', displayName: `${P.regionalMD} — Regional MD Southeast Asia`, role: 'manager' },
  { userId: U.industrialHead, email: 'huy.vo@meridian.example', displayName: `${P.industrialHead} — Industrial BU Head Vietnam`, role: 'manager' },
  { userId: U.pharmaAnalyst, email: 'chau.pham@meridian.example', displayName: `${P.pharmaAnalyst} — Pharma Commercial Analyst Vietnam`, role: 'member' },
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

/** Who belongs to which demo unit — the same seats the authority runtime's demo membership names. */
export const demoUnitMemberships: OrgUnitMembership[] = [
  { userId: U.countryGM, unitId: 'unit-vn', isManager: true },
  { userId: U.commercialDirector, unitId: 'unit-vn-commercial', isManager: true },
  { userId: U.financeDirector, unitId: 'unit-vn-finance', isManager: true },
  { userId: U.regionalMD, unitId: 'unit-sea', isManager: true },
  { userId: U.industrialHead, unitId: 'unit-vn-industrial', isManager: true },
  { userId: U.pharmaAnalyst, unitId: 'unit-vn-pharma', isManager: false },
];

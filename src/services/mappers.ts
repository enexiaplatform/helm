import type { OrgUnit } from '../domain/types.ts';

/** snake_case DB rows ↔ camelCase domain objects. One direction per shape;
 * writes construct row objects explicitly at the call site. */

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const sn = (v: unknown) => (typeof v === 'string' ? v : null);

export function mapOrgUnit(r: Row): OrgUnit {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    parentId: sn(r.parent_id),
    name: s(r.name),
    unitType: s(r.unit_type) as OrgUnit['unitType'],
  };
}

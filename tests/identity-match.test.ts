// PR B identity tools (read-only): normalisation, evidence/conflicts, verdict,
// duplicate clusters, the bounded queries sent upstream (assert the FILTERS),
// the candidate resolver's company↔contact linking, and the search_* identity
// mode leaving plain mode untouched. Nothing here may ever create a record.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import {
  clusters, companyClusterKeys, companyEvidence, companySearchToken, contactClusterKeys, contactEvidence, domainOf, isFreeMailDomain,
  normalizeCompanyName, normalizePhone, splitPersonName, verdict,
} from '../src/utils/identity-match';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

describe('normalisation', () => {
  test('company names, search token, person names, phones, domains, free mail', () => {
    expect(normalizeCompanyName('The Edge Estimates, LLC.')).toBe('edge estimates');
    expect(normalizeCompanyName('EDGE ESTIMATES INC')).toBe('edge estimates');
    expect(companySearchToken('The Edge Estimates, LLC.')).toBe('estimates');
    expect(splitPersonName('Daniel Lee')).toEqual({ first: 'daniel', last: 'lee' });
    expect(splitPersonName('Lee, Daniël')).toEqual({ first: 'daniel', last: 'lee' });
    expect(splitPersonName('Cher')).toBeNull();
    expect(normalizePhone('+1 (555) 123-4567')).toBe('5551234567');
    expect(normalizePhone('ext 12')).toBeNull();
    expect(domainOf('Marketing.Edge@Mail.Edge.com')).toBe('mail.edge.com');
    expect(domainOf('https://www.edge.com/contact')).toBe('edge.com');
    expect(isFreeMailDomain(domainOf('marketing.edgeestimate4@gmail.com'))).toBe(true);
  });
});

describe('evidence, conflicts, verdict, clusters', () => {
  const contact = { id: 1, firstName: 'Daniel', lastName: 'Lee', emailAddress: 'dan@edge.com', emailAddress2: 'd.lee@edge.com', companyID: 100, isActive: 1 };

  test('contact: exact email (primary or secondary), name, phone; mismatched email and inactive are conflicts', () => {
    expect(contactEvidence(contact, { email: 'D.LEE@edge.com' }).evidence).toEqual([{ kind: 'email_exact', strength: 'strong', detail: 'secondary email' }]);
    const byName = contactEvidence(contact, { name: 'Daniel Lee', email: 'marketing.edgeestimate4@gmail.com', companyIDs: [100] });
    expect(byName.evidence.map((e) => e.kind)).toEqual(['name_exact', 'company_consistent']);
    expect(byName.conflicts.map((c) => c.field)).toEqual(['email']);
    expect(contactEvidence({ ...contact, isActive: 0 }, { email: 'dan@edge.com' }).conflicts.map((c) => c.field)).toEqual(['isActive']);
    expect(contactEvidence(contact, { email: 'dan@edge.com', companyIDs: [999] }).conflicts.map((c) => c.field)).toEqual(['companyID']);
  });

  test('company: normalized name, web domain (never a consumer domain), phone, number; inactive flagged', () => {
    const c = { id: 100, companyName: 'Edge Estimates, LLC', webAddress: 'https://www.edge.com', phone: '(555) 123-4567', companyNumber: 'C-9', isActive: false };
    const ev = companyEvidence(c, { name: 'edge estimates', domain: 'dan@edge.com', phone: '555.123.4567', companyNumber: 'c-9' });
    expect(ev.evidence.map((e) => e.kind)).toEqual(['name_exact', 'web_domain', 'phone', 'company_number']);
    expect(ev.conflicts.map((x) => x.field)).toEqual(['isActive']);
    expect(companyEvidence(c, { domain: 'gmail.com' }).evidence).toEqual([]);
  });

  test('verdict: matched / decisive name+company / ambiguous (tie, conflict) / unmatched', () => {
    const E = (kind: string, strength: 'strong' | 'medium' | 'weak') => ({ kind, strength, detail: '' });
    expect(verdict([{ evidence: [E('email_exact', 'strong'), E('name_exact', 'medium')], conflicts: [] }])).toMatchObject({ verdict: 'matched', confidence: 'high' });
    expect(verdict([{ evidence: [E('name_exact', 'medium'), E('company_consistent', 'weak')], conflicts: [] }])).toMatchObject({ verdict: 'matched', confidence: 'medium' });
    expect(verdict([{ evidence: [E('email_exact', 'strong')], conflicts: [] }, { evidence: [E('email_exact', 'strong')], conflicts: [] }]).verdict).toBe('ambiguous'); // exact-email duplicates
    expect(verdict([{ evidence: [E('name_exact', 'medium'), E('company_consistent', 'weak')], conflicts: [{ field: 'email', detail: 'differs' }] }])).toMatchObject({ verdict: 'ambiguous', reason: expect.stringMatching(/conflicting/) });
    expect(verdict([{ evidence: [E('name_partial', 'weak')], conflicts: [] }]).verdict).toBe('ambiguous');
    expect(verdict([]).verdict).toBe('unmatched');
  });

  test('duplicate clusters: same normalized name / domain; same email across contacts', () => {
    const cos = [{ id: 1, companyName: 'Edge Estimates LLC', webAddress: 'edge.com' }, { id: 2, companyName: 'Edge Estimates', webAddress: null }, { id: 3, companyName: 'Other', webAddress: 'www.edge.com' }];
    expect(clusters(cos, companyClusterKeys)).toEqual([{ key: 'name:edge estimates', ids: [1, 2] }, { key: 'domain:edge.com', ids: [1, 3] }]);
    const cts = [{ id: 7, emailAddress: 'a@x.com', companyID: 1, lastName: 'Lee', firstName: 'D' }, { id: 8, emailAddress: 'A@X.com', companyID: 2, lastName: 'Lee', firstName: 'D' }];
    expect(clusters(cts, contactClusterKeys)).toEqual([{ key: 'email:a@x.com', ids: [7, 8] }]);
  });
});

function mk(rowsBy: (entity: string, filter: any[]) => any[]) {
  const s = new AutotaskService(config, logger);
  const query = jest.fn(async (entity: string, filter: any[]) => rowsBy(entity, filter));
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, create: jest.fn(), update: jest.fn() });
  jest.spyOn(s, 'getPicklistValues').mockResolvedValue([{ value: '1', label: 'Customer', isDefaultValue: false, sortOrder: 0, isActive: true, isSystem: false }]);
  jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[30, 'Owner One']]));
  jest.spyOn(s, 'getCompanyNamesByIds').mockImplementation(async (ids: number[]) => ids.map((id) => ({ id, companyName: `Co ${id}` })));
  return { s, query };
}

describe('findContacts — filters sent upstream', () => {
  test('email: OR across all 3 fields; EVERY exact-email duplicate returned; inactive included', async () => {
    const { s, query } = mk(() => [
      { id: 1, firstName: 'Dan', lastName: 'Lee', emailAddress: 'dan@edge.com', companyID: 100, isActive: 1, createDate: '2026-01-01' },
      { id: 2, firstName: 'Daniel', lastName: 'Lee', emailAddress2: 'dan@edge.com', companyID: 200, isActive: 0, createDate: '2026-10-01' },
    ]);
    const r: any = await s.findContacts({ email: 'Dan@Edge.com' });
    expect(query.mock.calls[0]![1]).toEqual([{ op: 'or', items: ['emailAddress', 'emailAddress2', 'emailAddress3'].map((f) => ({ op: 'eq', field: f, value: 'dan@edge.com' })) }]);
    expect(r.candidates.map((c: any) => c.id).sort()).toEqual([1, 2]);
    expect(r.clusters).toEqual([{ key: 'email:dan@edge.com', ids: [1, 2] }]);
    expect(r.candidates.find((c: any) => c.id === 2).conflicts.map((c: any) => c.field)).toEqual(['isActive']);
  });

  test('name → lastName eq + firstName initial; phone → contains last 4 across 3 phone fields (compared on digits)', async () => {
    const { s, query } = mk((_e, f) => (f[0].field === 'lastName' ? [{ id: 5, firstName: 'Daniel', lastName: 'Lee', companyID: 1, isActive: 1 }, { id: 6, firstName: 'Dora', lastName: 'Lee', companyID: 1, isActive: 1 }]
      : [{ id: 9, firstName: 'X', lastName: 'Y', phone: '555-999-4567', isActive: 1 }, { id: 10, firstName: 'P', lastName: 'Q', mobilePhone: '(555) 123-4567', isActive: 1 }]));
    const r: any = await s.findContacts({ name: 'Daniel Lee', phone: '+1 555 123 4567' });
    expect(query.mock.calls[0]![1]).toEqual([{ op: 'eq', field: 'lastName', value: 'lee' }, { op: 'beginsWith', field: 'firstName', value: 'd' }]);
    expect(query.mock.calls[1]![1]).toEqual([{ op: 'or', items: ['phone', 'mobilePhone', 'alternatePhone'].map((f) => ({ op: 'contains', field: f, value: '4567' })) }]);
    expect(r.candidates.map((c: any) => c.id)).toEqual([5, 10]); // Dora (name mismatch) and the wrong full number dropped
  });
});

describe('findCompanies — filters sent upstream', () => {
  test('a consumer email domain is never used to match companies', async () => {
    const { s, query } = mk(() => []);
    const r: any = await s.findCompanies({ domain: 'gmail.com' });
    expect(query).not.toHaveBeenCalled();
    expect(r.domain).toMatchObject({ value: 'gmail.com', freeMail: true });
  });

  test('name token + web domain + contacts-with-that-domain → companies in; inactive kept; type/owner labelled', async () => {
    const { s, query } = mk((e, f) => {
      if (e === 'Contacts') return [{ id: 1, companyID: 300 }, { id: 2, companyID: 300 }];
      if (f[0].field === 'companyName') return [{ id: 100, companyName: 'Edge Estimates LLC', isActive: false, companyType: 1, ownerResourceID: 30 }];
      if (f[0].field === 'webAddress') return [{ id: 200, companyName: 'EE Holdings', webAddress: 'edge.com', isActive: true }];
      return [{ id: 300, companyName: 'Edge Sales', isActive: true }];
    });
    const r: any = await s.findCompanies({ name: 'The Edge Estimates', domain: 'edge.com' });
    expect(query.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['Companies', [{ op: 'contains', field: 'companyName', value: 'estimates' }]],
      ['Companies', [{ op: 'contains', field: 'webAddress', value: 'edge.com' }]],
      ['Contacts', [{ op: 'endsWith', field: 'emailAddress', value: '@edge.com' }]],
      ['Companies', [{ op: 'in', field: 'id', value: [300] }]],
    ]);
    const byId = Object.fromEntries(r.candidates.map((c: any) => [c.id, c]));
    expect(byId[100]).toMatchObject({ isActive: false, companyType: { value: 1, label: 'Customer' }, owner: { id: 30, name: 'Owner One' } });
    expect(byId[100].evidence.map((e: any) => e.kind)).toEqual(['name_exact']);
    expect(byId[200].evidence.map((e: any) => e.kind)).toEqual(['web_domain']);
    expect(byId[300].evidence).toEqual([
      { kind: 'contact_email_domain', strength: 'medium', detail: '2 contact(s) with @edge.com email' },
      { kind: 'name_token', strength: 'weak', detail: 'shares "edge"' }, // "Edge Sales" vs "edge estimates"
    ]);
  });
});

describe('findCompanyContactCandidates', () => {
  test('gmail sender: person matched by email, company reached through the contact; never writes', async () => {
    const { s, query } = mk((e, f) => {
      if (e === 'Contacts' && f[0].op === 'or') return [{ id: 7, firstName: 'Daniel', lastName: 'Lee', emailAddress: 'marketing.edgeestimate4@gmail.com', companyID: 500, isActive: 1 }];
      if (e === 'Contacts') return [];
      if (e === 'Companies' && f[0].field === 'companyName') return [{ id: 500, companyName: 'Edge Estimates', isActive: true }, { id: 501, companyName: 'Edge Estimates Inc', isActive: true }];
      return [];
    });
    const r: any = await s.findCompanyContactCandidates({ companyName: 'Edge Estimates', contactName: 'Daniel Lee', email: 'marketing.edgeestimate4@gmail.com' });
    expect(r.readOnly).toBe(true);
    expect(r.emailDomain).toEqual({ value: 'gmail.com', freeMail: true });
    expect(r.notes[0]).toMatch(/identifies the PERSON, not the company/);
    expect(r.contact).toMatchObject({ verdict: 'matched' });
    expect(r.contact.candidates[0].evidence.map((e: any) => e.kind)).toEqual(['email_exact', 'name_exact', 'company_consistent']);
    // Two companies share the normalized name; the contact's link breaks the tie.
    expect(r.company.candidates[0]).toMatchObject({ id: 500 });
    expect(r.company.candidates[0].evidence.map((e: any) => e.kind)).toEqual(['name_exact', 'linked_contact']);
    expect(r.company.duplicateClusters).toEqual([{ key: 'name:edge estimates', ids: [500, 501] }]);
    expect(query.mock.calls.every((c) => c[0] === 'Contacts' || c[0] === 'Companies')).toBe(true);
  });
});

describe('search_* identity mode via the handler; plain mode untouched', () => {
  test('plain search_companies still calls searchCompanies; identity params route to findCompanies; bad companyType → choices', async () => {
    const { s } = mk(() => []);
    const plain = jest.spyOn(s, 'searchCompanies').mockResolvedValue({ items: [], page: 1, pageSize: 25, hasMore: false });
    const find = jest.spyOn(s, 'findCompanies').mockResolvedValue({ candidates: [], clusters: [], queries: [] });
    const h = new AutotaskToolHandler(s, logger);
    await h.callTool('autotask_search_companies', { searchTerm: 'edge' });
    expect(plain).toHaveBeenCalled();
    await h.callTool('autotask_search_companies', { name: 'Edge', companyType: 'customer', isActive: true });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ name: 'Edge', companyType: 1, isActive: true }));
    const bad = JSON.parse((await h.callTool('autotask_search_companies', { name: 'Edge', companyType: 'Martian' })).content[0].text);
    expect(bad.message).toMatch(/companyType "Martian" not found\. Choices: 1 = Customer/);
  });

  test('search_contacts: firstName+lastName and numeric isActive map into identity mode', async () => {
    const { s } = mk(() => []);
    const find = jest.spyOn(s, 'findContacts').mockResolvedValue({ candidates: [], clusters: [], queries: [] });
    await new AutotaskToolHandler(s, logger).callTool('autotask_search_contacts', { firstName: 'Daniel', lastName: 'Lee', companyID: 5, isActive: 0 });
    expect(find).toHaveBeenCalledWith({ email: undefined, name: 'Daniel Lee', phone: undefined, companyID: 5, isActive: false });
  });

  test('get_company verifies a user-supplied ID with creation metadata', async () => {
    const { s } = mk(() => []);
    jest.spyOn(s, 'getCompanyFull').mockResolvedValue({ company: { companyName: 'Spam Account', isActive: true, createDate: '2020-01-01' }, labels: { companyType: 'Customer' }, names: { ownerResourceID: { name: 'Owner One' }, createdByResourceID: { name: 'Admin' } }, udfs: [] });
    const msg = JSON.parse((await new AutotaskToolHandler(s, logger).callTool('autotask_get_company', { companyID: 29684631 })).content[0].text).message;
    expect(msg).toBe('Company 29684631: "Spam Account" — active, Customer, owner Owner One, created 2020-01-01 by Admin');
  });
});

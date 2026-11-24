// Work types by name (voice / chat: "priority remote", "remote priority work"):
// the matcher, operator aliases, and the time-entry tools resolving a named
// work type before any write. A loose match is never assumed — it comes back as
// a suggestion with the similar work types, for the person to confirm.
// Service mocked.

import { matchWorkType, matchWorkTypeForClient, parseWorkTypeAliases, parseWorkTypeRegions, regionOf, workTypeWords, type WorkTypeRef } from '../src/utils/work-type-match';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const TYPES: WorkTypeRef[] = [
  { id: 101, name: 'Remote Support', active: true },
  { id: 102, name: 'Remote Support - Priority', active: true },
  { id: 103, name: 'Onsite Support', active: true },
  { id: 104, name: 'Onsite Support - Priority', active: true },
  { id: 105, name: 'After Hours Remote', active: true },
  { id: 106, name: 'Bench Work', active: false },
];

describe('matchWorkType', () => {
  test.each([
    ['remote support', 101, 'exact'],
    ['Remote Support - Priority', 102, 'exact'],
    ['support remote', 101, 'words'],
    ['priority onsite support', 104, 'words'],
    ['on-site support', 103, 'words'],
    ['after-hours remote work', 105, 'words'],
    ['102', 102, 'id'],
  ])('"%s" → %d (%s)', (spoken, id, via) => {
    const m = matchWorkType(TYPES, spoken);
    expect(m).toEqual(expect.objectContaining({ ok: true, id, via }));
  });

  test.each(['priority remote', 'remote priority', 'Remote priority work'])('"%s" is NOT assumed — a suggestion to confirm, with the similar ones', (spoken) => {
    const m = matchWorkType(TYPES, spoken);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.reason).toBe('confirm');
    expect(m.suggested).toEqual({ id: 102, name: 'Remote Support - Priority' });
    expect(m.similar).toBe(true);
    // Suggested first, then everything sharing a word, closest first.
    expect(m.choices.map((c) => c.id)).toEqual([102, 105, 101, 104]);
  });

  test('a word shared by several work types is ambiguous, with only those as choices', () => {
    const m = matchWorkType(TYPES, 'priority');
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.reason).toBe('ambiguous');
    expect(m.choices.map((c) => c.id)).toEqual([104, 102]);
  });

  test('"onsite" alone is ambiguous, the plain one listed first', () => {
    const m = matchWorkType(TYPES, 'onsite');
    expect(m).toEqual(expect.objectContaining({ ok: false, reason: 'ambiguous' }));
    if (!m.ok) expect(m.choices.map((c) => c.id)).toEqual([103, 104]);
  });

  test('an inactive work type never matches by name or id — it says inactive', () => {
    expect(matchWorkType(TYPES, 'bench work')).toEqual(expect.objectContaining({ ok: false, reason: 'inactive' }));
    expect(matchWorkType(TYPES, '106')).toEqual(expect.objectContaining({ ok: false, reason: 'inactive' }));
  });

  test('unknown but sharing a word → only the similar ones', () => {
    const m = matchWorkType(TYPES, 'remote consulting');
    expect(m).toEqual(expect.objectContaining({ ok: false, reason: 'unknown', similar: true }));
    if (!m.ok) expect(m.choices.map((c) => c.id)).toEqual([105, 101, 102]);
  });

  test('unknown with nothing similar → every active work type', () => {
    const m = matchWorkType(TYPES, 'consulting');
    expect(m).toEqual(expect.objectContaining({ ok: false, reason: 'unknown', similar: false }));
    if (!m.ok) expect(m.choices).toHaveLength(5);
  });

  test('aliases win, in any word order, and point by label or id', () => {
    const aliases = parseWorkTypeAliases('{"rush": "Onsite Support - Priority", "urgent remote": 102}');
    expect(matchWorkType(TYPES, 'rush', aliases)).toEqual(expect.objectContaining({ ok: true, id: 104, via: 'alias' }));
    expect(matchWorkType(TYPES, 'Remote Urgent', aliases)).toEqual(expect.objectContaining({ ok: true, id: 102, via: 'alias' }));
  });

  test('the key=value form parses too', () => {
    const aliases = parseWorkTypeAliases('rush=Onsite Support - Priority; hot remote = 102');
    expect(matchWorkType(TYPES, 'rush', aliases)).toEqual(expect.objectContaining({ ok: true, id: 104 }));
    expect(matchWorkType(TYPES, 'remote hot', aliases)).toEqual(expect.objectContaining({ ok: true, id: 102 }));
  });

  test('an alias to a work type the tenant lacks is reported, not guessed', () => {
    const m = matchWorkType(TYPES, 'rush', parseWorkTypeAliases('rush=Emergency Dispatch'));
    expect(m).toEqual(expect.objectContaining({ ok: false, reason: 'unknown', badAlias: 'Emergency Dispatch' }));
  });

  test('"service" and "support" are the same word (real labels: "Remote~Priority Service")', () => {
    const real: WorkTypeRef[] = [
      { id: 1, name: 'Remote Support', active: true },
      { id: 2, name: 'Remote~Priority Service', active: true },
      { id: 3, name: 'Remote~Emergency Support', active: true },
      { id: 4, name: 'CT - Priority', active: true },
    ];
    expect(matchWorkType(real, 'priority remote support')).toEqual(expect.objectContaining({ ok: true, id: 2, via: 'words' }));
    expect(matchWorkType(real, 'remote priority service')).toEqual(expect.objectContaining({ ok: true, id: 2 }));
    expect(matchWorkType(real, 'priority remote')).toEqual(expect.objectContaining({ ok: false, reason: 'confirm', suggested: { id: 2, name: 'Remote~Priority Service' } }));
    expect(matchWorkType(real, 'remote')).toEqual(expect.objectContaining({ ok: false, reason: 'ambiguous' }));
  });

  test('the similar list is capped at 8', () => {
    const many: WorkTypeRef[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Remote Thing ${i + 1}`, active: true }));
    const m = matchWorkType(many, 'remote');
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.choices).toHaveLength(8);
  });

  test('filler and spoken variants are folded', () => {
    expect(workTypeWords('On-Site work type')).toEqual(['onsite']);
    expect(workTypeWords('remotely, after hours')).toEqual(['remote', 'afterhour']);
  });
});

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');
const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };
const ROLES = [{ roleID: 7, roleName: 'Engineer', isActive: true, roleExists: true }];

function mk() {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s, 'getWorkTypes').mockResolvedValue(TYPES);
  jest.spyOn(s, 'getResourceRoles').mockResolvedValue(ROLES as any);
  jest.spyOn(s, 'getBillingCode').mockImplementation(async (id: number) => {
    const t = TYPES.find((w) => w.id === id);
    return t ? ({ id, name: t.name, useType: 1, isActive: t.active } as any) : null;
  });
  jest.spyOn(s, 'getTimeEntry').mockResolvedValue(null);
  jest.spyOn(s, 'getResource').mockResolvedValue(null);
  return s;
}

describe('time-entry tools take a work type by name', () => {
  const base = { resourceID: 1001, ticketID: 2002, roleID: 7, dateWorked: '2026-11-23', hoursWorked: 1, summaryNotes: 'Remote fix' };
  afterEach(() => { delete process.env.AUTOTASK_WORK_TYPE_ALIASES; });

  test('create_time_entry: "priority remote" asks to confirm — suggestion + similar list, nothing written', async () => {
    const s = mk();
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'priority remote' }));
    expect(create).not.toHaveBeenCalled();
    expect(b.data).toEqual(expect.objectContaining({ status: 'needs_confirmation', reason: 'confirm', suggested: { id: 102, name: 'Remote Support - Priority' }, similar: true }));
    expect(b.message).toContain('Did you mean "Remote Support - Priority" (102)?');
    expect(b.message).toContain('1. Remote Support - Priority (102); 2. After Hours Remote (105)');
    expect(b.message).toContain('Nothing was written');
  });

  test('confirmed (the exact name) → written, and the message names it', async () => {
    const s = mk();
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'Remote Support - Priority' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ billingCodeID: 102 }));
    expect(create.mock.calls[0]![0]).not.toHaveProperty('workType');
    expect(b.message).toContain('work type Remote Support - Priority');
  });

  test('a label sent in billingCodeID is matched the same way', async () => {
    const s = mk();
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, billingCodeID: 'support remote' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ billingCodeID: 101 }));
    expect(b.message).toContain('work type Remote Support (from "support remote")');
  });

  test('ambiguous → a numbered list of the candidates, nothing written', async () => {
    const s = mk();
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'priority' }));
    expect(create).not.toHaveBeenCalled();
    expect(b.data).toEqual(expect.objectContaining({ status: 'needs_confirmation', reason: 'ambiguous' }));
    expect(b.message).toContain('1. Onsite Support - Priority (104); 2. Remote Support - Priority (102)');
    expect(b.message).toContain('Ask the person which one');
  });

  test('workType and a different billingCodeID → refused', async () => {
    const s = mk();
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'remote support', billingCodeID: 103 }));
    expect(create).not.toHaveBeenCalled();
    expect(b.data.reason).toBe('conflict');
  });

  test('log_my_time uses the operator alias', async () => {
    process.env.AUTOTASK_WORK_TYPE_ALIASES = 'rush=Onsite Support - Priority';
    const s = mk();
    const log = jest.spyOn(s, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 5 } as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_log_my_time', { ...base, workType: 'rush' }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ billingCodeID: 104 }));
    expect(b.message).toContain('Onsite Support - Priority');
  });

  test('update_time_entry resolves a named work type', async () => {
    const s = mk();
    const upd = jest.spyOn(s, 'updateTimeEntry').mockResolvedValue(undefined as any);
    await new AutotaskToolHandler(s, logger).callTool('autotask_update_time_entry', { id: 77, workType: 'remote support priority' });
    expect(upd).toHaveBeenCalledWith(77, expect.objectContaining({ billingCodeID: 102 }));
    expect(upd.mock.calls[0]![1]).not.toHaveProperty('workType');
  });

  test('list_work_types shows aliases and tests a spoken name', async () => {
    process.env.AUTOTASK_WORK_TYPE_ALIASES = '{"rush": 104, "gone": "Nope"}';
    const s = mk();
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_list_work_types', { name: 'priority remote' }));
    expect(b.data.workTypes).toHaveLength(5);
    expect(b.data.workTypes.find((w: any) => w.id === 104).aliases).toEqual(['rush']);
    expect(b.data.match).toEqual(expect.objectContaining({ ok: false, reason: 'confirm', suggested: { id: 102, name: 'Remote Support - Priority' } }));
    expect(b.message).toContain('did you mean Remote Support - Priority');
    expect(b.data.brokenAliases).toEqual([{ alias: 'gone', target: 'Nope' }]);
  });
});

// Regional copies of work types (a state tax rule): the CLIENT'S state decides, never the words.
const REGIONAL: WorkTypeRef[] = [
  { id: 1, name: 'Remote Support', active: true },
  { id: 2, name: 'Remote~Priority Service', active: true },
  { id: 3, name: 'Onsite~Priority Service', active: true },
  { id: 4, name: 'Travel', active: true },
  { id: 11, name: 'NY - Priority', active: true },
  { id: 12, name: 'NY - Emergency', active: true },
  { id: 13, name: 'NY - Standard', active: true },
  { id: 21, name: 'TX - Standard', active: true },
];
const RULES = parseWorkTypeRegions('NY=NY,New York; TX=TX');
const none = new Map<string, string>();

describe('regional work types (AUTOTASK_WORK_TYPE_REGIONS)', () => {
  test('parses both forms; a label prefix finds its region', () => {
    expect(RULES).toEqual([{ prefix: 'NY', words: ['ny'], places: ['ny', 'new york'] }, { prefix: 'TX', words: ['tx'], places: ['tx'] }]);
    expect(parseWorkTypeRegions('{"NY": ["NY", "New York"]}')[0]!.places).toEqual(['ny', 'new york']);
    expect(regionOf('NY - Priority', RULES)!.prefix).toBe('NY');
    expect(regionOf('Remote Support', RULES)).toBeNull();
    expect(parseWorkTypeRegions('')).toEqual([]);
  });

  test('no rules → unchanged behaviour', () => {
    expect(matchWorkTypeForClient(REGIONAL, 'priority remote', none, [], 'NY')).toEqual(matchWorkType(REGIONAL, 'priority remote'));
  });

  test('client outside every region: regional work types are never offered', () => {
    const m = matchWorkTypeForClient(REGIONAL, 'priority remote', none, RULES, 'MA');
    expect(m).toEqual(expect.objectContaining({ ok: false, reason: 'confirm', suggested: { id: 2, name: 'Remote~Priority Service' } }));
    if (!m.ok) expect(m.choices.map((c) => c.id).filter((id) => id > 10)).toEqual([]);
    expect(matchWorkTypeForClient(REGIONAL, 'standard', none, RULES, 'MA')).toEqual(expect.objectContaining({ ok: false, reason: 'unknown' }));
  });

  test('client in a region: its work types, prefix ignored', () => {
    expect(matchWorkTypeForClient(REGIONAL, 'priority', none, RULES, 'New York')).toEqual(expect.objectContaining({ ok: true, id: 11, name: 'NY - Priority' }));
    expect(matchWorkTypeForClient(REGIONAL, 'standard', none, RULES, 'ny')).toEqual(expect.objectContaining({ ok: true, id: 13 }));
    const m = matchWorkTypeForClient(REGIONAL, 'priority remote', none, RULES, 'NY');
    expect(m).toEqual(expect.objectContaining({ ok: false, reason: 'confirm', suggested: { id: 11, name: 'NY - Priority' } }));
    if (!m.ok) {
      expect(m.choices.map((c) => c.id)).toEqual([11, 12, 13]);
      expect((m as any).regionNote).toContain('only NY work types apply');
    }
  });

  test('client in a region, nothing regional fits: an ordinary work type only to confirm', () => {
    const m = matchWorkTypeForClient(REGIONAL, 'travel', none, RULES, 'NY');
    expect(m).toEqual(expect.objectContaining({ ok: false, reason: 'confirm', suggested: { id: 4, name: 'Travel' } }));
    expect((m as any).regionNote).toContain('is not a NY work type');
  });

  test('state unknown: a regional match is only a suggestion; ordinary ones work as before', () => {
    const m = matchWorkTypeForClient(REGIONAL, 'standard', none, RULES, null);
    expect(m.ok).toBe(false); // two regional "Standard"s, nothing used
    expect(matchWorkTypeForClient(REGIONAL, 'emergency', none, RULES, null)).toEqual(expect.objectContaining({ ok: false, reason: 'confirm', suggested: { id: 12, name: 'NY - Emergency' } }));
    expect(matchWorkTypeForClient(REGIONAL, 'remote support', none, RULES, null)).toEqual(expect.objectContaining({ ok: true, id: 1 }));
  });

  test('naming the prefix, an id or an alias is explicit', () => {
    expect(matchWorkTypeForClient(REGIONAL, 'NY emergency', none, RULES, 'MA')).toEqual(expect.objectContaining({ ok: true, id: 12 }));
    expect(matchWorkTypeForClient(REGIONAL, '2', none, RULES, 'NY')).toEqual(expect.objectContaining({ ok: true, id: 2 }));
    expect(matchWorkTypeForClient(REGIONAL, 'rush', parseWorkTypeAliases('rush=2'), RULES, 'NY')).toEqual(expect.objectContaining({ ok: true, id: 2 }));
  });
});

describe('time-entry tools pick regional work types by the ticket client', () => {
  const base = { resourceID: 1001, ticketID: 2002, roleID: 7, dateWorked: '2026-11-23', hoursWorked: 1, summaryNotes: 'Fix' };
  afterEach(() => { delete process.env.AUTOTASK_WORK_TYPE_REGIONS; });
  function mkRegional(state: string | null) {
    process.env.AUTOTASK_WORK_TYPE_REGIONS = 'NY=NY,New York';
    const s = mk();
    jest.spyOn(s, 'getWorkTypes').mockResolvedValue(REGIONAL);
    jest.spyOn(s, 'getBillingCode').mockImplementation(async (id: number) => {
      const t = REGIONAL.find((w) => w.id === id);
      return t ? ({ id, name: t.name, useType: 1, isActive: true } as any) : null;
    });
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 2002, companyID: 0 } as any); // company 0 is a real company
    const co = jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 0, state } as any);
    return { s, co };
  }

  test('client in the region: "priority" is written as the regional work type', async () => {
    const { s, co } = mkRegional('New York');
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'priority' }));
    expect(co).toHaveBeenCalledWith(0);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ billingCodeID: 11 }));
    expect(b.message).toContain('work type NY - Priority (from "priority")');
  });

  test('client in the region: "remote support" is not written — confirm, with the regional choices', async () => {
    const { s } = mkRegional('NY');
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'remote support' }));
    expect(create).not.toHaveBeenCalled();
    expect(b.data).toEqual(expect.objectContaining({ status: 'needs_confirmation', clientState: 'NY', suggested: { id: 1, name: 'Remote Support' } }));
    expect(b.message).toContain('is not a NY work type');
  });

  test('client elsewhere: "priority remote" suggests only ordinary work types', async () => {
    const { s } = mkRegional('MA');
    jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'priority remote' }));
    expect(b.data.suggested).toEqual({ id: 2, name: 'Remote~Priority Service' });
    expect(b.data.choices.some((c: any) => c.name.startsWith('NY'))).toBe(false);
  });

  test('client state unknown: a regional match is not written', async () => {
    const { s } = mkRegional(null);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(9 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'emergency' }));
    expect(create).not.toHaveBeenCalled();
    expect(b.message).toContain('state is not known');
  });

  test('update_time_entry takes the client from the entry ticket', async () => {
    const { s } = mkRegional('NY');
    (s.getTimeEntry as jest.Mock).mockResolvedValue({ id: 77, ticketID: 2002 });
    const upd = jest.spyOn(s, 'updateTimeEntry').mockResolvedValue(undefined as any);
    await new AutotaskToolHandler(s, logger).callTool('autotask_update_time_entry', { id: 77, workType: 'standard' });
    expect(upd).toHaveBeenCalledWith(77, expect.objectContaining({ billingCodeID: 13 }));
  });

  test('no fit at all: the spoken list names at most 8 and counts the rest', async () => {
    const { s } = mkRegional('MA');
    const many: WorkTypeRef[] = Array.from({ length: 12 }, (_, i) => ({ id: 300 + i, name: `Thing ${i + 1}`, active: true }));
    (s.getWorkTypes as jest.Mock).mockResolvedValue(many);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, workType: 'zebra' }));
    expect(b.data.choices).toHaveLength(12);
    expect(b.message).toContain('8. Thing 8 (307); and 4 more');
    expect(b.message).not.toContain('Thing 9');
  });

  test('list_work_types shows regions and matches for a ticket', async () => {
    const { s } = mkRegional('NY');
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_list_work_types', { name: 'emergency', ticketID: 2002 }));
    expect(b.data.workTypes.find((w: any) => w.id === 12).region).toEqual({ prefix: 'NY', states: ['ny', 'new york'] });
    expect(b.data.workTypes.find((w: any) => w.id === 1).region).toBeUndefined();
    expect(b.data.clientState).toBe('NY');
    expect(b.data.match).toEqual(expect.objectContaining({ ok: true, id: 12 }));
  });
});

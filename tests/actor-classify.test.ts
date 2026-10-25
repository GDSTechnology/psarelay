// MCP-001: human vs automation actor classification, with provenance, the
// operator registry, and reference technicians. Unknown is never silently
// human; this MCP's own writes (n8n / Nexus) are a service account.

import { classifyActor, parseRegistry, parseReference, registryLineProblem, referenceLineProblem, type ClassifyContext } from '../src/utils/actor-classify';
import { coerceSetting, setOverride, _resetSettings } from '../src/admin/settings';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';

afterEach(() => { _resetSettings(); jest.restoreAllMocks(); });

const ctx = (over: Partial<ClassifyContext> = {}): ClassifyContext => ({
  resources: new Map([
    [30, { id: 30, firstName: 'Pat', lastName: 'Tech', email: 'pat@gds.example', isActive: true, licenseType: 1 }],
    [31, { id: 31, firstName: 'Old', lastName: 'Timer', email: 'old@gds.example', isActive: false, licenseType: 1 }],
    [40, { id: 40, firstName: 'Datto', lastName: 'RMM', email: 'rmm@gds.example', isActive: true, licenseType: 7 }],
    [41, { id: 41, firstName: 'Blackpoint', lastName: 'Alerts', email: 'bp@gds.example', isActive: true, licenseType: 1 }],
    [50, { id: 50, firstName: 'Mcp', lastName: 'Api', email: 'mcp@gds.example', isActive: true, licenseType: 7 }],
    [4, { id: 4, firstName: 'Autotask', lastName: 'Administrator', isActive: true, licenseType: 1 }],
  ]),
  mcpApiUserId: 50, apiLicenseValue: 7, registry: new Map(), reference: new Map(), ...over,
});

describe('classifyActor', () => {
  test('rules with provenance', () => {
    const c = ctx();
    expect(classifyActor(30, c)).toMatchObject({ actorType: 'human', classificationSource: 'licensed-user', displayName: 'Pat Tech', reference: false });
    expect(classifyActor(31, c)).toMatchObject({ actorType: 'human', isActive: false }); // inactive people are still people
    expect(classifyActor(40, c)).toMatchObject({ actorType: 'integration', classificationSource: 'license-api-user' });
    expect(classifyActor(41, c)).toMatchObject({ actorType: 'unknown', classificationSource: 'name-suggests-automation' }); // licensed, but looks like a bot
    expect(classifyActor(50, c)).toMatchObject({ actorType: 'service_account', classificationSource: 'mcp-api-user' }); // n8n / Nexus writes
    expect(classifyActor(4, c)).toMatchObject({ actorType: 'system', classificationSource: 'system-resource' });
    expect(classifyActor(999, c)).toMatchObject({ actorType: 'unknown', classificationSource: 'not-found' });
    expect(classifyActor(null, c)).toMatchObject({ actorType: 'unknown', classificationSource: 'no-actor' });
  });

  test('the registry overrides everything; reference technicians are people', () => {
    const c = ctx({ registry: parseRegistry(['41=integration:Blackpoint', '30=service_account']), reference: parseReference(['31=Old Timer']) });
    expect(classifyActor(41, c)).toMatchObject({ actorType: 'integration', classificationSource: 'registry' });
    expect(classifyActor(30, c)).toMatchObject({ actorType: 'service_account', classificationSource: 'registry' });
    expect(classifyActor(31, c)).toMatchObject({ actorType: 'human', reference: true, classificationSource: 'registry' });
  });

  test('settings lines are validated', () => {
    expect(registryLineProblem('512=integration:Datto RMM')).toBeNull();
    expect(registryLineProblem('512=robot')).toMatch(/type must be one of/);
    expect(registryLineProblem('abc=human')).toMatch(/must be a number/);
    expect(referenceLineProblem('29682885')).toBeNull();
    expect(referenceLineProblem('Pat')).toMatch(/resourceId/);
    expect(coerceSetting('actors.registry', '512=integration\n\n513=human:Pat')).toEqual(['512=integration', '513=human:Pat']);
    expect(() => coerceSetting('actors.reference', ['x'])).toThrow(/resourceId/);
  });
});

describe('roster + ticket history', () => {
  const svc = () => {
    const s = new AutotaskService({ name: 't', version: '0', autotask: { username: 'mcp@gds.example', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } }, new Logger('error'));
    const rows = [...ctx().resources.values()];
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({
      query: jest.fn(async (entity: string) => {
        if (entity === 'Resources') return rows;
        if (entity === 'TicketHistory') return [
          { id: 1, date: '2026-10-09T10:00:00Z', action: 'Edited', detail: 'Status changed from New to In Progress', resourceID: 30 },
          { id: 2, date: '2026-10-09T10:01:00Z', action: 'Edited', detail: 'Priority changed from Low to High', resourceID: 50 },
          { id: 3, date: '2026-10-09T10:02:00Z', action: 'Edited', detail: 'Status changed from In Progress to Complete', resourceID: 40 },
        ];
        return [];
      }),
      get: jest.fn(async () => null),
    });
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([{ name: 'licenseType', picklistValues: [{ value: '7', label: 'API User' }] }] as any);
    jest.spyOn(s, 'resolveApiUserResourceId').mockResolvedValue(50);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map());
    return s;
  };

  test('roster: types, counts, reference from the console setting; inactive hidden by default', async () => {
    setOverride('actors.reference', ['30']);
    const r = await svc().getActorRoster() as any;
    expect(r.counts).toEqual({ human: 1, integration: 1, service_account: 1, system: 1, unknown: 1 });
    expect(r.referenceCount).toBe(1);
    expect(r.actors.find((a: any) => a.resourceId === 30)).toMatchObject({ actorType: 'human', reference: true });
    expect(r.actors.some((a: any) => a.resourceId === 31)).toBe(false);
  });

  test('history events carry actorType / provenance / reference; counts by type', async () => {
    setOverride('actors.reference', ['30']);
    const h = await svc().getTicketHistoryEvents(1) as any;
    expect(h.events.map((e: any) => [e.actor.resourceID, e.actor.actorType, e.actor.reference])).toEqual([[30, 'human', true], [50, 'service_account', false], [40, 'integration', false]]);
    expect(h.counts.byActorType).toEqual({ human: 1, service_account: 1, integration: 1 });
  });
});

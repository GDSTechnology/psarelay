// #5 — get_time_entry_targets: open tasks (exclude completed) + non-complete
// assigned tickets for a resource, with project names + searchTerm filter. Mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const mk = () => new AutotaskService(config, new Logger('error'));

describe('getTimeEntryTargets', () => {
  test('queries open tasks (exclude completed) + non-complete tickets; resolves project names', async () => {
    const s = mk();
    const query = jest.fn().mockImplementation(async (entity: string) => {
      if (entity === 'Tasks') return [{ id: 10, title: 'Rack install', projectID: 900, status: 1, remainingHours: 4 }];
      if (entity === 'Tickets') return [{ id: 20, ticketNumber: 'T2026.1', title: 'VPN down', status: 1, companyID: 5 }];
      if (entity === 'Projects') return [{ id: 900, projectName: 'HQ Buildout' }];
      return [];
    });
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    const r = await s.getTimeEntryTargets({ resourceID: 1 });

    // Task filters exclude completed
    const taskFilters = query.mock.calls.find((c) => c[0] === 'Tasks')[1];
    expect(taskFilters).toEqual(expect.arrayContaining([
      { op: 'eq', field: 'assignedResourceID', value: 1 },
      { op: 'noteq', field: 'status', value: 5 },
      { op: 'notExist', field: 'completedDateTime' },
    ]));
    // Ticket filters exclude complete
    const ticketFilters = query.mock.calls.find((c) => c[0] === 'Tickets')[1];
    expect(ticketFilters).toEqual(expect.arrayContaining([{ op: 'noteq', field: 'status', value: 5 }]));

    expect(r.tasks[0]).toMatchObject({ taskID: 10, projectID: 900, projectName: 'HQ Buildout', remainingHours: 4 });
    expect(r.tickets[0]).toMatchObject({ ticketID: 20, ticketNumber: 'T2026.1' });
    expect(r.counts).toEqual({ tasks: 1, tickets: 1 });
  });

  test('searchTerm filters task/ticket title and ticket number', async () => {
    const s = mk();
    const query = jest.fn().mockImplementation(async (entity: string) => {
      if (entity === 'Tasks') return [{ id: 10, title: 'Rack install', projectID: null }, { id: 11, title: 'Cabling', projectID: null }];
      if (entity === 'Tickets') return [{ id: 20, ticketNumber: 'T1', title: 'VPN down' }];
      return [];
    });
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    const r = await s.getTimeEntryTargets({ resourceID: 1, searchTerm: 'cabl' });
    expect(r.tasks.map((t: any) => t.taskID)).toEqual([11]); // only "Cabling"
    expect(r.tickets).toHaveLength(0); // "VPN down"/"T1" don't match
  });

  test('projectID / companyID scope the queries', async () => {
    const s = mk();
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    await s.getTimeEntryTargets({ resourceID: 1, projectID: 900, companyID: 5 });
    const taskFilters = query.mock.calls.find((c) => c[0] === 'Tasks')[1];
    const ticketFilters = query.mock.calls.find((c) => c[0] === 'Tickets')[1];
    expect(taskFilters).toEqual(expect.arrayContaining([{ op: 'eq', field: 'projectID', value: 900 }]));
    expect(ticketFilters).toEqual(expect.arrayContaining([{ op: 'eq', field: 'companyID', value: 5 }]));
  });
});

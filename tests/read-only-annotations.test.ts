// Read tools carry readOnlyHint, so clients (Microsoft 365 Copilot above all) don't ask "Confirm" before a lookup.

import { TOOL_DEFINITIONS, WRITES_DESPITE_READ_NAME } from '../src/handlers/tool.definitions';

const ro = (name: string) => (TOOL_DEFINITIONS.find((t) => t.name === name)?.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint;

describe('read-only markers', () => {
  test('the everyday lookups are read-only (no Confirm card in Copilot)', () => {
    for (const n of ['autotask_search_tickets', 'autotask_get_ticket_details', 'autotask_search_companies', 'autotask_search_contacts',
      'autotask_get_my_day', 'autotask_get_ticket_history', 'autotask_search_time_entries', 'autotask_whoami', 'autotask_test_connection']) {
      expect([n, ro(n)]).toEqual([n, true]);
    }
  });

  test('every get_/search_/list_/find_/report_ tool is read-only unless it is a known writer or explicitly marked otherwise', () => {
    const prefixes = ['autotask_get_', 'autotask_search_', 'autotask_list_', 'autotask_find_', 'autotask_query_', 'autotask_count_', 'autotask_report_'];
    const offenders = TOOL_DEFINITIONS.filter((t) => prefixes.some((p) => t.name.startsWith(p)))
      .filter((t) => !WRITES_DESPITE_READ_NAME.has(t.name))
      .filter((t) => { const a = t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined; return a?.readOnlyHint !== true && a?.readOnlyHint !== false && !a?.destructiveHint; })
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  test('writers are never marked read-only', () => {
    for (const n of ['autotask_find_or_create_contact', 'autotask_create_ticket', 'autotask_update_ticket', 'autotask_create_time_entry', 'autotask_log_my_time', 'autotask_add_ticket_update', 'autotask_execute_tool']) {
      expect([n, ro(n)]).not.toEqual([n, true]);
    }
  });
});

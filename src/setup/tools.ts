// autotask_setup_check — is this instance connected and allowed to do what its modules need?

import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { MODULES } from './check.js';
import { lastSetupReport, runSetupCheck, setupSummary } from './run.js';

type H = (a: Record<string, any>, ctx: CallerContext) => Promise<{ result: unknown; message: string }>;

export function setupToolHandlers(s: AutotaskService): Array<[string, H]> {
  return [['autotask_setup_check', async (a) => {
    if (a.cached === true && lastSetupReport()) { const r = lastSetupReport()!; return { result: r, message: `(from ${r.at}) ${setupSummary(r)}` }; }
    const modules = Array.isArray(a.modules) ? a.modules.map(String).filter((m: string) => MODULES.some((x) => x.id === m)) : undefined;
    const r = await runSetupCheck(s, modules?.length ? { modules } : {});
    return { result: r, message: setupSummary(r) };
  }]];
}

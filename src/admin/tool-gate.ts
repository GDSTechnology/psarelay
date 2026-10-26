// Console-controlled tool switches: "Allow write tools" and "Disabled tool
// groups" (admin/settings.ts). A blocked tool is hidden from tools/list and
// refused at dispatch — including through autotask_execute_tool.

import { TOOL_CATEGORIES, TOOL_DEFINITIONS } from '../handlers/tool.definitions.js';
import { isMutatingTool } from '../utils/idempotency.js';
import { settingValue } from './settings.js';
import { lockedReason, moduleOf, planWriteLock } from '../entitlements/index.js';

/** Discovery / routing meta-tools are never switched off — agents need them to see what is available. */
const ALWAYS_ON = new Set(['autotask_list_categories', 'autotask_list_category_tools', 'autotask_execute_tool', 'autotask_router', 'autotask_test_connection', 'autotask_whoami', 'autotask_report_gap']); // a missing capability can always be reported

// Name shapes that write even when the name prefix looks like a read
// (e.g. autotask_find_or_create_contact).
const WRITE_VERB = /_(create|update|delete|add|remove|set|log|complete|apply|move|start|close|build|extend|link|assign|approve|post|or_create)(_|$)/;

const readOnlyHint = new Map(TOOL_DEFINITIONS.map((t) => [t.name, !!(t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint]));

const categoriesOf = new Map<string, string[]>();
for (const [cat, { tools }] of Object.entries(TOOL_CATEGORIES)) for (const t of tools) (categoriesOf.get(t) ?? categoriesOf.set(t, []).get(t)!).push(cat);

/** True when a tool can change Autotask data. Errs toward "write": a mislabelled read is merely hidden in read-only mode. */
export function isWriteTool(name: string): boolean {
  if (name === 'autotask_raw_request') return true; // can send any method
  if (WRITES_DESPITE_NAME.has(name)) return true;
  if (READS_DESPITE_NAME.has(name) || readOnlyHint.get(name)) return false;
  return isMutatingTool(name) || WRITE_VERB.test(name.replace(/^autotask/, ''));
}

/** Changes nothing in Autotask (refreshes the local mirror by reading). */
const READS_DESPITE_NAME = new Set(['autotask_shadow_sync']);
/** Write to Autotask although the name doesn't say so (the bulk worker inactivates records). */
const WRITES_DESPITE_NAME = new Set(['autotask_bulk_inactivate']);

/** Why a tool is switched off in the console, or null when it may run. */
export function toolBlockReason(name: string): string | null {
  if (ALWAYS_ON.has(name)) return null;
  // Hosted plans: a module not on the account answers which plan / add-on unlocks it (self-hosted: never locked).
  const locked = toolLockedReason(name);
  if (locked) return locked;
  if (!settingValue<boolean>('tools.writesEnabled') && isWriteTool(name)) {
    return `${name} is disabled: this MCP is in read-only mode (an administrator turned off write tools in the admin console).`;
  }
  const disabled = settingValue<string[]>('tools.disabledCategories');
  if (disabled.length) {
    const hit = (categoriesOf.get(name) ?? []).find((c) => disabled.includes(c));
    if (hit) return `${name} is disabled: an administrator turned off the "${hit}" tool group in the admin console.`;
  }
  return null;
}

export const toolAllowed = (name: string): boolean => toolBlockReason(name) === null;

/** The module a tool belongs to. */
export const toolModule = (name: string): string => moduleOf(name, categoriesOf.get(name) ?? []);
/** Why the account's plan doesn't include this tool, or null. */
export function toolLockedReason(name: string): string | null {
  if (ALWAYS_ON.has(name)) return null;
  // A read-only plan or trial locks writes like a missing module, so clients are told how to unlock them.
  return lockedReason(toolModule(name)) ?? (isWriteTool(name) ? planWriteLock(name) : null);
}
/** Listed to clients: allowed tools, plus plan-locked ones (marked) unless the console hides them — they show what an upgrade adds. */
export function toolListed(name: string): boolean {
  if (toolAllowed(name)) return true;
  return toolLockedReason(name) !== null && settingValue<boolean>('entitlements.showLockedTools') !== false && toolBlockReasonIgnoringPlan(name) === null;
}
/** The console switches alone (read-only mode, disabled groups), without the plan. */
function toolBlockReasonIgnoringPlan(name: string): string | null {
  if (ALWAYS_ON.has(name)) return null;
  if (!settingValue<boolean>('tools.writesEnabled') && isWriteTool(name)) return 'read-only';
  const disabled = settingValue<string[]>('tools.disabledCategories');
  return (categoriesOf.get(name) ?? []).some((c) => disabled.includes(c)) ? 'disabled group' : null;
}

export const toolCategoryNames = (): string[] => Object.keys(TOOL_CATEGORIES);

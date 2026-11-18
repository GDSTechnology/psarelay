/**
 * Opportunity close (#20 §7): pure helpers for autotask_close_opportunity.
 *
 * Opportunity status, win reason and loss reason are tenant picklists, so values are resolved by LABEL from
 * live field info, never hard-coded. Autotask's stock statuses are Active / Lost / Closed / Implemented
 * ("Closed" = won, "Implemented" = won and delivered); a tenant may rename them, so a few common labels are
 * tried and an unknown one returns the choices.
 */
import type { PicklistValue } from '../services/picklist.cache';
import { activeChoices, matchPicklist, type PicklistChoice } from './staff-tools';

export type Outcome = 'won' | 'lost';

const WON_LABELS = ['closed', 'won', 'closed won', 'closed - won', 'closed/won'];
const LOST_LABELS = ['lost', 'closed lost', 'closed - lost', 'closed/lost'];
/** Statuses that already mean "won" — closing a won opportunity again writes nothing. */
const ALREADY_WON = [...WON_LABELS, 'implemented'];

export type StatusPick = { ok: true; value: number; label: string } | { ok: false; error: string; choices: PicklistChoice[] };

/** The status to set for an outcome: an explicit `override` (id or label), else the first stock label present. */
export function pickOutcomeStatus(values: PicklistValue[] | undefined, outcome: Outcome, override?: string | number): StatusPick {
  const choices = activeChoices(values);
  if (override != null && String(override).trim() !== '') {
    const m = matchPicklist(values, override);
    return m.ok ? { ok: true, value: m.value, label: m.label } : { ok: false, error: `Unknown opportunity status "${override}".`, choices };
  }
  for (const want of outcome === 'won' ? WON_LABELS : LOST_LABELS) {
    const hit = choices.find((c) => c.label.trim().toLowerCase() === want);
    if (hit) return { ok: true, ...hit };
  }
  return { ok: false, error: `No "${outcome === 'won' ? 'Closed' : 'Lost'}" opportunity status in this tenant — pass status with the label to use.`, choices };
}

/** Is the opportunity's current status already the outcome? (Won also counts "Implemented".) */
export function alreadyAt(values: PicklistValue[] | undefined, current: unknown, outcome: Outcome, target: number): boolean {
  if (current == null || current === '') return false;
  if (Number(current) === target) return true;
  const label = (values ?? []).find((v) => Number(v.value) === Number(current))?.label?.trim().toLowerCase();
  return !!label && (outcome === 'won' ? ALREADY_WON : LOST_LABELS).includes(label);
}

/** YYYY-MM-DD → the datetime Autotask stores for a close date. Noon UTC keeps the same calendar day in every US/EU zone. */
export function closeDateTime(day: string): string {
  return `${day}T12:00:00Z`;
}

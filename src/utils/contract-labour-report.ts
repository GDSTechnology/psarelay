// Contract labour report (#22 §10): per month, what labour on a contract was
// covered, what was excluded (role / work type — billed separately), what was
// non-billable, how many block hours it drew (block-hour factors applied), the
// month's allocation and balance, and a forecast for the current month.
//
// Monthly, use-it-or-lose-it like utils/block-hours: each block belongs to its
// startDate's month; an ended month's unused hours are forfeited. Draw =
// (hoursToBill ?? hoursWorked) × the role's blockHourMultiplier (default 1).
// Pure: the service reads the contract, its terms and its time entries.

export interface LabourEntry {
  id?: number;
  dateWorked: string;
  hoursWorked?: number | null;
  hoursToBill?: number | null;
  isNonBillable?: boolean | null;
  roleID?: number | null;
  billingCodeID?: number | null;
  resourceID?: number | null;
  ticketID?: number | null;
  taskID?: number | null;
}

export interface LabourTerms {
  blocks: Array<{ hours: number; startDate: string }>;
  factors: Array<{ roleID: number; blockHourMultiplier: number }>;
  excludedRoleIDs: number[];
  excludedBillingCodeIDs: number[];
}

export type LabourClass = 'covered' | 'excluded_role' | 'excluded_work_type' | 'non_billable';

export interface LabourMonth {
  month: string;
  coveredHours: number;
  /** Block hours drawn: covered hours × role factor. */
  drawn: number;
  excludedRoleHours: number;
  excludedWorkTypeHours: number;
  nonBillableHours: number;
  /** null when the contract has no blocks at all (not a block-hour contract). */
  allocated: number | null;
  remaining: number | null;
  overage: number | null;
  forfeited: number | null;
  /** drawn / allocated × 100. */
  burnPct: number | null;
  ended: boolean;
}

export interface LabourForecast {
  month: string;
  daysElapsed: number;
  daysInMonth: number;
  drawnSoFar: number;
  /** drawnSoFar ÷ daysElapsed × daysInMonth (calendar-day pace). */
  projectedDrawn: number;
  /** Mean drawn over the ended months in the window (up to the last 3). */
  trailingAverageDrawn: number | null;
  allocated: number | null;
  projectedOverage: number | null;
  projectedForfeit: number | null;
  status: 'no_allocation' | 'under' | 'on_track' | 'over';
}

export interface ContractLabourReport {
  window: { from: string; to: string; asOf: string };
  totals: { coveredHours: number; drawn: number; excludedRoleHours: number; excludedWorkTypeHours: number; nonBillableHours: number; allocated: number | null; overage: number | null; forfeited: number | null };
  months: LabourMonth[];
  byRole: Array<{ roleID: number | null; coveredHours: number; factor: number; drawn: number; excludedHours: number }>;
  byResource: Array<{ resourceID: number | null; coveredHours: number; drawn: number; excludedHours: number; nonBillableHours: number }>;
  forecast: LabourForecast | null;
  /** Up to 50 excluded entries, so the separately-billed work can be checked. */
  excludedEntries: Array<{ id?: number | undefined; dateWorked: string; hours: number; reason: LabourClass; roleID: number | null; billingCodeID: number | null; ticketID: number | null; taskID: number | null }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const monthOf = (iso: string): string | null => (/^\d{4}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 7) : null);
const hoursOf = (e: LabourEntry) => Number(e.hoursToBill != null ? e.hoursToBill : e.hoursWorked) || 0;

/** Months from..to inclusive, YYYY-MM (capped at 120). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Shift a YYYY-MM by n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function classifyLabour(e: LabourEntry, terms: LabourTerms): LabourClass {
  if (e.isNonBillable) return 'non_billable';
  if (e.roleID != null && terms.excludedRoleIDs.includes(Number(e.roleID))) return 'excluded_role';
  if (e.billingCodeID != null && terms.excludedBillingCodeIDs.includes(Number(e.billingCodeID))) return 'excluded_work_type';
  return 'covered';
}

export function computeContractLabour(
  entries: LabourEntry[],
  terms: LabourTerms,
  opts: { fromMonth: string; toMonth: string; asOf: Date },
): ContractLabourReport {
  const asOfDay = opts.asOf.toISOString().slice(0, 10);
  const currentMonth = asOfDay.slice(0, 7);
  const factorOf = new Map(terms.factors.map((f) => [Number(f.roleID), Number(f.blockHourMultiplier) || 1]));
  const factor = (roleID: number | null | undefined) => (roleID != null ? factorOf.get(Number(roleID)) ?? 1 : 1);
  const hasBlocks = terms.blocks.length > 0;

  const months = new Map<string, LabourMonth>();
  for (const m of monthRange(opts.fromMonth, opts.toMonth)) {
    months.set(m, { month: m, coveredHours: 0, drawn: 0, excludedRoleHours: 0, excludedWorkTypeHours: 0, nonBillableHours: 0, allocated: hasBlocks ? 0 : null, remaining: null, overage: null, forfeited: null, burnPct: null, ended: m < currentMonth });
  }
  for (const b of terms.blocks) {
    const m = monthOf(b.startDate);
    const row = m ? months.get(m) : undefined;
    if (row) row.allocated = (row.allocated ?? 0) + (Number(b.hours) || 0);
  }

  const byRole = new Map<string, ContractLabourReport['byRole'][number]>();
  const byResource = new Map<string, ContractLabourReport['byResource'][number]>();
  const excludedEntries: ContractLabourReport['excludedEntries'] = [];

  for (const e of entries) {
    const m = monthOf(e.dateWorked);
    const row = m ? months.get(m) : undefined;
    if (!row) continue;
    const h = hoursOf(e);
    const cls = classifyLabour(e, terms);
    const roleKey = String(e.roleID ?? 'none');
    const role = byRole.get(roleKey) ?? { roleID: e.roleID ?? null, coveredHours: 0, factor: factor(e.roleID), drawn: 0, excludedHours: 0 };
    const resKey = String(e.resourceID ?? 'none');
    const res = byResource.get(resKey) ?? { resourceID: e.resourceID ?? null, coveredHours: 0, drawn: 0, excludedHours: 0, nonBillableHours: 0 };
    if (cls === 'covered') {
      const d = h * factor(e.roleID);
      row.coveredHours += h; row.drawn += d;
      role.coveredHours += h; role.drawn += d;
      res.coveredHours += h; res.drawn += d;
    } else if (cls === 'non_billable') {
      row.nonBillableHours += h; res.nonBillableHours += h;
    } else {
      if (cls === 'excluded_role') row.excludedRoleHours += h; else row.excludedWorkTypeHours += h;
      role.excludedHours += h; res.excludedHours += h;
      if (excludedEntries.length < 50) excludedEntries.push({ id: e.id, dateWorked: String(e.dateWorked).slice(0, 10), hours: r2(h), reason: cls, roleID: e.roleID ?? null, billingCodeID: e.billingCodeID ?? null, ticketID: e.ticketID ?? null, taskID: e.taskID ?? null });
    }
    byRole.set(roleKey, role); byResource.set(resKey, res);
  }

  const list = [...months.values()].map((m) => {
    const out: LabourMonth = { ...m, coveredHours: r2(m.coveredHours), drawn: r2(m.drawn), excludedRoleHours: r2(m.excludedRoleHours), excludedWorkTypeHours: r2(m.excludedWorkTypeHours), nonBillableHours: r2(m.nonBillableHours) };
    if (m.allocated != null) {
      out.allocated = r2(m.allocated);
      out.remaining = r2(Math.max(0, m.allocated - m.drawn));
      out.overage = r2(Math.max(0, m.drawn - m.allocated));
      out.forfeited = m.ended ? r2(Math.max(0, m.allocated - m.drawn)) : 0;
      out.burnPct = m.allocated > 0 ? Math.round((m.drawn / m.allocated) * 1000) / 10 : null;
    }
    return out;
  });

  const sum = (pick: (m: LabourMonth) => number | null) => r2(list.reduce((s, m) => s + (pick(m) ?? 0), 0));
  const totals = {
    coveredHours: sum((m) => m.coveredHours), drawn: sum((m) => m.drawn),
    excludedRoleHours: sum((m) => m.excludedRoleHours), excludedWorkTypeHours: sum((m) => m.excludedWorkTypeHours),
    nonBillableHours: sum((m) => m.nonBillableHours),
    allocated: hasBlocks ? sum((m) => m.allocated) : null,
    overage: hasBlocks ? sum((m) => m.overage) : null,
    forfeited: hasBlocks ? sum((m) => m.forfeited) : null,
  };

  let forecast: LabourForecast | null = null;
  const cur = list.find((m) => m.month === currentMonth);
  if (cur) {
    const [y, mo] = currentMonth.split('-').map(Number) as [number, number];
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const daysElapsed = Math.max(1, Number(asOfDay.slice(8, 10)));
    const projectedDrawn = r2((cur.drawn / daysElapsed) * daysInMonth);
    const ended = list.filter((m) => m.ended).slice(-3);
    const trailingAverageDrawn = ended.length ? r2(ended.reduce((s, m) => s + m.drawn, 0) / ended.length) : null;
    const allocated = cur.allocated;
    let status: LabourForecast['status'] = 'no_allocation';
    if (allocated != null && allocated > 0) status = projectedDrawn > allocated ? 'over' : projectedDrawn >= allocated * 0.8 ? 'on_track' : 'under';
    forecast = {
      month: currentMonth, daysElapsed, daysInMonth, drawnSoFar: cur.drawn, projectedDrawn, trailingAverageDrawn, allocated,
      projectedOverage: allocated != null && allocated > 0 ? r2(Math.max(0, projectedDrawn - allocated)) : null,
      projectedForfeit: allocated != null && allocated > 0 ? r2(Math.max(0, allocated - projectedDrawn)) : null,
      status,
    };
  }

  const roundNums = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && k !== 'roleID' && k !== 'resourceID' ? r2(v) : v])) as T;
  const total = (x: { coveredHours: number; excludedHours: number; nonBillableHours?: number }) => x.coveredHours + x.excludedHours + (x.nonBillableHours ?? 0);
  return {
    window: { from: opts.fromMonth, to: opts.toMonth, asOf: asOfDay },
    totals,
    months: list,
    byRole: [...byRole.values()].map(roundNums).sort((a, b) => total(b) - total(a)),
    byResource: [...byResource.values()].map(roundNums).sort((a, b) => total(b) - total(a)),
    forecast,
    excludedEntries,
  };
}

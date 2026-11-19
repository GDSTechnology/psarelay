// Sales-cycle correlation (#20 §7): opportunity ↔ quotes ↔ contracts ↔ projects,
// linked by Autotask's own `opportunityID` on Quotes / Contracts / Projects
// (native links only — nothing inferred is stored). Pure: the service reads the
// records; this builds each opportunity's chain and the findings.
//
// Findings:
//   company_mismatch     (error)   a linked quote / contract / project is on another company
//   won_no_delivery      (warning) a won opportunity with no contract and no project
//   lost_with_delivery   (warning) a lost opportunity that still has a contract or project
//   unlinked_delivery    (warning) a contract / project with no opportunity, on a company that
//                                  has a won opportunity lacking that kind of delivery — the
//                                  likely link is suggested (one candidate) or listed (several)
//   won_no_quote         (info)    a won opportunity with no quote
//
// Outcome comes from the status LABEL (tenant picklist): Closed / Won / Implemented = won,
// anything starting "Lost" or "Closed lost" = lost, else open. Company 0 is a real company
// (the tenant's own), so ids are compared with `!= null`, never truthiness.

export type SalesPhase = 'won' | 'lost' | 'open';
export type LinkKind = 'quote' | 'contract' | 'project';

export interface SalesOpportunity { id: number; title?: string | null; companyID?: number | null; status?: number | null; statusLabel?: string | null; closedDate?: string | null; createDate?: string | null }
export interface SalesRecord { id: number; companyID?: number | null; opportunityID?: number | null; name?: string | null; startDate?: string | null; status?: number | string | null }

export interface SalesFinding {
  code: 'company_mismatch' | 'won_no_delivery' | 'lost_with_delivery' | 'unlinked_delivery' | 'won_no_quote';
  severity: 'error' | 'warning' | 'info';
  opportunityID: number | null;
  kind?: LinkKind;
  recordID?: number;
  message: string;
  /** For unlinked_delivery: the one won opportunity it most likely belongs to. */
  suggestedOpportunityID?: number;
  candidateOpportunityIDs?: number[];
  /** The repair call, when there is exactly one candidate (or a mismatch to unlink by hand). */
  repair?: { tool: string; args: Record<string, unknown> };
}

export interface SalesChain {
  opportunityID: number;
  title: string | null;
  companyID: number | null;
  phase: SalesPhase;
  statusLabel: string | null;
  closedDate: string | null;
  quotes: SalesRecord[];
  contracts: SalesRecord[];
  projects: SalesRecord[];
}

const WON = /^(closed|won|implemented)\b(?!\s*[-/]?\s*lost)/i;
const LOST = /^(lost\b|closed\s*[-/]?\s*lost)/i;

export function salesPhase(label: string | null | undefined): SalesPhase {
  const l = String(label ?? '').trim();
  if (!l) return 'open';
  if (LOST.test(l)) return 'lost';
  if (WON.test(l)) return 'won';
  return 'open';
}

const sameCompany = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null || Number(a) === Number(b);
const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null);
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** A won opportunity is a plausible source for a delivery record that starts 30 days before to 365 days after it closed. */
export function plausibleSource(opp: SalesOpportunity, rec: SalesRecord): boolean {
  const closed = day(opp.closedDate);
  const start = day(rec.startDate);
  if (!closed || !start) return true;
  const d = daysBetween(closed, start);
  return d >= -30 && d <= 365;
}

export function correlateSalesCycle(input: {
  opportunities: SalesOpportunity[];
  quotes: SalesRecord[];
  contracts: SalesRecord[];
  projects: SalesRecord[];
  /** Contracts / projects with NO opportunityID on the companies in scope. */
  unlinkedContracts?: SalesRecord[];
  unlinkedProjects?: SalesRecord[];
}): { chains: SalesChain[]; findings: SalesFinding[]; summary: Record<string, number> } {
  const byOpp = <T extends SalesRecord>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) if (r.opportunityID != null) { const k = Number(r.opportunityID); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return m;
  };
  const q = byOpp(input.quotes), c = byOpp(input.contracts), p = byOpp(input.projects);
  const findings: SalesFinding[] = [];
  const chains: SalesChain[] = input.opportunities.map((o) => ({
    opportunityID: Number(o.id), title: o.title ?? null, companyID: o.companyID ?? null,
    phase: salesPhase(o.statusLabel), statusLabel: o.statusLabel ?? null, closedDate: day(o.closedDate),
    quotes: q.get(Number(o.id)) ?? [], contracts: c.get(Number(o.id)) ?? [], projects: p.get(Number(o.id)) ?? [],
  }));

  for (const ch of chains) {
    for (const [kind, rows] of [['quote', ch.quotes], ['contract', ch.contracts], ['project', ch.projects]] as const) {
      for (const r of rows) {
        if (!sameCompany(r.companyID, ch.companyID)) {
          findings.push({
            code: 'company_mismatch', severity: 'error', opportunityID: ch.opportunityID, kind, recordID: r.id,
            message: `${kind} ${r.id} is on company ${r.companyID}, but opportunity ${ch.opportunityID} is on company ${ch.companyID}.`,
          });
        }
      }
    }
    const delivered = ch.contracts.length + ch.projects.length > 0;
    if (ch.phase === 'won' && !delivered) findings.push({ code: 'won_no_delivery', severity: 'warning', opportunityID: ch.opportunityID, message: `Opportunity ${ch.opportunityID} is won (${ch.statusLabel}) but no contract or project is linked to it.` });
    if (ch.phase === 'lost' && delivered) findings.push({ code: 'lost_with_delivery', severity: 'warning', opportunityID: ch.opportunityID, message: `Opportunity ${ch.opportunityID} is lost but has ${ch.contracts.length} contract(s) and ${ch.projects.length} project(s) linked — the outcome or the links are wrong.` });
    if (ch.phase === 'won' && ch.quotes.length === 0) findings.push({ code: 'won_no_quote', severity: 'info', opportunityID: ch.opportunityID, message: `Opportunity ${ch.opportunityID} is won with no quote.` });
  }

  // Unlinked delivery: candidates are won opportunities on the same company with no record of that kind yet.
  const won = chains.filter((ch) => ch.phase === 'won');
  const opps = new Map(input.opportunities.map((o) => [Number(o.id), o]));
  for (const [kind, rows] of [['contract', input.unlinkedContracts ?? []], ['project', input.unlinkedProjects ?? []]] as const) {
    for (const r of rows) {
      if (r.opportunityID != null) continue;
      const cands = won.filter((ch) => ch.companyID != null && r.companyID != null && Number(ch.companyID) === Number(r.companyID)
        && (kind === 'contract' ? ch.contracts.length === 0 : ch.projects.length === 0)
        && plausibleSource(opps.get(ch.opportunityID)!, r));
      if (!cands.length) continue;
      const f: SalesFinding = {
        code: 'unlinked_delivery', severity: 'warning', opportunityID: cands.length === 1 ? cands[0]!.opportunityID : null, kind, recordID: r.id,
        message: cands.length === 1
          ? `${kind} ${r.id}${r.name ? ` "${r.name}"` : ''} has no opportunity; won opportunity ${cands[0]!.opportunityID}${cands[0]!.title ? ` "${cands[0]!.title}"` : ''} on the same company has no ${kind} — likely the same deal. Confirm before linking.`
          : `${kind} ${r.id}${r.name ? ` "${r.name}"` : ''} has no opportunity; ${cands.length} won opportunities on the same company have no ${kind}. Pick one with the user.`,
        candidateOpportunityIDs: cands.map((x) => x.opportunityID),
      };
      if (cands.length === 1) {
        f.suggestedOpportunityID = cands[0]!.opportunityID;
        f.repair = { tool: 'autotask_link_to_opportunity', args: { opportunityID: cands[0]!.opportunityID, [kind === 'contract' ? 'contractID' : 'projectID']: r.id, dryRun: true } };
      }
      findings.push(f);
    }
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const summary: Record<string, number> = { opportunities: chains.length, won: won.length, lost: chains.filter((x) => x.phase === 'lost').length, open: chains.filter((x) => x.phase === 'open').length };
  for (const f of findings) summary[f.code] = (summary[f.code] ?? 0) + 1;
  return { chains, findings, summary };
}

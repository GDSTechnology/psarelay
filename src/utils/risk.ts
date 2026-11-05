// Tool risk classification + confirmation policy (Expansion Spec §4.3).
//
// Every tool has a risk level. High-risk mutations (destructive, financial,
// inventory movement) require an explicit `confirm: true` before they run;
// read-only and routine reversible updates pass through. Enforced server-side in
// callTool so a client can never skip it.

export type RiskLevel =
  | 'read-only'
  | 'reversible-update'
  | 'external-communication'
  | 'financial'
  | 'inventory-movement'
  | 'destructive';

/** Financial mutations (contract / quote / billing) — explicit confirmation (§4.3). */
export const FINANCIAL_TOOLS = new Set<string>([
  'autotask_create_contract',
  'autotask_create_contracts_bulk',
  'autotask_update_contract',
  'autotask_create_contract_service',
  'autotask_update_contract_service',
  'autotask_create_contract_milestone',
  'autotask_update_contract_milestone',
  'autotask_create_quote',
  'autotask_create_quote_item',
  'autotask_update_quote_item',
  'autotask_create_opportunity',
  'autotask_update_opportunity',
  'autotask_create_ticket_charge',
  'autotask_add_ticket_materials', // dry-run first; the write needs confirm:true
  'autotask_update_ticket_charge',
  'autotask_create_service', // catalog prices; dry-run first, the write needs confirm:true
  'autotask_update_service',
  'autotask_set_ticket_contract',
  'autotask_create_expense_report',
  'autotask_create_expense_item',
  'autotask_change_plan_execute', // writes approved catalog / pricing plan rows
]);

/** Client-visible external communication — show visibility/recipients (§4.3, populated in §15). */
export const EXTERNAL_COMM_TOOLS = new Set<string>([]);

/** Inventory movements — show source/dest/qty/serials (§4.3, populated in Phase 3). */
export const INVENTORY_MOVEMENT_TOOLS = new Set<string>([
  // Count-mutating inventory writes — require an explicit confirm:true (§4.3).
  // (remove_inventory_stock is classified 'destructive' via its annotation, which
  // also forces confirmation, so it isn't listed here.)
  'autotask_create_inventory_transfer',
  'autotask_add_inventory_stock',
]);

export function classifyRisk(
  toolName: string,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
): RiskLevel {
  if (annotations?.readOnlyHint) return 'read-only';
  if (annotations?.destructiveHint) return 'destructive';
  if (FINANCIAL_TOOLS.has(toolName)) return 'financial';
  if (INVENTORY_MOVEMENT_TOOLS.has(toolName)) return 'inventory-movement';
  if (EXTERNAL_COMM_TOOLS.has(toolName)) return 'external-communication';
  return 'reversible-update';
}

/** Risk levels that require an explicit `confirm: true` before mutating (§4.3). */
export function requiresExplicitConfirmation(risk: RiskLevel): boolean {
  return risk === 'destructive' || risk === 'financial' || risk === 'inventory-movement';
}

export interface ConfirmationRequired {
  status: 'confirmation_required';
  tool: string;
  riskLevel: RiskLevel;
  message: string;
}

export function buildConfirmationRequired(toolName: string, risk: RiskLevel): ConfirmationRequired {
  const what =
    risk === 'destructive'
      ? 'a destructive action that cannot be undone'
      : risk === 'financial'
        ? 'a financial change (contract / quote / billing)'
        : risk === 'inventory-movement'
          ? 'an inventory movement'
          : 'a high-risk change';
  return {
    status: 'confirmation_required',
    tool: toolName,
    riskLevel: risk,
    message: `${toolName} is ${what}. Review the specifics with the user, then call again with confirm: true to proceed.`,
  };
}

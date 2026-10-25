// #102 slices 2 & 3 — contract SLA coverage + assignment.
// Pure planners (classifyContractSlaCoverage, planContractSlaAssignment,
// activeStatusValues) + dry-run-first gating through the service (mocked).

import {
  classifyContractSlaCoverage, planContractSlaAssignment, activeStatusValues,
} from '../src/utils/contract-sla';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const SLA = [{ value: '1', label: 'Managed 24x7' }, { value: '2', label: 'Break-Fix' }];

describe('classifyContractSlaCoverage (pure)', () => {
  test('no SLA definitions → readiness no_sla_definitions', () => {
    const r = classifyContractSlaCoverage([{ id: 1 }], []);
    expect(r.readiness).toBe('no_sla_definitions');
    expect(r.slaDefinitionsCount).toBe(0);
    expect(r.message).toMatch(/generate_sla_framework/);
  });

  test('flags unlinked contracts (0 / null / empty all count as unlinked)', () => {
    const r = classifyContractSlaCoverage([
      { id: 1, contractName: 'A', serviceLevelAgreementID: 1 },   // linked
      { id: 2, contractName: 'B', serviceLevelAgreementID: null }, // unlinked
      { id: 3, contractName: 'C', serviceLevelAgreementID: 0 },    // unlinked (0 = none)
      { id: 4, contractName: 'D' },                                 // unlinked (absent)
    ], SLA);
    expect(r.readiness).toBe('unlinked_contracts');
    expect(r.linked).toBe(1);
    expect(r.unlinked).toBe(3);
    expect(r.unlinkedContracts.map((c) => c.id)).toEqual([2, 3, 4]);
  });

  test('all linked → all_linked', () => {
    const r = classifyContractSlaCoverage([{ id: 1, serviceLevelAgreementID: 2 }], SLA);
    expect(r.readiness).toBe('all_linked');
    expect(r.unlinked).toBe(0);
  });
});

describe('activeStatusValues (pure)', () => {
  test('derives active status values from labels, excluding Inactive', () => {
    const s = activeStatusValues([
      { value: '1', label: 'Active' }, { value: '2', label: 'Inactive' },
      { value: '3', label: 'Active - Renewed' }, { value: '4', label: 'Expired' },
    ]);
    expect([...s].sort()).toEqual([1, 3]);
  });
});

describe('planContractSlaAssignment (pure)', () => {
  const contracts = new Map<number, any>([
    [1, { id: 1, serviceLevelAgreementID: null }],
    [2, { id: 2, serviceLevelAgreementID: 1 }], // already set to 1
  ]);

  test('planned vs noop vs not_found vs invalid_sla', () => {
    const plan = planContractSlaAssignment(contracts, [
      { contractID: 1, serviceLevelAgreementID: 1 }, // planned (null → 1)
      { contractID: 2, serviceLevelAgreementID: 1 }, // noop (already 1)
      { contractID: 9, serviceLevelAgreementID: 2 }, // not_found
      { contractID: 1, serviceLevelAgreementID: 7 }, // invalid_sla (7 not a value)
    ], SLA);
    expect(plan.planned.map((p) => p.contractID)).toEqual([1]);
    expect(plan.planned[0]).toMatchObject({ from: null, to: 1, toLabel: 'Managed 24x7' });
    expect(plan.noop).toEqual([2]);
    expect(plan.notFound).toEqual([9]);
    expect(plan.invalidSla).toEqual([{ contractID: 1, serviceLevelAgreementID: 7 }]);
  });
});

describe('service dry-run gating', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
  const mk = () => new AutotaskService(config, new Logger('error'));
  const fieldInfo = [{ name: 'serviceLevelAgreementID', picklistValues: [{ value: '1', label: 'Managed 24x7', isActive: true }, { value: '2', label: 'Break-Fix', isActive: true }] }];

  test('assignContractSla defaults to dry-run — no writes', async () => {
    const s = mk();
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue(fieldInfo as any);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => [{ id: 1, serviceLevelAgreementID: null }] });
    const upd = jest.spyOn(s, 'updateContract').mockResolvedValue(undefined);
    const r = await s.assignContractSla({ serviceLevelAgreementID: 1, contractIDs: [1] });
    expect(r.status).toBe('dry_run');
    expect((r.plannedAssignments as any[]).map((p) => p.contractID)).toEqual([1]);
    expect(upd).not.toHaveBeenCalled();
  });

  test('dryRun:false applies the assignment', async () => {
    const s = mk();
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue(fieldInfo as any);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => [{ id: 1, serviceLevelAgreementID: null }] });
    const upd = jest.spyOn(s, 'updateContract').mockResolvedValue(undefined);
    const r = await s.assignContractSla({ assignments: [{ contractID: 1, serviceLevelAgreementID: 1 }], dryRun: false });
    expect(r.status).toBe('assigned');
    expect(r.assigned).toBe(1);
    expect(upd).toHaveBeenCalledWith(1, { serviceLevelAgreementID: 1 });
  });

  test('fails closed when the tenant has no SLA definitions', async () => {
    const s = mk();
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([{ name: 'serviceLevelAgreementID', picklistValues: [] }] as any);
    const upd = jest.spyOn(s, 'updateContract').mockResolvedValue(undefined);
    const r = await s.assignContractSla({ serviceLevelAgreementID: 1, contractIDs: [1], dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(r.step).toBe('sla_definitions');
    expect(upd).not.toHaveBeenCalled();
  });

  test('fails closed when every SLA value is invalid', async () => {
    const s = mk();
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue(fieldInfo as any);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => [{ id: 1, serviceLevelAgreementID: null }] });
    const upd = jest.spyOn(s, 'updateContract').mockResolvedValue(undefined);
    const r = await s.assignContractSla({ assignments: [{ contractID: 1, serviceLevelAgreementID: 99 }], dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(r.step).toBe('sla_value');
    expect(upd).not.toHaveBeenCalled();
  });
});

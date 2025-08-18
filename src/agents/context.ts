// src/agents/context.ts
import { getVehicles, getWorkOrders, getOpsTasks, getDemandHistory, getPMTasks, getFailures, getDemoWeekStart } from '../data/adapter';
import { getResourceSnapshot } from '../data/resourceStore';

type BuildPackOpts = {
  horizonDays?: number;
  baseWorkorders?: ReturnType<typeof getWorkOrders>;
};

export function buildKnowledgePack(opts: BuildPackOpts = {}) {
  const horizonDays = opts.horizonDays ?? 7;
  const vehicles = getVehicles();
  const workorders = (opts.baseWorkorders ?? getWorkOrders());
  const opsTasks = getOpsTasks(horizonDays);
  const pm = getPMTasks();
  const failures = getFailures();
  const demand = getDemandHistory(horizonDays);
  const { technicians, availability } = getResourceSnapshot();
  const anchorISO = getDemoWeekStart(); // '2025-08-22T00:00:00Z'

  // Small summaries the model can reference
  const woOpen = workorders.filter(w => w.status !== 'Closed');
  const kpi = {
    vehicles: { total: vehicles.length, available: vehicles.filter(v => v.status === 'AVAILABLE').length, due: vehicles.filter(v => v.status === 'DUE').length, down: vehicles.filter(v => v.status === 'DOWN').length },
    workorders: { total: workorders.length, open: woOpen.length, scheduled: woOpen.filter(w => w.status === 'Scheduled').length },
    demandHoursNextWeek: demand.reduce((a, r) => a + (r.hours ?? 0), 0)
  };

  // Capability / mutation schema shared with the LLM
  const mutationSchema = {
    WorkOrderOps: [
      'ADD_WORKORDER { id, vehicleId, title, type: "Preventive"|"Corrective", priority: "Low"|"Medium"|"High"|"Critical", requiredSkills: string[], hours, start, end, status }',
      'UPDATE_WORKORDER { id, patch: { start?, end?, priority?, status?, requiredSkills?, title? } }',
      'MOVE_WORKORDER { id, start, end }',
      'CANCEL_WORKORDER { id }'
    ],
    OpsTaskOps: [
      'ADD_OPS_TASK { id, vehicleId, title, start, end }',
      'MOVE_OPS_TASK { id, start, end }',
      'CANCEL_OPS_TASK { id }',
      'CANCEL_OPS_TASK { conflictsWith: "WO-..." } // app will resolve the first overlapping ops task for the WO'
    ],
    ResourceOps: [
      'ADD_TECH { id, name, skills: string[] }',
      'REMOVE_TECH { id }',
      'ADD_AVAILABILITY { date: "YYYY-MM-DD", technicianId, hours }',
      'REMOVE_AVAILABILITY { date: "YYYY-MM-DD", technicianId }'
    ],
    DateRules: 'Use local wall-clock ISO without Z (e.g., 2025-08-23T09:00:00). Keep changes within the static demo week starting 2025-08-22.'
  };

  return {
    anchorISO,
    horizonDays,
    kpi,
    vehicles,
    workorders,
    opsTasks,
    demand,
    pm,
    failures,
    technicians,
    availability,
    mutationSchema
  };
}

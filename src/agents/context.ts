// src/agents/context.ts
import { getVehicles, getWorkOrders, getOpsTasks, getPMTasks, getFailures, getDemandHistory, getTechnicians, getAvailability } from '../data/adapter';
import { getPartsCatalog } from '../data/partsCatalog';

export type KnowledgePack = {
  window: { horizonDays: number; generatedAt: string };
  datasets: {
    vehicles: ReturnType<typeof getVehicles>;
    workorders: ReturnType<typeof getWorkOrders>;
    opsTasks: ReturnType<typeof getOpsTasks>;
    pm: ReturnType<typeof getPMTasks>;
    failures: ReturnType<typeof getFailures>;
    demand: ReturnType<typeof getDemandHistory>;
    technicians: ReturnType<typeof getTechnicians>;
    availability: ReturnType<typeof getAvailability>;
    parts: ReturnType<typeof getPartsCatalog>;
  };
};

export function buildKnowledgePack(opts: { horizonDays: number; baseWorkorders: ReturnType<typeof getWorkOrders> }): KnowledgePack {
  const generatedAt = new Date().toISOString();
  const { horizonDays, baseWorkorders } = opts;

  const vehicles = getVehicles(20);
  const opsTasks = getOpsTasks(horizonDays);
  const pm = getPMTasks();
  const failures = getFailures();
  const demand = getDemandHistory?.(horizonDays) ?? [];
  const technicians = getTechnicians?.() ?? [];
  const availability = getAvailability?.() ?? [];
  const parts = getPartsCatalog?.() ?? [];

  return {
    window: { horizonDays, generatedAt },
    datasets: { vehicles, workorders: baseWorkorders, opsTasks, pm, failures, demand, technicians, availability, parts }
  };
}

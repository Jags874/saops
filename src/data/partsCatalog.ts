// src/data/partsCatalog.ts
export type CatalogPart = {
  part_id: string;
  part_name: string;
  subsystem: string;
  lead_time_days?: number;
  unit_cost?: number;
  stock?: number;
  eta?: string;
};

const BASE: CatalogPart[] = [
  { part_id: 'P-201', part_name: 'Brake Pad Set', subsystem: 'brakes',     lead_time_days: 2, unit_cost: 180, stock: 4 },
  { part_id: 'P-221', part_name: 'Water Pump Assy', subsystem: 'cooling',  lead_time_days: 7, unit_cost: 420, stock: 0 },
  { part_id: 'P-113', part_name: 'Radiator Hose',   subsystem: 'cooling',  lead_time_days: 1, unit_cost: 35,  stock: 10 },
  { part_id: 'P-310', part_name: 'Alternator 24V',  subsystem: 'electrical', lead_time_days: 5, unit_cost: 560, stock: 1 },
  { part_id: 'P-401', part_name: 'Clutch Pack',     subsystem: 'transmission', lead_time_days: 10, unit_cost: 900, stock: 0 },
  { part_id: 'P-501', part_name: 'EGR Valve',       subsystem: 'engine',   lead_time_days: 6, unit_cost: 350, stock: 2 },
];

let CATALOG = [...BASE];

export function getPartsCatalog() { return CATALOG; }
export function setPartsCatalog(next: CatalogPart[]) { CATALOG = next; }

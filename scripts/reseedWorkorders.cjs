// scripts/reseedWorkorders.cjs
// Rebuilds src/data/fake/workorders.json from vehicles/pm/ops/technicians
// enforcing your rules and enriching with parts/tools/technician.
// Now balances scheduled maintenance across the 7-day window.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const F = (p) => path.join(ROOT, 'src', 'data', 'fake', p);

const read  = (f) => JSON.parse(fs.readFileSync(F(f), 'utf-8'));
const write = (f, x) => (fs.writeFileSync(F(f), JSON.stringify(x, null, 2)), console.log('wrote', f));

function iso(d) { return d.toISOString(); }
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function toDate(x) { return new Date(x); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const PARTS = {
  brakes:       [{ partId: 'P-201', qty: 1 }],
  cooling:      [{ partId: 'P-221', qty: 1 }, { partId: 'P-113', qty: 1 }],
  electrical:   [{ partId: 'P-310', qty: 1 }],
  engine:       [{ partId: 'P-501', qty: 1 }],
  transmission: [{ partId: 'P-401', qty: 1 }],
};

const TOOLS = {
  brakes:       ['Torque Wrench', 'Brake Bleeder Kit'],
  cooling:      ['Coolant Pressure Tester', 'Hose Clamp Pliers'],
  electrical:   ['Multimeter', 'Crimping Tool'],
  engine:       ['Diagnostic Scanner', 'Torque Wrench'],
  transmission: ['Transmission Jack', 'Torque Wrench'],
};

function skillsFor(subsystem) {
  return subsystem === 'electrical' ? ['AutoElec'] : ['Mechanic'];
}

// Find a night slot that doesn't overlap ops
function placeNightNoOverlap(opsByVDay, vehicleId, day, hours) {
  for (let H = 19; H <= 23 - hours; H++) {
    const s = new Date(day); s.setHours(H, 0, 0, 0);
    const e = new Date(s);  e.setHours(e.getHours() + hours);
    const key = `${vehicleId}:${s.toISOString().slice(0,10)}`;
    const opsToday = opsByVDay.get(key) || [];
    const clash = opsToday.some(t => {
      const ts = toDate(t.start), te = toDate(t.end);
      return s < te && ts < e;
    });
    if (!clash) return { start: s, end: e };
  }
  // fallback: 19:00 even if overlapping
  const s = new Date(day); s.setHours(19,0,0,0);
  const e = new Date(s);  e.setHours(e.getHours() + hours);
  return { start: s, end: e };
}

function main() {
  const vehicles = read('vehicles.json');
  const pmDefs   = read('pm.json');
  const ops      = read('ops_tasks.json');
  const techs    = read('technicians.json');

  // “Week 0” from earliest ops start (pre-rebase)
  const minStart = ops.length ? ops.map(t => toDate(t.start)).reduce((a,b)=>a<b?a:b) : new Date();
  const week0 = startOfDay(minStart);

  // Index ops by vehicle+day
  const opsByVDay = new Map();
  for (const t of ops) {
    const v = t.vehicleId;
    const d = startOfDay(toDate(t.start)).toISOString().slice(0,10);
    const key = `${v}:${d}`;
    if (!opsByVDay.has(key)) opsByVDay.set(key, []);
    opsByVDay.get(key).push(t);
  }

  // Tech index by skill
  const techsBySkill = new Map([['Mechanic', []], ['AutoElec', []]]);
  for (const t of techs) {
    for (const s of (t.skills || [])) {
      if (!techsBySkill.has(s)) techsBySkill.set(s, []);
      techsBySkill.get(s).push(t);
    }
  }

  // New IDs
  let counter = 1;
  const nextId = () => `WO-${String(counter++).padStart(3, '0')}`;

  // ---- NEW: balance scheduled tasks across days 0..6
  const dayLoads = Array(7).fill(0); // simple count per day
  const pickBalancedDay = () => {
    let idx = 0; let min = dayLoads[0];
    for (let i=1;i<7;i++) if (dayLoads[i] < min) { min = dayLoads[i]; idx = i; }
    dayLoads[idx] += 1;
    return idx; // 0..6
  };

  const newWOs = [];

  for (const v of vehicles) {
    const vId = v.id;
    const status = v.status; // AVAILABLE | DUE | DOWN
    const basePM = pick(pmDefs);
    const pmHours = Number(basePM.estimatedHours ?? 2);
    const pmSkills = basePM.requiredSkills?.length ? basePM.requiredSkills : skillsFor(basePM.subsystem);
    const pmParts = PARTS[basePM.subsystem] || undefined;
    const pmTools = TOOLS[basePM.subsystem] || undefined;

    if (status === 'AVAILABLE') {
      // Only Low priority WOs (Open)
      newWOs.push({
        id: nextId(),
        vehicleId: vId,
        title: basePM.title,
        type: 'Preventive',
        priority: 'Low',
        status: 'Open',
        subsystem: basePM.subsystem,
        hours: pmHours,
        requiredSkills: pmSkills,
        tools: pmTools,
        parts: pmParts,
        created: iso(new Date(week0.getTime() - 3 * 86400000)),
      });

      const sub = pick(['engine','brakes','transmission','cooling','electrical']);
      newWOs.push({
        id: nextId(),
        vehicleId: vId,
        title: `Minor corrective: ${sub}`,
        type: 'Corrective',
        priority: 'Low',
        status: 'Open',
        subsystem: sub,
        hours: 2,
        requiredSkills: skillsFor(sub),
        tools: TOOLS[sub] || undefined,
        parts: PARTS[sub] || undefined,
        created: iso(new Date(week0.getTime() - 2 * 86400000)),
      });

    } else if (status === 'DUE') {
      // Must have a scheduled PM inside 0..6 days — distribute evenly
      const dayOffset = pickBalancedDay(); // 0..6
      const day = new Date(week0); day.setDate(day.getDate() + dayOffset);
      const slot = placeNightNoOverlap(opsByVDay, vId, day, pmHours);

      const techPool = techsBySkill.get(pmSkills[0]) || [];
      const tech = techPool.length ? pick(techPool) : null;

      newWOs.push({
        id: nextId(),
        vehicleId: vId,
        title: basePM.title,
        type: 'Preventive',
        priority: 'Medium',
        status: 'Scheduled',
        subsystem: basePM.subsystem,
        hours: pmHours,
        requiredSkills: pmSkills,
        tools: pmTools,
        parts: pmParts,
        technicianId: tech ? tech.id : undefined,
        created: iso(new Date(week0.getTime() - 2 * 86400000)),
        start: iso(slot.start),
        end: iso(slot.end),
      });

      // Optional Low PM (Open)
      newWOs.push({
        id: nextId(),
        vehicleId: vId,
        title: `PM follow-up: ${basePM.subsystem}`,
        type: 'Preventive',
        priority: 'Low',
        status: 'Open',
        subsystem: basePM.subsystem,
        hours: Math.max(1, Math.min(3, pmHours - 1)),
        requiredSkills: pmSkills,
        tools: pmTools,
        parts: pmParts,
        created: iso(new Date(week0.getTime() - 1 * 86400000)),
      });

    } else { // DOWN
      // High Corrective (In Progress) — also distribute across week mornings
      const sub = pick(['engine','brakes','transmission','cooling','electrical']);
      const dayOffset = pickBalancedDay(); // spread these too
      const day = new Date(week0); day.setDate(day.getDate() + dayOffset);
      const s = new Date(day); s.setHours(9,0,0,0);
      const e = new Date(s); e.setHours(e.getHours() + Math.max(4, Math.min(8, (basePM.estimatedHours ?? 2) + 2)));

      const skills = skillsFor(sub);
      const techPool = techsBySkill.get(skills[0]) || [];
      const tech = techPool.length ? pick(techPool) : null;

      newWOs.push({
        id: nextId(),
        vehicleId: vId,
        title: `Restore to service - ${sub}`,
        type: 'Corrective',
        priority: 'High',
        status: 'In Progress',
        subsystem: sub,
        hours: Math.max(4, Math.min(8, Number(basePM.estimatedHours ?? 2) + 2)),
        requiredSkills: skills,
        tools: TOOLS[sub] || undefined,
        parts: PARTS[sub] || undefined,
        technicianId: tech ? tech.id : undefined,
        created: iso(new Date(week0.getTime() - 1 * 86400000)),
        start: iso(s),
        end: iso(e),
      });

      // Optional Low PM (Open)
      newWOs.push({
        id: nextId(),
        vehicleId: vId,
        title: basePM.title,
        type: 'Preventive',
        priority: 'Low',
        status: 'Open',
        subsystem: basePM.subsystem,
        hours: pmHours,
        requiredSkills: pmSkills,
        tools: pmTools,
        parts: pmParts,
        created: iso(new Date(week0.getTime() - 2 * 86400000)),
      });
    }
  }

  write('workorders.json', newWOs);
  console.log(`Rebuilt ${newWOs.length} work orders across the week (balanced). Day loads:`, dayLoads);
}

main();

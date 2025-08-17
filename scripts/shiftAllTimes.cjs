// scripts/shiftAllTimes.cjs
// Shift every datetime string (with time part) in src/data/fake by a fixed hours delta.
// Usage: node scripts/shiftAllTimes.cjs -13   (negative = move earlier)
const fs = require('fs');
const path = require('path');

const deltaArg = Number(process.argv[2] || process.argv[3]); // tolerate "node ... -13" or "node ...  -13"
if (!Number.isFinite(deltaArg) || deltaArg === 0) {
  console.error('Usage: node scripts/shiftAllTimes.cjs <hoursDelta>\nExample: node scripts/shiftAllTimes.cjs -13');
  process.exit(1);
}
const HOURS_DELTA = deltaArg;
const MS_DELTA = HOURS_DELTA * 3_600_000;

const ROOT = process.cwd();
const FAKE_DIR = path.join(ROOT, 'src', 'data', 'fake');

const ISO_DT = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/; // has time portion

function listJsonFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) out.push(...listJsonFiles(p));
    else if (name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function walk(node, fn) {
  if (Array.isArray(node)) return node.map((v) => walk(v, fn));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = walk(node[k], fn);
    return out;
  }
  return fn(node);
}

function shiftOne(val) {
  if (typeof val === 'string' && ISO_DT.test(val)) {
    const t = Date.parse(val);
    if (Number.isFinite(t)) {
      return new Date(t + MS_DELTA).toISOString();
    }
  }
  return val;
}

(function main() {
  if (!fs.existsSync(FAKE_DIR)) {
    console.error('Cannot find src/data/fake — run from project root.');
    process.exit(1);
  }
  const files = listJsonFiles(FAKE_DIR);
  let total = 0;

  console.log(
    `Shifting datetimes by ${HOURS_DELTA}h across ${files.length} JSON file(s)...`
  );

  for (const f of files) {
    const data = loadJson(f);
    const before = JSON.stringify(data);
    const after = walk(data, shiftOne);
    const changed = JSON.stringify(after);
    if (changed !== before) {
      saveJson(f, after);
      const diff = (changed.match(/T\d{2}:/g) || []).length - (before.match(/T\d{2}:/g) || []).length;
      total += Math.abs(diff); // cheap counter
      console.log(`• shifted: ${path.relative(ROOT, f)}`);
    } else {
      console.log(`• no change: ${path.relative(ROOT, f)}`);
    }
  }

  console.log('Done.');
})();

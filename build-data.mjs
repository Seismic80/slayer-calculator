// build-data.mjs — bakes data.js for the slayer calculator from the OSRS Wiki.
// Usage: node build-data.mjs [--no-cache]
// Sources: master assignment tables, per-monster drop tables (DropsLine and the
// shared herb/seed/gem sub-table templates), infobox slayer XP, GE prices.
// Everything is cached in ./cache so re-runs are cheap.

import fs from 'fs';
import path from 'path';

const UA = 'osrs-slayer-calculator';
const CACHE = path.join(process.cwd(), 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const NO_CACHE = process.argv.includes('--no-cache');

async function fetchJson(url, cacheKey) {
  const f = path.join(CACHE, cacheKey.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
  if (!NO_CACHE && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const j = await res.json();
  fs.writeFileSync(f, JSON.stringify(j));
  return j;
}
const API = 'https://oldschool.runescape.wiki/api.php';
async function pageWikitext(title) {
  const j = await fetchJson(API + '?action=parse&prop=wikitext&format=json&formatversion=2&page=' + encodeURIComponent(title), 'page_' + title);
  if (j.error) return null;
  return j.parse.wikitext;
}
async function batchWikitext(titles) {
  // action=query allows 50 titles per request
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    let hash = 0;
    for (const ch of chunk.join('|')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const j = await fetchJson(API + '?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=' + encodeURIComponent(chunk.join('|')), 'batch_' + hash.toString(36));
    const redirect = {};
    for (const r of j.query.redirects || []) redirect[r.from] = r.to;
    const byTitle = {};
    for (const p of j.query.pages) if (p.revisions) byTitle[p.title] = p.revisions[0].slots.main.content;
    for (const t of chunk) {
      const resolved = redirect[t] || t;
      out[t] = byTitle[resolved] || null;
    }
  }
  return out;
}

/* ---------------- master assignment tables ---------------- */
// Parse a wikitable by header names so extra columns (Konar location,
// Krystilia slayer-xp) don't break the mapping.
function parseAssignTable(wt) {
  const start = wt.search(/\{\|\s*class="wikitable sortable/);
  if (start < 0) throw new Error('no assignments table');
  const end = wt.indexOf('\n|}', start);
  const block = wt.slice(start, end);
  // header cells may come before or after the first |- separator
  const chunks = block.split(/\n\|-/);
  const headChunkIdx = chunks.findIndex(c => /^\s*!/m.test(c));
  const headers = [...chunks[headChunkIdx].matchAll(/^!\s*(?:class="[^"]*"\s*\|)?\s*(.+)$/gm)]
    .map(m => m[1].replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1').toLowerCase());
  const col = name => headers.findIndex(h => h.includes(name));
  const iAmt = col('amount'), iExt = col('extended');
  if (iAmt < 0) throw new Error('no Amount column found; headers: ' + headers.join(' / '));
  const rows = chunks.slice(headChunkIdx + 1).filter(r => r.trim());
  const tasks = [];
  for (const row of rows) {
    // each cell starts a line with a single '|'
    const cells = [];
    for (const line of row.split('\n')) {
      const t = line.trim();
      if (t.startsWith('|') && !t.startsWith('|}')) cells.push(t.slice(1).trim());
    }
    if (cells.length < 3) continue;
    const clean = c => (c || '').replace(/data-sort-value="[^"]*"\s*\|/, '').trim();
    const nameM = cells[0].match(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/);
    if (!nameM) continue;
    const wM = row.match(/\{\{\+=\|weight\|(\d+)/);
    tasks.push({
      task: (nameM[2] || nameM[1]).trim(),
      amount: parseRange(clean(cells[iAmt])),
      extended: parseRange(clean(cells[iExt])),
      weight: wM ? +wM[1] : null,
      unlockText: stripWiki(clean(cells[3] || '')).slice(0, 120),
    });
  }
  return tasks.filter(t => t.weight != null);
}
function parseRange(s) {
  if (!s) return null;
  const m = s.match(/([\d,]+)\s*[-–]\s*([\d,]+)/);
  if (m) return [+m[1].replace(/,/g, ''), +m[2].replace(/,/g, '')];
  const n = s.match(/^([\d,]+)/);
  return n ? [+n[1].replace(/,/g, ''), +n[1].replace(/,/g, '')] : null;
}
function stripWiki(s) {
  return s.replace(/\{\{SCP\|([^}|]+)\|([^}|]+)[^}]*\}\}/g, '$2 $1')
    .replace(/\{\{[^}]*\}\}/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<ref[^/]*\/>/g, '').trim();
}

/* -------- task -> candidate monsters (curated; wiki page names) -------- */
// First entry is the default "base" kill. Names must match wiki page titles
// (redirects are followed). Bosses/alternatives per the master tables'
// Alternative(s) columns.
const CANDIDATES = {
  'Aberrant spectres': ['Aberrant spectre', 'Deviant spectre'],
  'Abyssal demons': ['Abyssal demon', 'Abyssal Sire'],
  'Ankou': ['Ankou'],
  'Aquanites': ['Aquanite'],
  'Araxytes': ['Araxyte', 'Araxxor'],
  'Aviansie': ['Aviansie', "Kree'arra"],
  'Basilisks': ['Basilisk', 'Basilisk Knight'],
  'Black demons': ['Black demon', 'Demonic gorilla'],
  'Black dragons': ['Black dragon', 'Brutal black dragon', 'King Black Dragon'],
  'Bloodveld': ['Bloodveld', 'Mutated Bloodveld'],
  'Blue dragons': ['Blue dragon', 'Brutal blue dragon'],
  'Brine rats': ['Brine rat'],
  'Cave horrors': ['Cave horror'],
  'Cave kraken': ['Cave kraken', 'Kraken'],
  'Custodian stalkers': ['Elder custodian stalker', 'Mature custodian stalker', 'Juvenile custodian stalker'],
  'Dagannoth': ['Dagannoth (Waterbirth Island)', 'Dagannoth Rex'],
  'Dark beasts': ['Dark beast'],
  'Drakes': ['Drake'],
  'Dust devils': ['Dust devil'],
  'Elves': ['Elf warrior'],
  'Fire giants': ['Fire giant'],
  'Fossil Island Wyverns': ['Spitting Wyvern', 'Ancient Wyvern'],
  'Frost dragons': ['Frost dragon'],
  'Gargoyles': ['Gargoyle', 'Grotesque Guardians'],
  'Greater demons': ['Greater demon', "K'ril Tsutsaroth", 'Skotizo', 'Tormented Demon'],
  'Gryphons': ['Gryphon', 'Shellbane gryphon'],
  'Hellhounds': ['Hellhound', 'Cerberus'],
  'Hydras': ['Hydra', 'Alchemical Hydra'],
  'Jellies': ['Jelly', 'Warped Jelly'],
  'Kalphite': ['Kalphite Worker', 'Kalphite Soldier', 'Kalphite Queen'],
  'Kurask': ['Kurask'],
  'Lesser Nagua': ['Sulphur Nagua', 'Frost Nagua'],
  'Lizardmen': ['Lizardman', 'Lizardman brute', 'Lizardman shaman'],
  'Metal dragons': ['Bronze dragon', 'Iron dragon', 'Steel dragon', 'Mithril dragon', 'Adamant dragon', 'Rune dragon'],
  'Mutated Zygomites': ['Zygomite', 'Ancient Zygomite'],
  'Nechryael': ['Nechryael', 'Greater Nechryael'],
  'Red dragons': ['Red dragon', 'Brutal red dragon'],
  'Scabarites': ['Locust rider'],
  'Skeletal Wyverns': ['Skeletal Wyvern'],
  'Smoke devils': ['Smoke devil', 'Thermonuclear smoke devil'],
  'Spiritual creatures': ['Spiritual mage', 'Spiritual ranger', 'Spiritual warrior'],
  'Suqahs': ['Suqah'],
  'Trolls': ['Mountain troll'],
  'Turoths': ['Turoth'],
  'TzHaar': ['TzHaar-Ket'],
  'Vampyres': ['Feral Vampyre', 'Vyrewatch Sentinel'],
  'Warped creatures': ['Warped Terrorbird', 'Warped Tortoise'],
  'Waterfiends': ['Waterfiend'],
  'Wyrms': ['Wyrm'],
  // Krystilia (all kills must be in the Wilderness)
  'Bandits': ['Bandit'],
  'Hill Giants': ['Hill Giant'],
  'Bears': ['Black bear', 'Callisto', 'Artio'],
  'Black Knights': ['Black Knight'],
  'Chaos druids': ['Chaos druid', 'Elder Chaos druid'],
  'Dark warriors': ['Dark warrior'],
  'Earth warriors': ['Earth warrior'],
  'Ents': ['Ent'],
  'Green dragons': ['Green dragon'],
  'Ice giants': ['Ice giant'],
  'Ice warriors': ['Ice warrior'],
  'Lava dragons': ['Lava dragon'],
  'Lesser demons': ['Lesser demon'],
  'Magic axes': ['Magic axe'],
  'Mammoths': ['Mammoth'],
  'Moss giants': ['Moss giant'],
  'Pirates': ['Pirate', 'Zombie pirate'],
  'Revenants': ['Revenant dragon', 'Revenant ork'],   // special-cased drop table below
  'Rogues': ['Rogue'],
  'Scorpions': ['Scorpion', 'Scorpia'],
  'Skeletons': ['Skeleton', "Vet'ion", "Calvar'ion"],
  'Spiders': ['Giant spider', 'Venenatis', 'Spindel'],
  'Zombies': ['Zombie', 'Zombie pirate'],
  // Boss task rosters
  'Boss (Duradel/Nieve)': ['General Graardor', 'Commander Zilyana', "K'ril Tsutsaroth", "Kree'arra",
    'Dagannoth Rex', 'Kalphite Queen', 'King Black Dragon', 'Giant Mole', 'Grotesque Guardians',
    'Kraken', 'Cerberus', 'Thermonuclear smoke devil', 'Abyssal Sire'],
  'Boss (Krystilia)': ['Callisto', "Vet'ion", 'Venenatis', 'Scorpia', 'Chaos Elemental',
    'Chaos Fanatic', 'Crazy archaeologist', 'King Black Dragon', 'Artio', "Calvar'ion", 'Spindel'],
};
// normalise task names coming out of the four tables to CANDIDATES keys
const TASK_ALIAS = {
  'aberrant spectre': 'Aberrant spectres', 'abyssal demon': 'Abyssal demons', 'ankou': 'Ankou',
  'aquanite': 'Aquanites', 'araxyte': 'Araxytes', 'aviansie': 'Aviansie', 'basilisk': 'Basilisks',
  'black demon': 'Black demons', 'black dragon': 'Black dragons', 'bloodveld': 'Bloodveld',
  'blue dragon': 'Blue dragons', 'boss': 'Boss', 'bosses': 'Boss', 'brine rat': 'Brine rats',
  'cave horror': 'Cave horrors', 'cave kraken': 'Cave kraken', 'custodian stalker': 'Custodian stalkers',
  'dagannoth': 'Dagannoth', 'dark beast': 'Dark beasts', 'drake': 'Drakes', 'dust devil': 'Dust devils',
  'elves': 'Elves', 'elf': 'Elves', 'fire giant': 'Fire giants', 'fossil island wyvern': 'Fossil Island Wyverns',
  'frost dragon': 'Frost dragons', 'gargoyle': 'Gargoyles', 'greater demon': 'Greater demons',
  'gryphon': 'Gryphons', 'hellhound': 'Hellhounds', 'hydra': 'Hydras', 'jellies': 'Jellies', 'jelly': 'Jellies',
  'kalphite': 'Kalphite', 'kurask': 'Kurask', 'lesser nagua': 'Lesser Nagua', 'lizardmen': 'Lizardmen',
  'metal dragon': 'Metal dragons', 'mutated zygomite': 'Mutated Zygomites', 'nechryael': 'Nechryael',
  'red dragon': 'Red dragons', 'scabarites': 'Scabarites', 'skeletal wyvern': 'Skeletal Wyverns',
  'smoke devil': 'Smoke devils', 'spiritual creature': 'Spiritual creatures', 'suqah': 'Suqahs',
  'troll': 'Trolls', 'turoth': 'Turoths', 'tzhaar': 'TzHaar', 'vampyre': 'Vampyres',
  'warped creature': 'Warped creatures', 'waterfiend': 'Waterfiends', 'wyrm': 'Wyrms',
  'bandit': 'Bandits', 'bear': 'Bears', 'black knight': 'Black Knights', 'chaos druid': 'Chaos druids',
  'dark warrior': 'Dark warriors', 'earth warrior': 'Earth warriors', 'ent': 'Ents',
  'green dragon': 'Green dragons', 'ice giant': 'Ice giants', 'ice warrior': 'Ice warriors',
  'lava dragon': 'Lava dragons', 'lesser demon': 'Lesser demons', 'magic axe': 'Magic axes',
  'mammoth': 'Mammoths', 'moss giant': 'Moss giants', 'pirate': 'Pirates', 'revenant': 'Revenants',
  'hill giant': 'Hill Giants', 'wilderness boss': 'Boss', 'wilderness bosse': 'Boss',
  'rogue': 'Rogues', 'scorpion': 'Scorpions', 'skeleton': 'Skeletons', 'spider': 'Spiders', 'zombie': 'Zombies',
};
function taskKey(name) {
  let n = name.toLowerCase().replace(/s$/, '');
  if (TASK_ALIAS[name.toLowerCase()]) return TASK_ALIAS[name.toLowerCase()];
  if (TASK_ALIAS[n]) return TASK_ALIAS[n];
  n = name.toLowerCase().replace(/es$/, '');
  if (TASK_ALIAS[n]) return TASK_ALIAS[n];
  return null;
}

/* ---------------- drop table parsing ---------------- */
const QUAL_RARITY = { always: 1, common: 1 / 8, uncommon: 1 / 32, rare: 1 / 128, 'very rare': 1 / 512 };
function evalArith(s, vars = {}) {
  s = String(s)
    .replace(/\{\{#var:([a-z0-9_]+)\}\}/gi, (_, n) => (vars[n.toLowerCase()] != null ? '(' + vars[n.toLowerCase()] + ')' : 'NaN'))
    .replace(/round\s*-?\d+/gi, '').replace(/,/g, '').replace(/×/g, '*').trim();
  if (!s || /[^0-9+\-*/(). eE]/.test(s)) return null;
  try { const v = Function('"use strict";return (' + s + ')')(); return isFinite(v) ? v : null; } catch { return null; }
}
function parseRarity(s, vars = {}) {
  if (!s) return null;
  s = s.replace(/&nbsp;/g, ' ').replace(/,/g, '').trim();
  // resolve {{#var:x}} and {{#expr:...}} to numbers first
  s = s.replace(/\{\{#var:([a-z0-9_]+)\}\}/gi, (_, n) => (vars[n.toLowerCase()] != null ? '(' + vars[n.toLowerCase()] + ')' : 'NaN'));
  s = s.replace(/\{\{#expr:([^{}]*)\}\}/gi, (_, e) => { const v = evalArith(e); return v == null ? 'NaN' : String(v); });
  const q = s.toLowerCase().replace(/\[\[|\]\]/g, '');
  for (const k of Object.keys(QUAL_RARITY)) if (q.startsWith(k)) return QUAL_RARITY[k];
  // whole-string arithmetic: "1/128", "2 × 1/128", "1/(32*(0.6))", "~1/90"
  const v = evalArith(s.replace(/^~/, '').split(';')[0]);
  if (v != null && v > 0 && v <= 1) return v;
  const m = s.match(/(?:(\d+(?:\.\d+)?)\s*[×x*]\s*)?~?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (m) return (m[1] ? +m[1] : 1) * (+m[2]) / (+m[3]);
  return null;
}
// brace-balanced extraction of {{Name|...}} templates with their positions
function extractTemplates(wt, name) {
  const out = [];
  const re = new RegExp('\\{\\{\\s*' + name + '\\s*\\|', 'gi');
  let m;
  while ((m = re.exec(wt))) {
    let depth = 2, i = m.index + m[0].length;
    const start = i;
    while (i < wt.length && depth > 0) {
      if (wt[i] === '{') depth++;
      else if (wt[i] === '}') depth--;
      i++;
    }
    out.push({ body: wt.slice(start, i - 2), index: m.index });
    re.lastIndex = i;
  }
  return out;
}
function parseQty(s) {
  if (!s) return 1;
  s = s.replace(/\(noted\)/gi, '').replace(/,/g, '').trim();
  const parts = s.split(/[;,]/).map(p => p.trim()).filter(Boolean);
  const vals = [];
  for (const p of parts) {
    const r = p.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
    if (r) vals.push((+r[1] + +r[2]) / 2);
    else { const n = p.match(/\d+(?:\.\d+)?/); if (n) vals.push(+n[0]); }
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
}
function templateParams(body) {
  // split top-level | (no nested template handling needed beyond depth count)
  const params = {}; let depth = 0, cur = '', parts = [];
  for (const ch of body) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '|' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  let pos = 0;
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0 && /^[a-z0-9_ ]+$/i.test(p.slice(0, eq).trim())) params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    else params[++pos] = p.trim();
  }
  return params;
}
function sectionCategory(header, itemName) {
  const h = (header || '').toLowerCase();
  const n = (itemName || '').toLowerCase();
  if (/unique|pre-roll|preroll|sigil|signet/.test(h)) return 'rares';
  if (/tertiary|catacombs|wilderness slayer|gems? \(/.test(h)) return 'tertiary';
  if (/herb/.test(h) || /^grimy /.test(n)) return 'herbs';
  if (/seed/.test(h) || / seed$/.test(n) || / sapling$/.test(n)) return 'seeds';
  if (/rune|ammunition|bolts|arrows/.test(h) || / rune$/.test(n) || /rune \(|arrow$|bolts?$|bolt tips$|javelin$/.test(n)) return 'runes';
  if (/weapon|armour|armor|equipment/.test(h)) return 'alchs';
  if (/food|potion|consumable|supplies/.test(h)) return 'supplies';
  if (/resource|material|ore|bar|log|gem/.test(h)) return 'resources';
  if (/coin|other|misc/.test(h)) return 'other';
  return 'other';
}
// Sub-table templates (herbs/seeds) expanded from their wiki definitions.
// The template defines vars from its {{{1}}} rate param, then each DropsLine
// rarity references them, e.g. rarity=1/{{#expr:1/(32*{{#var:herbbase}})}}.
const SUBTABLES = {};
async function loadSubtable(name) {
  if (SUBTABLES[name]) return SUBTABLES[name];
  const wt = await pageWikitext('Template:' + name);
  if (!wt) return (SUBTABLES[name] = null);
  const varDefs = [...wt.matchAll(/\{\{#vardefine:([a-z0-9_]+)\|\{\{#expr:((?:[^{}]|\{\{\{[^{}]*\}\}\}|\{\{#var:[a-z0-9_]+\}\})*)\}\}\}\}/gi)]
    .map(m => ({ name: m[1].toLowerCase(), expr: m[2] }));
  const lines = extractTemplates(wt, 'DropsLine').map(t => {
    const p = templateParams(t.body);
    return p.name ? { name: p.name, qtyRaw: p.quantity || '1', rarityRaw: p.rarity || '' } : null;
  }).filter(Boolean);
  SUBTABLES[name] = { varDefs, lines };
  return SUBTABLES[name];
}

/* ---------------- monster page parsing ---------------- */
function parseMonster(title, wt, warn) {
  const info = {};
  for (const f of ['hitpoints', 'slayxp', 'combat']) {
    const m = wt.match(new RegExp('\\|' + f + '\\d?\\s*=\\s*([\\d.]+)'));
    info[f] = m ? +m[1] : null;
  }
  // page-level arithmetic vars, e.g. {{#vardefine:herbbase|{{#expr:1/(...)}}}}
  // or plain {{#vardefine:allotseed|15/128 / 128}}
  const vars = {};
  for (const vm of wt.matchAll(/\{\{#vardefine:([a-z0-9_]+)\|([0-9+\-*/(). ]+)\}\}/gi)) {
    const v = evalArith(vm[2]);
    if (v != null) vars[vm[1].toLowerCase()] = v;
  }
  for (const vm of wt.matchAll(/\{\{#vardefine:([a-z0-9_]+)\|\{\{#expr:((?:[^{}]|\{\{\{[^{}]*\}\}\}|\{\{#var:[a-z0-9_]+\}\})*)\}\}\}\}/gi)) {
    const v = evalArith(vm[2], vars);
    if (v != null) vars[vm[1].toLowerCase()] = v;
  }
  const headers = [...wt.matchAll(/^===?\s*(.+?)\s*===?\s*$/gm)].map(m => ({ idx: m.index, name: m[1] }));
  const sectionAt = idx => { let s = ''; for (const h of headers) { if (h.idx < idx) s = h.name; else break; } return s; };

  const drops = [];
  const seen = new Set();
  for (const t of extractTemplates(wt, 'DropsLine')) {
    const p = templateParams(t.body);
    if (!p.name || /^nothing$/i.test(p.name)) continue;
    if (/^(once|varies|n\/?a)?$/i.test((p.rarity || '').trim())) continue; // quest one-offs / unstated
    const section = sectionAt(t.index);
    let rate = parseRarity(p.rarity, vars);
    // Konar's on-task tertiary: {{Brimstone rarity|N}} → 1/N per kill
    const brim = (p.rarity || '').match(/\{\{Brimstone rarity\|(\d+(?:\.\d+)?)/);
    if (rate == null && brim) { rate = 1 / +brim[1]; p.name = 'Brimstone key'; }
    if (rate == null || rate <= 0 || rate > 1) { warn.push(title + ': unparsed rarity "' + (p.rarity || '').slice(0, 40) + '" for ' + p.name); continue; }
    const key = p.name + '|' + rate.toFixed(8);
    if (seen.has(key)) continue;
    seen.add(key);
    drops.push({ name: p.name, qty: parseQty(p.quantity), rate, cat: sectionCategory(section, p.name), gemw: (p.gemw || '').toLowerCase() !== 'no' });
  }
  const subtableCalls = [];
  for (const m of wt.matchAll(/\{\{((?:Herb|Rare[ ]?[Ss]eed|Tree[- ]?herb[ ]?seed|Allotment[ ]?seed|Common[ ]?seed|Hops[ ]?seed|Many[ ]?seed|Uncommon[ ]?seed|FixedAllotmentSeed|GeneralSeed)[A-Za-z ]*DropLines\d?)\s*\|\s*([^}|]+)(?:\|\s*(\d+(?:-\d+)?))?[|}]/g)) {
    subtableCalls.push({ tpl: m[1].trim(), base: m[2].trim(), qty: m[3], section: sectionAt(m.index) });
  }
  for (const m of wt.matchAll(/\{\{(Gem drop table|GemDropTable|Rare drop table|RareDropTable)\s*(?:\|\s*([^}|]+))?/gi)) {
    const base = parseRarity((m[2] || '').trim(), vars);
    const isRDT = /rare/i.test(m[1]);
    drops.push({ name: isRDT ? 'Rare drop table roll' : 'Gem drop table roll', qty: 1, rate: base ?? 1 / 128, cat: 'other', gemw: false });
  }
  return { title, hp: info.hitpoints, slayxp: info.slayxp || info.hitpoints, combat: info.combat, drops, subtableCalls };
}

/* ---------------- main ---------------- */
const OUT_WARNINGS = [];
async function main() {
  // 1. masters
  const masterPages = {
    duradel: 'Duradel/Slayer assignments',
    nieve: 'Nieve/Slayer assignments',
    konar: 'Konar quo Maten',
    krystilia: 'Krystilia',
  };
  const masters = {};
  for (const [key, page] of Object.entries(masterPages)) {
    const wt = await pageWikitext(page);
    const tasks = parseAssignTable(wt);
    masters[key] = tasks.map(t => {
      const k = taskKey(t.task);
      if (!k) OUT_WARNINGS.push(key + ': no candidate mapping for task "' + t.task + '"');
      const cands = k === 'Boss'
        ? CANDIDATES[key === 'krystilia' ? 'Boss (Krystilia)' : 'Boss (Duradel/Nieve)']
        : (CANDIDATES[k] || []);
      return { task: t.task, key: k || t.task, amount: t.amount, extended: t.extended, weight: t.weight, unlock: t.unlockText, monsters: cands };
    });
    console.log(key + ': ' + masters[key].length + ' tasks, total weight ' + masters[key].reduce((a, t) => a + t.weight, 0));
  }

  // 2. points tables (base + milestone) parsed from master pages
  const pointPages = { duradel: 'Duradel', nieve: 'Nieve', konar: 'Konar quo Maten', krystilia: 'Krystilia' };
  const points = {};
  for (const [key, page] of Object.entries(pointPages)) {
    const wt = await pageWikitext(page);
    const seg = wt.slice(wt.search(/Task interval|Points given/i) - 200);
    const rows = [...seg.matchAll(/\|\s*Every\s*(task|[\d,]+(?:th|st|nd|rd))\s*\n\|\s*([\d,]+)/gi)].slice(0, 6);
    const p = { base: null, milestones: [] };
    for (const r of rows) {
      const v = +r[2].replace(/,/g, '');
      if (r[1].toLowerCase() === 'task') p.base = v;
      else p.milestones.push([+r[1].replace(/[^\d]/g, ''), v]);
    }
    points[key] = p;
    console.log(key + ' points:', JSON.stringify(p));
  }

  // 3. monsters
  const monsterSet = new Set();
  for (const list of Object.values(masters)) for (const t of list) for (const m of t.monsters) monsterSet.add(m);
  monsterSet.delete('Revenant dragon'); monsterSet.delete('Revenant ork'); // special-cased
  const titles = [...monsterSet];
  console.log('fetching ' + titles.length + ' monster pages...');
  const pages = await batchWikitext(titles);
  const monsters = {};
  for (const t of titles) {
    if (!pages[t]) { OUT_WARNINGS.push('MISSING PAGE: ' + t); continue; }
    monsters[t] = parseMonster(t, pages[t], OUT_WARNINGS);
  }
  // expand sub-table templates (herbs, seeds)
  for (const mon of Object.values(monsters)) {
    for (const call of mon.subtableCalls) {
      const tbl = await loadSubtable(call.tpl);
      const base = parseRarity(call.base) ?? (isFinite(+call.base) ? +call.base : null);
      if (!tbl || !tbl.lines.length || base == null) { OUT_WARNINGS.push(mon.title + ': sub-table ' + call.tpl + ' (' + call.base + ') not expanded'); continue; }
      // resolve the template's vardefines with {{{1}}} = this call's base rate
      const vars = {};
      for (const vd of tbl.varDefs) {
        const v = evalArith(vd.expr.replace(/\{\{\{1(?:\|[^}]*)?\}\}\}/g, '(' + base + ')'), vars);
        if (v != null) vars[vd.name] = v;
      }
      for (const l of tbl.lines) {
        const rate = parseRarity(l.rarityRaw.replace(/\{\{\{1(?:\|[^}]*)?\}\}\}/g, '(' + base + ')'), vars);
        if (rate == null || rate <= 0 || rate > 1) { OUT_WARNINGS.push(mon.title + '/' + call.tpl + ': bad line ' + l.name); continue; }
        const qty = parseQty(l.qtyRaw.replace(/\{\{\{2\|?([^}]*)\}\}\}/, (_, d) => call.qty || d || '1'));
        mon.drops.push({ name: l.name, qty, rate, cat: sectionCategory(call.section, l.name), gemw: true });
      }
    }
    delete mon.subtableCalls;
  }

  // stats fallback for group pages without a monster infobox
  const STAT_SOURCE = { 'Grotesque Guardians': 'Dusk' };
  for (const [target, src] of Object.entries(STAT_SOURCE)) {
    if (!monsters[target]) continue;
    const wt2 = await pageWikitext(src);
    if (!wt2) continue;
    for (const f of ['hitpoints', 'slayxp', 'combat']) {
      const m2 = wt2.match(new RegExp('\\|' + f + '\\d?\\s*=\\s*([\\d.]+)'));
      if (m2) monsters[target][{ hitpoints: 'hp', slayxp: 'slayxp', combat: 'combat' }[f]] = +m2[1];
    }
    if (!monsters[target].slayxp) monsters[target].slayxp = monsters[target].hp;
  }

  // 4. prices: mapping + latest for every referenced item
  console.log('fetching prices...');
  const mapping = await fetchJson('https://prices.runescape.wiki/api/v1/osrs/mapping', 'price_mapping');
  const latest = (await fetchJson('https://prices.runescape.wiki/api/v1/osrs/latest', 'price_latest')).data;
  const byName = {};
  for (const m of mapping) byName[m.name.toLowerCase()] = m;
  const itemNames = new Set();
  for (const mon of Object.values(monsters)) for (const d of mon.drops) itemNames.add(d.name);
  const items = {};
  for (const n of itemNames) {
    const m = byName[n.toLowerCase()];
    if (!m) { items[n] = { id: null, snap: n === 'Coins' ? 1 : 0, ha: 0, tradeable: false }; continue; }
    const p = latest[m.id];
    const snap = p && (p.high || p.low) ? Math.round(((p.high || p.low) + (p.low || p.high)) / 2) : 0;
    items[n] = { id: m.id, snap, ha: m.highalch || 0, tradeable: true };
  }
  // pseudo-items: average roll values, wiki-derived constants
  items['Rare drop table roll'] = { id: null, snap: 9000, ha: 0, tradeable: false }; // avg RDT roll ≈ 9k (https://oldschool.runescape.wiki/w/Rare_drop_table)
  items['Gem drop table roll'] = { id: null, snap: 400, ha: 0, tradeable: false };   // avg gem table roll (https://oldschool.runescape.wiki/w/Gem_drop_table)
  // untradeable keys — rough average chest values, shown as tertiary counts:
  items["Larran's key"] = { id: null, snap: 150000, ha: 0, tradeable: false };  // https://oldschool.runescape.wiki/w/Larran%27s_big_chest
  items['Brimstone key'] = { id: null, snap: 60000, ha: 0, tradeable: false };  // https://oldschool.runescape.wiki/w/Brimstone_chest

  // 5. rares reclassification heuristic: expensive + rare ⇒ 'rares'
  for (const mon of Object.values(monsters)) {
    for (const d of mon.drops) {
      const it = items[d.name];
      const price = it ? Math.max(it.snap, it.ha) : 0;
      if (d.cat !== 'tertiary' && d.rate <= 1 / 90 && price >= 100000) d.cat = 'rares';
      if (d.cat === 'other' && /clue scroll|ensouled|champion scroll|dark totem|ancient shard|mossy key|giant key|brimstone key|larran's key/i.test(d.name)) d.cat = 'tertiary';
    }
  }

  // 6. revenants special case: on-task per-kill EV table from the shared template
  //    formulas (see Template:Revenants/Drops; ported from the rev calculator).
  const revs = {};
  for (const [name, combat, hp] of [['Revenant dragon', 135, 155], ['Revenant ork', 105, 105]]) {
    const A = Math.floor(2200 / Math.floor(Math.sqrt(combat)));
    const B = 15 + Math.floor(Math.pow(combat + 60, 2) / 200);
    const s = Math.floor(Math.sqrt(combat));
    const medioc = (Math.min(A, B) - 1) / A, coins = B < A ? (A - B) / A : 0;
    const uniqueOn = 1 / (A * 5.333); // on task, unskulled
    const drops = [
      { name: 'Revenant ether', qty: (s + 2) / 2, rate: 1, cat: 'other', gemw: true },
      { name: "Craw's bow (u)", qty: 1, rate: uniqueOn / 5, cat: 'rares', gemw: true },
      { name: "Thammaron's sceptre (u)", qty: 1, rate: uniqueOn / 5, cat: 'rares', gemw: true },
      { name: "Viggora's chainmace (u)", qty: 1, rate: uniqueOn / 5, cat: 'rares', gemw: true },
      { name: 'Amulet of avarice', qty: 1, rate: uniqueOn * 2 / 5, cat: 'rares', gemw: true },
      { name: 'Ancient relic', qty: 1, rate: 1 / (A * 40), cat: 'rares', gemw: true },
      { name: 'Ancient effigy', qty: 1, rate: 1 / (A * 40), cat: 'rares', gemw: true },
      { name: 'Ancient medallion', qty: 1, rate: 1 / (A * 40), cat: 'rares', gemw: true },
      { name: 'Ancient statuette', qty: 1, rate: 2 / (A * 40), cat: 'rares', gemw: true },
      { name: 'Ancient crystal', qty: 1, rate: 3 / (A * 40), cat: 'rares', gemw: true },
      { name: 'Ancient totem', qty: 1, rate: 4 / (A * 40), cat: 'rares', gemw: true },
      { name: 'Ancient emblem', qty: 1, rate: 6 / (A * 40), cat: 'rares', gemw: true },
      { name: 'Magic seed', qty: 4, rate: 4 / (A * 40), cat: 'seeds', gemw: true },
      { name: 'Yew seed', qty: 4, rate: 4 / (A * 40), cat: 'seeds', gemw: true },
      { name: 'Dragon med helm', qty: 1, rate: 13 / (A * 40), cat: 'alchs', gemw: true },
      { name: 'Battlestaff', qty: 4, rate: medioc * 10 / 198, cat: 'alchs', gemw: true },
      { name: 'Bracelet of ethereum (uncharged)', qty: 1, rate: medioc * 30 / 198, cat: 'alchs', gemw: true },
      { name: 'Rune full helm', qty: 2, rate: medioc * 4 / 198, cat: 'alchs', gemw: true },
      { name: 'Rune platebody', qty: 2, rate: medioc * 4 / 198, cat: 'alchs', gemw: true },
      { name: 'Dragon platelegs', qty: 1.5, rate: medioc * 1 / 198, cat: 'alchs', gemw: true },
      { name: 'Dragon dagger', qty: 2, rate: medioc * 2 / 198, cat: 'alchs', gemw: true },
      { name: 'Death rune', qty: 45, rate: medioc * 10 / 198, cat: 'runes', gemw: true },
      { name: 'Blood rune', qty: 75, rate: medioc * 10 / 198, cat: 'runes', gemw: true },
      { name: 'Law rune', qty: 32.5, rate: medioc * 10 / 198, cat: 'runes', gemw: true },
      { name: 'Onyx bolt tips', qty: 4.5, rate: medioc * 6 / 198, cat: 'runes', gemw: true },
      { name: 'Coal', qty: 45, rate: medioc * 12 / 198, cat: 'resources', gemw: true },
      { name: 'Adamantite bar', qty: 5, rate: medioc * 12 / 198, cat: 'resources', gemw: true },
      { name: 'Runite ore', qty: 3, rate: medioc * 8 / 198, cat: 'resources', gemw: true },
      { name: 'Runite bar', qty: 2.5, rate: medioc * 6 / 198, cat: 'resources', gemw: true },
      { name: 'Black dragonhide', qty: 4, rate: medioc * 8 / 198, cat: 'resources', gemw: true },
      { name: 'Mahogany plank', qty: 8.5, rate: medioc * 6 / 198, cat: 'resources', gemw: true },
      { name: 'Yew logs', qty: 30, rate: medioc * 8 / 198, cat: 'resources', gemw: true },
      { name: 'Magic logs', qty: 12, rate: medioc * 4 / 198, cat: 'resources', gemw: true },
      { name: 'Uncut dragonstone', qty: 3.5, rate: medioc * 2 / 198, cat: 'resources', gemw: true },
      { name: 'Blighted manta ray', qty: 12.5, rate: medioc * 8 / 198, cat: 'supplies', gemw: true },
      { name: 'Blighted super restore(4)', qty: 2, rate: medioc * 6 / 198, cat: 'supplies', gemw: true },
      { name: 'Revenant cave teleport', qty: 3, rate: medioc * 10 / 198, cat: 'other', gemw: true },
    ];
    if (coins > 0) drops.push({ name: 'Coins', qty: (1 + 25 * s) / 2, rate: coins, cat: 'other', gemw: false });
    const slayxp = { 'Revenant dragon': 186, 'Revenant ork': 115 }[name];
    revs[name] = { title: name + ' (on task)', hp, slayxp, combat, drops };
    monsters[name] = revs[name];
  }
  // add price entries for rev items not already present
  const revItems = { 'Revenant ether': 21820, "Craw's bow (u)": 22547, "Thammaron's sceptre (u)": 22552, "Viggora's chainmace (u)": 22542, 'Amulet of avarice': 22557, 'Ancient relic': 22305, 'Ancient effigy': 22302, 'Ancient medallion': 22299, 'Ancient statuette': 21813, 'Ancient crystal': 21804, 'Ancient totem': 21810, 'Ancient emblem': 21807, 'Bracelet of ethereum (uncharged)': 21817, 'Revenant cave teleport': 21802, 'Blighted manta ray': 24589, 'Blighted super restore(4)': 24598 };
  for (const [n, id] of Object.entries(revItems)) {
    if (items[n]) continue;
    const m = mapping.find(x => x.id === id);
    const p = latest[id];
    items[n] = { id, snap: p && (p.high || p.low) ? Math.round(((p.high || p.low) + (p.low || p.high)) / 2) : 0, ha: (m && m.highalch) || 0, tradeable: true };
  }
  if (!items['Coins']) items['Coins'] = { id: null, snap: 1, ha: 1, tradeable: false };

  // 7. emit
  const out = { builtAt: new Date().toISOString().slice(0, 10), masters, points, monsters, items };
  fs.writeFileSync('data.js', '// Generated by build-data.mjs from the OSRS Wiki on ' + out.builtAt + ' — do not edit by hand.\nconst DATA = ' + JSON.stringify(out) + ';\n');
  fs.writeFileSync('build-warnings.txt', OUT_WARNINGS.join('\n'));
  console.log('monsters: ' + Object.keys(monsters).length + ', items: ' + Object.keys(items).length);
  console.log('warnings: ' + OUT_WARNINGS.length + ' (see build-warnings.txt)');
  console.log('data.js written: ' + (fs.statSync('data.js').size / 1024).toFixed(0) + ' KB');
}
main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * scan-zmel-datagouv.mjs v2 — Search + per-dataset deep fetch
 *
 * v1 trovava i dataset ma "filesCount:0" perché l'API search non include
 * le risorse. v2 fa una seconda GET /datasets/{slug}/ per ognuno per
 * ottenere i link reali ai file. Inoltre regex Med stricter (no falsi
 * positivi Loire-Atlantique→Aude).
 *
 * Esecuzione:  node scripts/scan-zmel-datagouv.mjs
 * Output:      ./zmel-scan.json
 */

import fs from 'node:fs';

const API = 'https://www.data.gouv.fr/api/1';

const QUERIES = [
  'ZMEL',
  'zones de mouillages',
  'mouillages organisés',
  'mouillages collectifs',
  'mouillage individuel',
  'mouillage plaisance',
  'AOT mouillage',
  'mouillages équipements légers',
  'plaisance mer',
];

const MED_DEPTS = {
  '06': 'Alpes-Maritimes',
  '11': 'Aude',
  '13': 'Bouches-du-Rhône',
  '2A': 'Corse-du-Sud',
  '2B': 'Haute-Corse',
  '30': 'Gard',
  '34': 'Hérault',
  '66': 'Pyrénées-Orientales',
  '83': 'Var',
};

const MED_NAMES_LC = [
  'alpes-maritimes', 'aude', 'bouches-du-rhône', 'bouches du rhône',
  'corse-du-sud', 'corse du sud', 'haute-corse', 'haute corse',
  'corse', 'gard', 'hérault', 'pyrénées-orientales', 'pyrénées orientales',
  'var', 'paca', 'provence', "côte d'azur", 'méditerranée', 'mediterranee',
  'languedoc', 'roussillon', 'occitanie', 'provence-alpes-côte',
];

async function api(path) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'audit-zmel/2.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
}

async function searchDatasets(query) {
  const all = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const j = await api(`/datasets/?q=${encodeURIComponent(query)}&page=${page}&page_size=100`);
      if (!j.data?.length) break;
      all.push(...j.data);
      if (j.data.length < 100) break;
    } catch (e) {
      console.error(`    [page ${page}] ${e.message}`);
      break;
    }
  }
  return all;
}

function checkMed(d) {
  const title = (d.title || '').toLowerCase();
  const zonesArr = (d.spatial?.zones || []).map(z => {
    if (typeof z === 'string') return z;
    return z?.name || z?.id || '';
  });
  const zones = zonesArr.join(' | ').toLowerCase();
  const tags = (d.tags || []).map(t => String(t).toLowerCase()).join(' | ');

  // 1. Codice dipartimento — STRICT: solo in title/zones/tags, con boundary
  //    accettiamo solo: " 83 ", "(83)", "[83]", "-83-", "_83_", "/83/", "(83)"
  for (const code of Object.keys(MED_DEPTS)) {
    const re = new RegExp(`(?:^|[\\s\\(\\[\\-_/])${code}(?:[\\s\\)\\]\\-_/.,]|$)`, 'i');
    if (re.test(title)) return { dept: code, name: MED_DEPTS[code], via: 'codice in title' };
    if (re.test(zones)) return { dept: code, name: MED_DEPTS[code], via: 'codice in zones' };
    if (re.test(tags))  return { dept: code, name: MED_DEPTS[code], via: 'codice in tags' };
  }
  // 2. Nome
  for (const nm of MED_NAMES_LC) {
    if (title.includes(nm)) return { dept: '?', name: nm, via: 'nome in title' };
    if (zones.includes(nm)) return { dept: '?', name: nm, via: 'nome in zones' };
    if (tags.includes(nm))  return { dept: '?', name: nm, via: 'nome in tags' };
  }
  return null;
}

function extractFiles(d) {
  return (d.resources || []).map(r => ({
    title: r.title,
    format: (r.format || '').toLowerCase(),
    mime: r.mime || null,
    url: r.url,
    filesize: r.filesize ?? null,
    lastModified: r.last_modified || null,
    type: r.type || null,
  }));
}

(async () => {
  console.log('▶ scan-zmel-datagouv.mjs v2 — search + deep fetch + filtri Méd stricter');

  // 1) Aggregate search results (deduplicate by id)
  const seen = new Map();
  for (const q of QUERIES) {
    process.stdout.write(`  q="${q}" ... `);
    try {
      const data = await searchDatasets(q);
      console.log(`${data.length} risultati`);
      for (const d of data) if (!seen.has(d.id)) seen.set(d.id, d);
    } catch (e) {
      console.log(`KO ${e.message}`);
    }
  }
  console.log(`\n  Totale dataset unici: ${seen.size}`);

  // 2) Filtro Méditerranée
  const medList = [];
  for (const d of seen.values()) {
    const med = checkMed(d);
    if (med) medList.push({ d, med });
  }
  console.log(`  Pre-fetch Med candidates: ${medList.length}`);

  // 3) Deep fetch ognuno per ottenere risorse
  console.log('\n  Deep fetch /datasets/{slug}/ per ognuno...');
  const enriched = [];
  let i = 0;
  for (const { d, med } of medList) {
    i++;
    process.stdout.write(`  [${i}/${medList.length}] ${d.slug.slice(0, 60)}... `);
    try {
      const full = await api(`/datasets/${d.slug}/`);
      const files = extractFiles(full);
      const tags = (full.tags || []);
      const zones = (full.spatial?.zones || []);
      console.log(`${files.length} risorse`);
      enriched.push({
        id: full.id, slug: full.slug, title: full.title,
        mediterranean: med,
        organization: full.organization?.name || null,
        lastUpdate: (full.last_update || full.last_modified || '').slice(0, 10) || null,
        license: full.license || null,
        tags,
        zones: typeof zones[0] === 'string' ? zones : zones.map(z => z?.name || z?.id),
        datasetUrl: `https://www.data.gouv.fr/datasets/${full.slug}/`,
        filesCount: files.length,
        files,
      });
    } catch (e) {
      console.log(`KO ${e.message}`);
      enriched.push({ id: d.id, slug: d.slug, title: d.title, mediterranean: med, error: e.message });
    }
  }

  // 4) Sort: Méd con file scaricabili in cima
  enriched.sort((a, b) => (b.filesCount || 0) - (a.filesCount || 0));

  // 5) Print summary
  console.log('\n' + '═'.repeat(72));
  console.log(' RIEPILOGO CANDIDATI MÉDITERRANÉE');
  console.log('═'.repeat(72));
  let withFiles = 0;
  for (const c of enriched) {
    if (c.filesCount > 0) withFiles++;
    console.log(`\n[${c.mediterranean.dept || '?'}/${c.mediterranean.name}] ${c.title}`);
    console.log(`  via: ${c.mediterranean.via}`);
    console.log(`  ${c.datasetUrl}`);
    console.log(`  Org: ${c.organization || '?'} | upd: ${c.lastUpdate || '?'}`);
    if (c.files?.length) {
      for (const f of c.files.slice(0, 8)) {
        const sz = f.filesize ? ` (${(f.filesize / 1024).toFixed(0)}KB)` : '';
        console.log(`    [${f.format || '?'}]${sz} ${f.url}`);
      }
      if (c.files.length > 8) console.log(`    ... +${c.files.length - 8} altri`);
    } else if (c.error) {
      console.log(`  ⚠ errore: ${c.error}`);
    } else {
      console.log(`  ⚠ nessuna risorsa nel dataset`);
    }
  }
  console.log('\n' + '═'.repeat(72));
  console.log(` ${enriched.length} candidati Med, di cui ${withFiles} con file scaricabili`);
  console.log('═'.repeat(72));

  fs.writeFileSync('./zmel-scan.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    queriedKeywords: QUERIES,
    deptFilter: MED_DEPTS,
    totalDatasetsScanned: seen.size,
    candidatesCount: enriched.length,
    candidatesWithFiles: withFiles,
    candidates: enriched,
  }, null, 2));
  console.log(`\n✔ Salvato: ${process.cwd()}/zmel-scan.json`);
})();

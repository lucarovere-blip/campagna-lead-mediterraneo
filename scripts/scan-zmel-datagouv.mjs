#!/usr/bin/env node
/**
 * scan-zmel-datagouv.mjs — Scan API data.gouv.fr per dataset ZMEL Méditerranée.
 *
 * Strategia: i WFS pubblici non hanno il dataset ZMEL. Su data.gouv.fr invece
 * ci sono dataset ZMEL ufficiali pubblicati DREAL/préfecture per dipartimento.
 * Lo script:
 *   1) Cerca con 4 query diverse (ZMEL, mouillages, ecc)
 *   2) Filtra per i 9 dipartimenti Méd (06,13,83,30,34,11,66,2A,2B)
 *   3) Estrae i link diretti ai file (GeoJSON, shapefile, KML, ZIP)
 *   4) Salva report strutturato
 *
 * Esecuzione:
 *   node scripts/scan-zmel-datagouv.mjs
 *
 * Output:
 *   ./zmel-scan.json   ← mandami questo
 */

import fs from 'node:fs';

const API = 'https://www.data.gouv.fr/api/1';
const QUERIES = [
  'ZMEL',
  'zones de mouillages',
  'mouillages organisés',
  'mouillage plaisance',
  'mouillages équipements légers',
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

const MED_NAMES = [
  ...Object.values(MED_DEPTS),
  'PACA', 'Provence', "Côte d'Azur", 'Méditerranée', 'Corse', 'Languedoc',
  'Roussillon', 'Occitanie', 'Provence-Alpes-Côte',
];

async function api(path) {
  const url = `${API}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'audit-zmel/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function searchDatasets(query) {
  // L'API supporta paginazione: prendiamo prime 2 pagine (200 dataset max per query)
  const all = [];
  for (let page = 1; page <= 2; page++) {
    try {
      const j = await api(`/datasets/?q=${encodeURIComponent(query)}&page=${page}&page_size=100`);
      if (!j.data || !j.data.length) break;
      all.push(...j.data);
      if (j.data.length < 100) break;
    } catch (e) {
      console.error(`  err page ${page}: ${e.message}`);
      break;
    }
  }
  return all;
}

function isMediterranean(dataset) {
  const blob = [
    dataset.title || '',
    dataset.description || '',
    ...(dataset.tags || []),
    ...(dataset.spatial?.zones || []).map(z => z.name || ''),
  ].join(' ');

  // Match codici dipartimento (es. " 83 ", "(83)", "_083_", "dept83", "Var (83)")
  for (const code of Object.keys(MED_DEPTS)) {
    const padded = code.padStart(3, '0'); // 083, 013, ecc
    const patterns = [
      new RegExp(`[^0-9]${code}[^0-9]`, 'i'),
      new RegExp(`_${padded}[._]`, 'i'),
      new RegExp(`d[ée]p\\w*[ -]*${code}\\b`, 'i'),
    ];
    if (patterns.some(p => p.test(blob))) return { dept: code, name: MED_DEPTS[code], match: 'codice' };
  }
  // Match nome regionale
  const lower = blob.toLowerCase();
  for (const name of MED_NAMES) {
    if (lower.includes(name.toLowerCase())) {
      // trova il dipartimento corrispondente se è un nome dipartimento
      const code = Object.entries(MED_DEPTS).find(([_, n]) => n === name)?.[0] || '?';
      return { dept: code, name, match: 'nome' };
    }
  }
  return null;
}

function extractFiles(dataset) {
  const resources = dataset.resources || [];
  return resources
    .filter(r => {
      const fmt = (r.format || '').toLowerCase();
      const url = r.url || '';
      return /(geojson|shp|zip|gpkg|kml|kmz|gml|json)$/i.test(fmt) || /\.(geojson|shp|zip|gpkg|kml|kmz|gml)$/i.test(url);
    })
    .map(r => ({
      title: r.title,
      format: r.format,
      url: r.url,
      filesize: r.filesize ?? null,
      lastModified: r.last_modified ?? null,
      mime: r.mime ?? null,
    }));
}

(async () => {
  console.log('▶ scan-zmel-datagouv.mjs — ricerca dataset ZMEL Méditerranée su data.gouv.fr');
  console.log(`  Dipartimenti target: ${Object.entries(MED_DEPTS).map(([c, n]) => `${c}=${n}`).join(', ')}`);

  const seen = new Map();
  for (const q of QUERIES) {
    process.stdout.write(`\n  Query "${q}" ... `);
    try {
      const data = await searchDatasets(q);
      console.log(`${data.length} dataset`);
      for (const d of data) if (!seen.has(d.id)) seen.set(d.id, d);
    } catch (e) {
      console.log(`KO ${e.message}`);
    }
  }
  console.log(`\n  Totale dataset unici visti: ${seen.size}`);

  // Filtra Méditerranée
  const candidates = [];
  const allMooringDatasets = []; // anche quelli non Med, per logging
  for (const d of seen.values()) {
    const med = isMediterranean(d);
    const files = extractFiles(d);
    const entry = {
      id: d.id,
      slug: d.slug,
      title: d.title,
      mediterranean: med,
      organization: d.organization?.name || d.owner?.first_name || null,
      lastUpdate: d.last_update || d.last_modified || null,
      datasetUrl: `https://www.data.gouv.fr/datasets/${d.slug}/`,
      filesCount: files.length,
      files,
    };
    if (med) candidates.push(entry);
    allMooringDatasets.push(entry);
  }

  console.log(`\n→ Dataset Méditerranée: ${candidates.length} / ${allMooringDatasets.length}`);
  console.log('─'.repeat(70));
  for (const c of candidates) {
    console.log(`\n[${c.mediterranean.dept} - ${c.mediterranean.name}] ${c.title}`);
    console.log(`  ${c.datasetUrl}`);
    console.log(`  Org: ${c.organization || '?'} | upd: ${c.lastUpdate?.slice(0, 10) || '?'} | files: ${c.filesCount}`);
    for (const f of c.files.slice(0, 5)) {
      const sz = f.filesize ? ` (${(f.filesize / 1024).toFixed(0)} KB)` : '';
      console.log(`    • [${f.format || '?'}]${sz} ${f.url}`);
    }
  }

  // Mostra anche i dataset non-Med per controllo (limit 10)
  const otherWithFiles = allMooringDatasets
    .filter(c => !c.mediterranean && c.filesCount > 0)
    .slice(0, 10);
  if (otherWithFiles.length) {
    console.log(`\n─ Altri dataset mouillages (non-Med, primi ${otherWithFiles.length}):`);
    for (const c of otherWithFiles) {
      console.log(`  • ${c.title} → ${c.datasetUrl}`);
    }
  }

  fs.writeFileSync('./zmel-scan.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    queriedKeywords: QUERIES,
    deptFilter: MED_DEPTS,
    totalDatasetsScanned: seen.size,
    mediterraneanCandidates: candidates,
    otherCandidatesSample: otherWithFiles,
  }, null, 2));
  console.log(`\n✔ Salvato: ${process.cwd()}/zmel-scan.json`);
})();

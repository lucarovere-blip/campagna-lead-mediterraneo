#!/usr/bin/env node
/**
 * test-wfs.mjs v2 — Audit completo per il dataset ZMEL Méditerranée francese.
 *
 * Cosa fa:
 *   1) GetCapabilities WFS + WMS sui servizi pubblici (GéoLittoral, Sextant, Géoplateforme)
 *   2) Cerca layer con keyword larghe (mouillage|plaisance|dpm|aot|nautique|ancrage|amarrage)
 *   3) Per ciascun layer match prova GetFeature in CRS:84 (axis lon,lat)
 *   4) Interroga GeoNetwork CSW di Sextant per metadati "mouillage"
 *   5) Scrape pagina download GéoLittoral per trovare link ZIP diretti
 *
 * Esecuzione:
 *   node scripts/test-wfs.mjs
 *
 * Output:
 *   ./wfs-audit.json   ← mandami questo
 */

import fs from 'node:fs';

const BBOX_MED = { minLon: 2.5, minLat: 41.3, maxLon: 10.0, maxLat: 43.9 };
const TIMEOUT_MS = 30000;
const MAX_FEATURES = 200;
const MAX_LAYERS_TO_TEST = 5;

// ─── PATTERN KEYWORD AMPIO ─────────────────────────────────────────────
const PATTERN = /(mouillage|ancrage|amarrage|amenagement_dpm|amenagement_du_dpm|plaisance|zmel|equipement_leger|equipements_legers|dpm|domaine_public_maritime|\baot\b|nautique|baignade|carenage)/i;

// ─── ENDPOINTS WFS ─────────────────────────────────────────────────────
const WFS_ENDPOINTS = [
  {
    name: 'GéoLittoral WFS',
    url: 'https://geolittoral.din.developpement-durable.gouv.fr/wxs',
  },
  {
    name: 'Sextant IFREMER (WFS catalogue)',
    url: 'https://sextant.ifremer.fr/services/wfs/littoral',
  },
  {
    name: 'Sextant IFREMER (WFS environnement)',
    url: 'https://sextant.ifremer.fr/services/wfs/environnement',
  },
  {
    name: 'Sextant IFREMER (WFS aires_protegees)',
    url: 'https://sextant.ifremer.fr/services/wfs/aires_protegees',
  },
  {
    name: 'Sextant IFREMER (WFS dce — sentinella)',
    url: 'https://sextant.ifremer.fr/services/wfs/dce',
  },
  {
    name: 'Géoplateforme WFS',
    url: 'https://data.geopf.fr/wfs/ows',
  },
];

// ─── ENDPOINTS WMS (a volte i layer mouillage sono solo qui) ───────────
const WMS_ENDPOINTS = [
  { name: 'GéoLittoral WMS', url: 'https://geolittoral.din.developpement-durable.gouv.fr/wxs' },
  { name: 'Géoplateforme WMS', url: 'https://data.geopf.fr/wms-r/wms' },
];

// ─── PAGINE DOWNLOAD (scrape link diretti shapefile) ───────────────────
const DOWNLOAD_PAGES = [
  'https://www.geolittoral.developpement-durable.gouv.fr/telechargement-en-ligne-donnees-geolittoral-a802.html',
  'https://www.geolittoral.developpement-durable.gouv.fr/plaisance-et-mouillages-r419.html',
];

// ─── SEXTANT GEONETWORK CSW ────────────────────────────────────────────
const SEXTANT_CSW_SEARCH = 'https://sextant.ifremer.fr/geonetwork/srv/fre/q?from=1&to=30&fast=index&_content_type=json&any=mouillage';

// ─── HELPERS ────────────────────────────────────────────────────────────
async function fetchT(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (audit-script)', ...(opts.headers || {}) } });
    clearTimeout(t);
    return res;
  } catch (e) { clearTimeout(t); throw e; }
}

function parseLayersFromCaps(text) {
  const blocks = [...text.matchAll(/<(?:wfs:)?FeatureType[\s\S]*?<\/(?:wfs:)?FeatureType>/g)].map(m => m[0]);
  if (blocks.length) {
    return blocks.map(b => ({
      name: (b.match(/<(?:wfs:)?Name>([^<]+)<\/(?:wfs:)?Name>/) || [])[1] || null,
      title: (b.match(/<(?:wfs:)?Title>([^<]+)<\/(?:wfs:)?Title>/) || [])[1] || null,
      abstract: (b.match(/<(?:wfs:)?Abstract>([^<]+)<\/(?:wfs:)?Abstract>/) || [])[1] || null,
    })).filter(l => l.name);
  }
  // fallback: WMS Layer blocks
  const wmsBlocks = [...text.matchAll(/<Layer(?:\s[^>]*)?>[\s\S]*?<\/Layer>/g)].map(m => m[0]);
  return wmsBlocks.map(b => ({
    name: (b.match(/<Name>([^<]+)<\/Name>/) || [])[1] || null,
    title: (b.match(/<Title>([^<]+)<\/Title>/) || [])[1] || null,
    abstract: (b.match(/<Abstract>([^<]+)<\/Abstract>/) || [])[1] || null,
  })).filter(l => l.name);
}

async function getCaps(baseUrl, kind = 'WFS') {
  const v = kind === 'WFS' ? '2.0.0' : '1.3.0';
  const sep = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${sep}service=${kind}&request=GetCapabilities&version=${v}`;
  try {
    const res = await fetchT(url);
    if (!res.ok) return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
    const text = await res.text();
    const layers = parseLayersFromCaps(text);
    const matches = layers.filter(l =>
      PATTERN.test(l.name || '') || PATTERN.test(l.title || '') || PATTERN.test(l.abstract || '')
    );
    return {
      ok: true, url, total: layers.length,
      mooringMatches: matches,
      sampleNames: layers.slice(0, 20).map(l => l.name),
    };
  } catch (e) { return { ok: false, url, error: e.message }; }
}

async function getFeature(baseUrl, typeName, useCRS84 = true) {
  // CRS:84 = lon,lat (axis order standard) — risolve il 400 di prima
  const bboxStr = useCRS84
    ? `${BBOX_MED.minLon},${BBOX_MED.minLat},${BBOX_MED.maxLon},${BBOX_MED.maxLat},urn:ogc:def:crs:OGC:1.3:CRS84`
    : `${BBOX_MED.minLat},${BBOX_MED.minLon},${BBOX_MED.maxLat},${BBOX_MED.maxLon},EPSG:4326`;
  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature',
    typeNames: typeName, count: String(MAX_FEATURES),
    outputFormat: 'application/json',
    srsName: useCRS84 ? 'urn:ogc:def:crs:OGC:1.3:CRS84' : 'EPSG:4326',
    bbox: bboxStr,
  });
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${params.toString()}`;
  try {
    const res = await fetchT(url);
    if (!res.ok) {
      // ritenta senza outputFormat (server può non supportare GeoJSON)
      if (useCRS84) {
        const params2 = new URLSearchParams(params);
        params2.delete('outputFormat');
        const url2 = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${params2.toString()}`;
        const res2 = await fetchT(url2);
        if (!res2.ok) return { ok: false, url, status: res.status };
        const t = await res2.text();
        return { ok: true, url: url2, format: 'gml', featureCount: (t.match(/<wfs:member>|<gml:featureMember>/g) || []).length, preview: t.slice(0, 400) };
      }
      return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    if (text.trim().startsWith('{')) {
      const j = JSON.parse(text);
      const feats = j.features || [];
      return {
        ok: true, url, format: 'json',
        featureCount: feats.length,
        totalFeatures: j.totalFeatures ?? j.numberMatched ?? null,
        sampleProperties: feats[0]?.properties || null,
        sampleGeometryType: feats[0]?.geometry?.type || null,
        propertyKeys: feats[0] ? Object.keys(feats[0].properties || {}) : [],
      };
    }
    return { ok: true, url, format: 'gml/xml', featureCount: (text.match(/<wfs:member>|<gml:featureMember>/g) || []).length, preview: text.slice(0, 400) };
  } catch (e) { return { ok: false, url, error: e.message }; }
}

async function scrapeDownloadPage(url) {
  try {
    const res = await fetchT(url);
    if (!res.ok) return { ok: false, url, status: res.status };
    const html = await res.text();
    const allLinks = [...html.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1]);
    const dataLinks = allLinks.filter(h => /\.(zip|shp|geojson|gpkg|csv|gml)$/i.test(h));
    const themeLinks = allLinks.filter(h => /(mouillage|plaisance|dpm|aot|nautique|ancrage|amarrage|equipement)/i.test(h));
    return { ok: true, url, dataLinks: [...new Set(dataLinks)].slice(0, 30), themeLinks: [...new Set(themeLinks)].slice(0, 30) };
  } catch (e) { return { ok: false, url, error: e.message }; }
}

async function querySextantCSW() {
  try {
    const res = await fetchT(SEXTANT_CSW_SEARCH);
    if (!res.ok) return { ok: false, status: res.status, url: SEXTANT_CSW_SEARCH };
    const text = await res.text();
    let recs = null;
    if (text.trim().startsWith('{')) {
      const j = JSON.parse(text);
      recs = (j.metadata || []).slice(0, 20).map(r => ({
        id: r['geonet:info']?.id || r.uuid,
        title: r.defaultTitle || r.title || (r['geonet:info']?.title) || null,
        keywords: Array.isArray(r.keyword) ? r.keyword.slice(0, 8) : (r.keyword || null),
      }));
    }
    return { ok: true, url: SEXTANT_CSW_SEARCH, totalSummary: recs?.length || 0, records: recs || text.slice(0, 600) };
  } catch (e) { return { ok: false, error: e.message, url: SEXTANT_CSW_SEARCH }; }
}

// ─── MAIN ──────────────────────────────────────────────────────────────
(async () => {
  console.log('▶ test-wfs.mjs v2 — audit ZMEL Méd francese');

  const results = { wfs: [], wms: [], downloads: [], sextantCSW: null };

  // 1. WFS endpoints
  for (const ep of WFS_ENDPOINTS) {
    process.stdout.write(`\n→ WFS ${ep.name}\n  ${ep.url}\n  GetCapabilities ... `);
    const cap = await getCaps(ep.url, 'WFS');
    if (!cap.ok) { console.log(`KO (${cap.error})`); results.wfs.push({ ep, capabilities: cap, features: [] }); continue; }
    console.log(`OK — ${cap.total} layer, ${cap.mooringMatches.length} match`);
    if (cap.mooringMatches.length) {
      cap.mooringMatches.slice(0, 5).forEach(l => console.log(`    • ${l.name} — ${l.title || ''}`));
    }
    const features = [];
    for (const layer of cap.mooringMatches.slice(0, MAX_LAYERS_TO_TEST)) {
      console.log(`  GetFeature su ${layer.name} (CRS:84)...`);
      const ft = await getFeature(ep.url, layer.name, true);
      features.push({ layer: layer.name, title: layer.title, result: ft });
      if (ft.ok) console.log(`    → ${ft.featureCount ?? 0} feature, geom: ${ft.sampleGeometryType || ft.format}, campi: ${(ft.propertyKeys || []).slice(0, 8).join(', ') || 'n/a'}`);
      else console.log(`    → KO ${ft.error || ft.status}`);
    }
    results.wfs.push({ ep, capabilities: cap, features });
  }

  // 2. WMS endpoints
  for (const ep of WMS_ENDPOINTS) {
    process.stdout.write(`\n→ WMS ${ep.name}\n  ${ep.url}\n  GetCapabilities ... `);
    const cap = await getCaps(ep.url, 'WMS');
    if (!cap.ok) { console.log(`KO (${cap.error})`); results.wms.push({ ep, capabilities: cap }); continue; }
    console.log(`OK — ${cap.total} layer, ${cap.mooringMatches.length} match`);
    if (cap.mooringMatches.length) cap.mooringMatches.slice(0, 5).forEach(l => console.log(`    • ${l.name} — ${l.title || ''}`));
    results.wms.push({ ep, capabilities: cap });
  }

  // 3. Download pages
  for (const dp of DOWNLOAD_PAGES) {
    process.stdout.write(`\n→ Download page ${dp}\n  scrape link ... `);
    const r = await scrapeDownloadPage(dp);
    if (!r.ok) console.log(`KO ${r.error || r.status}`);
    else {
      console.log(`OK — ${r.dataLinks.length} link a file dati, ${r.themeLinks.length} link tematici`);
      r.dataLinks.slice(0, 5).forEach(l => console.log(`    • ${l}`));
      r.themeLinks.slice(0, 5).forEach(l => console.log(`    • [tema] ${l}`));
    }
    results.downloads.push(r);
  }

  // 4. Sextant CSW
  console.log('\n→ Sextant GeoNetwork CSW (search "mouillage")...');
  const csw = await querySextantCSW();
  if (csw.ok) console.log(`  OK — ${csw.totalSummary} record metadati trovati`);
  else console.log(`  KO ${csw.error || csw.status}`);
  results.sextantCSW = csw;

  fs.writeFileSync('./wfs-audit.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    bboxMed: BBOX_MED,
    nodeVersion: process.version,
    ...results,
  }, null, 2));
  console.log(`\n✔ Salvato: ${process.cwd()}/wfs-audit.json`);
})();

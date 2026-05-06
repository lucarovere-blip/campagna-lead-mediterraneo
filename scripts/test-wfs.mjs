#!/usr/bin/env node
/**
 * test-wfs.mjs — Audit degli endpoint WFS pubblici per le ZMEL del Mediterraneo francese.
 *
 * Esegue:
 *   1) GetCapabilities su candidati endpoint GéoLittoral, Sextant IFREMER, API Carto
 *   2) Estrae i layer disponibili che matchano "mouillage" / "ancrage" / "ZMEL"
 *   3) Per ciascun layer trovato fa un GetFeature limitato alla bbox Méditerranée
 *      e conta le feature + estrae i campi del primo record
 *
 * Requisiti: Node.js 18+ (fetch nativo). Nessuna dipendenza npm.
 *
 * Esecuzione:
 *   node test-wfs.mjs
 *
 * Output:
 *   ./wfs-audit.json   ← mandami questo file
 */

import fs from 'node:fs';

// Bounding box Méditerranée francese (Pyrénées-Or → Liguria, include Corse)
const BBOX_MED = { minLon: 2.5, minLat: 41.3, maxLon: 10.0, maxLat: 43.9 };

// Candidati per ogni servizio (provo più URL, registro quale risponde)
const ENDPOINTS = [
  {
    name: 'GéoLittoral',
    candidates: [
      'https://geolittoral.din.developpement-durable.gouv.fr/services/wxs',
      'https://geolittoral.din.developpement-durable.gouv.fr/wxs',
      'https://www.geolittoral.developpement-durable.gouv.fr/wxs',
      'https://geolittoral.din.developpement-durable.gouv.fr/wfs',
      'https://geoservices.din.developpement-durable.gouv.fr/wxs/?map=/opt/data/carto/wmsv/intranet/MAPS/geolittoral.map',
    ],
  },
  {
    name: 'Sextant IFREMER',
    candidates: [
      'https://sextant.ifremer.fr/services/wfs',
      'https://sextant.ifremer.fr/geoserver/wfs',
      'https://www.ifremer.fr/services/wfs/sextant',
    ],
  },
  {
    name: 'data.gouv.fr / Géoplateforme',
    candidates: [
      'https://data.geopf.fr/wfs/ows',
      'https://wxs.ign.fr/parcellaire/geoportail/wfs', // sentinel: cadastre, non mouillage — ma se va sappiamo che WFS Géoportail risponde
    ],
  },
];

const PATTERN_MOUILLAGE = /(mouillage|ancrage|amarrage|zmel|equipements_legers)/i;

const TIMEOUT_MS = 20000;
const MAX_FEATURES = 200;

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), options.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function tryGetCapabilities(baseUrl) {
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}service=WFS&request=GetCapabilities&version=2.0.0`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { ok: false, status: res.status, url, error: `HTTP ${res.status}` };
    const text = await res.text();
    if (!text.includes('WFS_Capabilities') && !text.includes('FeatureType')) {
      return { ok: false, status: res.status, url, error: 'risposta non sembra WFS Capabilities', preview: text.slice(0, 200) };
    }
    // Parse semplice via regex (XML, no DOM)
    const layerBlocks = [...text.matchAll(/<FeatureType[\s\S]*?<\/FeatureType>/g)].map(m => m[0]);
    const layers = layerBlocks.map(block => {
      const name = (block.match(/<Name>([^<]+)<\/Name>/) || [])[1] || null;
      const title = (block.match(/<Title>([^<]+)<\/Title>/) || [])[1] || null;
      const abstract = (block.match(/<Abstract>([^<]+)<\/Abstract>/) || [])[1] || null;
      return { name, title, abstract };
    }).filter(l => l.name);

    const matches = layers.filter(l =>
      PATTERN_MOUILLAGE.test(l.name || '') ||
      PATTERN_MOUILLAGE.test(l.title || '') ||
      PATTERN_MOUILLAGE.test(l.abstract || '')
    );

    return {
      ok: true,
      url,
      totalLayers: layers.length,
      mooringMatches: matches,
      sampleLayerNames: layers.slice(0, 15).map(l => l.name),
    };
  } catch (e) {
    return { ok: false, url, error: e.message };
  }
}

async function tryGetFeature(baseUrl, typeName, bbox, fmt = 'application/json') {
  // GeoServer e MapServer accettano outputFormat=application/json (GeoJSON)
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: typeName,
    count: String(MAX_FEATURES),
    outputFormat: fmt,
    srsName: 'EPSG:4326',
    bbox: `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon},EPSG:4326`,
  });
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${params.toString()}`;
  try {
    const res = await fetchWithTimeout(url);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
    const text = await res.text();
    if (ct.includes('json') || text.trim().startsWith('{')) {
      try {
        const j = JSON.parse(text);
        const feats = j.features || [];
        return {
          ok: true,
          url,
          featureCount: feats.length,
          totalFeatures: j.totalFeatures ?? j.numberMatched ?? null,
          sampleProperties: feats[0]?.properties || null,
          sampleGeometryType: feats[0]?.geometry?.type || null,
          allPropertyKeys: feats[0] ? Object.keys(feats[0].properties || {}) : [],
        };
      } catch (e) {
        return { ok: false, url, error: 'JSON parse failed', preview: text.slice(0, 300) };
      }
    } else {
      // probabilmente GML XML — conto le feature in modo grezzo
      const featureCount = (text.match(/<wfs:member>|<gml:featureMember>/g) || []).length;
      return {
        ok: true,
        url,
        format: 'gml/xml',
        featureCount,
        note: 'risposta GML; servirà conversione GML→GeoJSON',
        preview: text.slice(0, 400),
      };
    }
  } catch (e) {
    return { ok: false, url, error: e.message };
  }
}

async function auditService(svc) {
  console.log(`\n━━━ ${svc.name} ━━━`);
  for (const base of svc.candidates) {
    process.stdout.write(`  Tentativo ${base} ... `);
    const cap = await tryGetCapabilities(base);
    if (!cap.ok) {
      console.log(`KO (${cap.error})`);
      continue;
    }
    console.log(`OK — ${cap.totalLayers} layer trovati, ${cap.mooringMatches.length} match mouillage`);

    // Test GetFeature sul primo layer mouillage trovato
    const featureTests = [];
    for (const layer of cap.mooringMatches.slice(0, 3)) {
      console.log(`    GetFeature su ${layer.name} (${layer.title || ''})...`);
      const ft = await tryGetFeature(base, layer.name, BBOX_MED);
      featureTests.push({ layer: layer.name, title: layer.title, result: ft });
      if (ft.ok) {
        console.log(`      → ${ft.featureCount} feature in bbox Med (geom: ${ft.sampleGeometryType || 'N/A'})`);
        if (ft.allPropertyKeys?.length) {
          console.log(`      → campi: ${ft.allPropertyKeys.slice(0, 12).join(', ')}${ft.allPropertyKeys.length > 12 ? '…' : ''}`);
        }
      } else {
        console.log(`      → KO: ${ft.error}`);
      }
    }

    return { service: svc.name, working: base, capabilities: cap, featureTests };
  }
  return { service: svc.name, working: null, error: 'nessun candidato risponde' };
}

(async () => {
  console.log('▶ test-wfs.mjs — audit endpoint WFS per ZMEL Méd francese');
  console.log(`  bbox Med: lon ${BBOX_MED.minLon}/${BBOX_MED.maxLon}, lat ${BBOX_MED.minLat}/${BBOX_MED.maxLat}`);

  const results = [];
  for (const svc of ENDPOINTS) {
    const r = await auditService(svc);
    results.push(r);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    bboxMed: BBOX_MED,
    nodeVersion: process.version,
    results,
  };
  fs.writeFileSync('./wfs-audit.json', JSON.stringify(report, null, 2));
  console.log(`\n✔ Salvato: ${process.cwd()}/wfs-audit.json`);
  console.log('  Mandami il file (anche solo i contenuti incollati in chat).');
})();

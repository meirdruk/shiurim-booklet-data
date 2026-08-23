#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   scripts/compute.mjs

   CRITICAL: pdfjs-dist is pinned to the EXACT version the browser tool
   loads from cdnjs (3.11.174) — see package.json. Different pdf.js
   versions represent PDF internals (e.g. fill-color operator arguments)
   differently, which silently breaks the gray-box detection this
   algorithm depends on with no visible error. Do not let this version
   float — see the README for details on why.
══════════════════════════════════════════════════════════ */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// pdf.js 3.11.174's legacy CJS build doesn't expose all named exports
// through Node's ESM/CJS interop (cjs-module-lexer static analysis misses
// some of them) — access everything through the default export instead.
const pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.js');
const pdfjsLib = pdfjsMod.default ?? pdfjsMod;

// Ambient dependency expected by booklet-logic.js's gray-box engine
// (gbGetFilledRects reads pdfjsLib.OPS). In the browser this is already
// global via the existing <script src="cdnjs.../pdf.min.js"> tag; here we
// set it explicitly before importing the shared module.
globalThis.pdfjsLib = pdfjsLib;

const {
  extractOutline,
  calculateEndPages,
  buildHayomYomPageMap,
  synthesizeHayomYomChildren,
} = await import('../shared/booklet-logic.js');

// IMPORTANT: this is your Worker's default workers.dev URL, NOT the
// scrape-dm.hamshachos.dev custom domain. Requests to workers.dev never
// pass through the hamshachos.dev zone's proxy, so its Bot Fight Mode
// setting doesn't apply here at all — this is a different security
// boundary, not a bypass of the zone's rules.
//
// FILL IN: find this at Cloudflare dashboard → Workers & Pages →
// scrape-dm → the URL shown on its overview page.
const REMOTE_URL   = 'https://scrape-dm.<YOUR-ACCOUNT-SUBDOMAIN>.workers.dev';
const OUTPUT_PATH  = path.join(__dirname, '..', 'data.json');
const SCHEMA_VERSION = 1;

// hayomYomPageMap's values are Sets in-memory (see booklet-logic.js) — not
// directly JSON-serializable. Convert to sorted plain arrays for output.
function hayomYomMapToJson(map) {
  const out = {};
  for (const [day, pages] of Object.entries(map)) {
    out[day] = [...pages].sort((a, b) => a - b);
  }
  return out;
}

async function fetchCurrentPdf() {
  console.log(`Fetching PDF from ${REMOTE_URL} ...`);
  // COMPUTE_SECRET / X-Compute-Secret is left in as harmless defense in
  // depth (see the earlier WAF custom rule) — it shouldn't be strictly
  // necessary via workers.dev, but doesn't hurt to keep sending it.
  const headers = {};
  if (process.env.COMPUTE_SECRET) {
    headers['X-Compute-Secret'] = process.env.COMPUTE_SECRET;
  }
  const res = await fetch(REMOTE_URL, { headers });
  if (!res.ok) throw new Error(`Failed to fetch PDF: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main() {
  const pdfBytes = await fetchCurrentPdf();
  console.log(`Downloaded ${pdfBytes.length} bytes.`);

  const pdfHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');

  // Skip all the expensive work entirely if the PDF hasn't changed since
  // the last successful run — avoids a wall of no-op commits.
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'));
  } catch (_) {
    // No existing file yet (first run), or it's unreadable — proceed.
  }
  if (existing && existing.pdfHash === pdfHash) {
    console.log('PDF unchanged since last run (hash match) — nothing to do.');
    return;
  }

  const doc = await pdfjsLib.getDocument({
    data: pdfBytes.slice(),
    disableWorker: true,
    isEvalSupported: false,
  }).promise;

  const S = {
    pdfJsDoc: doc,
    totalPages: doc.numPages,
    sections: [],
    hayomYomPageMap: {},
  };

  console.log(`Loaded PDF: ${S.totalPages} pages. Extracting outline...`);
  await extractOutline(S);
  console.log(`Found ${S.sections.length} outline sections. Calculating end pages...`);
  await calculateEndPages(S);
  console.log('Scanning היום יום gray-box page map...');
  await buildHayomYomPageMap(S);
  synthesizeHayomYomChildren(S);

  const output = {
    schemaVersion: SCHEMA_VERSION,
    pdfHash,
    computedAt: new Date().toISOString(),
    totalPages: S.totalPages,
    sections: S.sections,
    hayomYomPageMap: hayomYomMapToJson(S.hayomYomPageMap),
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUTPUT_PATH} (${S.sections.length} sections, hash ${pdfHash.slice(0, 12)}...)`);
}

main().catch(err => {
  console.error('compute.mjs failed:', err);
  process.exit(1);
});

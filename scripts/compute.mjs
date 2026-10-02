#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   scripts/compute.mjs

   Fetches the current weekly PDF, runs it through shared/booklet-logic.js,
   and writes data.json at the repo root for GitHub Pages to serve.

   pdfjs-dist is pinned to the exact version the browser tool loads
   (see package.json) — different versions represent PDF internals
   differently, which silently breaks gray-box detection.
══════════════════════════════════════════════════════════ */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This pdf.js build's named exports aren't all visible through Node's
// CJS interop — go through the default export.
const pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.js');
const pdfjsLib = pdfjsMod.default ?? pdfjsMod;

// booklet-logic.js expects a global pdfjsLib (for pdfjsLib.OPS).
globalThis.pdfjsLib = pdfjsLib;

const {
  extractOutline,
  correctDaySectionStartPages,
  calculateEndPages,
  buildHayomYomPageMap,
  synthesizeHayomYomChildren,
} = await import('../shared/booklet-logic.js');


const REMOTE_URL   = 'https://scrape-dm.meirdruk.workers.dev';
const OUTPUT_PATH  = path.join(__dirname, '..', 'data.json');
// Bump whenever the output shape or algorithm changes — the skip-check
// below relies on it.
const SCHEMA_VERSION = 4;

// hayomYomPageMap holds Sets in memory; convert to sorted arrays.
function hayomYomMapToJson(map) {
  const out = {};
  for (const [day, pages] of Object.entries(map)) {
    out[day] = [...pages].sort((a, b) => a - b);
  }
  return out;
}

async function fetchCurrentPdf() {
  console.log(`Fetching PDF from ${REMOTE_URL} ...`);
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

  // Skip the work only if both the PDF and the compute logic are
  // unchanged. Checking pdfHash alone would skip forever after a code
  // change, leaving a stale data.json live.
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'));
  } catch (_) {
    // No existing file yet (first run), or it's unreadable — proceed.
  }
  if (existing && existing.pdfHash === pdfHash && existing.schemaVersion === SCHEMA_VERSION) {
    console.log('PDF unchanged and schema version matches — nothing to do.');
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
  console.log(`Found ${S.sections.length} outline sections. Correcting start pages...`);
  await correctDaySectionStartPages(S);
  console.log('Calculating end pages...');
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

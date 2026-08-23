#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   scripts/compute.mjs

   Fetches the current weekly bulletin PDF directly from its source site
   (dvarmalchus.com — see fetchCurrentPdf below), runs it
   through the algorythm, and writes the result — plus a SHA-256
   hash of the source PDF bytes — to data.json at the repo root, which
   GitHub Pages serves as a static file (Pages configured to serve from
   the repo root, so shared/booklet-logic.js is reachable too, with no
   need to duplicate it into a separate Pages-specific folder).

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
} = await import('../shared/booklet-logic.js');

const SOURCE_PAGE_URL = 'https://dvarmalchus.com/Download.aspx?History=True';
const OUTPUT_PATH  = path.join(__dirname, '..', 'data.json');
const SCHEMA_VERSION = 1;

// Mirrors the headers used by the scrape-dm Cloudflare Worker.
const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// hayomYomPageMap's values are Sets in-memory (see booklet-logic.js) — not
// directly JSON-serializable. Convert to sorted plain arrays for output.
function hayomYomMapToJson(map) {
  const out = {};
  for (const [day, pages] of Object.entries(map)) {
    out[day] = [...pages].sort((a, b) => a - b);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════
   Fetch the current weekly PDF directly from the source site.

   NOTE ON DUPLICATION: this replicates the scrape-dm Cloudflare Worker's
   own logic (fetch the listing page, regex out today's PDF link, fetch
   that PDF with a Referer header) rather than calling the Worker itself.
   This is deliberate — GitHub Actions runners get blocked by Cloudflare
   Bot Fight Mode on the Worker's own domain, with no clean bypass
   available at the current Cloudflare plan tier. Going straight to the
   source avoids that hop entirely.

   This DOES mean the scraping logic now lives in two places (the Worker
   and here). If dvarmalchus.com's page structure ever changes, both need
   updating — acceptable here since this routine is small and
   self-contained, unlike the shared booklet-analysis algorithm.
══════════════════════════════════════════════════════════ */
async function fetchCurrentPdf() {
  console.log(`Fetching listing page from ${SOURCE_PAGE_URL} ...`);
  const pageResponse = await fetch(SOURCE_PAGE_URL, { headers: SCRAPE_HEADERS });
  if (!pageResponse.ok) {
    throw new Error(`Failed to fetch listing page: HTTP ${pageResponse.status}`);
  }
  const html = await pageResponse.text();

  const linkMatch =
    html.match(/href="(Download\/[^"]*\.pdf)"/i) ||
    html.match(/href="([^"]*Download\.aspx\?ID=[^"]*)"/i);

  if (!linkMatch || !linkMatch[1]) {
    console.log('Match failed. Page starts with:', html.substring(0, 200));
    throw new Error('Could not find the PDF link in the source page.');
  }

  let fileUrl = linkMatch[1];
  if (!fileUrl.startsWith('http')) {
    fileUrl = new URL(fileUrl, SOURCE_PAGE_URL).href;
  }

  console.log(`Fetching PDF from ${fileUrl} ...`);
  const fileResponse = await fetch(fileUrl, {
    headers: { ...SCRAPE_HEADERS, Referer: SOURCE_PAGE_URL },
  });
  if (!fileResponse.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${fileResponse.status}`);
  }

  return new Uint8Array(await fileResponse.arrayBuffer());
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

  const output = {
    schemaVersion: SCHEMA_VERSION,
    pdfHash,
    computedAt: new Date().toISOString(),
    sourceUrl: SOURCE_PAGE_URL,
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

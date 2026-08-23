/* ══════════════════════════════════════════════════════════
   booklet-logic.mjs

   AMBIENT DEPENDENCY: this module assumes a global `pdfjsLib` exists
   (used by gbGetFilledRects for `pdfjsLib.OPS`). This mirrors how the
   original HTML tool already loads pdf.js as a classic global script
   (not an ES module), so it's kept as-is here to avoid restructuring
   how pdf.js itself is loaded:
     - In the browser: already true, via the existing
       <script src="cdnjs.../pdf.min.js"> tag.
     - In Node (the compute script): set it explicitly before calling
       into this module, e.g.:
         globalThis.pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

   The `S` object passed into these functions is expected to have (at
   minimum) the same shape as the browser tool's state object:
     { pdfJsDoc, totalPages, sections, hayomYomPageMap }
══════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════
   Constants
══════════════════════════════════════════════════════════ */

// Full day names as they appear in PDF outlines
export const DAY_NAMES_HE = [
  'יום ראשון','יום שני','יום שלישי','יום רביעי','יום חמישי','יום שישי',
  'שבת','שבת קודש'
];

// Variants of חסלת to match across different PDF encodings
export const CHASLAT_VARIANTS = ['חסלת', 'חַסְלַת', '\u05D7\u05E1\u05DC\u05EA'];

// Parent titles for the day-section splitting rule (replaces the old
// dollar-sign rule's per-title day-name check). Matched against a
// section's parentTitle via .includes(), so minor title variations
// (e.g. trailing punctuation) still match.
export const KNOWN_DAY_PARENTS = [
  'חומש יומי',
  'תניא יומי',
  'רמב"ם - שלושה פרקים ליום',
  'רמב"ם - פרק אחד ליום'
];

// Exact marker text identifying a day-section's start-icon gray box, used by
// the day-section splitting rule. This looks like mis-decoded/garbled text —
// that is intentional and correct: this is genuinely how the marker decodes
// when scanning the source PDF's text content. Keep byte-for-byte as-is.
export const ICON_MARKER = 'â â';

// Padding (pt) for icon-box text matching in the day-section splitting rule.
// Distinct from GB_PAD (2pt, used by the היום יום engine) — this rule uses a
// tighter 1pt tolerance, per the original prototype it was ported from.
export const GB_PAD_ICON = 1;

// Tuning constants — same defaults as the standalone tool
export const GB_TINT_MIN  = 0.02;
export const GB_TINT_MAX  = 0.60;
export const GB_TOLERANCE = 0.06;
export const GB_PAD       = 2;      // pt of padding when matching text → box

/* ══════════════════════════════════════════════════════════
   Outline Extraction
══════════════════════════════════════════════════════════ */
export async function extractOutline(S) {
  const raw = await S.pdfJsDoc.getOutline();
  S.sections = [];
  if (!raw) return;

  let counter = 0;

  async function walk(items, parentId, parentTitle, level) {
    for (const item of items) {
      const id = counter++;
      let startPage = null;

      try {
        if (item.dest) {
          const pageIdx = await resolveDestToPageIdx(S, item.dest);
          if (pageIdx !== null) startPage = pageIdx + 1;
        }
      } catch (_) { /* skip */ }

      const sec = {
        id,
        title: (item.title || '').trim() || '—',
        startPage,
        endPage: null,
        level,
        parentId,
        parentTitle,
        childIds: [],
        collapsed: false,
      };
      S.sections.push(sec);

      if (parentId !== null) {
        const parent = S.sections.find(s => s.id === parentId);
        if (parent) parent.childIds.push(id);
      }

      if (item.items && item.items.length) {
        await walk(item.items, id, item.title, level + 1);
      }
    }
  }

  await walk(raw, null, null, 0);
}

export async function resolveDestToPageIdx(S, dest) {
  let explicit;
  if (typeof dest === 'string') {
    explicit = await S.pdfJsDoc.getDestination(dest);
  } else {
    explicit = dest;
  }
  if (!explicit || !Array.isArray(explicit) || explicit.length === 0) return null;
  const ref = explicit[0];
  try {
    return await S.pdfJsDoc.getPageIndex(ref);
  } catch (_) { return null; }
}

/* ══════════════════════════════════════════════════════════
   End-Page Algorithm
══════════════════════════════════════════════════════════ */
export async function calculateEndPages(S) {
  const withPage = S.sections
    .filter(s => s.startPage !== null)
    .sort((a, b) => a.startPage - b.startPage || a.id - b.id);

  for (const sec of S.sections) {
    if (sec.startPage === null) { sec.endPage = null; continue; }
    const next = withPage.find(s => s.startPage > sec.startPage);
    sec.endPage = next ? next.startPage - 1 : S.totalPages;
  }

  for (const sec of S.sections) {
    if (!sec.startPage) continue;

    // The raw next-section start page (or totalPages if sec is last),
    // BEFORE any rule below mutates sec.endPage. This is the window the
    // day-section splitting rule is allowed to search — it may adopt an
    // endPage as late as this page (catching legitimate overflow onto the
    // next section's start page) but no further.
    const next = withPage.find(s => s.startPage > sec.startPage);
    const windowEnd = next ? next.startPage : S.totalPages;

    if (isShabbosChumash(sec)) {
      // ── Chaslat rule owns שבת קודש within חומש יומי ──────
      const chaslatEnd = await chaslatRule(S, sec);
      if (chaslatEnd !== null) {
        sec.endPage = chaslatEnd;
      } else {
        // Chaslat found nothing within its buffer — fall back to the
        // day-section splitting rule instead of leaving the plain default.
        const split = await daySectionSplittingRule(S, sec, windowEnd);
        if (split !== null) sec.endPage = split;
      }
    } else if (isKnownDaySection(sec)) {
      // ── Day-Section Splitting Rule — all other known-day-parent
      // children (חומש יומי non-Shabbos days, תניא יומי, both Rambam
      // parents). No chaslat involvement here.
      const split = await daySectionSplittingRule(S, sec, windowEnd);
      if (split !== null) sec.endPage = split;
    }
  }
}

export function isShabbosChumash(sec) {
  const t = sec.title;
  const p = sec.parentTitle || '';
  return (t === 'שבת קודש' || t === 'שבת') &&
         (p.includes('חומש') || p === 'חומש יומי');
}

export function isKnownDaySection(sec) {
  const p = sec.parentTitle || '';
  return KNOWN_DAY_PARENTS.some(name => p.includes(name));
}

// Extract page text two ways: joined with space AND joined without.
// Also normalise to NFC so composed/decomposed Hebrew codepoints both match.
export async function getPageText(S, page1Based) {
  if (page1Based < 1 || page1Based > S.totalPages) return '';
  try {
    const page    = await S.pdfJsDoc.getPage(page1Based);
    const content = await page.getTextContent();
    const strs = content.items.map(i => i.str || '');
    const withSpace    = strs.join(' ').normalize('NFC');
    const withoutSpace = strs.join('').normalize('NFC');
    return withSpace + ' ' + withoutSpace;
  } catch (_) { return ''; }
}

export function textHasChaslat(txt) {
  const n = txt.normalize('NFC');
  return CHASLAT_VARIANTS.some(v => n.includes(v.normalize('NFC')));
}

export async function chaslatRule(S, sec) {
  // Scan up to BUFFER pages beyond the default endPage as a safety net
  const BUFFER = 6;
  const scanEnd = Math.min((sec.endPage || sec.startPage) + BUFFER, S.totalPages);

  for (let p = sec.startPage; p <= scanEnd; p++) {
    const txt = await getPageText(S, p);
    if (textHasChaslat(txt)) return p;
  }
  return null;
}

export function normalizeWs(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/* ══════════════════════════════════════════════════════════
   Day-Section Splitting Rule
   Replaces the old dollar-sign rule. Applies to direct children of
   KNOWN_DAY_PARENTS (see isKnownDaySection), and — as a fallback only, when
   chaslat finds nothing — to שבת קודש within חומש יומי (see isShabbosChumash).

   Unlike the old rule (which just checked whether "$" appeared anywhere on
   the already-assigned endPage), this looks for the section's start-icon
   gray box on its own start page, and only counts a "$" that appears AFTER
   that icon (further down the page) as this section's true end-of-section
   delimiter. If no icon is found on the start page at all, that page is
   skipped entirely rather than searched — searching without an icon anchor
   reintroduces exactly the false-positive risk (picking up a "$" left over
   from a different, unrelated section) this rule exists to eliminate.

   If nothing conclusive is found on the start page, scans forward page by
   page through windowEnd (the next section's start page, or totalPages if
   sec is last) for the first bare "$". windowEnd is inclusive, matching the
   original prototype's cap: a section may legitimately overflow onto the
   very next section's start page, but no further.

   Returns null if nothing is found anywhere in the window, meaning "no
   override" — the caller should keep whatever endPage was already assigned.
══════════════════════════════════════════════════════════ */
export async function daySectionSplittingRule(S, sec, windowEnd) {
  const textBoxesCache = {};
  async function getCachedTextBoxes(pageNum) {
    if (!textBoxesCache[pageNum]) {
      const page = await S.pdfJsDoc.getPage(pageNum);
      textBoxesCache[pageNum] = await gbGetTextBoxes(page);
    }
    return textBoxesCache[pageNum];
  }

  // ── Locate the start-icon box on the section's own start page ──
  const startPageObj  = await S.pdfJsDoc.getPage(sec.startPage);
  const startGrayRects = (await gbGetFilledRects(startPageObj)).filter(gbLooksGray);
  const startTextBoxes = await getCachedTextBoxes(sec.startPage);

  const iconRect = startGrayRects.find(r =>
    normalizeWs(gbBoxText(r, startTextBoxes, GB_PAD_ICON)) === normalizeWs(ICON_MARKER)
  );

  if (iconRect) {
    // A "$" counts only if it sits below the icon box (PDF y-axis is
    // bottom-up, so "below" = smaller y) — this excludes a "$" belonging to
    // an earlier, unrelated section that happens to land on the same page.
    const dollarBelowIcon = startTextBoxes.find(t =>
      t.text.trim() === '$' && t.y1 <= iconRect.y0
    );
    if (dollarBelowIcon) return sec.startPage;
  }
  // No icon on the start page (or icon found but no qualifying "$" below
  // it) — do not search this page any further; fall through to scanning
  // subsequent pages instead.

  // ── Scan forward through the rest of the window for the first bare "$" ──
  for (let p = sec.startPage + 1; p <= windowEnd; p++) {
    const textBoxes = await getCachedTextBoxes(p);
    if (textBoxes.some(t => t.text.trim() === '$')) return p;
  }

  return null;
}

/* ══════════════════════════════════════════════════════════
   Gray-Box Engine  (ported from the standalone extractor)
   Used for both היום יום section splitting and the day-section
   splitting rule's icon detection.
══════════════════════════════════════════════════════════ */
export async function gbGetFilledRects(page) {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const { OPS } = pdfjsLib;

  const rects = [];
  const ctmStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let fillAlpha = 1;
  let fillColor = null;
  let pendingPath = null;

  const mul = (a, b) => [
    a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3],
    a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3],
    a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5],
  ];
  const apply = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];
    switch (op) {
      case OPS.save:    ctmStack.push(ctm); break;
      case OPS.restore: ctm = ctmStack.pop() || ctm; break;
      case OPS.transform: ctm = mul(args, ctm); break;
      case OPS.setFillRGBColor:
      case OPS.setFillGray:
      case OPS.setFillCMYKColor:
        fillColor = args; break;
      case OPS.setGState:
        for (const [k, v] of (args[0] || [])) if (k === 'ca') fillAlpha = v;
        break;
      case OPS.constructPath:
        pendingPath = args; break;
      case OPS.fill:
      case OPS.eoFill:
        if (pendingPath) {
          const [subOps, flat] = pendingPath;
          const xs = [], ys = [];
          let j = 0, bailed = false;
          const pt = (x, y) => { const [px,py] = apply(ctm,x,y); xs.push(px); ys.push(py); };
          for (let k = 0; k < subOps.length && !bailed; k++) {
            switch (subOps[k]) {
              case OPS.rectangle: { const x=flat[j++],y=flat[j++],w=flat[j++],h=flat[j++]; pt(x,y);pt(x+w,y);pt(x+w,y+h);pt(x,y+h); break; }
              case OPS.moveTo: case OPS.lineTo: pt(flat[j],flat[j+1]); j+=2; break;
              case OPS.curveTo:  pt(flat[j],flat[j+1]); pt(flat[j+2],flat[j+3]); pt(flat[j+4],flat[j+5]); j+=6; break;
              case OPS.curveTo2: case OPS.curveTo3: pt(flat[j],flat[j+1]); pt(flat[j+2],flat[j+3]); j+=4; break;
              case OPS.closePath: break;
              default: bailed=true;
            }
          }
          if (xs.length) rects.push({ x0:Math.min(...xs), x1:Math.max(...xs), y0:Math.min(...ys), y1:Math.max(...ys), fillColor, fillAlpha });
        }
        break;
    }
  }
  return rects;
}

export async function gbGetTextBoxes(page) {
  const content = await page.getTextContent();
  return content.items
    .filter(item => item.str && item.str.trim())
    .map(item => {
      const [,b,,d,e,f] = item.transform;
      const w = item.width ?? 0;
      const h = item.height ?? (Math.hypot(b,d) || 10);
      return { text: item.str, x0: Math.min(e, e+w), x1: Math.max(e, e+w), y0: f, y1: f+h };
    });
}

export function gbBoxInside(text, rect, pad) {
  return text.x0 >= rect.x0 - pad && text.x1 <= rect.x1 + pad &&
         text.y0 >= rect.y0 - pad && text.y1 <= rect.y1 + pad;
}

export function gbColorToTint(fillColor, tol) {
  if (!fillColor) return null;
  const vals = Array.from(fillColor);
  const scale = Math.max(...vals) > 1 ? 255 : 1;
  const norm = vals.map(v => v / scale);
  if (norm.length === 1) return { neutral: true, tint: 1 - norm[0] };
  if (norm.length === 3) {
    const [r,g,b] = norm;
    return { neutral: Math.max(r,g,b)-Math.min(r,g,b) < tol, tint: 1-(r+g+b)/3 };
  }
  if (norm.length === 4) {
    const [c,m,y,k] = norm;
    return { neutral: Math.max(c,m,y) < tol, tint: k };
  }
  return null;
}

export function gbLooksGray(rect) {
  const c = gbColorToTint(rect.fillColor, GB_TOLERANCE);
  if (!c || !c.neutral) return false;
  const apparent = c.tint * rect.fillAlpha;
  return apparent >= GB_TINT_MIN && apparent <= GB_TINT_MAX;
}

// Extract text found inside a gray rect on a given page (using already-fetched text boxes).
// pad defaults to GB_PAD (existing היום יום behavior, unaffected); callers may
// override it — e.g. the day-section splitting rule uses GB_PAD_ICON.
export function gbBoxText(rect, textBoxes, pad = GB_PAD) {
  return textBoxes
    .filter(t => gbBoxInside(t, rect, pad))
    .map(t => t.text)
    .join(' ')
    .trim();
}

// Check if a string contains a Hebrew day-name and return which one
export function matchDayNameInText(text) {
  const n = text.trim().normalize('NFC');
  // Prefer longer matches first (שבת קודש before שבת)
  const sorted = [...DAY_NAMES_HE].sort((a,b) => b.length - a.length);
  for (const d of sorted) {
    if (n === d.normalize('NFC') || n.includes(d.normalize('NFC'))) return d;
  }
  return null;
}

/* ══════════════════════════════════════════════════════════
   Build היום יום page map via gray-box scanning
══════════════════════════════════════════════════════════ */
export async function buildHayomYomPageMap(S) {
  S.hayomYomPageMap = {};

  // Tiny local lookup — intentionally not shared with the HTML tool's own
  // (UI-facing) findSectionByTitle. It's a two-line pure function; keeping
  // this module free of any dependency on HTML-side helper functions is
  // worth the trivial duplication.
  const hayomYom = S.sections.find(s => s.title === 'היום יום' || s.title.includes('היום יום'));
  if (!hayomYom || !hayomYom.startPage) return;

  const rangeStart = hayomYom.startPage;

  // ── True end: next section at the SAME OR HIGHER level ──────────────
  // calculateEndPages() sets the parent's endPage to firstChild.startPage-1
  // (almost the same as startPage) because all children are in the sorted list.
  // Skip children and find the next real sibling/uncle instead.
  const trueEnd = (() => {
    const candidates = S.sections
      .filter(s =>
        s.startPage !== null &&
        s.startPage > hayomYom.startPage &&
        s.level <= hayomYom.level   // same level or shallower = sibling/uncle
      )
      .sort((a, b) => a.startPage - b.startPage);
    return candidates.length ? candidates[0].startPage - 1 : S.totalPages;
  })();

  console.log(`[היום יום scan] pages ${rangeStart}–${trueEnd}`);

  let prevDay = null;

  for (let pageNum = rangeStart; pageNum <= trueEnd; pageNum++) {
    const page      = await S.pdfJsDoc.getPage(pageNum);
    const allRects  = await gbGetFilledRects(page);
    const grayRects = allRects.filter(gbLooksGray);

    if (!grayRects.length) {
      // No gray boxes at all — previous day continues
      if (prevDay) {
        if (!S.hayomYomPageMap[prevDay]) S.hayomYomPageMap[prevDay] = new Set();
        S.hayomYomPageMap[prevDay].add(pageNum);
      }
      continue;
    }

    const textBoxes = await gbGetTextBoxes(page);

    // PDF y-axis goes bottom-up; sort gray rects top-to-bottom visually (highest y1 first)
    const sorted = [...grayRects].sort((a, b) => b.y1 - a.y1);

    // ── Rule: first box empty → continuation of prevDay ──
    const firstText = gbBoxText(sorted[0], textBoxes);
    if (!firstText && prevDay) {
      if (!S.hayomYomPageMap[prevDay]) S.hayomYomPageMap[prevDay] = new Set();
      S.hayomYomPageMap[prevDay].add(pageNum);
    }

    // ── Find every day-labeled box on this page ──────────
    for (const rect of sorted) {
      const text    = gbBoxText(rect, textBoxes);
      const dayName = matchDayNameInText(text);
      if (dayName) {
        if (!S.hayomYomPageMap[dayName]) S.hayomYomPageMap[dayName] = new Set();
        S.hayomYomPageMap[dayName].add(pageNum);
        prevDay = dayName;
      }
    }
  }

  console.log('[היום יום page map]', Object.fromEntries(
    Object.entries(S.hayomYomPageMap).map(([k,v]) => [k, [...v]])
  ));
}

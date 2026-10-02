/* ══════════════════════════════════════════════════════════
   booklet-logic.js

   Shared PDF-analysis logic, used by both the browser tool and the
   scheduled compute script so the two can't diverge.

   Requires a global `pdfjsLib` (used for pdfjsLib.OPS). In the browser
   that's the existing <script> tag; in Node, set it before importing.

   `S` is the state object: { pdfJsDoc, totalPages, sections, hayomYomPageMap }
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

// Parent titles the day-section splitting rule applies to.
// Matched against parentTitle via .includes().
export const KNOWN_DAY_PARENTS = [
  'חומש יומי',
  'תניא יומי',
  'רמב"ם - שלושה פרקים ליום',
  'רמב"ם - פרק אחד ליום'
];

// Text of a day-section's start-icon gray box. The garbled look is
// correct — that's how the marker decodes from the source PDF.
export const ICON_MARKER = 'â â';

// Padding (pt) for icon-box text matching. Tighter than GB_PAD,
// which the היום יום engine uses.
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

    // Next section's start page, before any rule below mutates endPage.
    // This is the window the splitting rule may search (inclusive).
    const next = withPage.find(s => s.startPage > sec.startPage);
    const windowEnd = next ? next.startPage : S.totalPages;

    if (isShabbosChumash(sec)) {
      // ── Chaslat rule owns שבת קודש within חומש יומי ──────
      const chaslatEnd = await chaslatRule(S, sec);
      if (chaslatEnd !== null) {
        sec.endPage = chaslatEnd;
      } else {
        // Chaslat found nothing — fall back to the splitting rule.
        const split = await daySectionSplittingRule(S, sec, windowEnd);
        if (split !== null) sec.endPage = split;
      }
    } else if (isKnownDaySection(sec)) {
      // ── Day-Section Splitting Rule — all other day-parent children ──
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

   Finds a section's start-icon on its start page and takes the first
   "$" that follows it in reading order as the section's end. If none
   is found there, scans forward to windowEnd (inclusive). Returns null
   when nothing is found, meaning "keep the existing endPage".
══════════════════════════════════════════════════════════ */

// Horizontal tolerance (pt) when testing column membership.
export const COLUMN_CONTAINMENT_PAD = 4;

/*
   Is itemBox after iconRect in reading order?

   The start-icon is a bar spanning its column's full width, so its
   x-span defines the column. Same column → compare y (PDF y-axis is
   bottom-up). Different column → RTL: the right column is read in full
   before the left, so an item is "after" only if it's to the icon's left.
*/
export function isAfterInReadingOrderRTL(itemBox, iconRect) {
  const itemCenterX = (itemBox.x0 + itemBox.x1) / 2;

  const sameColumn =
    itemCenterX >= iconRect.x0 - COLUMN_CONTAINMENT_PAD &&
    itemCenterX <= iconRect.x1 + COLUMN_CONTAINMENT_PAD;

  if (sameColumn) return itemBox.y1 <= iconRect.y0;

  const iconCenterX = (iconRect.x0 + iconRect.x1) / 2;
  return itemCenterX < iconCenterX;
}

// Sort boxes into RTL reading order (first-read first). Needed because
// pdf.js returns rects in drawing order, not visual order.
export function sortBoxesReadingOrderRTL(boxes) {
  return [...boxes].sort((a, b) => {
    if (isAfterInReadingOrderRTL(a, b)) return 1;   // a comes after b
    if (isAfterInReadingOrderRTL(b, a)) return -1;  // b comes after a
    return 0;
  });
}

// Day-sections starting on a given page, in document order. Used to pair
// each section with its own icon when several share a start page.
// Shabbos-Chumash sections count too: they still occupy an icon slot.
export function daySectionsStartingOnPage(S, pageNum) {
  return S.sections.filter(s =>
    s.startPage === pageNum && (isKnownDaySection(s) || isShabbosChumash(s))
  );
}

/* ══════════════════════════════════════════════════════════
   Correct day-section start pages against their actual start-icons

   The publisher sometimes anchors a bookmark to the top of the NEXT
   page instead of the section's real mid-page start, which would drop
   the opening content. A section is moved back one page only when its
   bookmarked page has fewer start-icons than sections claiming it, and
   the previous page has a spare unclaimed icon.

   Runs after extractOutline() and before calculateEndPages().
══════════════════════════════════════════════════════════ */
export async function countStartIconsOnPage(S, pageNum) {
  if (pageNum < 1 || pageNum > S.totalPages) return 0;
  const page = await S.pdfJsDoc.getPage(pageNum);
  const grayRects = (await gbGetFilledRects(page)).filter(gbLooksGray);
  if (!grayRects.length) return 0;
  const textBoxes = await gbGetTextBoxes(page);
  return grayRects.filter(r =>
    normalizeWs(gbBoxText(r, textBoxes, GB_PAD_ICON)) === normalizeWs(ICON_MARKER)
  ).length;
}

export async function correctDaySectionStartPages(S) {
  const daySections = S.sections.filter(s =>
    s.startPage !== null && (isKnownDaySection(s) || isShabbosChumash(s))
  );
  if (!daySections.length) return;

  // Icon counts for every claimed page and the page before it.
  const pagesOfInterest = new Set();
  for (const s of daySections) {
    pagesOfInterest.add(s.startPage);
    if (s.startPage > 1) pagesOfInterest.add(s.startPage - 1);
  }
  const iconCount = new Map();
  for (const p of [...pagesOfInterest].sort((a, b) => a - b)) {
    iconCount.set(p, await countStartIconsOnPage(S, p));
  }

  // How many day-sections currently claim each page.
  const claims = new Map();
  for (const s of daySections) {
    claims.set(s.startPage, (claims.get(s.startPage) || 0) + 1);
  }

  const claimedPages = [...claims.keys()].sort((a, b) => a - b);

  for (const page of claimedPages) {
    const deficit = (claims.get(page) || 0) - (iconCount.get(page) || 0);
    if (deficit <= 0) continue;              // every section here has an icon

    const prev = page - 1;
    if (prev < 1) continue;
    const spare = (iconCount.get(prev) || 0) - (claims.get(prev) || 0);
    if (spare <= 0) continue;                // nothing unclaimed to move back to

    // Move the earliest sections lacking an icon (document order
    // follows reading order).
    const movable = daySections
      .filter(s => s.startPage === page)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.min(deficit, spare));

    for (const sec of movable) {
      const parent = S.sections.find(p2 => p2.id === sec.parentId);
      console.log(
        `[correctDaySectionStartPages] "${sec.title}" (${sec.parentTitle ?? '—'}): ` +
        `bookmarked p${sec.startPage}, start-icon found on p${prev} — correcting.`
      );
      sec.startPage = prev;
      claims.set(page, claims.get(page) - 1);
      claims.set(prev, (claims.get(prev) || 0) + 1);

      // Keep the tree coherent: a parent must not start after its child.
      if (parent && parent.startPage === page) {
        console.log(
          `[correctDaySectionStartPages]   also moving parent "${parent.title}" p${page} → p${prev}`
        );
        parent.startPage = prev;
      }
    }
  }
}

export async function daySectionSplittingRule(S, sec, windowEnd) {
  const textBoxesCache = {};
  async function getCachedTextBoxes(pageNum) {
    if (!textBoxesCache[pageNum]) {
      const page = await S.pdfJsDoc.getPage(pageNum);
      textBoxesCache[pageNum] = await gbGetTextBoxes(page);
    }
    return textBoxesCache[pageNum];
  }

  // ── Locate THIS section's start-icon box on its own start page ──
  const startPageObj  = await S.pdfJsDoc.getPage(sec.startPage);
  const startGrayRects = (await gbGetFilledRects(startPageObj)).filter(gbLooksGray);
  const startTextBoxes = await getCachedTextBoxes(sec.startPage);

  const allIcons = sortBoxesReadingOrderRTL(
    startGrayRects.filter(r =>
      normalizeWs(gbBoxText(r, startTextBoxes, GB_PAD_ICON)) === normalizeWs(ICON_MARKER)
    )
  );

  // The Nth day-section starting on this page takes the Nth icon.
  const siblings = daySectionsStartingOnPage(S, sec.startPage);
  const myIndex  = siblings.findIndex(s => s.id === sec.id);

  let iconRect;
  if (allIcons.length === siblings.length && myIndex >= 0) {
    iconRect = allIcons[myIndex];
  } else if (siblings.length <= 1) {
    // Nothing to disambiguate — take the first icon in reading order.
    iconRect = allIcons[0];
  } else {
    // Counts don't match, so pairing is ambiguous. Best-effort, but warn.
    console.warn(
      `[daySectionSplittingRule] page ${sec.startPage}: ${siblings.length} day-sections ` +
      `but ${allIcons.length} icons — positional pairing may be unreliable for "${sec.title}".`
    );
    iconRect = myIndex >= 0 ? allIcons[myIndex] : undefined;
  }

  if (iconRect) {
    // Only a "$" after the icon in reading order counts — this excludes
    // one left over from a different section on the same page.
    const dollarAfterIcon = startTextBoxes.find(t =>
      t.text.trim() === '$' && isAfterInReadingOrderRTL(t, iconRect)
    );
    if (dollarAfterIcon) return sec.startPage;
  }
  // No icon, or no qualifying "$" after it — don't search this page
  // further; searching without an icon anchor risks false positives.

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

// Text inside a gray rect. pad defaults to GB_PAD; the splitting rule
// passes GB_PAD_ICON.
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

  const hayomYom = S.sections.find(s => s.title === 'היום יום' || s.title.includes('היום יום'));
  if (!hayomYom || !hayomYom.startPage) return;

  const rangeStart = hayomYom.startPage;

  // ── True end: next section at the SAME OR HIGHER level ──────────────
  // The parent's own endPage is useless here (it stops at its first
  // child), so skip children and find the next sibling/uncle instead.
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

/* ══════════════════════════════════════════════════════════
   Synthesize per-day child sections under היום יום

   The PDF's bookmarks never split היום יום by day — that only comes
   from the gray-box page scan. This turns that scan into real child
   sections so both tabs can select a single day through the same
   mechanism as any other section. Any existing children are replaced.

   Runs after calculateEndPages() and buildHayomYomPageMap().
══════════════════════════════════════════════════════════ */
export function synthesizeHayomYomChildren(S) {
  const hayomYom = S.sections.find(s => s.title === 'היום יום' || s.title.includes('היום יום'));
  if (!hayomYom || !hayomYom.startPage) return;

  const oldChildIds = new Set(hayomYom.childIds);
  S.sections = S.sections.filter(s => !oldChildIds.has(s.id));
  hayomYom.childIds = [];

  let nextId = S.sections.reduce((max, s) => Math.max(max, s.id), -1) + 1;

  const dayEntries = Object.entries(S.hayomYomPageMap)
    .map(([title, pages]) => {
      const sorted = [...pages].sort((a, b) => a - b);
      return { title, startPage: sorted[0], endPage: sorted[sorted.length - 1] };
    })
    .filter(e => e.startPage !== undefined)
    .sort((a, b) => a.startPage - b.startPage); // page order

  for (const entry of dayEntries) {
    const child = {
      id: nextId++,
      title: entry.title,
      startPage: entry.startPage,
      endPage: entry.endPage,
      level: hayomYom.level + 1,
      parentId: hayomYom.id,
      parentTitle: hayomYom.title,
      childIds: [],
      collapsed: false,
    };
    S.sections.push(child);
    hayomYom.childIds.push(child.id);
  }
}

// ============================================================================
// Single shared PDFKit layout module for every branded PDF (sales report,
// fee invoice, and any future report). Controllers should import from here
// and never re-implement tables, cards, headers or formatting.
// ============================================================================
import PDFDocument from 'pdfkit';

export const PAGE_MARGIN = 40;
export const BRAND_COLOR = '#C41E2D';

// ── formatting ──────────────────────────────────────────────────────────────
export function formatCurrency(value) {
  return `Rs. ${Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(date) {
  return date
    ? new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '-';
}

// ── document + geometry helpers ─────────────────────────────────────────────
export function createPdf(res, filename, { bufferPages = true } = {}) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages });
  doc.pipe(res);
  return doc;
}

export const contentWidth = (doc) => doc.page.width - PAGE_MARGIN * 2;
const bottomLimit = (doc) => doc.page.height - PAGE_MARGIN;

// Starts a new page (with optional running header) if `needed` points don't fit.
export function ensureSpace(doc, needed, runningHeaderTitle) {
  if (doc.y + needed <= bottomLimit(doc)) return false;
  doc.addPage();
  if (runningHeaderTitle) drawRunningHeader(doc, runningHeaderTitle);
  return true;
}

// Turns { flex } columns into pixel widths that sum exactly to the content width.
function resolveColumnWidths(doc, columns) {
  const totalFlex = columns.reduce((s, c) => s + c.flex, 0);
  const width = contentWidth(doc);
  let used = 0;
  return columns.map((c, i) => {
    if (i === columns.length - 1) return { ...c, width: width - used };
    const w = Math.floor((c.flex / totalFlex) * width);
    used += w;
    return { ...c, width: w };
  });
}

// ── page furniture ──────────────────────────────────────────────────────────
// Left block = title/subtitle. Optional right block = rightTitle/rightSubtitle.
export function drawTitleBand(doc, { title, subtitle, rightTitle, rightSubtitle, height = 90 }) {
  const w = contentWidth(doc);
  const hasRight = Boolean(rightTitle || rightSubtitle);
  const leftWidth = hasRight ? w * 0.62 : w;

  doc.rect(0, 0, doc.page.width, height).fill(BRAND_COLOR);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22)
    .text(title, PAGE_MARGIN, 28, { width: leftWidth, lineBreak: false });
  if (subtitle) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#FDECEC')
      .text(subtitle, PAGE_MARGIN, 56, { width: leftWidth });
  }
  if (rightTitle) {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#FFFFFF')
      .text(rightTitle, PAGE_MARGIN, 30, { width: w, align: 'right', lineBreak: false });
  }
  if (rightSubtitle) {
    doc.font('Helvetica').fontSize(10).fillColor('#FDECEC')
      .text(rightSubtitle, PAGE_MARGIN, 56, { width: w, align: 'right', lineBreak: false });
  }
  doc.y = height + 22;
}

export function drawRunningHeader(doc, title) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#999999')
    .text(title, PAGE_MARGIN, 20, { width: contentWidth(doc), align: 'left', lineBreak: false });
  doc.strokeColor('#EEEEEE').lineWidth(1)
    .moveTo(PAGE_MARGIN, 34).lineTo(doc.page.width - PAGE_MARGIN, 34).stroke();
  doc.y = 46;
}

export function drawSectionTitle(doc, text) {
  ensureSpace(doc, 70); // keep the title together with at least some content
  doc.y += 8;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111')
    .text(text, PAGE_MARGIN, doc.y, { width: contentWidth(doc) });
  doc.y += 4;
  doc.strokeColor(BRAND_COLOR).lineWidth(1.5)
    .moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + 40, doc.y).stroke();
  doc.y += 10;
}

// Writing inside the bottom margin makes PDFKit spawn blank pages, so the
// margin is zeroed on the page while the footer text is drawn.
function withZeroBottomMargin(doc, fn) {
  const prev = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  fn();
  doc.page.margins.bottom = prev;
}

export function drawFooterNote(doc, text) {
  withZeroBottomMargin(doc, () => {
    doc.font('Helvetica').fontSize(8).fillColor('#AAAAAA')
      .text(text, PAGE_MARGIN, doc.page.height - 36, {
        width: contentWidth(doc), align: 'center', lineBreak: false,
      });
  });
}

// Requires createPdf(..., { bufferPages: true }) (the default).
export function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    withZeroBottomMargin(doc, () => {
      doc.font('Helvetica').fontSize(8).fillColor('#999999')
        .text(`Page ${i - range.start + 1} of ${range.count}`, PAGE_MARGIN, doc.page.height - 26, {
          width: contentWidth(doc), align: 'center', lineBreak: false,
        });
    });
  }
}

// ── KPI cards (2 per row) ───────────────────────────────────────────────────
// cards: [{ label, value, change, positive, neutral, accent }]
// Every card position is computed from ONE fixed `startY`. (Previously doc.y
// was re-read per card, but drawing text moves doc.y, so later cards drifted.)
export function drawKpiCards(doc, cards) {
  const gap = 14;
  const cardHeight = 64;
  const cardWidth = (contentWidth(doc) - gap) / 2;
  const padLeft = 16;
  const innerWidth = cardWidth - padLeft - 12;
  const rowsNeeded = Math.ceil(cards.length / 2);

  ensureSpace(doc, rowsNeeded * (cardHeight + gap));
  const startY = doc.y;

  cards.forEach((card, i) => {
    const x = PAGE_MARGIN + (i % 2) * (cardWidth + gap);
    const y = startY + Math.floor(i / 2) * (cardHeight + gap);

    doc.roundedRect(x, y, cardWidth, cardHeight, 6).fillAndStroke('#FAFAFA', '#E5E7EB');
    doc.rect(x, y + 8, 3, cardHeight - 16).fill(card.accent || BRAND_COLOR);

    doc.font('Helvetica').fontSize(8.5).fillColor('#666666')
      .text(String(card.label).toUpperCase(), x + padLeft, y + 10, { width: innerWidth, lineBreak: false });

    // shrink the value font until it fits the card instead of clipping
    let size = 16;
    doc.font('Helvetica-Bold');
    while (size > 9 && doc.fontSize(size).widthOfString(String(card.value)) > innerWidth) size -= 0.5;
    doc.fontSize(size).fillColor('#111111')
      .text(String(card.value), x + padLeft, y + 25, { width: innerWidth, lineBreak: false });

    if (card.change) {
      const color = card.neutral ? '#888888' : card.positive ? '#2E7D32' : '#C41E2D';
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(color)
        .text(card.change, x + padLeft, y + 46, { width: innerWidth, lineBreak: false });
    }
  });

  doc.y = startY + rowsNeeded * (cardHeight + gap);
}

// ── status badge (does not move doc.y) ──────────────────────────────────────
export function drawBadge(doc, { label, color, x, y, width = 130, height = 22 }) {
  doc.roundedRect(x, y, width, height, 4).fill(color);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF')
    .text(label, x, y + (height - 10) / 2 + 0.5, { width, align: 'center', lineBreak: false });
}

// ── table with auto-height rows ─────────────────────────────────────────────
// columns: [{ key, label, flex, align }]   rows: [{ [key]: value }]
// Each row is as tall as its tallest wrapped cell. Header repeats on every page
// and each page's table segment gets its own border.
export function drawTable(doc, {
  columns: rawColumns, rows, runningHeaderTitle,
  minRowHeight = 22, padX = 6, padY = 6, fontSize = 9, headerHeight = 24,
}) {
  const columns = resolveColumnWidths(doc, rawColumns);
  const tableWidth = contentWidth(doc);
  const data = rows.length ? rows : [{ [columns[0].key]: 'No records' }];
  let segmentTop = doc.y;

  const measureRow = (row) => {
    doc.font('Helvetica').fontSize(fontSize);
    let tallest = 0;
    for (const col of columns) {
      const h = doc.heightOfString(String(row[col.key] ?? ''), {
        width: col.width - padX * 2,
        align: col.align,
      });
      tallest = Math.max(tallest, h);
    }
    return Math.max(minRowHeight, Math.ceil(tallest) + padY * 2);
  };

  const drawHeader = () => {
    const y = doc.y;
    doc.rect(PAGE_MARGIN, y, tableWidth, headerHeight).fill('#1F2933');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    let x = PAGE_MARGIN;
    for (const col of columns) {
      doc.text(col.label, x + padX, y + 8, { width: col.width - padX * 2, align: col.align, lineBreak: false });
      x += col.width;
    }
    doc.y = y + headerHeight;
    segmentTop = y;
  };

  const closeSegment = () => {
    doc.strokeColor('#D0D3D8').lineWidth(0.75)
      .rect(PAGE_MARGIN, segmentTop, tableWidth, doc.y - segmentTop).stroke();
  };

  // header + first row must fit together, otherwise start on a fresh page
  ensureSpace(doc, headerHeight + measureRow(data[0]), runningHeaderTitle);
  drawHeader();

  data.forEach((row, i) => {
    const h = measureRow(row);
    if (doc.y + h > bottomLimit(doc)) {
      closeSegment();
      doc.addPage();
      if (runningHeaderTitle) drawRunningHeader(doc, runningHeaderTitle);
      drawHeader();
    }

    const y = doc.y;
    if (i % 2 === 1) doc.rect(PAGE_MARGIN, y, tableWidth, h).fill('#F5F6F8');

    // column separators
    doc.strokeColor('#E5E7EB').lineWidth(0.5);
    let gx = PAGE_MARGIN;
    for (const col of columns.slice(0, -1)) {
      gx += col.width;
      doc.moveTo(gx, y).lineTo(gx, y + h).stroke();
    }

    doc.font('Helvetica').fontSize(fontSize).fillColor('#222222');
    let x = PAGE_MARGIN;
    for (const col of columns) {
      doc.text(String(row[col.key] ?? ''), x + padX, y + padY, {
        width: col.width - padX * 2,
        align: col.align,
      });
      x += col.width;
    }
    doc.y = y + h;
  });

  closeSegment();
  doc.y += 16;
}

// ── totals box (right aligned) ──────────────────────────────────────────────
// rows: [{ label, value }]  — the last row is emphasised.
export function drawTotals(doc, rows, { width = 220 } = {}) {
  ensureSpace(doc, rows.length * 20 + 10);
  const x = doc.page.width - PAGE_MARGIN - width;
  let y = doc.y;
  rows.forEach(({ label, value }, i) => {
    const last = i === rows.length - 1;
    if (last) {
      doc.rect(x, y, width, 26).fill('#F5F6F8');
      doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND_COLOR);
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#444444');
    }
    const ty = y + (last ? 8 : 4);
    doc.text(label, x + 10, ty, { width: width * 0.5, lineBreak: false });
    doc.text(value, x + width * 0.5, ty, { width: width * 0.5 - 10, align: 'right', lineBreak: false });
    y += last ? 26 : 18;
  });
  doc.y = y + 16;
}
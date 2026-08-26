import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import prisma from '../../config/db.js';

// ============================================================================
// Shared sales-report data builder. Both the JSON endpoint and the PDF/Excel
// exports pull from this single function so the numbers always match —
// only the txLimit differs (exports pull a much longer transaction list).
//
// Query params:
//   range        7D | 30D | 6M | 1Y   (default 30D) — window for the KPI cards
//   trendMonths  1-12                 (default 6)   — months in the bar chart
//   txLimit      1-1000               (default 20 for JSON, 500 for exports)
// ============================================================================

const RANGE_DAYS = {
  '7D': 7,
  '30D': 30,
  '6M': 182,
  '1Y': 365,
};

const RANGE_LABELS = {
  '7D': 'Last 7 days',
  '30D': 'Last 30 days',
  '6M': 'Last 6 months',
  '1Y': 'Last 12 months',
};

const PLAN_COLORS = ['#C41E2D', '#7B1FA2', '#1565C0', '#2E7D32', '#FFA000', '#29B6F6'];

// ── resolve the selected range + the equal-length prior window (for deltas) ──
function resolveRange(rangeParam) {
  const key = RANGE_DAYS[(rangeParam || '30D').toUpperCase()] ? rangeParam.toUpperCase() : '30D';
  const days = RANGE_DAYS[key];

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const prevEnd = new Date(start);
  const prevStart = new Date(start);
  prevStart.setDate(prevStart.getDate() - days);

  return { key, start, end, prevStart, prevEnd };
}

function pct(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function toNumber(decimal) {
  return decimal === null || decimal === undefined ? 0 : Number(decimal);
}

function formatCurrency(value) {
  return `Rs. ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── membership + shop revenue for an arbitrary window ───────────────────────
async function getRevenueForWindow(start, end) {
  const [feeAgg, orderAgg] = await Promise.all([
    prisma.feeRecord.aggregate({
      where: { status: 'PAID', paidDate: { gte: start, lte: end } },
      _sum: { paidAmount: true },
    }),
    prisma.productOrder.aggregate({
      where: { status: { not: 'CANCELLED' }, placedAt: { gte: start, lte: end } },
      _sum: { totalAmount: true },
    }),
  ]);

  return {
    membershipRevenue: toNumber(feeAgg._sum.paidAmount),
    shopRevenue: toNumber(orderAgg._sum.totalAmount),
  };
}

async function buildSalesReportData({ range, trendMonths = 6, txLimit = 20 }) {
  const { start, end, prevStart, prevEnd, key } = resolveRange(range);
  trendMonths = Math.min(Math.max(trendMonths, 1), 12);
  txLimit = Math.min(Math.max(txLimit, 1), 1000);

  // ── KPI 1 & 3: total revenue + shop sales, current vs previous window ────
  const [current, previous] = await Promise.all([
    getRevenueForWindow(start, end),
    getRevenueForWindow(prevStart, prevEnd),
  ]);
  const currentTotal = current.membershipRevenue + current.shopRevenue;
  const previousTotal = previous.membershipRevenue + previous.shopRevenue;

  // ── KPI 2: memberships sold (paid fee transactions) ──────────────────────
  const [membershipsSoldCurrent, membershipsSoldPrevious] = await Promise.all([
    prisma.feeRecord.count({ where: { status: 'PAID', paidDate: { gte: start, lte: end } } }),
    prisma.feeRecord.count({ where: { status: 'PAID', paidDate: { gte: prevStart, lte: prevEnd } } }),
  ]);

  // ── KPI 4: outstanding dues — live snapshot, not windowed ────────────────
  const outstandingRecords = await prisma.feeRecord.findMany({
    where: { status: { in: ['PENDING', 'OVERDUE', 'PARTIAL'] } },
    select: { amount: true, paidAmount: true, memberId: true },
  });
  const outstandingTotal = outstandingRecords.reduce(
    (sum, r) => sum + (toNumber(r.amount) - toNumber(r.paidAmount)),
    0,
  );
  const outstandingMemberCount = new Set(outstandingRecords.map((r) => r.memberId)).size;

  // ── Plan split / plan performance table (paid fees within the window) ───
  const paidFeesInWindow = await prisma.feeRecord.findMany({
    where: { status: 'PAID', paidDate: { gte: start, lte: end } },
    select: {
      memberId: true,
      paidAmount: true,
      plan: { select: { id: true, name: true } },
    },
  });

  const planMap = new Map();
  for (const fee of paidFeesInWindow) {
    const planId = fee.plan.id;
    if (!planMap.has(planId)) {
      planMap.set(planId, { plan: fee.plan.name, members: new Set(), revenue: 0 });
    }
    const entry = planMap.get(planId);
    entry.members.add(fee.memberId);
    entry.revenue += toNumber(fee.paidAmount);
  }

  const membershipRevenueForShare = current.membershipRevenue || 1;
  const planRows = Array.from(planMap.values())
    .map((p, i) => ({
      plan: p.plan,
      members: p.members.size,
      revenue: Number(p.revenue.toFixed(2)),
      share: Number((p.revenue / membershipRevenueForShare).toFixed(4)),
      color: PLAN_COLORS[i % PLAN_COLORS.length],
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // ── Revenue trend: last N months, membership + shop revenue, stacked ────
  const trendStart = new Date();
  trendStart.setMonth(trendStart.getMonth() - (trendMonths - 1));
  trendStart.setDate(1);
  trendStart.setHours(0, 0, 0, 0);

  const [feesForTrend, ordersForTrend] = await Promise.all([
    prisma.feeRecord.findMany({
      where: { status: 'PAID', paidDate: { gte: trendStart } },
      select: { paidDate: true, paidAmount: true },
    }),
    prisma.productOrder.findMany({
      where: { status: { not: 'CANCELLED' }, placedAt: { gte: trendStart } },
      select: { placedAt: true, totalAmount: true },
    }),
  ]);

  const monthBuckets = [];
  for (let i = trendMonths - 1; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    monthBuckets.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label: d.toLocaleString('en-US', { month: 'short' }),
      membership: 0,
      shop: 0,
    });
  }
  const bucketIndex = new Map(monthBuckets.map((b, i) => [b.key, i]));

  for (const fee of feesForTrend) {
    const k = `${fee.paidDate.getFullYear()}-${fee.paidDate.getMonth()}`;
    if (bucketIndex.has(k)) monthBuckets[bucketIndex.get(k)].membership += toNumber(fee.paidAmount);
  }
  for (const order of ordersForTrend) {
    const k = `${order.placedAt.getFullYear()}-${order.placedAt.getMonth()}`;
    if (bucketIndex.has(k)) monthBuckets[bucketIndex.get(k)].shop += toNumber(order.totalAmount);
  }

  const trend = monthBuckets.map((b) => ({
    label: b.label,
    membership: Number(b.membership.toFixed(2)),
    shop: Number(b.shop.toFixed(2)),
    total: Number((b.membership + b.shop).toFixed(2)),
  }));
  const trendTotal = trend.reduce((s, b) => s + b.total, 0);
  const trendChangePercent =
    trend.length >= 2 ? pct(trend[trend.length - 1].total, trend[trend.length - 2].total) : 0;

  // ── Transaction log ───────────────────────────────────────────────────
  // IMPORTANT: this must include every fee record regardless of status, not
  // just PAID ones — Pending/Overdue/Partial rows have no paidDate yet, so
  // we fall back to submittedDate, then dueDate, to get a display date, and
  // sort on that effective date since Prisma can't order by a coalesce.
  const transactionRecords = await prisma.feeRecord.findMany({
    where: { status: { in: ['PAID', 'PENDING', 'OVERDUE', 'PARTIAL'] } },
    orderBy: { createdAt: 'desc' },
    take: txLimit,
    select: {
      dueDate: true,
      submittedDate: true,
      paidDate: true,
      amount: true,
      paidAmount: true,
      status: true,
      paymentMethod: true,
      member: { select: { name: true } },
      plan: { select: { name: true } },
    },
  });

  const transactions = transactionRecords
    .map((t) => ({
      date: t.paidDate || t.submittedDate || t.dueDate,
      member: t.member.name,
      plan: t.plan.name,
      mode: t.paymentMethod,
      amount: toNumber(t.paidAmount ?? t.amount),
      status: t.status,
    }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    range: key,
    rangeLabel: RANGE_LABELS[key],
    window: { start, end },
    kpis: {
      totalRevenue: {
        value: Number(currentTotal.toFixed(2)),
        changePercent: pct(currentTotal, previousTotal),
        positive: currentTotal >= previousTotal,
      },
      membershipsSold: {
        value: membershipsSoldCurrent,
        delta: membershipsSoldCurrent - membershipsSoldPrevious,
        positive: membershipsSoldCurrent >= membershipsSoldPrevious,
      },
      shopSales: {
        value: Number(current.shopRevenue.toFixed(2)),
        changePercent: pct(current.shopRevenue, previous.shopRevenue),
        positive: current.shopRevenue >= previous.shopRevenue,
      },
      outstandingDues: {
        value: Number(outstandingTotal.toFixed(2)),
        memberCount: outstandingMemberCount,
        positive: false,
      },
    },
    revenueTrend: {
      total: Number(trendTotal.toFixed(2)),
      changePercent: trendChangePercent,
      months: trend,
    },
    planSplit: planRows,
    transactions,
  };
}

// ============================================================================
// GET /api/reports/sales
// ============================================================================
const getSalesReport = async function (req, res, next) {
  try {
    const data = await buildSalesReportData({
      range: req.query.range,
      trendMonths: parseInt(req.query.trendMonths, 10) || 6,
      txLimit: parseInt(req.query.txLimit, 10) || 20,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// GET /api/reports/sales/export/pdf
//
// Professional, multi-page report:
//   - Branded header band (title + range + generated-at)
//   - 2x2 KPI card grid with colored accent bars and up/down deltas
//   - Plan Performance table
//   - Full Transaction Log table (every status, not just paid)
// All tables use flex-ratio column widths computed from the actual content
// width, so nothing is ever clipped regardless of page size or margins.
// Every page gets a running header + a "Page X of Y" footer.
// ============================================================================

const PAGE_MARGIN = 40;
const BRAND_COLOR = '#C41E2D';

function contentWidth(doc) {
  return doc.page.width - PAGE_MARGIN * 2;
}

// Turns { flex } columns into concrete pixel widths that always sum exactly
// to the available content width (last column absorbs any rounding).
function resolveColumnWidths(doc, columns) {
  const totalFlex = columns.reduce((s, c) => s + c.flex, 0);
  const width = contentWidth(doc);
  let used = 0;
  const resolved = columns.map((c, i) => {
    if (i === columns.length - 1) {
      return { ...c, width: width - used };
    }
    const w = Math.floor((c.flex / totalFlex) * width);
    used += w;
    return { ...c, width: w };
  });
  return resolved;
}

function drawRunningHeader(doc, title) {
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#999999')
    .text(title, PAGE_MARGIN, 20, { width: contentWidth(doc), align: 'left' });
  doc
    .strokeColor('#EEEEEE')
    .lineWidth(1)
    .moveTo(PAGE_MARGIN, 34)
    .lineTo(doc.page.width - PAGE_MARGIN, 34)
    .stroke();
  doc.y = 46;
}

function drawSectionTitle(doc, text) {
  if (doc.y > doc.page.height - PAGE_MARGIN - 60) {
    doc.addPage();
  }
  doc.moveDown(0.6);
  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor('#111111')
    .text(text, PAGE_MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.3);
  doc
    .strokeColor(BRAND_COLOR)
    .lineWidth(1.5)
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + 40, doc.y)
    .stroke();
  doc.moveDown(0.6);
}

// Generic aligned table renderer. Column widths are flex-based (always fit
// the page), text is truncated with an ellipsis instead of wrapping so rows
// stay a fixed height, and the header repeats on every new page.
function drawTable(doc, { columns: rawColumns, rows, runningHeaderTitle }) {
  const columns = resolveColumnWidths(doc, rawColumns);
  const rowHeight = 22;
  const headerHeight = 24;
  const bottomLimit = doc.page.height - PAGE_MARGIN;
  const tableWidth = contentWidth(doc);
  let tableTop = doc.y;

  function drawHeader() {
    const y = doc.y;
    doc.rect(PAGE_MARGIN, y, tableWidth, headerHeight).fill('#1F2933');
    let x = PAGE_MARGIN;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    for (const col of columns) {
      doc.text(col.label, x + 6, y + 8, {
        width: col.width - 12,
        align: col.align,
        lineBreak: false,
      });
      x += col.width;
    }
    doc.y = y + headerHeight;
  }

  function drawGridLines(y) {
    // subtle vertical separators between columns for a cleaner, tabular look
    let x = PAGE_MARGIN;
    doc.strokeColor('#E5E7EB').lineWidth(0.5);
    for (const col of columns) {
      x += col.width;
      if (x < PAGE_MARGIN + tableWidth - 1) {
        doc.moveTo(x, y).lineTo(x, y + rowHeight).stroke();
      }
    }
  }

  drawHeader();

  rows.forEach((row, i) => {
    if (doc.y + rowHeight > bottomLimit) {
      doc.addPage();
      if (runningHeaderTitle) drawRunningHeader(doc, runningHeaderTitle);
      tableTop = doc.y;
      drawHeader();
    }

    const y = doc.y;
    if (i % 2 === 1) {
      doc.rect(PAGE_MARGIN, y, tableWidth, rowHeight).fill('#F5F6F8');
    }
    drawGridLines(y);

    let x = PAGE_MARGIN;
    doc.font('Helvetica').fontSize(9).fillColor('#222222');
    for (const col of columns) {
      const cellValue = row[col.key] ?? '';
      doc.text(String(cellValue), x + 6, y + 6, {
        width: col.width - 12,
        align: col.align,
        lineBreak: false,
        ellipsis: true,
      });
      x += col.width;
    }
    doc.y = y + rowHeight;
  });

  // outer border around the table section drawn since the last header/page break
  doc.strokeColor('#D0D3D8').lineWidth(0.75);
  doc.rect(PAGE_MARGIN, tableTop, tableWidth, doc.y - tableTop).stroke();

  doc.moveDown(1);
}

function drawKpiCards(doc, cards) {
  const gap = 14;
  const cardWidth = (contentWidth(doc) - gap) / 2;
  const cardHeight = 62;

  cards.forEach((card, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = PAGE_MARGIN + col * (cardWidth + gap);
    const y = doc.y + row * (cardHeight + gap);

    doc.roundedRect(x, y, cardWidth, cardHeight, 6).fillAndStroke('#FAFAFA', '#E5E7EB');
    // accent bar
    doc.rect(x, y, 4, cardHeight).fill(card.accent);

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#666666')
      .text(card.label.toUpperCase(), x + 16, y + 10, { width: cardWidth - 30, lineBreak: false });

    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor('#111111')
      .text(card.value, x + 16, y + 24, { width: cardWidth - 30, lineBreak: false });

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(card.positive ? '#2E7D32' : '#C41E2D')
      .text(card.change, x + 16, y + 44, { width: cardWidth - 30, lineBreak: false });
  });

  const rowsUsed = Math.ceil(cards.length / 2);
  doc.y = doc.y + rowsUsed * (cardHeight + gap);
}

function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#999999')
      .text(
        `Page ${i - range.start + 1} of ${range.count}`,
        PAGE_MARGIN,
        doc.page.height - 26,
        { width: contentWidth(doc), align: 'center' },
      );
  }
}

const exportSalesPdf = async function (req, res, next) {
  try {
    const data = await buildSalesReportData({
      range: req.query.range,
      trendMonths: parseInt(req.query.trendMonths, 10) || 6,
      txLimit: parseInt(req.query.txLimit, 10) || 500,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-report.pdf"');

    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    doc.pipe(res);

    // ── Title block ──────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(BRAND_COLOR);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text('Sales Report', PAGE_MARGIN, 28);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#FDECEC')
      .text(
        `${data.rangeLabel}  ·  Generated ${new Date().toLocaleString('en-IN')}`,
        PAGE_MARGIN,
        56,
      );
    doc.y = 112;

    // ── KPI summary cards ────────────────────────────────────────────────
    drawSectionTitle(doc, 'Summary');
    drawKpiCards(doc, [
      {
        label: 'Total Revenue',
        value: formatCurrency(data.kpis.totalRevenue.value),
        change: `${data.kpis.totalRevenue.changePercent >= 0 ? '▲' : '▼'} ${Math.abs(data.kpis.totalRevenue.changePercent)}% vs previous period`,
        positive: data.kpis.totalRevenue.positive,
        accent: BRAND_COLOR,
      },
      {
        label: 'Memberships Sold',
        value: String(data.kpis.membershipsSold.value),
        change: `${data.kpis.membershipsSold.delta >= 0 ? '▲' : '▼'} ${Math.abs(data.kpis.membershipsSold.delta)} vs previous period`,
        positive: data.kpis.membershipsSold.positive,
        accent: '#7B1FA2',
      },
      {
        label: 'Shop Sales',
        value: formatCurrency(data.kpis.shopSales.value),
        change: `${data.kpis.shopSales.changePercent >= 0 ? '▲' : '▼'} ${Math.abs(data.kpis.shopSales.changePercent)}% vs previous period`,
        positive: data.kpis.shopSales.positive,
        accent: '#29B6F6',
      },
      {
        label: 'Outstanding Dues',
        value: formatCurrency(data.kpis.outstandingDues.value),
        change: `${data.kpis.outstandingDues.memberCount} members owing`,
        positive: false,
        accent: '#FFA000',
      },
    ]);

    // ── Plan performance ─────────────────────────────────────────────────
    drawSectionTitle(doc, 'Plan Performance');
    drawTable(doc, {
      runningHeaderTitle: 'Sales Report — Plan Performance (cont.)',
      columns: [
        { key: 'plan', label: 'PLAN', flex: 3, align: 'left' },
        { key: 'members', label: 'MEMBERS', flex: 1.4, align: 'center' },
        { key: 'revenue', label: 'REVENUE', flex: 1.8, align: 'right' },
        { key: 'share', label: 'SHARE', flex: 1.2, align: 'right' },
      ],
      rows: data.planSplit.map((p) => ({
        plan: p.plan,
        members: p.members,
        revenue: formatCurrency(p.revenue),
        share: `${(p.share * 100).toFixed(0)}%`,
      })),
    });

    // ── Transaction log ──────────────────────────────────────────────────
    drawSectionTitle(doc, `Transaction Log (${data.transactions.length} records)`);
    drawTable(doc, {
      runningHeaderTitle: 'Sales Report — Transaction Log (cont.)',
      columns: [
        { key: 'date', label: 'DATE', flex: 1.1, align: 'left' },
        { key: 'member', label: 'MEMBER', flex: 1.9, align: 'left' },
        { key: 'plan', label: 'PLAN', flex: 1.6, align: 'left' },
        { key: 'mode', label: 'MODE', flex: 1, align: 'center' },
        { key: 'amount', label: 'AMOUNT', flex: 1.3, align: 'right' },
        { key: 'status', label: 'STATUS', flex: 1, align: 'center' },
      ],
      rows: data.transactions.map((t) => ({
        date: t.date ? new Date(t.date).toISOString().slice(0, 10) : '-',
        member: t.member,
        plan: t.plan,
        mode: t.mode || '-',
        amount: formatCurrency(t.amount),
        status: t.status,
      })),
    });

    addPageNumbers(doc);
    doc.end();
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// GET /api/reports/sales/export/excel
//
// Three-sheet workbook: Summary (KPIs), Plan Performance, Transactions.
// The Transactions sheet carries the FULL log (every status — paid, pending,
// overdue, partial — not just paid ones), with borders, currency formatting,
// autofilter, and a frozen header row so it behaves like a real report.
// ============================================================================

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2933' } };
    cell.alignment = { vertical: 'middle', horizontal: cell.alignment?.horizontal || 'left' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF1F2933' } },
      bottom: { style: 'thin', color: { argb: 'FF1F2933' } },
      left: { style: 'thin', color: { argb: 'FF1F2933' } },
      right: { style: 'thin', color: { argb: 'FF1F2933' } },
    };
  });
  row.height = 20;
}

function addThinBorder(cell) {
  cell.border = {
    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
  };
}

function shadeAlternateRow(row, index) {
  if (index % 2 === 1) {
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F8FA' } };
    });
  }
}

const exportSalesExcel = async function (req, res, next) {
  try {
    const data = await buildSalesReportData({
      range: req.query.range,
      trendMonths: parseInt(req.query.trendMonths, 10) || 6,
      txLimit: parseInt(req.query.txLimit, 10) || 500,
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Club Fitness Reports';
    workbook.created = new Date();

    // ── Sheet 1: Summary ───────────────────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Summary', {
      views: [{ showGridLines: false }],
    });
    summarySheet.columns = [
      { key: 'metric', header: 'Metric', width: 28 },
      { key: 'value', header: 'Value', width: 22 },
      { key: 'change', header: 'vs Previous Period', width: 26 },
    ];

    summarySheet.mergeCells('A1:C1');
    summarySheet.getCell('A1').value = `Sales Report — ${data.rangeLabel}`;
    summarySheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFC41E2D' } };
    summarySheet.getCell('A1').alignment = { vertical: 'middle' };
    summarySheet.getRow(1).height = 26;

    summarySheet.mergeCells('A2:C2');
    summarySheet.getCell('A2').value = `Generated ${new Date().toLocaleString('en-IN')}`;
    summarySheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF888888' } };
    summarySheet.addRow([]);

    const headerRow = summarySheet.addRow(['Metric', 'Value', 'vs Previous Period']);
    styleHeaderRow(headerRow);

    const summaryRows = [
      ['Total Revenue', data.kpis.totalRevenue.value, `${data.kpis.totalRevenue.changePercent >= 0 ? '+' : ''}${data.kpis.totalRevenue.changePercent}%`],
      ['Memberships Sold', data.kpis.membershipsSold.value, `${data.kpis.membershipsSold.delta >= 0 ? '+' : ''}${data.kpis.membershipsSold.delta}`],
      ['Shop Sales', data.kpis.shopSales.value, `${data.kpis.shopSales.changePercent >= 0 ? '+' : ''}${data.kpis.shopSales.changePercent}%`],
      ['Outstanding Dues', data.kpis.outstandingDues.value, `${data.kpis.outstandingDues.memberCount} members owing`],
    ];

    summaryRows.forEach((r, idx) => {
      const row = summarySheet.addRow(r);
      shadeAlternateRow(row, idx);
      row.eachCell((cell) => addThinBorder(cell));
      if (r[0] !== 'Memberships Sold') {
        row.getCell(2).numFmt = '"Rs. "#,##0.00';
      }
      row.getCell(2).alignment = { horizontal: 'right' };
      row.getCell(3).alignment = { horizontal: 'right' };
    });

    // ── Sheet 2: Plan Performance ──────────────────────────────────────────
    const planSheet = workbook.addWorksheet('Plan Performance', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    planSheet.columns = [
      { key: 'plan', header: 'Plan', width: 28 },
      { key: 'members', header: 'Members', width: 12 },
      { key: 'revenue', header: 'Revenue', width: 18 },
      { key: 'share', header: 'Share', width: 12 },
    ];
    styleHeaderRow(planSheet.getRow(1));

    data.planSplit.forEach((p, idx) => {
      const row = planSheet.addRow({
        plan: p.plan,
        members: p.members,
        revenue: p.revenue,
        share: p.share,
      });
      shadeAlternateRow(row, idx);
      row.eachCell((cell) => addThinBorder(cell));
      row.getCell('members').alignment = { horizontal: 'center' };
      row.getCell('revenue').numFmt = '"Rs. "#,##0.00';
      row.getCell('revenue').alignment = { horizontal: 'right' };
      row.getCell('share').numFmt = '0%';
      row.getCell('share').alignment = { horizontal: 'right' };
    });

    const planTotalRevenue = data.planSplit.reduce((s, p) => s + p.revenue, 0);
    const planTotalMembers = data.planSplit.reduce((s, p) => s + p.members, 0);
    const totalRow = planSheet.addRow({
      plan: 'Total',
      members: planTotalMembers,
      revenue: planTotalRevenue,
      share: 1,
    });
    totalRow.font = { bold: true };
    totalRow.eachCell((cell) => addThinBorder(cell));
    totalRow.getCell('members').alignment = { horizontal: 'center' };
    totalRow.getCell('revenue').numFmt = '"Rs. "#,##0.00';
    totalRow.getCell('revenue').alignment = { horizontal: 'right' };
    totalRow.getCell('share').numFmt = '0%';
    totalRow.getCell('share').alignment = { horizontal: 'right' };

    // ── Sheet 3: Transactions — the full log, every status ──────────────────
    const txSheet = workbook.addWorksheet('Transactions', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    txSheet.columns = [
      { key: 'date', header: 'Date', width: 14 },
      { key: 'member', header: 'Member', width: 26 },
      { key: 'plan', header: 'Plan', width: 22 },
      { key: 'mode', header: 'Mode', width: 12 },
      { key: 'amount', header: 'Amount', width: 16 },
      { key: 'status', header: 'Status', width: 14 },
    ];
    styleHeaderRow(txSheet.getRow(1));

    data.transactions.forEach((t, idx) => {
      const row = txSheet.addRow({
        date: t.date ? new Date(t.date) : null,
        member: t.member,
        plan: t.plan,
        mode: t.mode || '-',
        amount: t.amount,
        status: t.status,
      });
      shadeAlternateRow(row, idx);
      row.eachCell((cell) => addThinBorder(cell));
      row.getCell('date').numFmt = 'yyyy-mm-dd';
      row.getCell('mode').alignment = { horizontal: 'center' };
      row.getCell('amount').numFmt = '"Rs. "#,##0.00';
      row.getCell('amount').alignment = { horizontal: 'right' };
      row.getCell('status').alignment = { horizontal: 'center' };

      // color-code status for quick scanning, matching the app's badge colors
      const statusColors = {
        PAID: 'FF2E7D32',
        OVERDUE: 'FFC41E2D',
        PENDING: 'FFFFA000',
        PARTIAL: 'FFFFA000',
      };
      if (statusColors[t.status]) {
        row.getCell('status').font = { color: { argb: statusColors[t.status] }, bold: true };
      }
    });

    txSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: 6 },
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="sales-report.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
};

export default { getSalesReport, exportSalesPdf, exportSalesExcel };
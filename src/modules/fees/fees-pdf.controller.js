import prisma from '../../config/db.js';
import {
  PAGE_MARGIN, contentWidth, formatCurrency, formatDate,
  createPdf, drawTitleBand, drawBadge, drawTable, drawTotals, drawFooterNote, ensureSpace,
} from '../../utils/pdf-report-kit.js'; // adjust path to wherever you put pdfLayout.js

const STATUS_STYLE = {
  PAID: { label: 'PAID', color: '#2E7D32' },
  PARTIAL: { label: 'PARTIALLY PAID', color: '#FFA000' },
  PENDING: { label: 'PAYMENT DUE', color: '#29B6F6' },
  OVERDUE: { label: 'OVERDUE', color: '#C41E2D' },
  WAIVED: { label: 'WAIVED', color: '#757575' },
};

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const generateFeeInvoicePdf = asyncHandler(async (req, res) => {
  const fee = await prisma.feeRecord.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, amount: true, paidAmount: true, status: true, dueDate: true,
      paidDate: true, paymentMethod: true, notes: true, createdAt: true,
      member: { select: { id: true, name: true, phone: true, email: true } },
      plan: { select: { name: true } },
    },
  });

  if (!fee) {
    const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
    return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
  }

  const amount = Number(fee.amount);
  const paid = Number(fee.paidAmount || 0);
  const balance = fee.status === 'WAIVED' ? 0 : Math.max(0, amount - paid);
  const status = STATUS_STYLE[fee.status] || STATUS_STYLE.PENDING;
  const planName = fee.plan?.name || 'Membership Fee';

  const doc = createPdf(res, `invoice-${fee.id}.pdf`, { bufferPages: false });
  const width = contentWidth(doc);

  // ── Letterhead ──────────────────────────────────────────────────────────
  drawTitleBand(doc, {
    title: 'Club Fitness',
    subtitle: '123 MG Road, Thiruvananthapuram, Kerala 695001\nbilling@clubfitness.in  ·  +91 98765 43210',
    rightTitle: 'INVOICE',
    rightSubtitle: `#${fee.id}`,
    height: 110,
  });

  // ── Status badge, then Bill To / meta on their own row ──────────────────
  const badgeY = doc.y;
  drawBadge(doc, {
    label: status.label, color: status.color,
    x: doc.page.width - PAGE_MARGIN - 130, y: badgeY,
  });

  const metaTop = badgeY + 34;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#999999').text('BILL TO', PAGE_MARGIN, metaTop);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111')
    .text(fee.member.name, PAGE_MARGIN, metaTop + 14, { width: width * 0.45 });
  doc.font('Helvetica').fontSize(9).fillColor('#555555')
    .text(fee.member.phone || '-', PAGE_MARGIN, metaTop + 32, { width: width * 0.45 })
    .text(fee.member.email || '-', PAGE_MARGIN, metaTop + 46, { width: width * 0.45 });

  const metaX = PAGE_MARGIN + width * 0.5;
  const metaW = width * 0.5;
  [
    ['Invoice Date', formatDate(fee.createdAt)],
    ['Due Date', formatDate(fee.dueDate)],
    ['Paid Date', fee.paidDate ? formatDate(fee.paidDate) : '-'],
    ['Member ID', fee.member.id],
  ].forEach(([label, value], i) => {
    const y = metaTop + i * 15;
    doc.font('Helvetica').fontSize(9).fillColor('#777777')
      .text(label, metaX, y, { width: metaW * 0.35, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111111')
      .text(value, metaX + metaW * 0.35, y, { width: metaW * 0.65, align: 'right', lineBreak: false });
  });

  doc.y = metaTop + 76;
  doc.strokeColor('#E5E7EB').lineWidth(1)
    .moveTo(PAGE_MARGIN, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).stroke();
  doc.y += 16;

  // ── Line items (same table as every report; rows auto-size) ─────────────
  drawTable(doc, {
    columns: [
      { key: 'description', label: 'DESCRIPTION', flex: 5.5, align: 'left' },
      { key: 'qty', label: 'QTY', flex: 1.5, align: 'center' },
      { key: 'amount', label: 'AMOUNT', flex: 3, align: 'right' },
    ],
    rows: [{ description: planName, qty: '1', amount: formatCurrency(amount) }],
    minRowHeight: 28,
    fontSize: 10,
  });

  // ── Totals ──────────────────────────────────────────────────────────────
  const totals = [{ label: 'Subtotal', value: formatCurrency(amount) }];
  if (paid > 0) totals.push({ label: 'Amount Paid', value: `- ${formatCurrency(paid)}` });
  totals.push({ label: fee.status === 'WAIVED' ? 'Waived' : 'Balance Due', value: formatCurrency(balance) });
  drawTotals(doc, totals);

  // ── Notes ───────────────────────────────────────────────────────────────
  if (fee.paymentMethod || fee.notes) {
    ensureSpace(doc, 60);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#999999').text('NOTES', PAGE_MARGIN, doc.y);
    doc.y += 4;
    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    if (fee.paymentMethod) doc.text(`Payment method: ${fee.paymentMethod}`, PAGE_MARGIN, doc.y, { width });
    if (fee.notes) doc.text(fee.notes, PAGE_MARGIN, doc.y, { width });
  }

  drawFooterNote(doc, 'Thank you for being a Club Fitness member. This is a system-generated invoice.');
  doc.end();
});

export default { generateFeeInvoicePdf };
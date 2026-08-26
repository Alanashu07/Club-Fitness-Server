import PDFDocument from 'pdfkit';
import prisma from '../../config/db.js';

const BRAND_COLOR = '#C41E2D';
const PAGE_MARGIN = 48;
 
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
function formatCurrency(value) {
    return `Rs. ${Number(value || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}
 
function formatDate(date) {
    return date
        ? new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : '-';
}
 
const generateFeeInvoicePdf = asyncHandler(async (req, res, next) => {
    try {
        const fee = await prisma.feeRecord.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                amount: true,
                paidAmount: true,
                status: true,
                dueDate: true,
                paidDate: true,
                paymentMethod: true,
                notes: true,
                createdAt: true,
                member: { select: { id: true, name: true, phone: true, email: true } },
                plan: { select: { name: true } }
            },
        });
 
        if (!fee) {
            const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
            return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
        }
 
        const amount = Number(fee.amount);
        const paid = Number(fee.paidAmount || 0);
        const balance = Math.max(0, amount - paid);
        const status = STATUS_STYLE[fee.status] || STATUS_STYLE.PENDING;
        const planName = fee.plan?.name || 'Membership Fee';
 
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${fee.id}.pdf"`);
 
        const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
        doc.pipe(res);
 
        const contentWidth = doc.page.width - PAGE_MARGIN * 2;
 
        // ── Letterhead ──────────────────────────────────────────────────────
        doc.rect(0, 0, doc.page.width, 110).fill(BRAND_COLOR);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(24).text('Club Fitness', PAGE_MARGIN, 34);
        doc
            .font('Helvetica')
            .fontSize(9)
            .fillColor('#FDECEC')
            .text('123 MG Road, Thiruvananthapuram, Kerala 695001  ·  billing@clubfitness.in  ·  +91 98765 43210', PAGE_MARGIN, 62);
 
        doc
            .font('Helvetica-Bold')
            .fontSize(18)
            .fillColor('#FFFFFF')
            .text('INVOICE', PAGE_MARGIN, 34, { width: contentWidth, align: 'right' });
        doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#FDECEC')
            .text(`#${fee.id}`, PAGE_MARGIN, 58, { width: contentWidth, align: 'right' });
 
        doc.y = 132;
 
        // ── Status badge ────────────────────────────────────────────────────
        const badgeWidth = 130;
        doc
            .roundedRect(doc.page.width - PAGE_MARGIN - badgeWidth, doc.y, badgeWidth, 22, 4)
            .fillAndStroke(status.color, status.color);
        doc
            .font('Helvetica-Bold')
            .fontSize(10)
            .fillColor('#FFFFFF')
            .text(status.label, doc.page.width - PAGE_MARGIN - badgeWidth, doc.y - 16, {
                width: badgeWidth,
                align: 'center',
            });
 
        // ── Bill To / Invoice meta (two columns) ───────────────────────────
        const metaTop = doc.y;
        doc
            .font('Helvetica-Bold')
            .fontSize(9)
            .fillColor('#999999')
            .text('BILL TO', PAGE_MARGIN, metaTop);
        doc
            .font('Helvetica-Bold')
            .fontSize(12)
            .fillColor('#111111')
            .text(fee.member.name, PAGE_MARGIN, metaTop + 14);
        doc
            .font('Helvetica')
            .fontSize(9)
            .fillColor('#555555')
            .text(fee.member.phone || '-', PAGE_MARGIN, metaTop + 32)
            .text(fee.member.email || '-', PAGE_MARGIN, metaTop + 46);
 
        const metaColX = PAGE_MARGIN + contentWidth * 0.55;
        const metaColWidth = contentWidth * 0.45;
        const metaRows = [
            ['Invoice Date', formatDate(fee.createdAt)],
            ['Due Date', formatDate(fee.dueDate)],
            ['Paid Date', fee.paidDate ? formatDate(fee.paidDate) : '-'],
            ['Member ID', fee.member.id],
        ];
        metaRows.forEach((row, i) => {
            const y = metaTop + i * 15;
            doc.font('Helvetica').fontSize(9).fillColor('#777777').text(row[0], metaColX, y, { width: metaColWidth * 0.5 });
            doc
                .font('Helvetica-Bold')
                .fontSize(9)
                .fillColor('#111111')
                .text(row[1], metaColX + metaColWidth * 0.5, y, { width: metaColWidth * 0.5, align: 'right' });
        });
 
        doc.y = metaTop + 76;
        doc.strokeColor('#E5E7EB').lineWidth(1).moveTo(PAGE_MARGIN, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).stroke();
        doc.moveDown(1);
 
        // ── Line items table ────────────────────────────────────────────────
        const tableTop = doc.y;
        const colDesc = { x: PAGE_MARGIN, width: contentWidth * 0.55 };
        const colQty = { x: PAGE_MARGIN + contentWidth * 0.55, width: contentWidth * 0.15 };
        const colAmount = { x: PAGE_MARGIN + contentWidth * 0.7, width: contentWidth * 0.3 };
 
        doc.rect(PAGE_MARGIN, tableTop, contentWidth, 24).fill('#1F2933');
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF');
        doc.text('DESCRIPTION', colDesc.x + 8, tableTop + 8, { width: colDesc.width - 8 });
        doc.text('QTY', colQty.x, tableTop + 8, { width: colQty.width, align: 'center' });
        doc.text('AMOUNT', colAmount.x, tableTop + 8, { width: colAmount.width - 8, align: 'right' });
 
        const rowY = tableTop + 24;
        const rowHeight = 28;
        doc.rect(PAGE_MARGIN, rowY, contentWidth, rowHeight).stroke('#E5E7EB');
        doc.font('Helvetica').fontSize(10).fillColor('#222222');
        doc.text(planName, colDesc.x + 8, rowY + 9, { width: colDesc.width - 8 });
        doc.text('1', colQty.x, rowY + 9, { width: colQty.width, align: 'center' });
        doc.text(formatCurrency(amount), colAmount.x, rowY + 9, { width: colAmount.width - 8, align: 'right' });
 
        doc.y = rowY + rowHeight + 16;
 
        // ── Totals box ─────────────────────────────────────────────────────
        const totalsWidth = 220;
        const totalsX = doc.page.width - PAGE_MARGIN - totalsWidth;
        const totalRows = [['Subtotal', formatCurrency(amount)]];
        if (paid > 0) totalRows.push(['Amount Paid', `- ${formatCurrency(paid)}`]);
        totalRows.push([fee.status === 'WAIVED' ? 'Waived' : 'Balance Due', formatCurrency(fee.status === 'WAIVED' ? 0 : balance)]);
 
        let ty = doc.y;
        totalRows.forEach(([label, value], i) => {
            const isLast = i === totalRows.length - 1;
            if (isLast) {
                doc.rect(totalsX, ty, totalsWidth, 26).fill('#F5F6F8');
                doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND_COLOR);
            } else {
                doc.font('Helvetica').fontSize(10).fillColor('#444444');
            }
            doc.text(label, totalsX + 10, ty + (isLast ? 8 : 4), { width: totalsWidth * 0.5 });
            doc.text(value, totalsX + totalsWidth * 0.5, ty + (isLast ? 8 : 4), {
                width: totalsWidth * 0.5 - 10,
                align: 'right',
            });
            ty += isLast ? 26 : 18;
        });
        doc.y = ty + 24;
 
        // ── Notes / payment method ─────────────────────────────────────────
        if (fee.paymentMethod || fee.notes) {
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#999999').text('NOTES', PAGE_MARGIN, doc.y);
            doc.moveDown(0.3);
            if (fee.paymentMethod) {
                doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Payment method: ${fee.paymentMethod}`);
            }
            if (fee.notes) {
                doc.font('Helvetica').fontSize(9).fillColor('#555555').text(fee.notes, { width: contentWidth });
            }
            doc.moveDown(1);
        }
 
        // ── Footer ──────────────────────────────────────────────────────────
        doc
            .font('Helvetica')
            .fontSize(8)
            .fillColor('#AAAAAA')
            .text('Thank you for being a Club Fitness member. This is a system-generated invoice.', PAGE_MARGIN, doc.page.height - 50, {
                width: contentWidth,
                align: 'center',
            });
 
        doc.end();
    } catch (err) {
        next(err);
    }
});

export default { generateFeeInvoicePdf };
// ============================================================================
// Shared PDFKit layout primitives for branded, paginated report exports.
// Any report controller (sales, fees, attendance, ...) can import these
// instead of re-implementing table/card/header drawing per-report.
// ============================================================================

export const PAGE_MARGIN = 40;
export const BRAND_COLOR = '#C41E2D';

export function contentWidth(doc) {
    return doc.page.width - PAGE_MARGIN * 2;
}

export function formatCurrency(value) {
    return `Rs. ${Number(value || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}

// Turns { flex } columns into concrete pixel widths that always sum exactly
// to the available content width (last column absorbs any rounding).
function resolveColumnWidths(doc, columns) {
    const totalFlex = columns.reduce((s, c) => s + c.flex, 0);
    const width = contentWidth(doc);
    let used = 0;
    return columns.map((c, i) => {
        if (i === columns.length - 1) {
            return { ...c, width: width - used };
        }
        const w = Math.floor((c.flex / totalFlex) * width);
        used += w;
        return { ...c, width: w };
    });
}

export function drawRunningHeader(doc, title) {
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

export function drawSectionTitle(doc, text) {
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
export function drawTable(doc, { columns: rawColumns, rows, runningHeaderTitle }) {
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

// cards: [{ label, value, change, positive, accent }]
export function drawKpiCards(doc, cards) {
    const gap = 14;
    const cardWidth = (contentWidth(doc) - gap) / 2;
    const cardHeight = 62;

    cards.forEach((card, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = PAGE_MARGIN + col * (cardWidth + gap);
        const y = doc.y + row * (cardHeight + gap);

        doc.roundedRect(x, y, cardWidth, cardHeight, 6).fillAndStroke('#FAFAFA', '#E5E7EB');
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

        if (card.change) {
            doc
                .font('Helvetica-Bold')
                .fontSize(9)
                .fillColor(card.positive ? '#2E7D32' : '#C41E2D')
                .text(card.change, x + 16, y + 44, { width: cardWidth - 30, lineBreak: false });
        }
    });

    const rowsUsed = Math.ceil(cards.length / 2);
    doc.y = doc.y + rowsUsed * (cardHeight + gap);
}

export function drawTitleBand(doc, { title, subtitle }) {
    doc.rect(0, 0, doc.page.width, 90).fill(BRAND_COLOR);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text(title, PAGE_MARGIN, 28);
    doc.font('Helvetica').fontSize(10).fillColor('#FDECEC').text(subtitle, PAGE_MARGIN, 56);
    doc.y = 112;
}

export function addPageNumbers(doc) {
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
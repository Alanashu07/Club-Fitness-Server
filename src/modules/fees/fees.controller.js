import PDFDocument from 'pdfkit';
import dateUtil from '../../utils/date.js';
import prisma from '../../config/db.js';
import { sendReminderNotification } from '../../utils/notifications.js';
import {
    PAGE_MARGIN,
    formatCurrency,
    drawTitleBand,
    drawSectionTitle,
    drawKpiCards,
    drawTable,
    addPageNumbers,
} from '../../utils/pdf-report-kit.js';

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const FEE_STATUS_SORT_ORDER = { overdue: 0, pending: 1, partial: 2, paid: 3, waived: 4 };

// ── DB enum (PENDING | OVERDUE | PAID | PARTIAL | WAIVED) -> UI status ─────
const mapFeeStatus = function (status) {
    return String(status || 'PENDING').toLowerCase();
};

const mapPaymentMethod = function (method) {
    if (!method) return null;
    const map = { CASH: 'cash', UPI: 'upi', BANK_TRANSFER: 'bankTransfer', OTHER: 'other' };
    return map[method] || 'other';
};

const toDbPaymentMethod = function (method) {
    const map = { cash: 'CASH', upi: 'UPI', bankTransfer: 'BANK_TRANSFER', other: 'OTHER' };
    return map[method] || 'OTHER';
};

// ── whole days between today and a past due date (0 if not overdue) ───────
const overdueDaysFor = function (dueDate, status) {
    if (status !== 'OVERDUE') return 0;
    const target = new Date(dueDate);
    target.setHours(0, 0, 0, 0);
    const diffMs = dateUtil.startOfToday().getTime() - target.getTime();
    return Math.max(0, Math.round(diffMs / 86400000));
};

const serializeFee = function (fee) {
    return {
        id: fee.id,
        memberId: fee.memberId,
        memberName: fee.member?.name || 'Unknown',
        memberPhone: fee.member?.phone || null,
        memberEmail: fee.member?.email || null,
        plan: fee.plan?.name || fee.planNameSnapshot || 'No Plan',
        planId: fee.planId || null,
        amount: Number(fee.amount),
        paidAmount: fee.paidAmount != null ? Number(fee.paidAmount) : null,
        status: mapFeeStatus(fee.status),
        dueDate: fee.dueDate,
        paidDate: fee.paidDate,
        paymentMethod: mapPaymentMethod(fee.paymentMethod),
        receiptUrl: fee.receiptUrl || null,
        notes: fee.notes || null,
        overdueDays: overdueDaysFor(fee.dueDate, fee.status),
        createdAt: fee.createdAt,
        updatedAt: fee.updatedAt,
    };
};

const FEE_SELECT = {
    id: true,
    memberId: true,
    planId: true,
    amount: true,
    paidAmount: true,
    status: true,
    dueDate: true,
    paidDate: true,
    paymentMethod: true,
    receiptImageUrl: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
    member: { select: { id: true, name: true, phone: true, email: true } },
    plan: { select: { id: true, name: true } },
};

// ── GET /api/admin/fees ──────────────────────────────────────────────────────
// Query params:
//   search     — matches member name, phone, or invoice id (case-insensitive)
//   status     — All | Pending | Overdue | Paid | Partial | Waived (default All)
//   memberId   — filter to one member
//   planId     — filter to one membership plan
//   sortBy     — dueDate | amount | name | overdueDays (default dueDate)
//   page, limit — pagination (default page=1, limit=20)
const listFees = asyncHandler(async (req, res) => {
    const {
        search = '',
        status = 'All',
        memberId,
        planId,
        sortBy = 'dueDate',
        page = '1',
        limit = '20',
    } = req.query;

    const where = {};

    if (status && status !== 'All') {
        where.status = status.toUpperCase();
    }
    if (memberId) {
        where.memberId = memberId;
    }
    if (planId) {
        where.planId = planId;
    }
    if (search.trim()) {
        where.OR = [
            { id: { contains: search } },
            { member: { name: { contains: search, mode: 'insensitive' } } },
            { member: { phone: { contains: search } } },
            { member: { id: { contains: search } } },
        ];
    }

    // Fetched in full (not paginated at the DB level) because overdueDays is
    // computed, not stored, and sorting by it needs the value resolved first.
    // Fine for gym-scale fee volumes; revisit with a stored `overdueDays`
    // column or a cron-updated status if this ever needs to scale up.
    const rows = await prisma.feeRecord.findMany({
        where,
        select: FEE_SELECT,
        orderBy: { dueDate: 'asc' },
    });

    let fees = rows.map(serializeFee);

    switch (sortBy) {
        case 'amount':
            fees.sort((a, b) => b.amount - a.amount);
            break;
        case 'name':
            fees.sort((a, b) => a.memberName.localeCompare(b.memberName));
            break;
        case 'overdueDays':
            fees.sort((a, b) => b.overdueDays - a.overdueDays);
            break;
        default:
            fees.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    }

    // secondary tie-break so overdue/pending naturally float up within a tab
    fees.sort((a, b) => {
        if (sortBy !== 'dueDate') return 0;
        return FEE_STATUS_SORT_ORDER[a.status] - FEE_STATUS_SORT_ORDER[b.status];
    });

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const total = fees.length;
    const start = (pageNum - 1) * limitNum;
    const paged = fees.slice(start, start + limitNum);

    res.json({
        fees: paged,
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
        counts: {
            all: rows.length,
            pending: fees.filter((f) => f.status === 'pending').length,
            overdue: fees.filter((f) => f.status === 'overdue').length,
            paid: fees.filter((f) => f.status === 'paid').length,
            partial: fees.filter((f) => f.status === 'partial').length,
            waived: fees.filter((f) => f.status === 'waived').length,
        },
    });
});

// ── GET /api/admin/fees/summary ─────────────────────────────────────────────
// Powers the revenue overview card: collected vs outstanding, progress, etc.
const getFeeSummary = asyncHandler(async (req, res) => {
    const rows = await prisma.feeRecord.findMany({ select: FEE_SELECT });
    const fees = rows.map(serializeFee);

    const totalCollected = fees
        .filter((f) => f.status === 'paid')
        .reduce((sum, f) => sum + (f.paidAmount || f.amount), 0);

    const totalOutstanding = fees
        .filter((f) => ['overdue', 'pending', 'partial'].includes(f.status))
        .reduce((sum, f) => sum + (f.amount - (f.paidAmount || 0)), 0);

    const totalPartialPaid = fees
        .filter((f) => f.status === 'partial')
        .reduce((sum, f) => sum + (f.paidAmount || 0), 0);

    const total = totalCollected + totalOutstanding;

    res.json({
        totalCollected,
        totalOutstanding,
        totalPartialPaid,
        collectedProgress: total > 0 ? Number((totalCollected / total).toFixed(4)) : 0,
        counts: {
            total: fees.length,
            pending: fees.filter((f) => f.status === 'pending').length,
            overdue: fees.filter((f) => f.status === 'overdue').length,
            paid: fees.filter((f) => f.status === 'paid').length,
            partial: fees.filter((f) => f.status === 'partial').length,
            waived: fees.filter((f) => f.status === 'waived').length,
        },
    });
});

// ── GET /api/admin/fees/:id ─────────────────────────────────────────────────
const getFeeById = asyncHandler(async (req, res) => {
    const fee = await prisma.feeRecord.findUnique({ where: { id: req.params.id }, select: FEE_SELECT });
    if (!fee) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }
    res.json({ fee: serializeFee(fee) });
});

// ── POST /api/admin/fees ─────────────────────────────────────────────────────
// body: memberId, planId, amount, dueDate, status?, notes?
const createFee = asyncHandler(async (req, res) => {
    const { memberId, planId, amount, dueDate, status = 'PENDING', notes } = req.body;

    const member = await prisma.user.findFirst({ where: { id: memberId, role: 'MEMBER' }, select: { id: true } });
    if (!member) {
        const failure = { title: 'Member not found', message: 'The selected member does not exist.', code: 400 };
        return res.status(400).json({ error: 'Member not found', code: 'INVALID_MEMBER', failure });
    }

    let plan = null;
    if (planId) {
        plan = await prisma.membershipPlan.findUnique({ where: { id: planId } });
        if (!plan) {
            const failure = { title: 'Invalid membership plan', message: 'The selected plan does not exist.', code: 400 };
            return res.status(400).json({ error: 'Plan not found', code: 'INVALID_PLAN', failure });
        }
    }

    const fee = await prisma.feeRecord.create({
        data: {
            memberId,
            planId: plan?.id || null,
            planNameSnapshot: plan?.name || null,
            amount,
            status: status.toUpperCase(),
            dueDate: new Date(dueDate),
            notes: notes || null,
        },
        select: FEE_SELECT,
    });

    res.status(201).json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id ────────────────────────────────────────────────
// Generic edit: any subset of amount, dueDate, planId, notes
const updateFee = asyncHandler(async (req, res) => {
    const { amount, dueDate, planId, notes } = req.body;
    const id = req.params.id;

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }

    const data = {};
    if (amount !== undefined) data.amount = amount;
    if (dueDate !== undefined) data.dueDate = new Date(dueDate);
    if (notes !== undefined) data.notes = notes;
    if (planId !== undefined) {
        const plan = await prisma.membershipPlan.findUnique({ where: { id: planId } });
        if (!plan) {
            const failure = { title: 'Invalid membership plan', message: 'The selected plan does not exist.', code: 400 };
            return res.status(400).json({ error: 'Plan not found', code: 'INVALID_PLAN', failure });
        }
        data.planId = plan.id;
        data.planNameSnapshot = plan.name;
    }

    const fee = await prisma.feeRecord.update({ where: { id }, data, select: FEE_SELECT });
    res.json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id/approve ────────────────────────────────────────
// Approves a member-submitted payment claim (status PENDING -> PAID)
const approveFee = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }
    if (existing.status !== 'PENDING') {
        const failure = { title: 'Cannot approve', message: 'Only pending-review invoices can be approved.', code: 409 };
        return res.status(409).json({ error: 'Fee is not pending review', code: 'INVALID_STATE', failure });
    }

    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status: 'PAID',
            paidAmount: existing.amount,
            paidDate: new Date(),
        },
        select: FEE_SELECT,
    });

    res.json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id/reject ─────────────────────────────────────────
// body: reason?
const rejectFee = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { reason } = req.body;

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }
    if (existing.status !== 'PENDING') {
        const failure = { title: 'Cannot reject', message: 'Only pending-review invoices can be rejected.', code: 409 };
        return res.status(409).json({ error: 'Fee is not pending review', code: 'INVALID_STATE', failure });
    }

    const isPastDue = new Date(existing.dueDate).getTime() < dateUtil.startOfToday().getTime();
    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status: isPastDue ? 'OVERDUE' : 'PENDING',
            receiptUrl: null,
            notes: reason ? `Payment rejected: ${reason}` : existing.notes,
        },
        select: FEE_SELECT,
    });

    res.json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id/mark-paid ──────────────────────────────────────
// body: amountReceived, method (cash|upi|bankTransfer|other), notes?
const markFeePaid = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { amountReceived, method, notes } = req.body;

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }

    const received = Number(amountReceived);
    if (!received || received <= 0) {
        const failure = { title: 'Invalid amount', message: 'Amount received must be greater than zero.', code: 400 };
        return res.status(400).json({ error: 'Invalid amountReceived', code: 'INVALID_AMOUNT', failure });
    }

    const status = received >= Number(existing.amount) ? 'PAID' : 'PARTIAL';

    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status,
            paidAmount: received,
            paidDate: new Date(),
            paymentMethod: toDbPaymentMethod(method),
            notes: notes || existing.notes,
        },
        select: FEE_SELECT,
    });

    res.json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id/waive ──────────────────────────────────────────
// body: reason?
const waiveFee = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { reason } = req.body;

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }

    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status: 'WAIVED',
            notes: reason || existing.notes,
        },
        select: FEE_SELECT,
    });

    res.json({ fee: serializeFee(fee) });
});

// ── POST /api/admin/fees/:id/remind ──────────────────────────────────────────
// body: channels — array subset of ['push', 'whatsapp', 'sms']
const sendFeeReminder = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { channels = ['push'] } = req.body;

    const fee = await prisma.feeRecord.findUnique({ where: { id }, select: FEE_SELECT });
    if (!fee) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }

    const serialized = serializeFee(fee);
    const message = `Hi ${serialized.memberName.split(' ')[0]}, your ${serialized.plan} fee of ₹${serialized.amount} is ${
        serialized.overdueDays > 0 ? `${serialized.overdueDays} days overdue` : 'due soon'
    }. Please pay at the earliest.`;

    const results = await sendReminderNotification({
        memberId: fee.memberId,
        channels,
        message,
    });

    res.json({ sent: true, channels, results });
});

// ── POST /api/admin/fees/:id/receipt ─────────────────────────────────────────
// body: receiptUrl — set after the file has been uploaded via your storage layer
const attachReceipt = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { receiptUrl } = req.body;

    if (!receiptUrl) {
        const failure = { title: 'Missing receipt', message: 'A receiptUrl is required.', code: 400 };
        return res.status(400).json({ error: 'receiptUrl is required', code: 'MISSING_RECEIPT_URL', failure });
    }

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }

    const fee = await prisma.feeRecord.update({ where: { id }, data: { receiptUrl }, select: FEE_SELECT });
    res.json({ fee: serializeFee(fee) });
});

// ── DELETE /api/admin/fees/:id ───────────────────────────────────────────────
const deleteFee = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) {
        const failure = { title: 'Fee record not found', message: 'This invoice no longer exists.', code: 404 };
        return res.status(404).json({ error: 'Fee record not found', code: 'FEE_NOT_FOUND', failure });
    }
    await prisma.feeRecord.delete({ where: { id } });
    res.json({ message: 'Fee record deleted successfully!' });
});

// ── shared: fetch + filter + sort fees for the export (no pagination) ──────
async function buildFeeExportData({ search = '', status = 'All', memberId, planId, sortBy = 'dueDate' }) {
    const where = {};

    if (status && status !== 'All') {
        where.status = status.toUpperCase();
    }
    if (memberId) where.memberId = memberId;
    if (planId) where.planId = planId;
    if (search.trim()) {
        where.OR = [
            { id: { contains: search } },
            { member: { name: { contains: search, mode: 'insensitive' } } },
            { member: { phone: { contains: search } } },
            { member: { id: { contains: search } } },
        ];
    }

    const rows = await prisma.feeRecord.findMany({ where, select: FEE_SELECT });
    let fees = rows.map(serializeFee);

    switch (sortBy) {
        case 'amount':
            fees.sort((a, b) => b.amount - a.amount);
            break;
        case 'name':
            fees.sort((a, b) => a.memberName.localeCompare(b.memberName));
            break;
        case 'overdueDays':
            fees.sort((a, b) => b.overdueDays - a.overdueDays);
            break;
        default:
            fees.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    }

    const totalCollected = fees
        .filter((f) => f.status === 'paid')
        .reduce((sum, f) => sum + (f.paidAmount || f.amount), 0);
    const totalOutstanding = fees
        .filter((f) => ['overdue', 'pending', 'partial'].includes(f.status))
        .reduce((sum, f) => sum + (f.amount - (f.paidAmount || 0)), 0);
    const totalPartialPaid = fees
        .filter((f) => f.status === 'partial')
        .reduce((sum, f) => sum + (f.paidAmount || 0), 0);
    const overdueCount = fees.filter((f) => f.status === 'overdue').length;
    const total = totalCollected + totalOutstanding;

    return {
        fees,
        summary: {
            totalCollected,
            totalOutstanding,
            totalPartialPaid,
            overdueCount,
            collectedProgress: total > 0 ? totalCollected / total : 0,
        },
    };
}

// ── GET /api/admin/fees/export/pdf ───────────────────────────────────────────
// Query params mirror listFees's filters (search, status, memberId, planId,
// sortBy) but the export is never paginated — it always includes every
// matching record. Produces a branded, multi-page report: summary cards
// followed by the full fee record table.
const exportFeesPdf = asyncHandler(async (req, res) => {
    const { search, status, memberId, planId, sortBy } = req.query;
    const { fees, summary } = await buildFeeExportData({ search, status, memberId, planId, sortBy });

    const statusLabel = !status || status === 'All' ? 'All Statuses' : status;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="fee-report.pdf"');

    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    doc.pipe(res);

    drawTitleBand(doc, {
        title: 'Fee Report',
        subtitle: `${statusLabel}  ·  Generated ${new Date().toLocaleString('en-IN')}`,
    });

    drawSectionTitle(doc, 'Summary');
    drawKpiCards(doc, [
        {
            label: 'Collected',
            value: formatCurrency(summary.totalCollected),
            change: `${(summary.collectedProgress * 100).toFixed(0)}% of total billed`,
            positive: true,
            accent: '#2E7D32',
        },
        {
            label: 'Outstanding',
            value: formatCurrency(summary.totalOutstanding),
            change: `${summary.overdueCount} overdue invoices`,
            positive: false,
            accent: '#FFA000',
        },
        {
            label: 'Partially Paid',
            value: formatCurrency(summary.totalPartialPaid),
            change: `${fees.filter((f) => f.status === 'partial').length} partial invoices`,
            positive: true,
            accent: '#29B6F6',
        },
        {
            label: 'Total Records',
            value: String(fees.length),
            change: `${fees.filter((f) => f.status === 'waived').length} waived`,
            positive: true,
            accent: '#7B1FA2',
        },
    ]);

    drawSectionTitle(doc, `Fee Records (${fees.length})`);
    drawTable(doc, {
        runningHeaderTitle: 'Fee Report — Records (cont.)',
        columns: [
            { key: 'id', label: 'INVOICE', flex: 1.3, align: 'left' },
            { key: 'member', label: 'MEMBER', flex: 1.9, align: 'left' },
            { key: 'plan', label: 'PLAN', flex: 1.6, align: 'left' },
            { key: 'amount', label: 'AMOUNT', flex: 1.3, align: 'right' },
            { key: 'dueDate', label: 'DUE DATE', flex: 1.1, align: 'left' },
            { key: 'status', label: 'STATUS', flex: 1, align: 'center' },
        ],
        rows: fees.map((f) => ({
            id: f.id,
            member: f.memberName,
            plan: f.plan,
            amount: formatCurrency(f.paidAmount ?? f.amount),
            dueDate: f.dueDate ? new Date(f.dueDate).toISOString().slice(0, 10) : '-',
            status: f.status.toUpperCase(),
        })),
    });

    addPageNumbers(doc);
    doc.end();
});

export default {
    listFees,
    getFeeSummary,
    getFeeById,
    createFee,
    updateFee,
    approveFee,
    rejectFee,
    markFeePaid,
    waiveFee,
    sendFeeReminder,
    attachReceipt,
    deleteFee,
    exportFeesPdf,
};
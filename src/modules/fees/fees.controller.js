import PDFDocument from 'pdfkit';
import dateUtil from '../../utils/date.js';
import prisma from '../../config/db.js';
import { getFileUrl } from '../../config/multer.js';
import { sendReminderNotification } from '../../utils/notifications.js';
import offerService from '../offer/offer.service.js';
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

// ── constants ───────────────────────────────────────────────────────────────
const FEE_STATUS_SORT_ORDER = { overdue: 0, pending: 1, partial: 2, paid: 3, waived: 4 };
const VALID_DB_STATUSES = ['PENDING', 'OVERDUE', 'PAID', 'PARTIAL', 'WAIVED'];
// Same list the members API (renewMembership / createMember) validates against
const PAYMENT_METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER'];
const UI_TO_DB_METHOD = { cash: 'CASH', upi: 'UPI', bankTransfer: 'BANK_TRANSFER', other: 'OTHER' };
const DB_TO_UI_METHOD = { CASH: 'cash', UPI: 'upi', BANK_TRANSFER: 'bankTransfer', OTHER: 'other' };
const REMINDER_CHANNELS = ['push', 'whatsapp', 'sms'];
const SORT_KEYS = { duedate: 'dueDate', amount: 'amount', name: 'name', overduedays: 'overdueDays' };

// ── helpers ─────────────────────────────────────────────────────────────────
const failWith = (res, status, error, code, title, message) =>
    res.status(status).json({ error, code, failure: { title, message, code: status } });

const feeNotFound = (res) =>
    failWith(res, 404, 'Fee record not found', 'FEE_NOT_FOUND', 'Fee record not found', 'This invoice no longer exists.');

// Accepts DB values (CASH) or UI keys (bankTransfer). null = none, undefined = invalid.
const normalizePaymentMethod = (m) => {
    if (m === undefined || m === null || m === '') return null;
    if (PAYMENT_METHODS.includes(m)) return m;
    return UI_TO_DB_METHOD[m];
};

// "Due Date" / "due_date" / "dueDate" all resolve to dueDate
const normalizeSort = (s) => SORT_KEYS[String(s || '').replace(/[\s_-]/g, '').toLowerCase()] || 'dueDate';

const parseDate = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

const round2 = (n) => Math.round(n * 100) / 100;

// A PENDING invoice whose due date has passed is overdue even if no cron has
// flipped the DB status yet. This keeps the fee screen consistent with
// members' listMembers (which shows the latest fee as overdue/pending).
const effectiveStatus = (fee) => {
    if (fee.status === 'PENDING' && fee.dueDate && new Date(fee.dueDate) < dateUtil.startOfToday()) {
        return 'OVERDUE';
    }
    return fee.status;
};

const mapFeeStatus = (status) => String(status || 'PENDING').toLowerCase();

const mapPaymentMethod = (method) => (method ? DB_TO_UI_METHOD[method] || 'other' : null);

const overdueDaysFor = (dueDate, status) => {
    if (status !== 'OVERDUE') return 0;
    const target = new Date(dueDate);
    target.setHours(0, 0, 0, 0);
    const diffMs = dateUtil.startOfToday().getTime() - target.getTime();
    return Math.max(0, Math.round(diffMs / 86400000));
};

const FEE_SELECT = {
    id: true,
    memberId: true,
    planId: true,
    amount: true,
    discountAmount: true,
    paidAmount: true,
    status: true,
    dueDate: true,
    paidDate: true,
    paymentMethod: true,
    receiptImageUrl: true, // was `receiptUrl`, which is not the column members/renew writes to
    notes: true,
    periodStart: true,
    periodEnd: true,
    appliedAt: true,
    renewalGroupId: true,
    approvedById: true,
    approvedDate: true,
    createdAt: true,
    updatedAt: true,
    member: { select: { id: true, name: true, phone: true, email: true } },
    plan: { select: { id: true, name: true } },
};

const serializeFee = (fee) => {
    const eff = effectiveStatus(fee);
    const amount = Number(fee.amount);
    const paid = fee.paidAmount != null ? Number(fee.paidAmount) : null;
    const settled = eff === 'PAID' || eff === 'WAIVED';
    return {
        id: fee.id,
        memberId: fee.memberId,
        memberName: fee.member?.name || 'Unknown',
        memberPhone: fee.member?.phone || null,
        memberEmail: fee.member?.email || null,
        plan: fee.plan?.name || 'No Plan',
        planId: fee.planId || null,
        amount,
        discountAmount: fee.discountAmount != null ? Number(fee.discountAmount) : 0,
        paidAmount: paid,
        balance: settled ? 0 : Math.max(0, round2(amount - (paid || 0))),
        status: mapFeeStatus(eff),
        dueDate: fee.dueDate,
        paidDate: fee.paidDate,
        paymentMethod: mapPaymentMethod(fee.paymentMethod),
        receiptUrl: fee.receiptImageUrl || null,
        notes: fee.notes || null,
        overdueDays: overdueDaysFor(fee.dueDate, eff),
        // renewal info written by members' renewMembership / createMember
        isRenewal: fee.periodStart != null,
        periodStart: fee.periodStart,
        periodEnd: fee.periodEnd,
        applied: fee.appliedAt != null,
        renewalGroupId: fee.renewalGroupId || null,
        approvedById: fee.approvedById || null,
        approvedDate: fee.approvedDate || null,
        createdAt: fee.createdAt,
        updatedAt: fee.updatedAt,
    };
};

const buildWhere = ({ search = '', memberId, planId }) => {
    const where = {};
    if (memberId) where.memberId = memberId;
    if (planId) where.planId = planId;
    const q = String(search || '').trim();
    if (q) {
        where.OR = [
            { id: { contains: q } },
            { member: { name: { contains: q, mode: 'insensitive' } } },
            { member: { phone: { contains: q } } },
            { member: { id: { contains: q } } },
        ];
    }
    return where;
};

const sortFees = (fees, sortBy) => {
    switch (sortBy) {
        case 'amount':
            return fees.sort((a, b) => b.amount - a.amount);
        case 'name':
            return fees.sort((a, b) => a.memberName.localeCompare(b.memberName));
        case 'overdueDays':
            return fees.sort((a, b) => b.overdueDays - a.overdueDays);
        default:
            // overdue/pending float up, then by due date
            return fees.sort(
                (a, b) =>
                    (FEE_STATUS_SORT_ORDER[a.status] ?? 9) - (FEE_STATUS_SORT_ORDER[b.status] ?? 9) ||
                    new Date(a.dueDate) - new Date(b.dueDate)
            );
    }
};

const countsOf = (list) => ({
    total: list.length,
    all: list.length,
    pending: list.filter((f) => f.status === 'pending').length,
    overdue: list.filter((f) => f.status === 'overdue').length,
    paid: list.filter((f) => f.status === 'paid').length,
    partial: list.filter((f) => f.status === 'partial').length,
    waived: list.filter((f) => f.status === 'waived').length,
});

// collected counts any money received (incl. partial and partially-paid-then-waived);
// outstanding is what is still owed on open invoices.
const totalsOf = (fees) => {
    const totalCollected = fees.reduce(
        (sum, f) => sum + (f.paidAmount ?? (f.status === 'paid' ? f.amount : 0)),
        0
    );
    const totalOutstanding = fees
        .filter((f) => ['overdue', 'pending', 'partial'].includes(f.status))
        .reduce((sum, f) => sum + f.balance, 0);
    const totalPartialPaid = fees
        .filter((f) => f.status === 'partial')
        .reduce((sum, f) => sum + (f.paidAmount || 0), 0);
    const billed = totalCollected + totalOutstanding;
    return {
        totalCollected: round2(totalCollected),
        totalOutstanding: round2(totalOutstanding),
        totalPartialPaid: round2(totalPartialPaid),
        collectedProgress: billed > 0 ? Number((totalCollected / billed).toFixed(4)) : 0,
    };
};

// Fetch everything matching the non-status filters, then filter by status in
// memory: the "effective" status (pending past due => overdue) is computed.
async function loadFees({ search, status = 'All', memberId, planId, sortBy }) {
    const rows = await prisma.feeRecord.findMany({
        where: buildWhere({ search, memberId, planId }),
        select: FEE_SELECT,
    });
    const matching = rows.map(serializeFee);
    const wanted = String(status || 'All').toLowerCase();
    const fees = !wanted || wanted === 'all' ? [...matching] : matching.filter((f) => f.status === wanted);
    sortFees(fees, normalizeSort(sortBy));
    return { matching, fees };
}

const loadFee = (id) => prisma.feeRecord.findUnique({ where: { id }, select: FEE_SELECT });

// ── status buckets as DB filters ─────────────────────────────────────────────
// Mirrors effectiveStatus(): PENDING + past due => overdue.
const BUCKET_ORDER = ['overdue', 'pending', 'partial', 'paid', 'waived'];

const bucketWheres = (today) => ({
    overdue: { OR: [{ status: 'OVERDUE' }, { status: 'PENDING', dueDate: { lt: today } }] },
    pending: { status: 'PENDING', dueDate: { gte: today } },
    partial: { status: 'PARTIAL' },
    paid: { status: 'PAID' },
    waived: { status: 'WAIVED' },
});

const DUE_ASC = [{ dueDate: 'asc' }, { id: 'asc' }]; // id = stable tiebreaker for paging

// Paginates in the database. The "sorted list" is a sequence of segments
// (each a where + orderBy + count); we skip whole segments before the page
// and only query the ones the page window overlaps.
async function loadFeesPage({ search, status = 'All', memberId, planId, sortBy, page, limit }) {
    const base = buildWhere({ search, memberId, planId });
    const today = dateUtil.startOfToday();
    const buckets = bucketWheres(today);
    const sort = normalizeSort(sortBy);
    const wanted = String(status || 'All').toLowerCase();
    const filtered = wanted !== 'all';

    // counts for ALL statuses (tab badges) under search/member/plan filters
    const bucketCounts = await Promise.all(
        BUCKET_ORDER.map((k) => prisma.feeRecord.count({ where: { AND: [base, buckets[k]] } }))
    );
    const c = Object.fromEntries(BUCKET_ORDER.map((k, i) => [k, bucketCounts[i]]));
    const all = bucketCounts.reduce((a, b) => a + b, 0);
    const counts = { total: all, all, ...c };

    // build segments
    let segments;
    if (filtered && !buckets[wanted]) {
        segments = []; // unknown status => empty, same as before
    } else if (sort === 'amount' || sort === 'name') {
        const orderBy =
            sort === 'amount'
                ? [{ amount: 'desc' }, { id: 'asc' }]
                : [{ member: { name: 'asc' } }, { id: 'asc' }];
        segments = [{ where: filtered ? buckets[wanted] : {}, orderBy, count: filtered ? c[wanted] : all }];
    } else if (sort === 'overdueDays') {
        // most overdue first (= oldest due date), everything else after (0 days)
        segments = filtered
            ? [{ where: buckets[wanted], orderBy: DUE_ASC, count: c[wanted] }]
            : [
                  { where: buckets.overdue, orderBy: DUE_ASC, count: c.overdue },
                  { where: { NOT: buckets.overdue }, orderBy: DUE_ASC, count: all - c.overdue },
              ];
    } else {
        // default: overdue → pending → partial → paid → waived, each by due date
        const keys = filtered ? [wanted] : BUCKET_ORDER;
        segments = keys.map((k) => ({ where: buckets[k], orderBy: DUE_ASC, count: c[k] }));
    }

    const total = segments.reduce((sum, s) => sum + s.count, 0);

    // fetch only the window [start, start + limit)
    let toSkip = (page - 1) * limit;
    let need = limit;
    const rows = [];
    for (const seg of segments) {
        if (need <= 0) break;
        if (toSkip >= seg.count) {
            toSkip -= seg.count;
            continue;
        }
        const chunk = await prisma.feeRecord.findMany({
            where: { AND: [base, seg.where] },
            orderBy: seg.orderBy,
            skip: toSkip,
            take: Math.min(need, seg.count - toSkip),
            select: FEE_SELECT,
        });
        rows.push(...chunk);
        need -= chunk.length;
        toSkip = 0;
    }

    return { fees: rows.map(serializeFee), total, counts };
}

// ── GET /api/admin/fees ──────────────────────────────────────────────────────
const listFees = asyncHandler(async (req, res) => {
    const { search = '', status = 'All', memberId, planId, sortBy = 'dueDate', page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const { fees, total, counts } = await loadFeesPage({
        search, status, memberId, planId, sortBy, page: pageNum, limit: limitNum,
    });

    res.json({
        fees,
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
        counts,
    });
});

// ── GET /api/admin/fees/summary ─────────────────────────────────────────────
// Optional ?memberId= for a per-member summary.
const getFeeSummary = asyncHandler(async (req, res) => {
    const { memberId } = req.query;
    const rows = await prisma.feeRecord.findMany({
        where: memberId ? { memberId } : {},
        select: FEE_SELECT,
    });
    const fees = rows.map(serializeFee);
    res.json({ ...totalsOf(fees), counts: countsOf(fees) });
});

// ── GET /api/v1/fees/:id ─────────────────────────────────────────────────
// Returns the invoice plus everything the detail screen needs:
//   fee          -> same shape as before (nothing else breaks)
//   membership   -> plan + billing period this invoice belongs to
//   relatedFees  -> every other invoice in the same renewalGroupId
//                   (the "pair": e.g. one PAID + one WAIVED/PENDING)
//   reminders    -> reminders sent for this invoice
//   approvedBy   -> staff who approved / marked paid / waived
//   offer        -> offer redemption tied to this invoice (if any)
//   memberHistory-> member's 5 most recent other invoices
const FEE_DETAIL_SELECT = {
    ...FEE_SELECT,
    submittedDate: true,
    plan: true, // full plan row instead of { id, name }
    approvedBy: { select: { id: true, name: true, role: true } },
    remindersSent: {
        orderBy: { sentAt: 'desc' },
        select: { id: true, channel: true, sentAt: true, automatic: true },
    },
    userOffer: true,
};

const plainPlan = (p) =>
    p ? { ...p, price: p.price != null ? Number(p.price) : null } : null;

const getFeeById = asyncHandler(async (req, res) => {
    const id = req.params.id;

    const fee = await prisma.feeRecord.findUnique({ where: { id }, select: FEE_DETAIL_SELECT });
    if (!fee) return feeNotFound(res);

    const [related, history] = await Promise.all([
        fee.renewalGroupId
            ? prisma.feeRecord.findMany({
                  where: { renewalGroupId: fee.renewalGroupId, id: { not: id } },
                  select: FEE_SELECT,
                  orderBy: { createdAt: 'asc' },
              })
            : Promise.resolve([]),
        prisma.feeRecord.findMany({
            where: { memberId: fee.memberId, id: { not: id } },
            select: FEE_SELECT,
            orderBy: { createdAt: 'desc' },
            take: 5,
        }),
    ]);

    const base = serializeFee(fee);
    const today = dateUtil.startOfToday();
    const isCurrentPeriod =
        fee.periodStart && fee.periodEnd
            ? new Date(fee.periodStart) <= today && today <= new Date(fee.periodEnd)
            : false;

    res.json({
        fee: { ...base, submittedDate: fee.submittedDate },
        membership: {
            planId: fee.planId,
            plan: plainPlan(fee.plan),
            isRenewal: base.isRenewal,
            periodStart: fee.periodStart,
            periodEnd: fee.periodEnd,
            applied: base.applied,
            appliedAt: fee.appliedAt,
            isCurrentPeriod,
            renewalGroupId: fee.renewalGroupId || null,
        },
        relatedFees: related.map(serializeFee),
        reminders: fee.remindersSent,
        approvedBy: fee.approvedBy || null,
        offer: fee.userOffer || null,
        memberHistory: history.map(serializeFee),
    });
});

// ── POST /api/admin/fees ─────────────────────────────────────────────────────
// Standalone invoice (not a membership period; use POST /members/:id/renew for that).
// body: memberId, planId?, amount?, dueDate, status?, paidAmount?, paymentMethod?, notes?
// Status is derived from paidAmount the same way createMember does it.
const createFee = asyncHandler(async (req, res) => {
    const { memberId, planId, dueDate, status = 'PENDING', notes, paidAmount, paymentMethod } = req.body;

    const member = await prisma.user.findFirst({ where: { id: memberId, role: 'MEMBER' }, select: { id: true } });
    if (!member) {
        return failWith(res, 400, 'Member not found', 'INVALID_MEMBER', 'Member not found', 'The selected member does not exist.');
    }

    let plan = null;
    if (planId) {
        plan = await prisma.membershipPlan.findUnique({ where: { id: planId } });
        if (!plan) {
            return failWith(res, 400, 'Plan not found', 'INVALID_PLAN', 'Invalid membership plan', 'The selected plan does not exist.');
        }
    }

    const amount = req.body.amount !== undefined && req.body.amount !== '' ? Number(req.body.amount) : plan ? Number(plan.price) : NaN;
    if (Number.isNaN(amount) || amount <= 0) {
        return failWith(res, 400, 'Invalid amount', 'INVALID_AMOUNT', 'Invalid amount', 'amount must be greater than zero.');
    }

    const due = parseDate(dueDate);
    if (!due) {
        return failWith(res, 400, 'Invalid due date', 'INVALID_DUE_DATE', 'Invalid date', 'dueDate must be a valid date.');
    }

    const requested = String(status).toUpperCase();
    if (!VALID_DB_STATUSES.includes(requested)) {
        return failWith(res, 400, 'Invalid status', 'INVALID_STATUS', 'Invalid status', `status must be one of ${VALID_DB_STATUSES.join(', ')}.`);
    }

    const method = normalizePaymentMethod(paymentMethod);
    if (method === undefined) {
        return failWith(res, 400, 'Invalid payment method', 'INVALID_PAYMENT_METHOD', 'Invalid payment method', `paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}.`);
    }

    let paid = 0;
    if (paidAmount !== undefined && paidAmount !== '' && paidAmount !== null) paid = Number(paidAmount);
    else if (requested === 'PAID') paid = amount;
    if (Number.isNaN(paid) || paid < 0 || paid > amount) {
        return failWith(res, 400, 'Invalid paid amount', 'INVALID_PAID_AMOUNT', 'Invalid amount', 'paidAmount must be between 0 and the invoice amount.');
    }
    if (requested === 'PARTIAL' && !(paid > 0 && paid < amount)) {
        return failWith(res, 400, 'Invalid paid amount', 'INVALID_PAID_AMOUNT', 'Invalid amount', 'A partial invoice needs a paidAmount above 0 and below the amount.');
    }

    const now = new Date();
    const isAdmin = req.user?.role === 'ADMIN';
    const finalStatus = paid >= amount ? 'PAID' : paid > 0 ? 'PARTIAL' : requested === 'PAID' || requested === 'PARTIAL' ? 'PENDING' : requested;

    const fee = await prisma.feeRecord.create({
        data: {
            memberId,
            planId: plan?.id || null,
            planNameSnapshot: plan?.name || null,
            amount,
            paidAmount: paid > 0 ? paid : null,
            status: finalStatus,
            dueDate: due,
            paidDate: paid > 0 ? now : null,
            paymentMethod: paid > 0 ? method || 'CASH' : null,
            notes: notes || null,
            approvedById: (paid > 0 || finalStatus === 'WAIVED') && isAdmin ? req.user.id : null,
            approvedDate: paid > 0 || finalStatus === 'WAIVED' ? now : null,
            // standalone invoice: no membership period, never applied to the member
            appliedAt: now,
        },
        select: FEE_SELECT,
    });

    res.status(201).json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id ────────────────────────────────────────────────
// Any subset of amount, dueDate, planId, notes. If money was already received,
// status is re-derived so a lowered amount can't leave PARTIAL > amount.
const updateFee = asyncHandler(async (req, res) => {
    const { amount, dueDate, planId, notes } = req.body;
    const id = req.params.id;

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) return feeNotFound(res);

    const data = {};

    if (amount !== undefined) {
        const n = Number(amount);
        if (Number.isNaN(n) || n <= 0) {
            return failWith(res, 400, 'Invalid amount', 'INVALID_AMOUNT', 'Invalid amount', 'amount must be greater than zero.');
        }
        const paid = Number(existing.paidAmount || 0);
        if (paid > n) {
            return failWith(res, 409, 'Amount below paid', 'AMOUNT_BELOW_PAID', 'Cannot lower amount', `₹${paid} has already been received on this invoice.`);
        }
        data.amount = n;
        if (paid > 0 && ['PAID', 'PARTIAL'].includes(existing.status)) {
            data.status = paid >= n ? 'PAID' : 'PARTIAL';
        }
    }
    if (dueDate !== undefined) {
        const d = parseDate(dueDate);
        if (!d) return failWith(res, 400, 'Invalid due date', 'INVALID_DUE_DATE', 'Invalid date', 'dueDate must be a valid date.');
        data.dueDate = d;
    }
    if (notes !== undefined) data.notes = notes;
    if (planId !== undefined) {
        const plan = await prisma.membershipPlan.findUnique({ where: { id: planId } });
        if (!plan) {
            return failWith(res, 400, 'Plan not found', 'INVALID_PLAN', 'Invalid membership plan', 'The selected plan does not exist.');
        }
        data.planId = plan.id;
        data.planNameSnapshot = plan.name;
    }

    const fee = await prisma.feeRecord.update({ where: { id }, data, select: FEE_SELECT });
    res.json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id/approve ────────────────────────────────────────
// Approves a member-submitted payment claim (PENDING -> PAID).
const approveFee = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) return feeNotFound(res);
    if (existing.status !== 'PENDING') {
        return failWith(res, 409, 'Fee is not pending review', 'INVALID_STATE', 'Cannot approve', 'Only pending-review invoices can be approved.');
    }

    const now = new Date();
    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status: 'PAID',
            paidAmount: existing.amount,
            paidDate: now,
            paymentMethod: existing.paymentMethod || 'OTHER',
            approvedById: req.user?.id ?? null,
            approvedDate: now,
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
    if (!existing) return feeNotFound(res);
    if (existing.status !== 'PENDING') {
        return failWith(res, 409, 'Fee is not pending review', 'INVALID_STATE', 'Cannot reject', 'Only pending-review invoices can be rejected.');
    }

    const isPastDue = new Date(existing.dueDate).getTime() < dateUtil.startOfToday().getTime();
    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status: isPastDue ? 'OVERDUE' : 'PENDING',
            receiptImageUrl: null, // was `receiptUrl` (non-existent column)
            notes: reason ? `Payment rejected: ${reason}` : existing.notes,
        },
        select: FEE_SELECT,
    });

    res.json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id/mark-paid ──────────────────────────────────────
// body: amountReceived, method (cash|upi|bankTransfer|other or DB value), notes?
// amountReceived is ADDED to what was already paid (it used to overwrite it),
// so a second instalment on a PARTIAL invoice completes it correctly.
const markFeePaid = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { amountReceived, method, notes } = req.body;

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) return feeNotFound(res);
    if (existing.status === 'PAID' || existing.status === 'WAIVED') {
        return failWith(res, 409, 'Fee already settled', 'INVALID_STATE', 'Already settled', `This invoice is already ${existing.status.toLowerCase()}.`);
    }

    const received = Number(amountReceived);
    if (!received || received <= 0) {
        return failWith(res, 400, 'Invalid amountReceived', 'INVALID_AMOUNT', 'Invalid amount', 'Amount received must be greater than zero.');
    }

    const dbMethod = normalizePaymentMethod(method);
    if (dbMethod === undefined) {
        return failWith(res, 400, 'Invalid payment method', 'INVALID_PAYMENT_METHOD', 'Invalid payment method', `method must be one of ${PAYMENT_METHODS.join(', ')}.`);
    }

    const amount = Number(existing.amount);
    const previouslyPaid = Number(existing.paidAmount || 0);
    const balance = round2(amount - previouslyPaid);
    if (received > balance) {
        return failWith(res, 400, 'Amount exceeds balance', 'AMOUNT_EXCEEDS_BALANCE', 'Too much received', `Only ₹${balance} is outstanding on this invoice.`);
    }

    const newPaid = round2(previouslyPaid + received);
    const now = new Date();
    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status: newPaid >= amount ? 'PAID' : 'PARTIAL',
            paidAmount: newPaid,
            paidDate: now,
            paymentMethod: dbMethod || 'CASH',
            notes: notes || existing.notes,
            approvedById: req.user?.id ?? existing.approvedById,
            approvedDate: now,
        },
        select: FEE_SELECT,
    });

    res.json({ fee: serializeFee(fee) });
});

// ── PATCH /api/admin/fees/:id/waive ──────────────────────────────────────────
// body: reason?   Waives whatever is still owed; money already received is kept.
const waiveFee = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { reason } = req.body;

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) return feeNotFound(res);
    if (existing.status === 'PAID' || existing.status === 'WAIVED') {
        return failWith(res, 409, 'Fee already settled', 'INVALID_STATE', 'Cannot waive', `This invoice is already ${existing.status.toLowerCase()}.`);
    }

    const now = new Date();
    const fee = await prisma.feeRecord.update({
        where: { id },
        data: {
            status: 'WAIVED',
            notes: reason || existing.notes,
            approvedById: req.user?.id ?? null,
            approvedDate: now,
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

    const fee = await loadFee(id);
    if (!fee) return feeNotFound(res);

    if (!Array.isArray(channels) || !channels.length || channels.some((c) => !REMINDER_CHANNELS.includes(c))) {
        return failWith(res, 400, 'Invalid channels', 'INVALID_CHANNELS', 'Invalid channels', `channels must be a non-empty subset of ${REMINDER_CHANNELS.join(', ')}.`);
    }

    const s = serializeFee(fee);
    if (s.status === 'paid' || s.status === 'waived') {
        return failWith(res, 409, 'Nothing to remind', 'INVALID_STATE', 'Nothing to remind', 'This invoice is already settled.');
    }

    const message = `Hi ${s.memberName.split(' ')[0]}, your ${s.plan} fee of ₹${s.balance.toFixed(0)} is ${
        s.overdueDays > 0 ? `${s.overdueDays} days overdue` : 'due soon'
    }. Please pay at the earliest. — Club Fitness`;

    const results = await sendReminderNotification({ memberId: fee.memberId, channels, message });

    res.json({ sent: true, channels, results });
});

// ── POST /api/admin/fees/:id/receipt ─────────────────────────────────────────
// Multipart upload (field "receipt", same storage as renewMembership's
// 'receipts' folder) or JSON { receiptUrl }. Route needs the multer middleware.
const attachReceipt = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const receiptUrl = req.file ? getFileUrl('receipts', req.file.filename) : req.body?.receiptUrl;

    if (!receiptUrl) {
        return failWith(res, 400, 'receipt is required', 'MISSING_RECEIPT_URL', 'Missing receipt', 'Upload a receipt image or provide a receiptUrl.');
    }

    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) return feeNotFound(res);

    const fee = await prisma.feeRecord.update({
        where: { id },
        data: { receiptImageUrl: receiptUrl },
        select: FEE_SELECT,
    });
    res.json({ fee: serializeFee(fee) });
});

// ── DELETE /api/admin/fees/:id ───────────────────────────────────────────────
// Renewal records are protected: removing the latest renewal must go through
// DELETE /members/:id/renew/last so the member's plan/dates are rolled back.
// Any offer redemption tied to the invoice is released first (UserOffer holds
// a FK to the fee record and Offer.redemptionCount must be decremented).
const deleteFee = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.feeRecord.findUnique({ where: { id } });
    if (!existing) return feeNotFound(res);

    if (existing.periodStart) {
        const [latest, others] = await Promise.all([
            prisma.feeRecord.findFirst({
                where: { memberId: existing.memberId, periodStart: { not: null } },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
            }),
            prisma.feeRecord.count({ where: { memberId: existing.memberId, id: { not: id } } }),
        ]);
        if (latest?.id === id && others > 0) {
            return failWith(
                res, 409, 'Use renewal revert', 'USE_REVERT_RENEWAL', 'Cannot delete renewal',
                "This is the member's latest renewal. Use \"Revert last renewal\" so their membership is restored."
            );
        }
    }

    await prisma.$transaction(async (tx) => {
        await offerService.releaseRedemptions(tx, [id]);
        await tx.feeRecord.delete({ where: { id } });
    });

    res.json({ message: 'Fee record deleted successfully!' });
});

// ── GET /api/admin/fees/export/pdf ───────────────────────────────────────────
// IMPORTANT: register this route BEFORE GET /fees/:id or "export" is parsed as an id.
// Same filters as listFees (search, status, memberId, planId, sortBy); never paginated.
const exportFeesPdf = asyncHandler(async (req, res) => {
    const { search, status, memberId, planId, sortBy } = req.query;
    const { matching, fees } = await loadFees({ search, status, memberId, planId, sortBy });
    const summary = { ...totalsOf(fees), overdueCount: fees.filter((f) => f.status === 'overdue').length };
    const counts = countsOf(matching);

    const statusLabel = !status || String(status).toLowerCase() === 'all' ? 'All Statuses' : status;

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
            change: `${counts.waived} waived overall`,
            positive: true,
            accent: '#7B1FA2',
        },
    ]);

    drawSectionTitle(doc, `Fee Records (${fees.length})`);
    drawTable(doc, {
        runningHeaderTitle: 'Fee Report — Records (cont.)',
        columns: [
            { key: 'id', label: 'INVOICE', flex: 1.2, align: 'left' },
            { key: 'member', label: 'MEMBER', flex: 1.6, align: 'left' },
            { key: 'plan', label: 'PLAN', flex: 1.4, align: 'left' },
            { key: 'amount', label: 'AMOUNT', flex: 1.1, align: 'right' },
            { key: 'balance', label: 'BALANCE', flex: 1.1, align: 'right' },
            { key: 'dueDate', label: 'DUE DATE', flex: 1.1, align: 'left' },
            { key: 'status', label: 'STATUS', flex: 1, align: 'center' },
        ],
        rows: fees.map((f) => ({
            id: f.id,
            member: f.memberName,
            plan: f.plan,
            amount: formatCurrency(f.amount), // was paidAmount ?? amount, which mixed two meanings in one column
            balance: formatCurrency(f.balance),
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
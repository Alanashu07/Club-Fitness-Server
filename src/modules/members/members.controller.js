import dateUtil from '../../utils/date.js';
import prisma from '../../config/db.js';
import { hashPassword } from '../../utils/password.js';
import {
    sendWelcomeEmail,
    sendRenewalEmail,
    sendExpiryReminderEmail,
    sendExpiredNoticeEmail,
} from '../../utils/mailer.js';
import checkinService from '../device/checkin.service.js';
import commandQueue from '../device/device-command-queue.service.js';
import env from '../../config/env.js';
import { fail } from '../../validators/error.handler.js';
import { getFileUrl, deleteProfileImage } from '../../config/multer.js';
import { randomUUID } from 'crypto';
import offerService, { OfferError } from '../offer/offer.service.js';

const FEE_STATUS_SORT_ORDER = { overdue: 0, pending: 1, paid: 2 };
const WEEKLY_OFF_DAYS = [0];
const MAX_STREAK_LOOKBACK_DAYS = 3650;
const buildOffDayChecker = function (holidays) {
    const holidaySet = new Set(holidays.map((h) => new Date(h.date).toDateString()));
    return (d) => WEEKLY_OFF_DAYS.includes(d.getDay()) || holidaySet.has(d.toDateString());
};

const fetchHolidays = (from, to) =>
    prisma.holiday.findMany({
        where: { date: { gte: from, lte: to } },
        select: { date: true },
    });

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const tryResolveOffer = async (req, res, args) => {
    try {
        return await offerService.resolveOffer(prisma, args);
    } catch (err) {
        if (err instanceof OfferError) {
            fail(req, res, err.status, err.error, err.code, err.title, err.message);
            return undefined;
        }
        throw err;
    }
};

const getNextDevicePin = async function () {
    const result = await prisma.user.aggregate({ _max: { devicePin: true } });
    return (result._max.devicePin || 0) + 1;
};

// ── streak: consecutive days of attendance ending today (or yesterday) ─────
// Consecutive attended days ending today. Off days (weekly off / holidays):
//  - attended      -> counted in the streak
//  - not attended  -> skipped, streak continues
// Today gets a grace: not having checked in yet doesn't break the streak.
const computeStreak = function (dateStrSet, today, isOffDay = () => false) {
    let cursor = new Date(today);
    let streak = 0;

    for (let i = 0; i < MAX_STREAK_LOOKBACK_DAYS; i++) {
        if (dateStrSet.has(cursor.toDateString())) {
            streak++;
        } else if (i > 0 && !isOffDay(cursor)) {
            break; // missed an open day
        }
        cursor = dateUtil.subDays(cursor, 1);
    }
    return streak;
};

// ── collapse the 5-value FeeStatus enum down to the 3 buckets the UI cares about ──
const mapFeeStatus = function (status) {
    if (!status) return 'paid'; // no fee record yet — nothing owed
    if (status === 'PAID' || status === 'WAIVED') return 'paid';
    if (status === 'OVERDUE') return 'overdue';
    return 'pending'; // PENDING, PARTIAL
};

// ── whole days between today and a future/past date (negative if past) ────
const daysUntil = function (date) {
    if (!date) return 0;
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    const diffMs = target.getTime() - dateUtil.startOfToday().getTime();
    return Math.round(diffMs / 86400000);
};

const MEMBER_SELECT = {
    id: true,
    name: true,
    phone: true,
    email: true,
    status: true,
    profileImageUrl: true,
    membershipStart: true,
    membershipEnd: true,
    membershipPlan: { select: { id: true, name: true } },
    assignedTrainer: { select: { id: true, name: true } },
};

const FEE_SORT_RANK = FEE_STATUS_SORT_ORDER; // existing map

// ── helpers (all scoped to a given list of member ids) ──────────────────────

// Latest fee per member. `distinct` + orderBy keeps the newest row per member.
async function latestFeesFor(memberIds) {
    if (!memberIds.length) return new Map();
    const rows = await prisma.feeRecord.findMany({
        where: { memberId: { in: memberIds } },
        distinct: ['memberId'],
        orderBy: [{ memberId: 'asc' }, { createdAt: 'desc' }],
        select: { memberId: true, status: true, amount: true, id: true },
    });
    return new Map(rows.map((r) => [r.memberId, r]));
}

async function attendanceDaysFor(memberIds, windowStart) {
    const byMember = new Map(); // memberId -> Set<dateString>
    if (!memberIds.length) return byMember;
    const rows = await prisma.attendance.findMany({
        where: { memberId: { in: memberIds }, checkInAt: { gte: windowStart } },
        select: { memberId: true, checkInAt: true },
    });
    for (const row of rows) {
        const set = byMember.get(row.memberId) || new Set();
        set.add(new Date(row.checkInAt).toDateString());
        byMember.set(row.memberId, set);
    }
    return byMember;
}

// Members whose LATEST fee is OVERDUE. One indexed pass in SQL, returns ids only.
// Table/column names assume Prisma defaults; adjust if you use @@map.
async function overdueMemberIds() {
    const rows = await prisma.$queryRaw`
        SELECT f."memberId"
        FROM (
            SELECT DISTINCT ON ("memberId") "memberId", status
            FROM "FeeRecord"
            ORDER BY "memberId", "createdAt" DESC
        ) f
        JOIN "User" u ON u.id = f."memberId"
        WHERE f.status = 'OVERDUE' AND u.role = 'MEMBER'
    `;
    return rows.map((r) => r.memberId);
}

// Global summary. Never affected by search/status/plan/trainer filters or paging.
async function memberSummary(overdueIds) {
    const grouped = await prisma.user.groupBy({
        by: ['status'],
        where: { role: 'MEMBER' },
        _count: { _all: true },
    });
    const countOf = (s) => grouped.find((g) => g.status === s)?._count._all || 0;
    return {
        total: grouped.reduce((sum, g) => sum + g._count._all, 0),
        active: countOf('ACTIVE'),
        expired: countOf('EXPIRED'),
        overdue: overdueIds.length,
    };
}

// ── GET /api/admin/members ───────────────────────────────────────────────────
const listMembers = asyncHandler(async (req, res) => {
    const {
        search = '',
        status = 'All',
        planId,
        trainerId,
        checkedInToday,
        overdueOnly,
        sortBy = 'name',
        page = '1',
        limit = '20',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const today = dateUtil.startOfToday();
    const windowStart = dateUtil.subDays(today, 90);

    // ── 1. Filters (everything pushed into the DB query) ────────────────────
    const where = { role: 'MEMBER' };

    if (status && status !== 'All') where.status = status;
    if (planId) where.membershipPlanId = planId;
    if (trainerId) where.assignedTrainerId = trainerId === 'unassigned' ? null : trainerId;
    if (search.trim()) {
        where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            { email: { contains: search, mode: 'insensitive' } },
            { id: { contains: search } },
        ];
    }

    // Computed filters resolve to id lists (small, bounded sets), then become `id IN (...)`
    const overdueIds = await overdueMemberIds(); // also feeds the global summary
    let idLimit = null; // null = no restriction

    if (overdueOnly === 'true') idLimit = overdueIds;

    if (checkedInToday === 'true') {
        const rows = await prisma.attendance.findMany({
            where: { checkInAt: { gte: today } },
            distinct: ['memberId'],
            select: { memberId: true },
        });
        const todayIds = rows.map((r) => r.memberId);
        idLimit = idLimit ? idLimit.filter((id) => todayIds.includes(id)) : todayIds;
    }
    if (idLimit) where.id = { in: idLimit };

    // ── 2. Fetch exactly one page of members ────────────────────────────────
    const total = await prisma.user.count({ where });
    let pageUsers;

    if (sortBy === 'streak' || sortBy === 'feeStatus') {
        // Computed sort keys can't be expressed in the query. Resolve them for
        // ids only (no full rows), sort, slice, then load just the page rows.
        const candidates = await prisma.user.findMany({
            where,
            select: { id: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }], // stable tiebreak
        });
        const candidateIds = candidates.map((c) => c.id);

        let rank;
        if (sortBy === 'streak') {
            const [days, holidays] = await Promise.all([
                attendanceDaysFor(candidateIds, windowStart),
                fetchHolidays(windowStart, today),
            ]);
            const isOffDay = buildOffDayChecker(holidays);
            rank = new Map(
                candidateIds.map((id) => [id, -computeStreak(days.get(id) || new Set(), today, isOffDay)])
            );
        } else {
            const fees = await latestFeesFor(candidateIds);
            rank = new Map(
                candidateIds.map((id) => [id, FEE_SORT_RANK[mapFeeStatus(fees.get(id)?.status)] ?? 9])
            );
        }

        const pageIds = [...candidateIds]
            .sort((a, b) => rank.get(a) - rank.get(b)) // stable: name order is kept for ties
            .slice((pageNum - 1) * limitNum, pageNum * limitNum);

        const rows = await prisma.user.findMany({ where: { id: { in: pageIds } }, select: MEMBER_SELECT });
        const byId = new Map(rows.map((u) => [u.id, u]));
        pageUsers = pageIds.map((id) => byId.get(id)).filter(Boolean);
    } else {
        // name / expiry: real DB-level pagination
        const orderBy =
            sortBy === 'expiry'
                ? [{ membershipEnd: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
                : [{ name: 'asc' }, { id: 'asc' }];

        pageUsers = await prisma.user.findMany({
            where,
            select: MEMBER_SELECT,
            orderBy,
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });
    }

    // ── 3. Computed fields, only for the members on this page ───────────────
    const pageIds = pageUsers.map((u) => u.id);
    const [todayRows, days, fees, holidays] = await Promise.all([
        pageIds.length
            ? prisma.attendance.findMany({
                where: { memberId: { in: pageIds }, checkInAt: { gte: today } },
                distinct: ['memberId'],
                select: { memberId: true },
            })
            : [],
        attendanceDaysFor(pageIds, windowStart),
        latestFeesFor(pageIds),
        fetchHolidays(windowStart, today),
    ]);
    const isOffDay = buildOffDayChecker(holidays);
    const checkedInSet = new Set(todayRows.map((a) => a.memberId));

    const members = pageUsers.map((u) => {
        const latestFee = fees.get(u.id);
        return {
            id: u.id,
            name: u.name,
            phone: u.phone,
            profileImageUrl: u.profileImageUrl,
            email: u.email,
            plan: u.membershipPlan?.name || 'No Plan',
            planId: u.membershipPlan?.id || null,
            status: u.status,
            joinDate: u.membershipStart,
            expiryDate: u.membershipEnd,
            daysLeft: daysUntil(u.membershipEnd),
            trainer: u.assignedTrainer?.name || 'Unassigned',
            trainerId: u.assignedTrainer?.id || null,
            checkedInToday: checkedInSet.has(u.id),
            workoutStreak: computeStreak(days.get(u.id) || new Set(), today, isOffDay),
            feeStatus: mapFeeStatus(latestFee?.status),
            lastFee: latestFee?.id,
            amount: Number(latestFee?.amount || 0),
        };
    });

    // ── 4. Response ─────────────────────────────────────────────────────────
    res.json({
        members,
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
        summary: await memberSummary(overdueIds), // all members, regardless of filters
    });
});

// ── POST /api/admin/members ─────────────────────────────────────────────────
const createMember = asyncHandler(async (req, res) => {
    const {
        name,
        phone,
        email,
        dateOfBirth,
        password,
        planId,
        trainerId,
        startDate,
        role = 'MEMBER',
        offerId, offerCode,                 // NEW: optional offer
        paidAmount, paymentMethod, notes,   // were referenced but missing
    } = req.body;

    // Only MEMBER requires a membership plan
    if (role === 'MEMBER' && !planId) {
        const failure = {
            title: "Membership plan required",
            message: "A membership plan is required for members.",
            code: 400,
        };

        return res.status(400).json({
            error: 'Membership plan required',
            code: 'MISSING_PLAN',
            failure,
        });
    }

    // Don't allow arbitrary roles
    const allowedRoles = ['MEMBER', 'STAFF', 'ADMIN'];

    if (!allowedRoles.includes(role)) {
        const failure = {
            title: "Invalid role",
            message: "The selected user role is not valid.",
            code: 400,
        };

        return res.status(400).json({
            error: 'Invalid role',
            code: 'INVALID_ROLE',
            failure,
        });
    }

    // Validate membership plan only for MEMBER
    let plan = null;

    if (role === 'MEMBER') {
        plan = await prisma.membershipPlan.findUnique({
            where: { id: planId },
        });

        if (!plan || !plan.isActive) {
            const failure = {
                title: "Invalid membership plan",
                message: "The selected membership plan is not available.",
                code: 400,
            };

            return res.status(400).json({
                error: 'Membership plan not found or inactive',
                code: 'INVALID_PLAN',
                failure,
            });
        }
    }

    // Check existing user
    const existing = await prisma.user.findFirst({
        where: {
            OR: [
                { phone },
                ...(email ? [{ email }] : []),
            ],
        },
        select: { id: true },
    });

    if (existing) {
        const failure = {
            title: "User already exists",
            message: "A user with this phone or email already exists.",
            code: 409,
        };

        return res.status(409).json({
            error: 'Phone or email already in use',
            code: 'USER_EXISTS',
            failure,
        });
    }

    // Trainer validation
    if (trainerId) {
        const trainer = await prisma.user.findFirst({
            where: {
                id: trainerId,
                role: { in: ['STAFF', 'ADMIN'] },
            },
            select: { id: true },
        });

        if (!trainer) {
            const failure = {
                title: "Invalid trainer",
                message: "The selected trainer is not available.",
                code: 400,
            };

            return res.status(400).json({
                error: 'Trainer not found',
                code: 'INVALID_TRAINER',
                failure,
            });
        }
    }

    let offerQuote = null;
    if (role === 'MEMBER' && (offerId || offerCode)) {
        offerQuote = await tryResolveOffer(req, res, { offerId, offerCode, plan, context: 'NEW_MEMBER' });
        if (!offerQuote) return; // failure already sent
    }
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
        return res.status(400).json({ error: 'Invalid payment method', code: 'INVALID_PAYMENT_METHOD' });
    }

    const membershipStart =
        role === 'MEMBER'
            ? (startDate ? new Date(startDate) : new Date())
            : null;

    if (
        membershipStart &&
        Number.isNaN(membershipStart.getTime())
    ) {
        return res.status(400).json({
            error: 'Invalid start date',
            code: 'INVALID_START_DATE',
        });
    }

    const membershipEnd =
        role === 'MEMBER'
            ? new Date(membershipStart)
            : null;

    if (membershipEnd) {
        membershipEnd.setDate(
            membershipEnd.getDate() + plan.durationDays
        );
    }

    // ── Initial fee record data (MEMBER only) ──
    const now = new Date();
    const isAdmin = req.user?.role === 'ADMIN';
    let feeData = null;

    if (role === 'MEMBER') {
        const price = offerQuote ? offerQuote.finalAmount : Number(plan.price);

        // Default kept: admin-created = fully paid, staff-created = unpaid.
        // An explicit paidAmount overrides it.
        const paid = paidAmount !== undefined && paidAmount !== '' ? Number(paidAmount) : (isAdmin ? price : 0);

        if (Number.isNaN(paid) || paid < 0) { /* unchanged 400 */ }

        feeData = {
            planId: plan.id,
            amount: price,                                   // net of discount
            discountAmount: offerQuote?.discountAmount ?? null,
            paidAmount: paid > 0 ? paid : null,
            status: paid >= price ? 'PAID' : paid > 0 ? 'PARTIAL' : 'PENDING',
            dueDate: membershipStart,
            paidDate: paid > 0 ? now : null,
            paymentMethod: paid > 0 ? (paymentMethod || 'CASH') : null, // was `'CASH' || null`
            notes: notes || null,
            approvedById: paid > 0 && isAdmin ? req.user.id : null,
            approvedDate: paid > 0 ? now : null,
            periodStart: membershipStart,
            periodEnd: membershipEnd,
            appliedAt: now,
        };
    }

    const initialStatus =
        role === 'MEMBER'
            ? (
                plan.name.toLowerCase().includes('trial')
                    ? 'TRIAL'
                    : 'ACTIVE'
            )
            : 'ACTIVE';

    const passwordHash = password
        ? await hashPassword(password)
        : null;

    const devicePin = await getNextDevicePin();
    const deviceSN = env.DEFAULT_DEVICE_SN || req.body.deviceSN;

    if (!deviceSN) {
        const failure = {
            title: "No device configured",
            message:
                "No biometric device SN was provided and DEFAULT_DEVICE_SN is not set.",
            code: 400,
        };

        return res.status(400).json({
            error: 'deviceSN required',
            code: 'MISSING_DEVICE_SN',
            failure,
        });
    }

    const profileImageUrl = req.file ? getFileUrl('profiles', req.file.filename) : null;

    const member = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
            data: {
                name, phone, email, passwordHash,
                dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                profileImageUrl,
                role, status: initialStatus,
                membershipPlanId: plan?.id ?? null,
                membershipStart, membershipEnd,
                devicePin, deviceSN,
                assignedTrainerId: trainerId || null,
                ...(feeData ? { feeRecords: { create: feeData } } : {}),
            },
            select: {
                id: true, name: true, phone: true, email: true, role: true, status: true,
                membershipStart: true, membershipEnd: true, profileImageUrl: true,
                membershipPlan: { select: { id: true, name: true } },
                assignedTrainer: { select: { id: true, name: true } },
                feeRecords: { select: { id: true } }, // NEW: need the fee id to link the offer
            },
        });

        if (offerQuote) {
            await offerService.recordRedemption(tx, {
                quote: offerQuote,
                userId: created.id,
                feeRecordId: created.feeRecords[0].id,
                source: 'NEW_MEMBER',
            });
        }
        return created;
    });

    res.status(201).json({
        member: {
            id: member.id,
            name: member.name,
            phone: member.phone,
            email: member.email,
            role: member.role,

            profileImageUrl: member.profileImageUrl,

            plan: member.membershipPlan?.name || 'No Plan',
            planId: member.membershipPlan?.id || null,

            status: member.status,

            joinDate: member.membershipStart,
            expiryDate: member.membershipEnd,

            daysLeft: member.membershipEnd
                ? daysUntil(member.membershipEnd)
                : null,

            trainer: member.assignedTrainer?.name || 'Unassigned',
            trainerId: member.assignedTrainer?.id || null,

            checkedInToday: false,
            workoutStreak: 0,

            feeStatus: feeData ? mapFeeStatus(feeData.status) : null,

            amount: plan ? Number(plan.price) : null,

            devicePin,
            feeStatus: feeData ? mapFeeStatus(feeData.status) : null,
            amount: feeData ? Number(feeData.amount) : null,       // net amount owed
            originalAmount: plan ? Number(plan.price) : null,
            discountAmount: feeData?.discountAmount ?? 0,
            offer: offerQuote ? { id: offerQuote.offer.id, name: offerQuote.offer.name } : null,
        },
    });

    if (member.email) {
        sendWelcomeEmail(member.email, {
            name: member.name,
            planName: plan?.name || null,
            memberId: member.id,
            planAmount: plan?.price || null,
        }).catch((err) =>
            logger.error('sendWelcomeEmail failed', {
                memberId: member.id,
                err,
            })
        );
    }

    commandQueue.queueCommand(
        deviceSN,
        `DATA UPDATE USERINFO PIN=${devicePin}\tName=${name}\tPri=0\tCard=0\tGrp=${env.DEFAULT_DEVICE_GROUP_ID}`
    ).catch((err) =>
        logger.error('queueCommand failed', {
            memberId: member.id,
            deviceSN,
            err,
        })
    );
});

const getAllTrainers = asyncHandler(async (req, res) => {
    const { title } = req.query;

    const where = { role: 'STAFF', status: 'ACTIVE' };
    if (title) {
        where.staffTitle = { equals: title, mode: 'insensitive' };
    }

    const trainers = await prisma.user.findMany({
        where,
        select: {
            id: true,
            name: true,
            staffTitle: true,
            profileImageUrl: true,
        },
        orderBy: { name: 'asc' },
    });

    res.json({ trainers });
});

const getAllMembershipPlans = asyncHandler(async (req, res) => {
    const { includeInactive, includeOffers = 'true', context } = req.query;

    const plans = await prisma.membershipPlan.findMany({
        where: includeInactive === 'true' ? {} : { isActive: true },
        select: {
            id: true, name: true, durationDays: true, price: true,
            description: true, features: true, isActive: true,
        },
        orderBy: { price: 'asc' },
    });

    const active = includeOffers === 'false' ? [] : await offerService.listActiveOffers(prisma, { context });

    res.json({
        plans: plans.map((p) => ({
            ...p,
            price: Number(p.price),
            offers: offerService.offersForPlan(active, p),
        })),
    });
});

const createMembershipPlan = asyncHandler(async (req, res) => {
    const { name, durationDays, price, description, features, isActive } = req.body;
    const plan = await prisma.membershipPlan.create({
        data: {
            name,
            durationDays,
            price,
            description,
            features,
            isActive,
        },
    });
    res.json({ plan });
});

const updateMembershipPlan = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { name, durationDays, price, description, features, isActive } = req.body;
    const plan = await prisma.membershipPlan.update({
        where: { id },
        data: {
            name,
            durationDays,
            price,
            description,
            features,
            isActive,
        },
    });
    res.json({ plan });
});

//Find users with membership plan. If exist return error alerting to change user plans first or make plan inactive instead. Otherwise delete it. 
const deleteMembershipPlan = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const plan = await prisma.membershipPlan.findUnique({ where: { id } });
    const usersWithPlan = plan ? await prisma.user.findMany({ where: { membershipPlanId: id } }) : [];
    if (!plan) {
        const failure = { title: "Plan not found", message: "The plan you are trying to delete does not exist.", code: 404 };
        return res.status(404).json({ error: 'No plan exists!', code: 'PLAN_NOT_FOUND', failure });
    }
    if (usersWithPlan && usersWithPlan.length > 0) {
        const failure = { title: "Plan in use", message: "The plan you are trying to delete is in use. You may find users with this plan and assign them to another plan. Or you can make the plan inactive instead.", code: 409 };
        return res.status(409).json({ error: 'Plan in use', code: 'PLAN_IN_USE', failure });
    }
    await prisma.membershipPlan.delete({ where: { id } });
    res.json({ message: 'Plan deleted Successfully!' });
});

const suspendMember = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const member = await prisma.user.findUnique({ where: { id } });
    if (!member || member.role !== 'MEMBER') {
        const failure = { title: 'Member not found', message: 'No member exists with this id.', code: 404 };
        return res.status(404).json({ error: 'Member not found', code: 'MEMBER_NOT_FOUND', failure });
    }
    await prisma.user.update({ where: { id }, data: { status: 'SUSPENDED', blocked: true } });
    if (member.deviceSN && member.devicePin) {
        await checkinService.blockUserSoft(member.deviceSN, member.devicePin);
    }
    res.json({ message: `Member ${member.name} suspended successfully!`, member });
});

// ── POST /api/v1/admin/members/:id/reactivate ───────────────────────────────
// Staff approves payment after a block (expired + grace exhausted). Restores
// status/expiry and re-authorizes on the device. If the member was ever
// hard-blocked (blockUserHard, not the default soft block), they'll need to
// re-enroll their face — this endpoint can't undo that.
const reactivateMember = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { newMembershipEnd, planId } = req.body;

    const member = await prisma.user.findUnique({ where: { id } });
    if (!member || member.role !== 'MEMBER') {
        const failure = { title: 'Member not found', message: 'No member exists with this id.', code: 404 };
        return res.status(404).json({ error: 'Member not found', code: 'MEMBER_NOT_FOUND', failure });
    }
    if (!member.devicePin || !member.deviceSN) {
        const failure = { title: 'Member not enrolled', message: 'This member has no device enrollment on file.', code: 400 };
        return res.status(400).json({ error: 'Member has no device enrollment', code: 'NOT_ENROLLED', failure });
    }

    const updated = await prisma.user.update({
        where: { id },
        data: {
            status: 'ACTIVE',
            blocked: false,
            graceEntriesUsed: 0,
            membershipEnd: newMembershipEnd ? new Date(newMembershipEnd) : member.membershipEnd,
            membershipPlanId: planId ? planId : member.membershipPlanId,
        },
        select: { id: true, name: true, membershipEnd: true, devicePin: true, deviceSN: true },
    });

    await checkinService.unblockUser(updated.deviceSN, updated.devicePin);

    res.json({
        member: updated,
        message: `Member ${updated.name} reactivated. If they were hard-blocked previously, they must re-enroll their face at the device.`,
    });
});

const getMemberDetails = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const member = await prisma.user.findUnique({ where: { id }, include: { membershipPlan: { select: { id: true, name: true, price: true, durationDays: true } } }, });
    if (!member || member.role !== 'MEMBER') {
        const failure = { title: 'Member not found', message: 'No member exists with this id.', code: 404 };
        return res.status(404).json({ error: 'Member not found', code: 'MEMBER_NOT_FOUND', failure });
    }

    const trainer = member.assignedTrainerId
        ? await prisma.user.findFirst({
            where: { id: member.assignedTrainerId },
            select: { id: true, name: true },
        })
        : null;

    const attendance = await prisma.attendance.findMany({
        where: { memberId: id },
        orderBy: { checkInAt: 'desc' }
    });

    const feeHistory = await prisma.feeRecord.findMany({
        where: { memberId: id },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: { name: true, id: true, price: true } } },
    });

    const attendanceDates = new Set(
        attendance.map((a) => new Date(a.checkInAt).toDateString())
    );
    const today = dateUtil.startOfToday();
    const oldest = attendance.length
        ? new Date(attendance[attendance.length - 1].checkInAt)
        : today;
    const holidays = await fetchHolidays(oldest, today);
    const isOffDay = buildOffDayChecker(holidays);

    const workoutStreak = computeStreak(attendanceDates, today, isOffDay);
    const checkedInToday = attendanceDates.has(today.toDateString());
    const offerRedemptions = await prisma.userOffer.findMany({
        where: { userId: id },
        orderBy: { redeemedAt: 'desc' },
        include: { offer: { select: { id: true, name: true, code: true } } },
    });
    res.json({
        member: {
            ...member,
            assignedTrainer: trainer?.name || 'Unassigned',
            workoutStreak,
            checkedInToday,
        }, attendance, feeHistory, offerRedemptions
    });
});

// ── PATCH /api/v1/admin/members/:id ─────────────────────────────────────────
// Body (all optional): name, phone, email, dateOfBirth, planId, trainerId, startDate
// membershipEnd is never accepted from the client. It is always computed as
// startDate + plan.durationDays.
const updateMember = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, dateOfBirth, planId, trainerId, startDate } = req.body;

    const fail = (code, error, errorCode, title, message) =>
        res.status(code).json({ error, code: errorCode, failure: { title, message, code } });

    const member = await prisma.user.findUnique({ where: { id } });
    if (!member || member.role !== 'MEMBER') {
        return fail(404, 'Member not found', 'MEMBER_NOT_FOUND', 'Member not found', 'No member exists with this id.');
    }

    // ── Unique phone / email (excluding this member) ──
    const normalizedEmail = email === undefined ? undefined : (email.trim() || null);
    const normalizedPhone = phone === undefined ? undefined : phone.trim();

    const conflictChecks = [];
    if (normalizedPhone && normalizedPhone !== member.phone) conflictChecks.push({ phone: normalizedPhone });
    if (normalizedEmail && normalizedEmail !== member.email) conflictChecks.push({ email: normalizedEmail });

    if (conflictChecks.length) {
        const existing = await prisma.user.findFirst({
            where: { id: { not: id }, OR: conflictChecks },
            select: { id: true },
        });
        if (existing) {
            return fail(409, 'Phone or email already in use', 'USER_EXISTS', 'User already exists', 'A user with this phone or email already exists.');
        }
    }

    // ── Trainer ──
    if (trainerId) {
        const trainer = await prisma.user.findFirst({
            where: { id: trainerId, role: { in: ['STAFF', 'ADMIN'] } },
            select: { id: true },
        });
        if (!trainer) {
            return fail(400, 'Trainer not found', 'INVALID_TRAINER', 'Invalid trainer', 'The selected trainer is not available.');
        }
    }

    // ── DOB ──
    let parsedDob;
    if (dateOfBirth !== undefined) {
        parsedDob = dateOfBirth ? new Date(dateOfBirth) : null;
        if (parsedDob && Number.isNaN(parsedDob.getTime())) {
            return fail(400, 'Invalid date of birth', 'INVALID_DOB', 'Invalid date', 'The date of birth is not valid.');
        }
    }

    // ── Plan / dates: end date is always derived from the plan ──
    let plan = null;
    let membershipStart;
    let membershipEnd;
    let status;

    const planChanged = !!planId && planId !== member.membershipPlanId;
    const needsRecompute = planChanged || startDate !== undefined;

    if (needsRecompute) {
        const effectivePlanId = planId || member.membershipPlanId;
        if (!effectivePlanId) {
            return fail(400, 'Membership plan required', 'MISSING_PLAN', 'Membership plan required', 'A membership plan is required for members.');
        }

        plan = await prisma.membershipPlan.findUnique({ where: { id: effectivePlanId } });
        // An already-assigned plan that was later deactivated is still valid
        // when only the start date changes; a *new* plan must be active.
        if (!plan || (planChanged && !plan.isActive)) {
            return fail(400, 'Membership plan not found or inactive', 'INVALID_PLAN', 'Invalid membership plan', 'The selected membership plan is not available.');
        }

        membershipStart = startDate ? new Date(startDate) : (member.membershipStart || new Date());
        if (Number.isNaN(membershipStart.getTime())) {
            return fail(400, 'Invalid start date', 'INVALID_START_DATE', 'Invalid date', 'The start date is not valid.');
        }

        membershipEnd = new Date(membershipStart);
        membershipEnd.setDate(membershipEnd.getDate() + plan.durationDays);

        // Re-derive status from the new end date. SUSPENDED is an admin
        // decision, so it is never overwritten here.
        if (member.status !== 'SUSPENDED') {
            if (membershipEnd < dateUtil.startOfToday()) status = 'EXPIRED';
            else status = plan.name.toLowerCase().includes('trial') ? 'TRIAL' : 'ACTIVE';
        }
    }

    let profileImageUrl;
    const removeImage = req.body.removeProfileImage === true || req.body.removeProfileImage === 'true';
    if (req.file) profileImageUrl = getFileUrl('profiles', req.file.filename);
    else if (removeImage) profileImageUrl = null;

    const updated = await prisma.user.update({
        where: { id },
        data: {
            name: name?.trim() || undefined,
            phone: normalizedPhone || undefined,
            profileImageUrl,
            email: normalizedEmail,
            dateOfBirth: parsedDob,
            assignedTrainerId: trainerId === undefined ? undefined : (trainerId || null),
            ...(needsRecompute
                ? {
                    membershipPlanId: plan.id,
                    membershipStart,
                    membershipEnd,
                    ...(status ? { status } : {}),
                }
                : {}),
        },
        select: {
            id: true,
            name: true,
            phone: true,
            profileImageUrl: true,
            email: true,
            status: true,
            membershipStart: true,
            membershipEnd: true,
            devicePin: true,
            deviceSN: true,
            membershipPlan: { select: { id: true, name: true } },
            assignedTrainer: { select: { id: true, name: true } },
        },
    });

    if (profileImageUrl !== undefined && member.profileImageUrl && member.profileImageUrl !== profileImageUrl) {
        deleteProfileImage(member.profileImageUrl); // best effort, errors are logged inside
    }

    // Keep the biometric device's display name in sync
    if (name && name.trim() !== member.name && updated.deviceSN && updated.devicePin) {
        commandQueue.queueCommand(
            updated.deviceSN,
            `DATA UPDATE USERINFO PIN=${updated.devicePin}\tName=${updated.name}\tPri=0\tCard=0\tGrp=${env.DEFAULT_DEVICE_GROUP_ID}`
        ).catch((err) =>
            logger.error('queueCommand failed', { memberId: id, deviceSN: updated.deviceSN, err })
        );
    }

    res.json({
        member: {
            id: updated.id,
            name: updated.name,
            phone: updated.phone,
            email: updated.email,
            plan: updated.membershipPlan?.name || 'No Plan',
            planId: updated.membershipPlan?.id || null,
            status: updated.status,
            joinDate: updated.membershipStart,
            expiryDate: updated.membershipEnd,
            daysLeft: daysUntil(updated.membershipEnd),
            trainer: updated.assignedTrainer?.name || 'Unassigned',
            trainerId: updated.assignedTrainer?.id || null,
        },
    });
});

const deleteMember = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === 'true'; // "?force=false" is a truthy string, so compare explicitly

    const member = await prisma.user.findUnique({ where: { id } });
    if (!member) {
        return fail(req, res, 404, 'Member not found', 'MEMBER_NOT_FOUND', 'Member not found', 'No member exists with this id.');
    }

    // ── Soft delete (default) ────────────────────────────────────────────────
    if (!force) {
        if (member.devicePin && member.deviceSN) {
            await checkinService.blockUserHard(member.deviceSN, member.devicePin);
        }
        await prisma.user.update({
            where: { id },
            data: { status: 'SUSPENDED', blocked: true }, // `isActive` doesn't exist on User
        });
        return res.json({
            member: { id },
            message: 'Member de-activated successfully! Rerun this with force=true to permanently delete their entire history.',
        });
    }

    // ── Hard delete ──────────────────────────────────────────────────────────
    const result = await hardDeleteUser(id);
    if (!result.ok) {
        return fail(req, res, result.status, result.message, result.code, 'Cannot permanently delete', result.message);
    }
    return res.json({ member: { id }, message: 'Member deleted successfully!', warnings: result.warnings });
    // These tables have a REQUIRED FK to User (authored by staff/admin), so they
    // can't be nulled or safely cascaded. Block instead of destroying shared content.
    // const [plans, announcements, documents] = await Promise.all([
    //     prisma.workoutPlan.count({ where: { createdById: id } }),
    //     prisma.announcement.count({ where: { createdById: id } }),
    //     prisma.document.count({ where: { uploadedById: id } }),
    // ]);
    // if (plans || announcements || documents) {
    //     return fail(
    //         req, res, 409,
    //         'Member owns content',
    //         'MEMBER_HAS_AUTHORED_CONTENT',
    //         'Cannot permanently delete',
    //         `This user authored ${plans} workout plan(s), ${announcements} announcement(s) and ${documents} document(s). Reassign or delete them first, or de-activate the user instead.`
    //     );
    // }

    // if (member.devicePin && member.deviceSN) {
    //     await checkinService.blockUserHard(member.deviceSN, member.devicePin);
    // }

    // try {
    //     await prisma.$transaction([
    //         // Optional FKs pointing at this user: detach so the delete can't be blocked
    //         prisma.user.updateMany({ where: { assignedTrainerId: id }, data: { assignedTrainerId: null } }),
    //         prisma.user.updateMany({ where: { referredById: id }, data: { referredById: null } }),
    //         prisma.feeRecord.updateMany({ where: { approvedById: id }, data: { approvedById: null } }),
    //         prisma.productOrder.updateMany({ where: { processedById: id }, data: { processedById: null } }),
    //         prisma.deviceCheckInEvent.updateMany({ where: { memberId: id }, data: { memberId: null } }), // keep door audit log

    //         // Required FKs (default onDelete = Restrict): must be removed first.
    //         // FeeReminder and OrderItem are removed via their onDelete: Cascade.
    //         prisma.userOffer.deleteMany({ where: { userId: id } }),
    //         prisma.feeRecord.deleteMany({ where: { memberId: id } }),
    //         prisma.productOrder.deleteMany({ where: { memberId: id } }),
    //         prisma.workoutAssignment.deleteMany({ where: { memberId: id } }),
    //         prisma.bodyMeasurement.deleteMany({ where: { memberId: id } }),
    //         prisma.classBooking.deleteMany({ where: { memberId: id } }),
    //         prisma.equipmentBooking.deleteMany({ where: { memberId: id } }),
    //         prisma.feedback.deleteMany({ where: { memberId: id } }),
    //         prisma.userBadge.deleteMany({ where: { userId: id } }),
    //         prisma.notification.deleteMany({ where: { userId: id } }),
    //         prisma.attendance.deleteMany({ where: { memberId: id } }),

    //         // RotationToken is onDelete: Cascade, so it goes with the user
    //         prisma.user.delete({ where: { id } }),
    //     ]);
    //     await deleteProfileImage(member.profileImageUrl);
    // } catch (err) {
    //     if (err.code === 'P2003') {
    //         return fail(req, res, 409, 'Member is still referenced', 'MEMBER_DELETE_CONSTRAINT', 'Cannot permanently delete', 'Other records still reference this member. De-activate the user instead.');
    //     }
    //     throw err;
    // }

    // return res.json({ member: { id }, message: 'Member deleted successfully!' });
});

const addDays = (date, days) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
};

// Applies one queued renewal to the user. Safe to call twice: the
// `appliedAt: null` claim means only one caller can win.
const applyRenewal = async (tx, feeId) => {
    const claimed = await tx.feeRecord.updateMany({
        where: { id: feeId, appliedAt: null },
        data: { appliedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    // One read: fee + the member fields needed for every decision below
    const fee = await tx.feeRecord.findUnique({
        where: { id: feeId },
        include: {
            member: {
                select: { status: true, blocked: true, deviceSN: true, devicePin: true },
            },
        },
    });
    const member = fee.member;

    const membershipData = {
        membershipPlanId: fee.planId,
        membershipStart: fee.periodStart,
        membershipEnd: fee.periodEnd,
        graceEntriesUsed: 0,
        contentAccessUntil: null,
    };

    // Reactivate lapsed members, but never override a manual suspension
    const lapsed = member.status === 'EXPIRED' || member.status === 'TRIAL';
    // Only an ACTIVE (or just-reactivated) member gets unblocked
    let shouldUnblock = (lapsed || member.status === 'ACTIVE') && member.blocked;

    // One write: membership fields + status + blocked together.
    // `status` in the where guards against a suspension that landed after our read.
    const updated = await tx.user.updateMany({
        where: { id: fee.memberId, status: member.status },
        data: {
            ...membershipData,
            ...(lapsed && { status: 'ACTIVE' }),
            ...(shouldUnblock && { blocked: false }),
        },
    });

    if (updated.count === 0) {
        // Status changed between read and write (e.g. admin suspended the member).
        // Apply the renewal fields only and leave status/blocked untouched.
        await tx.user.update({
            where: { id: fee.memberId },
            data: membershipData,
        });
        shouldUnblock = false;
    }

    if (shouldUnblock) {
        await checkinService.unblockUser(member.deviceSN, member.devicePin);
    }
    return true;
};

// Applies every queued renewal whose start date has arrived.
// Used by the endpoint (single member) and by the scheduled job (everyone).
const applyDueRenewals = async (memberId) => {
    const due = await prisma.feeRecord.findMany({
        where: {
            appliedAt: null,
            periodStart: { lte: new Date() },
            ...(memberId && { memberId }),
        },
        orderBy: { periodStart: 'asc' }, // chained renewals must apply in order
        select: { id: true },
    });

    let applied = 0;
    for (const { id } of due) {
        try {
            if (await prisma.$transaction((tx) => applyRenewal(tx, id))) applied++;
        } catch (err) {
            console.error(`Failed to apply renewal ${id}:`, err);
        }
    }
    return applied;
};

const PAYMENT_METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER'];

// POST /members/:id/renew
// body: { planId?, startDate?, paidAmount?, paymentMethod?, notes? }
const renewMembership = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { planId, paidAmount, paymentMethod, notes, waiveRemaining = false, offerId, offerCode } = req.body ?? {};
    const startOverride = req.body?.startDate ?? req.query.startDate;

    const member = await prisma.user.findUnique({ where: { id } });
    if (!member) {
        return fail(req, res, 404, 'Member not found', 'MEMBER_NOT_FOUND', 'Member not found', 'No member exists with this id.');
    }
    if (member.role !== 'MEMBER') {
        return fail(req, res, 400, 'Not a member', 'NOT_A_MEMBER', 'Cannot renew', 'Only users with the "MEMBER" role have memberships.');
    }

    const targetPlanId = planId || member.membershipPlanId;
    if (!targetPlanId) {
        return fail(req, res, 400, 'Plan required', 'PLAN_REQUIRED', 'Plan required', 'This member has no current plan. Provide a planId.');
    }
    const plan = await prisma.membershipPlan.findUnique({ where: { id: targetPlanId } });
    if (!plan || !plan.isActive) {
        return fail(req, res, 404, 'Plan not found', 'PLAN_NOT_FOUND', 'Plan not found', 'The selected plan does not exist or is inactive.');
    }

    let overrideDate = null;
    if (startOverride) {
        overrideDate = new Date(startOverride);
        if (Number.isNaN(overrideDate.getTime())) {
            return fail(req, res, 400, 'Invalid start date', 'INVALID_START_DATE', 'Invalid start date', 'startDate must be a valid ISO date.');
        }
    }

    // Where the current membership (and any already-queued renewals) finish.
    // A new renewal must start at or after this point so periods never overlap.
    const lastQueued = await prisma.feeRecord.findFirst({
        where: { memberId: id, appliedAt: null, periodEnd: { not: null } },
        orderBy: { periodEnd: 'desc' },
        select: { periodEnd: true },
    });
    const candidates = [member.membershipEnd, lastQueued?.periodEnd].filter(Boolean);
    const chainEnd = candidates.length
        ? candidates.reduce((a, b) => (a > b ? a : b))
        : null; // null = no previous period

    const now = new Date();
    let periodStart;
    if (overrideDate) {
        if (chainEnd && overrideDate < chainEnd) {
            return fail(
                req, res, 409,
                'Start date overlaps',
                'START_DATE_OVERLAP',
                'Start date overlaps',
                `This member is already covered until ${chainEnd.toISOString()}. Choose a start date on or after that.`
            );
        }
        periodStart = overrideDate;
    } else {
        // Default: continue right after the current membership, or start now if it has lapsed
        periodStart = chainEnd ?? now;
    }
    const periodEnd = addDays(periodStart, plan.durationDays);
    if (periodEnd <= now) {
        return fail(req, res, 409, 'Renewal already elapsed', 'RENEWAL_ELAPSED', 'Renewal already elapsed',
            'The renewal period would end in the past. Provide a startDate or choose a longer plan.');
    }

    const paid = paidAmount ? Number(paidAmount) : 0;
    if (Number.isNaN(paid) || paid < 0) {
        return fail(req, res, 400, 'Invalid amount', 'INVALID_PAID_AMOUNT', 'Invalid amount', 'paidAmount must be a non-negative number.');
    }
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
        return fail(req, res, 400, 'Invalid payment method', 'INVALID_PAYMENT_METHOD', 'Invalid payment method', `paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}.`);
    }

    let offerQuote = null;
    if (offerId || offerCode) {
        offerQuote = await tryResolveOffer(req, res, {
            offerId, offerCode, plan, memberId: id, context: 'RENEWAL',
        });
        if (!offerQuote) return;
    }
    const price = offerQuote ? offerQuote.finalAmount : Number(plan.price);
    // multipart bodies send booleans as strings
    const waive = waiveRemaining === true || waiveRemaining === 'true';
    const isAdmin = req.user?.role === 'ADMIN';
    const partial = paid > 0 && paid < price;

    const { feeRecords, mainFee } = await prisma.$transaction(async (tx) => {
        const now = new Date();
        const receiptImageUrl = req.file ? getFileUrl('receipts', req.file.filename) : null;
        const created = [];

        // The main record always carries the membership period and is what
        // applyRenewal() acts on.
        const main = await tx.feeRecord.create({
            data: {
                memberId: id,
                planId: plan.id,
                // Partial payment: this record covers only what was paid.
                amount: partial ? paid : plan.price,
                discountAmount: offerQuote?.discountAmount ?? null,
                paidAmount: paid > 0 ? paid : null,
                status: partial
                    ? 'PAID'
                    : paid >= price ? 'PAID'
                        : waive ? 'WAIVED'   // nothing paid, whole amount waived
                            : 'PENDING',
                dueDate: periodStart,
                paidDate: paid > 0 ? now : null,
                paymentMethod: paid > 0 ? paymentMethod || null : null,
                notes: notes || null,
                receiptImageUrl,
                approvedById: isAdmin && (paid > 0 || waive) ? req.user.id : null,
                approvedDate: paid > 0 || waive ? now : null,
                periodStart,
                periodEnd,
                renewalGroupId: partial ? randomUUID() : null,
                createdAt: now,
            },
        });
        created.push(main);
        if (offerQuote) {
            await offerService.recordRedemption(tx, {
                quote: offerQuote, userId: id, feeRecordId: main.id, source: 'RENEWAL',
            });
        }

        // Partial payment: second record for the remainder (pending or waived)
        if (partial) {
            const remainder = Math.round((price - paid) * 100) / 100;
            const rest = await tx.feeRecord.create({
                data: {
                    memberId: id,
                    planId: plan.id,
                    amount: remainder,
                    paidAmount: null,
                    status: waive ? 'WAIVED' : 'PENDING',
                    dueDate: periodStart,
                    paidDate: null,
                    paymentMethod: null,
                    notes: notes || null,
                    approvedById: waive && isAdmin ? req.user.id : null,
                    approvedDate: waive ? now : null,
                    // No period: this record never changes the membership, so
                    // applyDueRenewals (which requires periodStart) ignores it.
                    periodStart: null,
                    periodEnd: null,
                    appliedAt: now,
                    renewalGroupId: main.renewalGroupId,
                    // +1ms so it is strictly the newest record. listMembers uses
                    // the latest record for feeStatus, so it shows pending/paid correctly.
                    createdAt: new Date(now.getTime() + 1),
                },
            });
            created.push(rest);
        }

        // Starts today or earlier: apply right away
        if (periodStart <= now) await applyRenewal(tx, main.id);

        return { feeRecords: created, mainFee: main };
    });

    const [updatedFee, updatedMember] = await Promise.all([
        prisma.feeRecord.findUnique({ where: { id: mainFee.id } }),
        prisma.user.findUnique({
            where: { id },
            select: { id: true, status: true, membershipPlanId: true, membershipStart: true, membershipEnd: true },
        }),
    ]);

    res.status(201).json({
        feeRecord: updatedFee,   // main record, kept for backward compatibility
        feeRecords,              // all records created (1 or 2)
        member: updatedMember,
        discount: offerQuote
            ? { offerId: offerQuote.offer.id, name: offerQuote.offer.name, discountAmount: offerQuote.discountAmount, finalAmount: offerQuote.finalAmount }
            : null,
        applied: updatedFee.appliedAt !== null,
        message: updatedFee.appliedAt
            ? 'Membership renewed and active now.'
            : `Renewal scheduled. The new plan takes effect on ${periodStart.toISOString()}.`,
    });

    sendRenewalEmail(updatedFee.id);
});

// ── DELETE /api/v1/admin/members/:id/renew/last ─────────────────────────────
// Reverts the most recent renewal for a member:
//  - Queued renewal (not applied yet): the fee record is deleted; the member is untouched.
//  - Applied renewal: the fee record is deleted and the member's plan / start / end /
//    status are restored from the previous fee record.
// Only renewal records (periodStart set) are eligible, so the initial fee record
// created in createMember can never be reverted by this endpoint.
const revertLastRenewal = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const member = await prisma.user.findUnique({ where: { id } });
    if (!member) {
        return fail(req, res, 404, 'Member not found', 'MEMBER_NOT_FOUND', 'Member not found', 'No member exists with this id.');
    }
    if (member.role !== 'MEMBER') {
        return fail(req, res, 400, 'Not a member', 'NOT_A_MEMBER', 'Cannot revert', 'Only users with the "MEMBER" role have memberships.');
    }

    const result = await prisma.$transaction(async (tx) => {
        // Re-read inside the transaction so the member state is consistent with the delete
        const current = await tx.user.findUnique({ where: { id } });

        const last = await tx.feeRecord.findFirst({
            where: { memberId: id, periodStart: { not: null } },
            orderBy: { createdAt: 'desc' },
        });
        if (!last) return { error: 'NO_RENEWAL' };
        const deleteRenewal = async () => {
            const ids = last.renewalGroupId
                ? (await tx.feeRecord.findMany({ where: { renewalGroupId: last.renewalGroupId }, select: { id: true } })).map((r) => r.id)
                : [last.id];

            await offerService.releaseRedemptions(tx, ids); // decrements Offer.redemptionCount, deletes UserOffer rows

            if (last.renewalGroupId) {
                await tx.feeRecord.deleteMany({ where: { renewalGroupId: last.renewalGroupId } });
            } else {
                await tx.feeRecord.delete({ where: { id: last.id } });
            }
        };

        // Queued renewal: nothing was applied to the member, just remove it
        if (!last.appliedAt) {
            await deleteRenewal();
            return { reverted: last, member: current, restored: false };
        }

        // Applied renewal: find the record to roll back to
        const previous = await tx.feeRecord.findFirst({
            where: { memberId: id, id: { not: last.id } },
            orderBy: { createdAt: 'desc' },
            include: { plan: { select: { id: true, name: true, durationDays: true } } },
        });
        if (!previous) return { error: 'NO_PREVIOUS_RECORD' };

        // Fee records created by createMember have no periodStart/periodEnd,
        // so derive them from dueDate + plan duration.
        const prevStart = previous.periodStart ?? previous.dueDate;
        const prevEnd =
            previous.periodEnd ??
            (prevStart && previous.plan ? addDays(prevStart, previous.plan.durationDays) : null);
        if (!prevStart || !prevEnd) return { error: 'PREVIOUS_PERIOD_UNKNOWN' };

        // Re-derive status from the restored end date. SUSPENDED is an admin
        // decision and is never overwritten.
        let status;
        if (current.status !== 'SUSPENDED') {
            if (prevEnd < new Date()) status = 'EXPIRED';
            else status = previous.plan?.name?.toLowerCase().includes('trial') ? 'TRIAL' : 'ACTIVE';
        }

        await deleteRenewal();

        const updated = await tx.user.update({
            where: { id },
            data: {
                membershipPlanId: previous.planId,
                membershipStart: prevStart,
                membershipEnd: prevEnd,
                ...(status ? { status } : {}),
            },
            select: {
                id: true,
                name: true,
                status: true,
                membershipPlanId: true,
                membershipStart: true,
                membershipEnd: true,
            },
        });

        return { reverted: last, member: updated, restored: true, restoredFrom: previous };
    });

    if (result.error === 'NO_RENEWAL') {
        return fail(req, res, 404, 'No renewal found', 'NO_RENEWAL', 'Nothing to revert', 'This member has no renewal to revert.');
    }
    if (result.error === 'NO_PREVIOUS_RECORD') {
        return fail(req, res, 409, 'No previous record', 'NO_PREVIOUS_RECORD', 'Cannot revert', 'There is no earlier fee record to restore the membership from.');
    }
    if (result.error === 'PREVIOUS_PERIOD_UNKNOWN') {
        return fail(req, res, 409, 'Previous period unknown', 'PREVIOUS_PERIOD_UNKNOWN', 'Cannot revert', 'The previous fee record has no usable membership period.');
    }

    return res.json({
        revertedFeeRecordId: result.reverted.id,
        member: result.member,
        restoredFromFeeRecordId: result.restoredFrom?.id ?? null,
        message: result.restored
            ? 'Last renewal reverted and previous membership restored.'
            : 'Queued renewal removed. Current membership was not affected.',
    });
});

// ── POST /api/v1/admin/members/:id/remind ───────────────────────────────────
// Manually sends a membership email:
//  - membership still running (expires sooner or later) -> expiry reminder
//  - membership already ended                           -> expired / overdue notice
const sendReminder = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const member = await prisma.user.findUnique({
        where: { id },
        include: { membershipPlan: true }, // the mail builders read member.membershipPlan.name / price
    });

    if (!member || member.role !== 'MEMBER') {
        return fail(req, res, 404, 'Member not found', 'MEMBER_NOT_FOUND', 'Member not found', 'No member exists with this id.');
    }
    if (!member.email) {
        return fail(req, res, 400, 'No email on file', 'NO_EMAIL', 'Cannot send reminder', 'This member has no email address.');
    }
    if (!member.membershipEnd || !member.membershipPlan) {
        return fail(req, res, 400, 'No active membership', 'NO_MEMBERSHIP', 'Cannot send reminder', 'This member has no membership plan or expiry date.');
    }

    const now = new Date();
    const expired = member.membershipEnd < now;

    if (expired) {
        await sendExpiredNoticeEmail(member, now, { automatic: false });
    } else {
        await sendExpiryReminderEmail(member, now, { automatic: false });
    }

    res.json({
        type: expired ? 'EXPIRED' : 'EXPIRING',
        message: expired
            ? `Expired notice sent to ${member.name}.`
            : `Expiry reminder sent to ${member.name}.`,
    });
});

export default {
    listMembers,
    getMemberDetails,
    createMember,
    updateMember,
    getAllTrainers,
    getAllMembershipPlans,
    createMembershipPlan,
    updateMembershipPlan,
    deleteMembershipPlan,
    reactivateMember,
    suspendMember,
    deleteMember,
    renewMembership,
    revertLastRenewal,
    applyDueRenewals,
    sendReminder,
};
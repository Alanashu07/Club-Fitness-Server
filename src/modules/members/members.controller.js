import dateUtil from '../../utils/date.js';
import prisma from '../../config/db.js';
import { hashPassword } from '../../utils/password.js';
import { sendWelcomeEmail } from '../../utils/mailer.js';
import checkinService from '../device/checkin.service.js';
import commandQueue from '../device/device-command-queue.service.js';
import env from '../../config/env.js';
import { fail } from '../../validators/error.handler.js';
import { getFileUrl } from '../../config/multer.js';

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

// ── GET /api/admin/members ──────────────────────────────────────────────────
// Query params:
//   search           — matches name, phone, email, or id (case-insensitive)
//   status           — ACTIVE | EXPIRED | SUSPENDED | TRIAL | All (default All)
//   planId           — filter to one membership plan
//   trainerId        — filter to one assigned trainer ('unassigned' for none)
//   checkedInToday   — 'true' to only show members checked in today
//   overdueOnly      — 'true' to only show members with an overdue fee
//   sortBy           — name | expiry | feeStatus | streak (default name)
//   page, limit       — pagination (default page=1, limit=20)
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

    const where = { role: 'MEMBER' };

    if (status && status !== 'All') {
        where.status = status; // ACTIVE | EXPIRED | SUSPENDED | TRIAL
    }
    if (planId) {
        where.membershipPlanId = planId;
    }
    if (trainerId) {
        where.assignedTrainerId = trainerId === 'unassigned' ? null : trainerId;
    }
    if (search.trim()) {
        where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            { email: { contains: search, mode: 'insensitive' } },
            { id: { contains: search } },
        ];
    }

    // Fetched in full (not paginated at the DB level) because feeStatus and
    // streak/checkedInToday are computed, not stored — sorting and the
    // overdueOnly/checkedInToday filters need those values resolved first.
    // Fine for gym-scale member counts; revisit with a materialized view or
    // a `currentFeeStatus` column on User if this ever needs to scale past
    // a few thousand members.
    const users = await prisma.user.findMany({
        where,
        select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            status: true,
            membershipStart: true,
            membershipEnd: true,
            membershipPlan: { select: { id: true, name: true } },
            assignedTrainer: { select: { id: true, name: true } },
        },
    });

    const memberIds = users.map((u) => u.id);
    const today = dateUtil.startOfToday();
    const windowStart = dateUtil.subDays(today, 90);

    const [todayAttendance, recentAttendance, feeRows, holidays] = await Promise.all([
        prisma.attendance.findMany({
            where: { memberId: { in: memberIds }, checkInAt: { gte: dateUtil.startOfToday() } },
            distinct: ['memberId'],
            select: { memberId: true },
        }),
        prisma.attendance.findMany({
            where: { memberId: { in: memberIds }, checkInAt: { gte: dateUtil.subDays(dateUtil.startOfToday(), 90) } },
            select: { memberId: true, checkInAt: true },
        }),
        prisma.feeRecord.findMany({
            where: { memberId: { in: memberIds } },
            orderBy: { createdAt: 'desc' },
            select: { memberId: true, status: true, amount: true },
        }),
        fetchHolidays(windowStart, today),
    ]);
    const isOffDay = buildOffDayChecker(holidays);

    const checkedInTodaySet = new Set(todayAttendance.map((a) => a.memberId));

    const attendanceByMember = new Map(); // memberId -> Set<dateString>
    for (const row of recentAttendance) {
        const set = attendanceByMember.get(row.memberId) || new Set();
        set.add(new Date(row.checkInAt).toDateString());
        attendanceByMember.set(row.memberId, set);
    }

    // feeRows is ordered newest-first, so the first match per member is latest
    const latestFeeByMember = new Map();
    for (const row of feeRows) {
        if (!latestFeeByMember.has(row.memberId)) latestFeeByMember.set(row.memberId, row);
    }

    let members = users.map((u) => {
        const latestFee = latestFeeByMember.get(u.id);
        return {
            id: u.id,
            name: u.name,
            phone: u.phone,
            email: u.email,
            plan: u.membershipPlan?.name || 'No Plan',
            planId: u.membershipPlan?.id || null,
            status: u.status,
            joinDate: u.membershipStart,
            expiryDate: u.membershipEnd,
            daysLeft: daysUntil(u.membershipEnd),
            trainer: u.assignedTrainer?.name || 'Unassigned',
            trainerId: u.assignedTrainer?.id || null,
            checkedInToday: checkedInTodaySet.has(u.id),
            workoutStreak: computeStreak(attendanceByMember.get(u.id) || new Set(), today, isOffDay),
            feeStatus: mapFeeStatus(latestFee?.status),
            amount: Number(latestFee?.amount || 0),
        };
    });

    if (checkedInToday === 'true') {
        members = members.filter((m) => m.checkedInToday);
    }
    if (overdueOnly === 'true') {
        members = members.filter((m) => m.feeStatus === 'overdue');
    }

    switch (sortBy) {
        case 'expiry':
            members.sort((a, b) => a.daysLeft - b.daysLeft);
            break;
        case 'feeStatus':
            members.sort(
                (a, b) => FEE_STATUS_SORT_ORDER[a.feeStatus] - FEE_STATUS_SORT_ORDER[b.feeStatus]
            );
            break;
        case 'streak':
            members.sort((a, b) => b.workoutStreak - a.workoutStreak);
            break;
        default:
            members.sort((a, b) => a.name.localeCompare(b.name));
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const total = members.length;
    const start = (pageNum - 1) * limitNum;
    const paged = members.slice(start, start + limitNum);

    // summary counts reflect the search/status/plan/trainer filters but not
    // checkedInToday/overdueOnly, mirroring the screen's top stat row which
    // stays fixed while filter chips change the list below it
    res.json({
        members: paged,
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
        summary: {
            total,
            active: members.filter((m) => m.status === 'ACTIVE').length,
            expired: members.filter((m) => m.status === 'EXPIRED').length,
            overdue: members.filter((m) => m.feeStatus === 'overdue').length,
        },
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

    const member = await prisma.user.create({
        data: {
            name,
            phone,
            email,
            passwordHash,
            dateOfBirth: dateOfBirth
                ? new Date(dateOfBirth)
                : null,

            role,
            status: initialStatus,

            membershipPlanId: plan?.id ?? null,
            membershipStart,
            membershipEnd,

            devicePin,
            deviceSN,

            assignedTrainerId: trainerId || null,

            ...(role === 'MEMBER' && plan
                ? {
                    feeRecords: {
                        create: {
                            planId: plan.id,
                            amount: plan.price,
                            status: req.user?.role === 'ADMIN' ? 'PAID' : 'PENDING',
                            dueDate: membershipStart,
                        },
                    },
                }
                : {}),
        },

        select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            role: true,
            status: true,
            membershipStart: true,
            membershipEnd: true,

            membershipPlan: {
                select: {
                    id: true,
                    name: true,
                },
            },

            assignedTrainer: {
                select: {
                    id: true,
                    name: true,
                },
            },
        },
    });

    res.status(201).json({
        member: {
            id: member.id,
            name: member.name,
            phone: member.phone,
            email: member.email,
            role: member.role,

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

            feeStatus: role === 'MEMBER'
                ? req.user?.role === 'ADMIN' ? 'paid' : 'pending'
                : null,

            amount: plan ? Number(plan.price) : null,

            devicePin,
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
    const { includeInactive } = req.query;

    const plans = await prisma.membershipPlan.findMany({
        where: includeInactive === 'true' ? {} : { isActive: true },
        select: {
            id: true,
            name: true,
            durationDays: true,
            price: true,
            description: true,
            features: true,
            isActive: true,
        },
        orderBy: { price: 'asc' },
    });

    res.json({ plans: plans.map((p) => ({ ...p, price: Number(p.price) })) });
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
    res.json({
        member: {
            ...member,
            assignedTrainer: trainer?.name || 'Unassigned',
            workoutStreak,
            checkedInToday,
        }, attendance, feeHistory
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

    const updated = await prisma.user.update({
        where: { id },
        data: {
            name: name?.trim() || undefined,
            phone: normalizedPhone || undefined,
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
    // These tables have a REQUIRED FK to User (authored by staff/admin), so they
    // can't be nulled or safely cascaded. Block instead of destroying shared content.
    const [plans, announcements, documents] = await Promise.all([
        prisma.workoutPlan.count({ where: { createdById: id } }),
        prisma.announcement.count({ where: { createdById: id } }),
        prisma.document.count({ where: { uploadedById: id } }),
    ]);
    if (plans || announcements || documents) {
        return fail(
            req, res, 409,
            'Member owns content',
            'MEMBER_HAS_AUTHORED_CONTENT',
            'Cannot permanently delete',
            `This user authored ${plans} workout plan(s), ${announcements} announcement(s) and ${documents} document(s). Reassign or delete them first, or de-activate the user instead.`
        );
    }

    if (member.devicePin && member.deviceSN) {
        await checkinService.blockUserHard(member.deviceSN, member.devicePin);
    }

    try {
        await prisma.$transaction([
            // Optional FKs pointing at this user: detach so the delete can't be blocked
            prisma.user.updateMany({ where: { assignedTrainerId: id }, data: { assignedTrainerId: null } }),
            prisma.user.updateMany({ where: { referredById: id }, data: { referredById: null } }),
            prisma.feeRecord.updateMany({ where: { approvedById: id }, data: { approvedById: null } }),
            prisma.productOrder.updateMany({ where: { processedById: id }, data: { processedById: null } }),
            prisma.deviceCheckInEvent.updateMany({ where: { memberId: id }, data: { memberId: null } }), // keep door audit log

            // Required FKs (default onDelete = Restrict): must be removed first.
            // FeeReminder and OrderItem are removed via their onDelete: Cascade.
            prisma.feeRecord.deleteMany({ where: { memberId: id } }),
            prisma.productOrder.deleteMany({ where: { memberId: id } }),
            prisma.workoutAssignment.deleteMany({ where: { memberId: id } }),
            prisma.bodyMeasurement.deleteMany({ where: { memberId: id } }),
            prisma.classBooking.deleteMany({ where: { memberId: id } }),
            prisma.equipmentBooking.deleteMany({ where: { memberId: id } }),
            prisma.feedback.deleteMany({ where: { memberId: id } }),
            prisma.userBadge.deleteMany({ where: { userId: id } }),
            prisma.notification.deleteMany({ where: { userId: id } }),
            prisma.attendance.deleteMany({ where: { memberId: id } }),

            // RotationToken is onDelete: Cascade, so it goes with the user
            prisma.user.delete({ where: { id } }),
        ]);
    } catch (err) {
        if (err.code === 'P2003') {
            return fail(req, res, 409, 'Member is still referenced', 'MEMBER_DELETE_CONSTRAINT', 'Cannot permanently delete', 'Other records still reference this member. De-activate the user instead.');
        }
        throw err;
    }

    return res.json({ member: { id }, message: 'Member deleted successfully!' });
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
    const { planId, paidAmount, paymentMethod, notes } = req.body ?? {};
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
    const price = Number(plan.price);
    const status = paid >= price ? 'PAID' : paid > 0 ? 'PARTIAL' : 'PENDING';

    const fee = await prisma.$transaction(async (tx) => {
        const isAdmin = req.user?.role === 'ADMIN';
        const created = await tx.feeRecord.create({
            data: {
                memberId: id,
                planId: plan.id,
                amount: plan.price,
                paidAmount: paid > 0 ? paid : null,
                status,
                dueDate: periodStart,
                paidDate: paid > 0 ? now : null,
                paymentMethod: paid > 0 ? paymentMethod || null : null,
                notes: notes || null,
                receiptImageUrl: req.file ? getFileUrl('receipts', req.file.filename) : null,
                approvedById: isAdmin ? req.user.id : null,
                approvedDate: paid > 0 ? now : null,
                periodStart,
                periodEnd,
            },
        });

        // Starts today or earlier (expired member / backdated override): apply right away
        if (periodStart <= now) await applyRenewal(tx, created.id);

        return created;
    });

    const [updatedFee, updatedMember] = await Promise.all([
        prisma.feeRecord.findUnique({ where: { id: fee.id } }),
        prisma.user.findUnique({
            where: { id },
            select: { id: true, status: true, membershipPlanId: true, membershipStart: true, membershipEnd: true },
        }),
    ]);

    return res.status(201).json({
        feeRecord: updatedFee,
        member: updatedMember,
        applied: updatedFee.appliedAt !== null,
        message: updatedFee.appliedAt
            ? 'Membership renewed and active now.'
            : `Renewal scheduled. The new plan takes effect on ${periodStart.toISOString()}.`,
    });
});

export default { listMembers, getMemberDetails, createMember, updateMember, getAllTrainers, getAllMembershipPlans, createMembershipPlan, updateMembershipPlan, deleteMembershipPlan, reactivateMember, suspendMember, deleteMember, renewMembership, applyDueRenewals };
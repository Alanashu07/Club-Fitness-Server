import dateUtil from '../../utils/date.js';
import prisma from '../../config/db.js';
import { hashPassword } from '../../utils/password.js';
import { sendWelcomeEmail } from '../../utils/mailer.js';
import checkinService from '../device/checkin.service.js';
import commandQueue from '../device/device-command-queue.service.js';
import env from '../../config/env.js';

const FEE_STATUS_SORT_ORDER = { overdue: 0, pending: 1, paid: 2 };
function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const getNextDevicePin = async function () {
    const result = await prisma.user.aggregate({ _max: { devicePin: true } });
    return (result._max.devicePin || 0) + 1;
};

// ── streak: consecutive days of attendance ending today (or yesterday) ─────
const computeStreak = function (dateStrSet, today) {
    let cursor = new Date(today);
    if (!dateStrSet.has(cursor.toDateString())) {
        cursor = dateUtil.subDays(cursor, 1);
        if (!dateStrSet.has(cursor.toDateString())) return 0;
    }
    let streak = 0;
    while (dateStrSet.has(cursor.toDateString())) {
        streak++;
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

    const [todayAttendance, recentAttendance, feeRows] = await Promise.all([
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
    ]);

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

    const today = dateUtil.startOfToday();
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
            workoutStreak: computeStreak(attendanceByMember.get(u.id) || new Set(), today),
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
    const { name, phone, email, dateOfBirth, password, planId, trainerId, startDate } = req.body;

    const existing = await prisma.user.findFirst({
        where: { OR: [{ phone }, ...(email ? [{ email }] : [])] },
        select: { id: true },
    });
    if (existing) {
        const failure = { title: "User already exists", message: "A user with this phone or email already exists.", code: 409 };
        return res.status(409).json({ error: 'Phone or email already in use', code: 'USER_EXISTS', failure });
    }

    const plan = await prisma.membershipPlan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) {
        const failure = { title: "Invalid membership plan", message: "The selected membership plan is not available.", code: 400 };
        return res.status(400).json({ error: 'Membership plan not found or inactive', code: 'INVALID_PLAN', failure });
    }

    if (trainerId) {
        const trainer = await prisma.user.findFirst({
            where: { id: trainerId, role: { in: ['STAFF', 'ADMIN'] } },
            select: { id: true },
        });
        if (!trainer) {
            const failure = { title: "Invalid trainer", message: "The selected trainer is not available.", code: 400 };
            return res.status(400).json({ error: 'Trainer not found', code: 'INVALID_TRAINER', failure });
        }
    }

    const membershipStart = startDate ? new Date(startDate) : new Date();
    const membershipEnd = new Date(membershipStart);
    membershipEnd.setDate(membershipEnd.getDate() + plan.durationDays);

    // A "Trial Pass"-style plan should land the member in TRIAL status rather
    // than ACTIVE — adjust this check if you'd rather drive it off a flag on
    // MembershipPlan instead of sniffing the plan name.
    const initialStatus = plan.name.toLowerCase().includes('trial') ? 'TRIAL' : 'ACTIVE';

    const passwordHash = password ? await hashPassword(password) : null;

    const devicePin = await getNextDevicePin();
    const deviceSN = env.DEFAULT_DEVICE_SN || req.body.deviceSN;

    if (!deviceSN) {
        const failure = { title: "No device configured", message: "No biometric device SN was provided and DEFAULT_DEVICE_SN is not set.", code: 400 };
        return res.status(400).json({ error: 'deviceSN required', code: 'MISSING_DEVICE_SN', failure });
    }

    const member = await prisma.user.create({
        data: {
            name,
            phone,
            email,
            passwordHash,
            dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
            role: 'MEMBER',
            status: initialStatus,
            membershipPlanId: plan.id,
            membershipStart,
            membershipEnd,
            devicePin,
            deviceSN,
            assignedTrainerId: trainerId || null,
            feeRecords: {
                create: {
                    planId: plan.id,
                    amount: plan.price,
                    status: 'PENDING',
                    dueDate: membershipStart,
                },
            },
        },
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

    if (member.email) {
        await sendWelcomeEmail(member.email, { name: member.name, planName: plan.name, memberId: member.id, planAmount: plan.price });
    }
    await commandQueue.queueCommand(
        deviceSN,
        `DATA UPDATE USERINFO PIN=${devicePin}\tName=${name}\tPri=0\tCard=0`
    );

    res.status(201).json({
        member: {
            id: member.id,
            name: member.name,
            phone: member.phone,
            email: member.email,
            plan: member.membershipPlan?.name || 'No Plan',
            planId: member.membershipPlan?.id || null,
            status: member.status,
            joinDate: member.membershipStart,
            expiryDate: member.membershipEnd,
            daysLeft: daysUntil(member.membershipEnd),
            trainer: member.assignedTrainer?.name || 'Unassigned',
            trainerId: member.assignedTrainer?.id || null,
            checkedInToday: false,
            workoutStreak: 0,
            feeStatus: 'pending',
            amount: Number(plan.price),
            devicePin,
        },
    });
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
            membershipEnd: new Date(newMembershipEnd),
            ...(planId ? { membershipPlanId: planId } : {}),
        },
        select: { id: true, name: true, membershipEnd: true, devicePin: true, deviceSN: true },
    });

    await checkinService.unblockUser(updated.deviceSN, updated.devicePin);

    res.json({
        member: updated,
        message: 'Member reactivated. If they were hard-blocked previously, they must re-enroll their face at the device.',
    });
});

export default { listMembers, createMember, getAllTrainers, getAllMembershipPlans, createMembershipPlan, updateMembershipPlan, deleteMembershipPlan, reactivateMember };
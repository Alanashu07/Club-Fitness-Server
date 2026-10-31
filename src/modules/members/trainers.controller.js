import prisma from '../../config/db.js';
import checkinService from '../device/checkin.service.js';
import commandQueue from '../device/device-command-queue.service.js';
import { fail } from '../../validators/error.handler.js';
import { deleteProfileImage, getFileUrl } from '../../config/multer.js';
import env from '../../config/env.js';
import { sendTrainerWelcomeEmail } from '../../utils/mailer.js';

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const getNextDevicePin = async () => {
    const result = await prisma.user.aggregate({ _max: { devicePin: true } });
    return (result._max.devicePin || 0) + 1;
};

// Tabs / newlines would corrupt the device command, so flatten them.
const deviceSafeName = (name) => name.replace(/[\t\r\n]+/g, ' ').trim();

// Trainers are User rows with role = STAFF (staffTitle / hireDate are staff-only fields).
const TRAINER_SELECT = {
    id: true,
    name: true,
    phone: true,
    email: true,
    staffTitle: true,
    emergencyContact: true,
    hireDate: true,
    profileImageUrl: true,
    status: true,
    blocked: true,
    devicePin: true,
    deviceSN: true,
    _count: { select: { trainees: true } },
};

// Shape the Flutter TrainerEntity.fromJson expects.
const toTrainerDto = (t) => ({
    id: t.id,
    name: t.name,
    phone: t.phone,
    email: t.email,
    staffTitle: t.staffTitle || 'Trainer',
    emergencyContact: t.emergencyContact,
    hireDate: t.hireDate,
    profileImageUrl: t.profileImageUrl,
    status: t.status,
    blocked: t.blocked,
    traineeCount: t._count?.trainees ?? 0,
});

const toTraineeDto = (m) => ({
    id: m.id,
    name: m.name,
    profileImageUrl: m.profileImageUrl,
    blocked: m.blocked,
    membershipEnd: m.membershipEnd,
    status: m.status,
    membershipPlanId: m.membershipPlan ? m.membershipPlan.id : null,
    membershipPlanName: m.membershipPlan ? m.membershipPlan.name : null,
});

const toWorkoutPlanDto = (p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    assignedCount: p._count?.assignments ?? 0,
});

const toTrainerDetailDto = (t) => ({
    ...toTrainerDto(t),
    devicePin: t.devicePin,
    createdAt: t.createdAt,
    trainees: (t.trainees ?? []).map(toTraineeDto),
    workoutPlansCreated: (t.workoutPlansCreated ?? []).map(toWorkoutPlanDto),
});

const parseDate = (value) => {
    if (value === undefined) return { value: undefined };
    if (value === null || value === '') return { value: null };
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? { error: true } : { value: d };
};

const clean = (v) => (typeof v === 'string' ? v.trim() : v);

const notFound = (req, res) =>
    fail(req, res, 404, 'Trainer not found', 'TRAINER_NOT_FOUND', 'Trainer not found', 'No trainer exists with this id.');

// ── GET /api/admin/trainers ──────────────────────────────────────────────────
// Query: search, title, status
//   status omitted        -> ACTIVE only (keeps the member-form trainer picker working)
//   status=ALL or ''      -> every trainer (what the Trainers screen "All" chip sends)
//   status=ACTIVE|SUSPENDED
const getAllTrainers = asyncHandler(async (req, res) => {
    const { title, search = '' } = req.query;
    const rawStatus = req.query.status;

    const where = { role: 'STAFF' };

    if (rawStatus === undefined) {
        where.status = 'ACTIVE';
    } else if (rawStatus !== '' && String(rawStatus).toUpperCase() !== 'ALL') {
        const status = String(rawStatus).toUpperCase();
        if (!['ACTIVE', 'SUSPENDED', 'EXPIRED', 'TRIAL'].includes(status)) {
            return fail(req, res, 400, 'Invalid status', 'INVALID_STATUS', 'Invalid status', 'status must be ACTIVE, SUSPENDED or ALL.');
        }
        where.status = status;
    }

    if (title) where.staffTitle = { equals: title, mode: 'insensitive' };

    const q = String(search).trim();
    if (q) {
        where.OR = [
            { name: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { email: { contains: q, mode: 'insensitive' } },
        ];
    }

    const trainers = await prisma.user.findMany({
        where,
        select: TRAINER_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    res.json({ trainers: trainers.map(toTrainerDto) });
});

// ── GET /api/v1/trainers/:id ──────────────────────────────────────────────
// Returns the flat shape TrainerDetailEntity.fromJson expects:
// trainer fields at the top level + `trainees` + `workoutPlansCreated`.
const getTrainer = asyncHandler(async (req, res) => {
    const trainer = await prisma.user.findUnique({
        where: { id: req.params.id, role: 'STAFF' },
        select: {
            ...TRAINER_SELECT,
            role: true,
            createdAt: true,
            trainees: {
                select: {
                    id: true,
                    name: true,
                    profileImageUrl: true,
                    blocked: true,
                    membershipEnd: true,
                    membershipPlan: { select: { id: true, name: true } },
                    status: true,
                },
                orderBy: { name: 'asc' },
            },
            workoutPlansCreated: {
                select: {
                    id: true,
                    name: true,
                    createdAt: true,
                    _count: { select: { assignments: true } },
                },
                orderBy: { createdAt: 'desc' },
                take: 5,
            },
        },
    });

    if (!trainer) return notFound(req, res);

    res.json(toTrainerDetailDto(trainer));
});

// ── POST /api/admin/trainers ─────────────────────────────────────────────────
// Body: name, phone, email?, staffTitle?, emergencyContact?, hireDate?
const createTrainer = asyncHandler(async (req, res) => {
    const name = clean(req.body.name);
    const phone = clean(req.body.phone);
    const email = clean(req.body.email) || null;
    const staffTitle = clean(req.body.staffTitle) || 'Trainer';
    const emergencyContact = clean(req.body.emergencyContact) || null;

    if (!name) return fail(req, res, 400, 'Name required', 'MISSING_NAME', 'Name required', 'Trainer name is required.');
    if (!phone) return fail(req, res, 400, 'Phone required', 'MISSING_PHONE', 'Phone required', 'Trainer phone number is required.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return fail(req, res, 400, 'Invalid email', 'INVALID_EMAIL', 'Invalid email', 'The email address is not valid.');
    }

    const hire = parseDate(req.body.hireDate);
    if (hire.error) return fail(req, res, 400, 'Invalid hire date', 'INVALID_HIRE_DATE', 'Invalid date', 'The hire date is not valid.');

    const existing = await prisma.user.findFirst({
        where: { OR: [{ phone }, ...(email ? [{ email }] : [])] },
        select: { id: true },
    });
    if (existing) {
        return fail(req, res, 409, 'Phone or email already in use', 'USER_EXISTS', 'User already exists', 'A user with this phone or email already exists.');
    }

    const deviceSN = env.DEFAULT_DEVICE_SN || req.body.deviceSN;
    if (!deviceSN) {
        return fail(
            req, res, 400,
            'deviceSN required',
            'MISSING_DEVICE_SN',
            'No device configured',
            'No biometric device SN was provided and DEFAULT_DEVICE_SN is not set.'
        );
    }
    const devicePin = await getNextDevicePin();
    const profileImageUrl = req.file ? getFileUrl('profiles', req.file.filename) : null;

    const trainer = await prisma.user.create({
        data: {
            name,
            phone,
            email,
            staffTitle,
            emergencyContact,
            profileImageUrl,
            hireDate: hire.value ?? new Date(),
            role: 'STAFF',
            status: 'ACTIVE',
            devicePin,
            deviceSN,
        },
        select: TRAINER_SELECT,
    });

    res.status(201).json({ trainer: toTrainerDto(trainer) });

    commandQueue.queueCommand(
        deviceSN,
        `DATA UPDATE USERINFO PIN=${devicePin}\tName=${deviceSafeName(name)}\tPri=0\tCard=0\tGrp=${env.DEFAULT_DEVICE_GROUP_ID}`
    ).catch((err) =>
        console.error('queueCommand failed', { trainerId: trainer.id, deviceSN, err })
    );

    sendTrainerWelcomeEmail(email, { name, staffTitle, hireDate: hire.value, phone, devicePin }).catch((err) =>
        console.error('sendTrainerWelcomeEmail failed', { trainerId: trainer.id, email, err })
    );
});

// ── PATCH /api/admin/trainers/:id ────────────────────────────────────────────
// Body (all optional): name, phone, email, staffTitle, emergencyContact, hireDate
const updateTrainer = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const current = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, phone: true, email: true, profileImageUrl: true, deviceSN: true, devicePin: true, name: true } });
    if (!current || current.role !== 'STAFF') return notFound(req, res);

    const name = req.body.name === undefined ? undefined : clean(req.body.name);
    const phone = req.body.phone === undefined ? undefined : clean(req.body.phone);
    const email = req.body.email === undefined ? undefined : (clean(req.body.email) || null);
    const staffTitle = req.body.staffTitle === undefined ? undefined : (clean(req.body.staffTitle) || 'Trainer');
    const emergencyContact = req.body.emergencyContact === undefined ? undefined : (clean(req.body.emergencyContact) || null);

    if (name !== undefined && !name) return fail(req, res, 400, 'Name required', 'MISSING_NAME', 'Name required', 'Trainer name cannot be empty.');
    if (phone !== undefined && !phone) return fail(req, res, 400, 'Phone required', 'MISSING_PHONE', 'Phone required', 'Trainer phone number cannot be empty.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return fail(req, res, 400, 'Invalid email', 'INVALID_EMAIL', 'Invalid email', 'The email address is not valid.');
    }

    const hire = parseDate(req.body.hireDate);
    if (hire.error) return fail(req, res, 400, 'Invalid hire date', 'INVALID_HIRE_DATE', 'Invalid date', 'The hire date is not valid.');

    const conflicts = [];
    if (phone && phone !== current.phone) conflicts.push({ phone });
    if (email && email !== current.email) conflicts.push({ email });
    if (conflicts.length) {
        const existing = await prisma.user.findFirst({
            where: { id: { not: id }, OR: conflicts },
            select: { id: true },
        });
        if (existing) {
            return fail(req, res, 409, 'Phone or email already in use', 'USER_EXISTS', 'User already exists', 'A user with this phone or email already exists.');
        }
    }

    let profileImageUrl;
    const removeImage = req.body.removeProfileImage === true || req.body.removeProfileImage === 'true';
    if (req.file) profileImageUrl = getFileUrl('profiles', req.file.filename);
    else if (removeImage) profileImageUrl = null;

    const trainer = await prisma.user.update({
        where: { id },
        data: { name, phone, email, staffTitle, emergencyContact, hireDate: hire.value, profileImageUrl },
        select: TRAINER_SELECT,
    });

    if (profileImageUrl !== undefined && current.profileImageUrl) {
        deleteProfileImage(current.profileImageUrl);
    }

    res.json({ trainer: toTrainerDto(trainer) });

    if (name && name !== current.name && current.deviceSN && current.devicePin) {
        commandQueue.queueCommand(
            current.deviceSN,
            `DATA UPDATE USERINFO PIN=${current.devicePin}\tName=${deviceSafeName(name)}`
        ).catch((err) =>
            console.error('queueCommand failed', { trainerId: id, deviceSN: current.deviceSN, err })
        );
    }
});

// ── PATCH /api/admin/trainers/:id/status ─────────────────────────────────────
// Body: { suspended: true | false }   (status: 'SUSPENDED' | 'ACTIVE' is also accepted)
const setTrainerStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;

    let suspended = req.body.suspended;
    if (suspended === undefined && req.body.status) suspended = String(req.body.status).toUpperCase() === 'SUSPENDED';
    if (suspended === undefined) {
        return fail(req, res, 400, 'Status required', 'MISSING_STATUS', 'Status required', 'Provide suspended: true or false.');
    }
    suspended = suspended === true || suspended === 'true';

    const current = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, deviceSN: true, devicePin: true } });
    if (!current || current.role !== 'STAFF') return notFound(req, res);

    if (suspended && req.user?.id === id) {
        return fail(req, res, 400, 'Cannot suspend yourself', 'SELF_SUSPEND', 'Not allowed', 'You cannot suspend your own account.');
    }

    const trainer = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
            where: { id },
            data: { status: suspended ? 'SUSPENDED' : 'ACTIVE', blocked: suspended },
            select: TRAINER_SELECT,
        });
        // Suspended trainers must lose app access immediately
        if (suspended) {
            await tx.rotationToken.updateMany({
                where: { userId: id, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        }
        return updated;
    });

    // Gate device sync is best effort: the DB state above is the source of truth
    if (current.deviceSN && current.devicePin) {
        try {
            if (suspended) await checkinService.blockUserSoft(current.deviceSN, current.devicePin);
            else await checkinService.unblockUser(current.deviceSN, current.devicePin);
        } catch (err) {
            console.error('trainer device sync failed', { id, err });
        }
    }

    res.json({
        trainer: toTrainerDto(trainer),
        message: suspended ? `${current.name} suspended.` : `${current.name} reactivated.`,
    });
});

// ── DELETE /api/admin/trainers/:id ───────────────────────────────────────────
// Members assigned to this trainer are un-assigned (assignedTrainerId = null),
// matching the warning shown in the app. Optional ?reassignTo=<trainerId> moves
// them to another trainer instead.
// Blocked (409) when the trainer authored shared content (workout plans,
// announcements, documents). Suspend them instead.
const deleteTrainer = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reassignTo } = req.query;

    const trainer = await prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true, name: true, profileImageUrl: true, deviceSN: true, devicePin: true },
    });
    if (!trainer || trainer.role !== 'STAFF') return notFound(req, res);

    if (req.user?.id === id) {
        return fail(req, res, 400, 'Cannot delete yourself', 'SELF_DELETE', 'Not allowed', 'You cannot delete your own account.');
    }

    if (reassignTo) {
        if (reassignTo === id) {
            return fail(req, res, 400, 'Invalid reassignment', 'INVALID_REASSIGN', 'Invalid trainer', 'Cannot reassign members to the trainer being deleted.');
        }
        const target = await prisma.user.findFirst({
            where: { id: reassignTo, role: 'STAFF', status: 'ACTIVE' },
            select: { id: true },
        });
        if (!target) {
            return fail(req, res, 400, 'Trainer not found', 'INVALID_TRAINER', 'Invalid trainer', 'The trainer to reassign members to is not available.');
        }
    }

    // Shared content authored by this user has a required FK, so it can't be nulled
    const [plans, announcements, documents] = await Promise.all([
        prisma.workoutPlan.count({ where: { createdById: id } }),
        prisma.announcement.count({ where: { createdById: id } }),
        prisma.document.count({ where: { uploadedById: id } }),
    ]);
    if (plans || announcements || documents) {
        return fail(
            req, res, 409,
            'Trainer owns content',
            'TRAINER_HAS_AUTHORED_CONTENT',
            'Cannot delete trainer',
            `This trainer authored ${plans} workout plan(s), ${announcements} announcement(s) and ${documents} document(s). Suspend them instead, or reassign that content first.`
        );
    }

    let unassigned = 0;
    try {
        await prisma.$transaction(async (tx) => {
            const moved = await tx.user.updateMany({
                where: { assignedTrainerId: id },
                data: { assignedTrainerId: reassignTo || null },
            });
            unassigned = moved.count;

            // Optional FKs pointing at this user
            await tx.user.updateMany({ where: { referredById: id }, data: { referredById: null } });
            await tx.feeRecord.updateMany({ where: { approvedById: id }, data: { approvedById: null } });
            await tx.productOrder.updateMany({ where: { processedById: id }, data: { processedById: null } });
            await tx.deviceCheckInEvent.updateMany({ where: { memberId: id }, data: { memberId: null } });

            // Required FKs owned by the user
            await tx.notification.deleteMany({ where: { userId: id } });
            await tx.attendance.deleteMany({ where: { memberId: id } });

            // RotationToken is onDelete: Cascade
            await tx.user.delete({ where: { id } });
        });
    } catch (err) {
        if (err.code === 'P2003') {
            return fail(req, res, 409, 'Trainer is still referenced', 'TRAINER_DELETE_CONSTRAINT', 'Cannot delete trainer', 'Other records still reference this trainer. Suspend them instead.');
        }
        throw err;
    }

    // Post-commit cleanup is best effort
    if (trainer.deviceSN && trainer.devicePin) {
        checkinService.blockUserHard(trainer.deviceSN, trainer.devicePin).catch((err) =>
            console.error('trainer device removal failed', { id, err })
        );
    }
    if (trainer.profileImageUrl) deleteProfileImage(trainer.profileImageUrl);

    res.json({
        trainer: { id },
        unassignedMembers: unassigned,
        message: `${trainer.name} removed.`,
    });
});

export default {
    getAllTrainers,
    getTrainer,
    createTrainer,
    updateTrainer,
    setTrainerStatus,
    deleteTrainer,
};
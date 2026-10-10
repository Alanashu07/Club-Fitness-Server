import prisma from '../config/db.js';
import checkinService from '../modules/device/checkin.service.js';
import { deleteProfileImage } from '../config/multer.js';

const nonZero = (rows) => rows.filter((r) => r.count > 0);

// Everything that would happen if this user were hard-deleted.
export async function getDeletionImpact(id) {
    const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, role: true, deviceSN: true, devicePin: true, profileImageUrl: true },
    });
    if (!user) return null;

    const [
        plans, announcements, documents,
        feeRecords, feeReminders, userOffers, productOrders, orderItems,
        workoutAssignments, bodyMeasurements, classBookings, equipmentBookings,
        feedback, userBadges, notifications, attendance,
        trainees, referred, approvedFees, processedOrders, checkIns,
    ] = await Promise.all([
        prisma.workoutPlan.count({ where: { createdById: id } }),
        prisma.announcement.count({ where: { createdById: id } }),
        prisma.document.count({ where: { uploadedById: id } }),

        prisma.feeRecord.count({ where: { memberId: id } }),
        prisma.feeReminder.count({ where: { feeRecord: { memberId: id } } }),
        prisma.userOffer.count({ where: { userId: id } }),
        prisma.productOrder.count({ where: { memberId: id } }),
        prisma.orderItem.count({ where: { order: { memberId: id } } }),
        prisma.workoutAssignment.count({ where: { memberId: id } }),
        prisma.bodyMeasurement.count({ where: { memberId: id } }),
        prisma.classBooking.count({ where: { memberId: id } }),
        prisma.equipmentBooking.count({ where: { memberId: id } }),
        prisma.feedback.count({ where: { memberId: id } }),
        prisma.userBadge.count({ where: { userId: id } }),
        prisma.notification.count({ where: { userId: id } }),
        prisma.attendance.count({ where: { memberId: id } }),

        prisma.user.count({ where: { assignedTrainerId: id } }),
        prisma.user.count({ where: { referredById: id } }),
        prisma.feeRecord.count({ where: { approvedById: id } }),
        prisma.productOrder.count({ where: { processedById: id } }),
        prisma.deviceCheckInEvent.count({ where: { memberId: id } }),
    ]);

    const blockers = nonZero([
        { label: 'Workout plans authored', count: plans },
        { label: 'Announcements authored', count: announcements },
        { label: 'Documents uploaded', count: documents },
    ]);

    return {
        user,
        blocked: blockers.length > 0,
        blockedMessage: blockers.length
            ? `This user authored ${plans} workout plan(s), ${announcements} announcement(s) and ${documents} document(s). Reassign or delete them first, or de-activate the user instead.`
            : null,
        blockers,
        willDelete: nonZero([
            { label: 'Fee records', count: feeRecords },
            { label: 'Fee reminders', count: feeReminders },
            { label: 'Offer redemptions', count: userOffers },
            { label: 'Product orders', count: productOrders },
            { label: 'Order items', count: orderItems },
            { label: 'Workout assignments', count: workoutAssignments },
            { label: 'Body measurements', count: bodyMeasurements },
            { label: 'Class bookings', count: classBookings },
            { label: 'Equipment bookings', count: equipmentBookings },
            { label: 'Feedback', count: feedback },
            { label: 'Badges', count: userBadges },
            { label: 'Notifications', count: notifications },
            { label: 'Attendance records', count: attendance },
        ]),
        willDetach: nonZero([
            { label: 'Members that have this user as trainer', count: trainees },
            { label: 'Users referred by this user', count: referred },
            { label: 'Fee records approved by this user', count: approvedFees },
            { label: 'Orders processed by this user', count: processedOrders },
            { label: 'Door check-in events (kept for audit)', count: checkIns },
        ]),
        device: user.deviceSN && user.devicePin
            ? { deviceSN: user.deviceSN, devicePin: user.devicePin }
            : null,
    };
}

// Same steps as the hard-delete API. Never throws for expected failures.
export async function hardDeleteUser(id) {
    const impact = await getDeletionImpact(id);
    if (!impact) {
        return { ok: false, status: 404, code: 'MEMBER_NOT_FOUND', message: 'No member exists with this id.' };
    }
    if (impact.blocked) {
        return { ok: false, status: 409, code: 'MEMBER_HAS_AUTHORED_CONTENT', message: impact.blockedMessage };
    }

    try {
        await prisma.$transaction([
            prisma.user.updateMany({ where: { assignedTrainerId: id }, data: { assignedTrainerId: null } }),
            prisma.user.updateMany({ where: { referredById: id }, data: { referredById: null } }),
            prisma.feeRecord.updateMany({ where: { approvedById: id }, data: { approvedById: null } }),
            prisma.productOrder.updateMany({ where: { processedById: id }, data: { processedById: null } }),
            prisma.deviceCheckInEvent.updateMany({ where: { memberId: id }, data: { memberId: null } }),

            prisma.userOffer.deleteMany({ where: { userId: id } }),
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

            prisma.user.delete({ where: { id } }),
        ]);
    } catch (err) {
        if (err.code === 'P2003') {
            return {
                ok: false, status: 409, code: 'MEMBER_DELETE_CONSTRAINT',
                message: 'Other records still reference this member. De-activate the user instead.',
            };
        }
        throw err;
    }

    // DB delete succeeded: now clean up the device and the profile image.
    const warnings = [];
    if (impact.device) {
        try {
            await checkinService.blockUserHard(impact.device.deviceSN, impact.device.devicePin);
        } catch (err) {
            console.error('blockUserHard failed after delete', { id, err });
            warnings.push(`Could not queue the device removal command for PIN ${impact.device.devicePin}. Remove them from the device manually.`);
        }
    }
    try {
        await deleteProfileImage(impact.user.profileImageUrl);
    } catch (err) {
        console.error('deleteProfileImage failed', { id, err });
    }

    return { ok: true, name: impact.user.name, warnings };
}
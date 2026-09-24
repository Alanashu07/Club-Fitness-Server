import prisma from '../../config/db.js';
import commandQueue from './device-command-queue.service.js';
import env from '../../config/env.js';

// ── block / unblock command builders ────────────────────────────────────────

// Soft block: reassigns the user to a timezone with zero valid access
// windows, instead of flipping IsAuthorize. Keeps the enrolled face template
// intact, and is honored far more consistently across firmware than the
// authorize flag — same code path the device uses for normal scheduling.
// const blockUserSoft = async function (deviceSN, devicePin) {
//     await commandQueue.queueCommand(
//         deviceSN,
//         `DATA UPDATE userauthorize PIN=${devicePin}\tAuthorizeTimeZoneId=${env.BLOCKED_DEVICE_TIME_ZONE_ID}\tAuthorizeDoorId=${env.DEFAULT_DEVICE_DOOR_ID}`
//     );
// };

// Soft block: reassigns the user to the card-only access group, forcing
// card verification at the terminal. Since the member only has a face
// template enrolled (no card), this makes them effectively unable to
// pass, without deleting their face template or touching PIN/timezone.
const blockUserSoft = async function (deviceSN, devicePin) {
    await commandQueue.queueCommand(
        deviceSN,
        `DATA UPDATE USERINFO PIN=${devicePin}\tGrp=${env.BLOCKED_DEVICE_GROUP_ID}`
    );
};

const unblockUser = async function (deviceSN, devicePin) {
    await commandQueue.queueCommand(
        deviceSN,
        `DATA UPDATE USERINFO PIN=${devicePin}\tGrp=${env.DEFAULT_DEVICE_GROUP_ID}`
    );
};

// Hard block: deletes the user record (and face template) from the device.
// Guaranteed to work on any ADMS-compatible firmware, but the member must
// re-enroll their face at the kiosk after being unblocked.
const blockUserHard = async function (deviceSN, devicePin) {
    await commandQueue.queueCommand(deviceSN, `DATA DELETE USERINFO PIN=${devicePin}`);
};

// const unblockUser = async function (deviceSN, devicePin, doorId = env.DEFAULT_DEVICE_DOOR_ID) {
//     await commandQueue.queueCommand(
//         deviceSN,
//         `DATA UPDATE userauthorize PIN=${devicePin}\tAuthorizeTimeZoneId=${env.DEFAULT_DEVICE_TIME_ZONE_ID}\tAuthorizeDoorId=${doorId}`
//     );
// };

// ── the actual decision, called from the ATTLOG push handler ───────────────
const handleCheckInEvent = async function ({ deviceSN, devicePin, eventTime, pendingAuth = false }) {
    const member = await prisma.user.findFirst({
        where: { devicePin, deviceSN },
    });

    if (!member) {
        return logEvent({ deviceSN, devicePin, eventTime, result: 'DENIED', reason: 'unknown_user', pendingAuth });
    }

    if (member.blocked) {
        // Door already opened locally before the block command was applied —
        // log it, re-queue the block as a safety net, and flag for staff.
        await blockUserSoft(deviceSN, devicePin);
        return logEvent({
            deviceSN, devicePin, eventTime, memberId: member.id, pendingAuth,
            result: 'DENIED', reason: 'blocked_but_still_entered',
        });
    }

    const membershipActive = member.role === 'ADMIN' || (member.status === 'ACTIVE' && member.membershipEnd && member.membershipEnd > new Date());

    if (membershipActive) {
        await recordAttendance(member.id, eventTime);
        return logEvent({
            deviceSN, devicePin, eventTime, memberId: member.id, pendingAuth,
            result: 'ALLOWED', reason: 'membership_active',
        });
    }

    // Membership lapsed — flip status if this is the first time we're seeing it.
    if (member.status === 'ACTIVE') {
        await prisma.user.update({ where: { id: member.id }, data: { status: 'EXPIRED' } });
    }

    const graceUsed = member.graceEntriesUsed + 1;
    const graceRemaining = env.GRACE_ENTRIES_ALLOWED - graceUsed;

    if (graceRemaining >= 0) {
        await prisma.user.update({ where: { id: member.id }, data: { graceEntriesUsed: graceUsed } });
        await recordAttendance(member.id, eventTime);

        if (graceRemaining === 0) {
            // last grace entry consumed -> block now so the NEXT attempt fails
            await prisma.user.update({ where: { id: member.id }, data: { blocked: true } });
            await blockUserSoft(deviceSN, devicePin);
        }

        return logEvent({
            deviceSN, devicePin, eventTime, memberId: member.id, pendingAuth,
            result: 'ALLOWED', reason: `grace_entry_${graceUsed}_of_${env.GRACE_ENTRIES_ALLOWED}`,
        });
    }

    // Grace exhausted and a scan still got through (race with the block command) —
    // block defensively and deny.
    await prisma.user.update({ where: { id: member.id }, data: { blocked: true } });
    await blockUserSoft(deviceSN, devicePin);
    return logEvent({
        deviceSN, devicePin, eventTime, memberId: member.id, pendingAuth,
        result: 'DENIED', reason: 'grace_exhausted',
    });
};

const recordAttendance = async function (memberId, checkInAt) {
    await prisma.attendance.create({ data: { memberId, checkInAt, method: 'FACE' } });
};

const logEvent = async function ({ deviceSN, devicePin, eventTime, memberId = null, result, reason, pendingAuth }) {
    const event = await prisma.deviceCheckInEvent.create({
        data: { deviceSN, devicePin, eventTime, memberId, result, reason, pendingAuth },
    });
    console.log(`[CHECK-IN] pin=${devicePin} -> ${result} (${reason})`);
    return event;
};

export default {
    handleCheckInEvent,
    blockUserSoft,
    blockUserHard,
    unblockUser,
};
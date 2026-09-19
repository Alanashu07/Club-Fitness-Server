import cron from 'node-cron'; // npm i node-cron
import prisma from '../config/db.js';
import checkinService from '../modules/device/checkin.service.js';
import env from '../config/env.js';

const GRACE_ENTRIES_ALLOWED = env.GRACE_ENTRIES_ALLOWED;

// Only needed when GRACE_ENTRIES_ALLOWED = 0 (block immediately on expiry).
// With grace entries enabled, handleCheckInEvent already blocks on the 3rd
// post-expiry scan — this job is redundant in that mode and exits early.
export const startMembershipExpiryJob = function () {
    cron.schedule('*/15 * * * *', async () => {
        if (GRACE_ENTRIES_ALLOWED > 0) return;

        const expiredMembers = await prisma.user.findMany({
            where: {
                role: 'MEMBER',
                blocked: false,
                membershipEnd: { lt: new Date() },
                devicePin: { not: null },
            },
        });

        for (const member of expiredMembers) {
            await prisma.user.update({
                where: { id: member.id },
                data: { status: 'EXPIRED', blocked: true },
            });
            await checkinService.blockUserSoft(member.deviceSN, member.devicePin);
            console.log(`[CRON] Auto-blocked expired membership: ${member.name}`);
        }
    });
};
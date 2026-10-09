import cron from 'node-cron'; // npm i node-cron
import prisma from '../config/db.js';
import checkinService from '../modules/device/checkin.service.js';
import env from '../config/env.js';
import memberController from '../modules/members/members.controller.js';
import { runMembershipEmailJobs } from './membership-reminder.js';

// Only needed when GRACE_ENTRIES_ALLOWED = 0 (block immediately on expiry).
// With grace entries enabled, handleCheckInEvent already blocks on the 3rd
// post-expiry scan — this job is redundant in that mode and exits early.

export const startCronJob = function () {
    cron.schedule('*/15 * * * *', async () => {
        await expireMemberships();
        const applied = await memberController.applyDueRenewals();
        if (applied) console.log(`[CRON] Applied ${applied} renewals`);
        await runMembershipEmailJobs();
    })
}

const expireMemberships = async function () {
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
};
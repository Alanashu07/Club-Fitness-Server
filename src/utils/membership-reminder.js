import prisma from '../config/db.js';
import { sendExpiryReminderEmail, sendExpiredNoticeEmail } from './mailer.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REMINDER_WINDOW_HOURS = 24; // remind this long before expiry
const OVERDUE_LOOKBACK_DAYS = 3;  // don't email members who expired longer ago than this

// A renewal that has been recorded but not yet applied to the membership.
// Adjust if your applyDueRenewals() uses a different definition.
const PENDING_RENEWAL = { appliedAt: null, periodStart: { not: null } };

// ── 1. Reminder: 24h before expiry, only if no renewal is scheduled ─────────
export async function sendExpiryReminders() {
  const now = new Date();
  const members = await prisma.user.findMany({
    where: {
      role: 'MEMBER',
      status: 'ACTIVE',
      email: { not: null },
      membershipPlanId: { not: null },
      membershipEnd: { gt: now, lte: new Date(now.getTime() + REMINDER_WINDOW_HOURS * HOUR) },
      feeRecords: { none: PENDING_RENEWAL },
    },
    include: { membershipPlan: true },
  });

  let sent = 0;
  for (const m of members) {
    // already reminded for this expiry date
    if (m.expiryReminderSentFor?.getTime() === m.membershipEnd.getTime()) continue;

    try {
      await sendExpiryReminderEmail(m, now);
      sent++;
    } catch (err) {
      // not marked as sent, so the next 15-min run retries
      console.error(`[CRON] Expiry reminder failed for ${m.name}:`, err.message);
    }
  }
  return sent;
}

// ── 2. Overdue: after expiry, only if no renewal is scheduled ───────────────
export async function sendExpiredNotices() {
  const now = new Date();
  const members = await prisma.user.findMany({
    where: {
      role: 'MEMBER',
      status: { in: ['ACTIVE', 'EXPIRED'] },
      email: { not: null },
      membershipPlanId: { not: null },
      membershipEnd: { lt: now, gte: new Date(now.getTime() - OVERDUE_LOOKBACK_DAYS * DAY) },
      feeRecords: { none: PENDING_RENEWAL },
    },
    include: { membershipPlan: true },
  });

  let sent = 0;
  for (const m of members) {
    if (m.expiredEmailSentFor?.getTime() === m.membershipEnd.getTime()) continue;

    try {
      await sendExpiredNoticeEmail(m, now);
      sent++;
    } catch (err) {
      console.error(`[CRON] Expired notice failed for ${m.name}:`, err.message);
    }
  }
  return sent;
}

// ── Entry point for the cron ────────────────────────────────────────────────
export async function runMembershipEmailJobs() {
  try {
    const reminders = await sendExpiryReminders();
    if (reminders) console.log(`[CRON] Sent ${reminders} expiry reminders`);
  } catch (err) {
    console.error('[CRON] Expiry reminders job failed:', err);
  }

  try {
    const expired = await sendExpiredNotices();
    if (expired) console.log(`[CRON] Sent ${expired} expired notices`);
  } catch (err) {
    console.error('[CRON] Expired notices job failed:', err);
  }
}
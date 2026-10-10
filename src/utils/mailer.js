import Mustache from 'mustache';
import { loadTemplate } from './load-template.js'; // adjust path to match your project
import { sendEmail } from '../config/brevo.js'; // adjust path to match your project
import env from '../config/env.js'; // adjust path to match your project
import { fileURLToPath } from 'url';
import path from 'path';
import prisma from '../config/db.js';

const OTP_TEMPLATE_PATH = '../components/otp-template.html';
const WELCOME_TEMPLATE_PATH = '../components/welcome-template.html';
const RENEW_TEMPLATE_PATH = '../components/renew-membership-template.html';
const FEE_OVERDUE_TEMPLATE_PATH = '../components/fee-overdue-template.html';
const FEE_REMINDER_TEMPLATE_PATH = '../components/fee-reminder-template.html';

// ── sendOtpEmail: renders the Mustache template and dispatches via Brevo ─────
const sendOtpEmail = async function (toEmail, otp, { name, ttlMinutes = 5 } = {}) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const template = await loadTemplate(OTP_TEMPLATE_PATH, __dirname);

    const html = Mustache.render(template, {
        name: name || 'there',
        otp,
        expiry: ttlMinutes,
        year: new Date().getFullYear(),
        logo_url: env.LOGO_TRANSPARENT,
    });

    const sent = await sendEmail({
        to: toEmail,
        subject: `${otp} is your verification code`,
        html,
        text: `Your verification code is ${otp}. It expires in ${ttlMinutes} minutes.`,
    });

    if (!sent) {
        throw new Error('Failed to send OTP email');
    }
};

const sendWelcomeEmail = async function (
    toEmail,
    {
        name,
        planName,
        planAmount,
        memberId,
        ctaUrl,
        ctaLabel = 'Complete Your Profile',
        supportEmail = env.SUPPORT_EMAIL,
        supportPhone = env.SUPPORT_PHONE,
        gymAddress = env.GYM_ADDRESS,
        instagramUrl = env.INSTAGRAM_URL,
        facebookUrl = env.FACEBOOK_URL
    } = {}
) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const template = await loadTemplate(WELCOME_TEMPLATE_PATH, __dirname);

    const html = Mustache.render(template, {
        name: name || 'there',
        plan_name: planName || 'Standard Membership',
        plan_amount: planAmount || '0.0',
        member_id: memberId || 'N/A',
        cta_url: ctaUrl || env.APP_URL,
        cta_label: ctaLabel,
        support_email: supportEmail,
        support_phone: supportPhone,
        gym_address: gymAddress,
        instagram_url: instagramUrl,
        facebook_url: facebookUrl,
        year: new Date().getFullYear(),
        logo_url: env.LOGO_TRANSPARENT,
    });

    const sent = await sendEmail({
        to: toEmail,
        subject: `Welcome to ClubFitness, ${name || 'there'}! Your membership is active 💪`,
        html,
        text: `Welcome to ClubFitness, ${name || 'there'}!\n\nYour ${planName || 'membership'} is now active (Member ID: ${memberId || 'N/A'}).\n\nGet started: ${ctaUrl || env.APP_URL}\n\nQuestions? Contact us at ${supportEmail} or ${supportPhone}.`,
    });

    if (!sent) {
        throw new Error('Failed to send welcome email');
    }
};

const fmtDate = (d) =>
    new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });


// ── 3. Add these NEW helpers + functions (e.g. after sendFeeOverdueEmail) ───
const fmtDateTime = (d) =>
    new Date(d).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
    });

const fmtMoney = (n) =>
    Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const METHOD_LABELS = { CASH: 'Cash', UPI: 'UPI', BANK_TRANSFER: 'Bank Transfer', OTHER: 'Other' };

const sendRenewalEmail = async function (feeRecordId) {
    const fee = await prisma.feeRecord.findUnique({
        where: { id: feeRecordId },
        include: { member: true, plan: true, userOffer: true },
    });

    if (!fee) throw new Error(`FeeRecord ${feeRecordId} not found`);
    if (!fee.member.email) {
        console.warn(`Member ${fee.member.id} has no email, skipping`);
        return null;
    }

    const periodStart = fee.periodStart ?? fee.member.membershipStart;
    const periodEnd = fee.periodEnd ?? fee.member.membershipEnd;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const template = await loadTemplate(RENEW_TEMPLATE_PATH, __dirname);

    const html = Mustache.render(template, {
        logo_url: env.LOGO_URL,
        name: fee.member.name,
        plan_name: fee.plan.name,
        plan_amount: fmtMoney(fee.paidAmount ?? fee.amount),
        member_id: fee.member.id,
        payment_method: fee.paymentMethod ? METHOD_LABELS[fee.paymentMethod] : null,
        period_start: fmtDate(periodStart),
        period_end: fmtDate(periodEnd),

        // Optional discount rows (hidden when there is no offer)
        offer_name: fee.userOffer?.offerName ?? null,
        original_amount: fee.userOffer ? fmtMoney(fee.userOffer.originalAmount) : null,
        discount_amount: fee.userOffer ? fmtMoney(fee.userOffer.discountAmount) : null,

        cta_url: `${env.APP_URL}/workout/member`,
        cta_label: 'Check your workouts',
        support_email: env.SUPPORT_EMAIL,
        support_phone: env.SUPPORT_PHONE,
        instagram_url: env.INSTAGRAM_URL,
        facebook_url: env.FACEBOOK_URL,
        year: new Date().getFullYear(),
        gym_address: env.GYM_ADDRESS,
    });

    await sendEmail({
        to: fee.member.email,
        subject: `Membership renewed – valid until ${fmtDate(periodEnd)} 🔥`,
        html,
        text: `Hi ${fee.member.name}, your ${fee.plan.name} membership has been renewed and is valid until ${fmtDate(periodEnd)}. Thank you!`,
    });
}

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

const daysLeftLabel = (days) =>
    days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;

// Fields shared by both templates
function baseVars(fee) {
    const paid = Number(fee.paidAmount ?? 0);
    const due = Number(fee.amount) - paid;
    return {
        logo_url: env.LOGO_URL,
        name: fee.member.name,
        plan_name: fee.plan.name,
        member_id: fee.member.id,
        due_date: fmtDate(fee.dueDate),
        amount_due: fmtMoney(due),
        paid_amount: paid > 0 ? fmtMoney(paid) : null, // shown only for partial payments
        upi_id: env.UPI_ID,
        cta_url: `${env.APP_URL}/payments/${fee.id}`,
        cta_label: 'Pay Now',
        support_email: env.SUPPORT_EMAIL,
        support_phone: env.SUPPORT_PHONE,
        instagram_url: env.INSTAGRAM_URL,
        facebook_url: env.FACEBOOK_URL,
        year: new Date().getFullYear(),
        gym_address: env.GYM_ADDRESS,
    };
}

function membershipBaseVars(member) {
    return {
        logo_url: env.LOGO_URL,
        name: member.name,
        plan_name: member.membershipPlan.name,
        member_id: member.id,
        amount_due: fmtMoney(member.membershipPlan.price), // renewal cost = current plan price
        paid_amount: null,
        upi_id: env.UPI_ID,
        cta_url: `${env.APP_URL}/renew`,
        cta_label: 'Renew Now',
        support_email: env.SUPPORT_EMAIL,
        support_phone: env.SUPPORT_PHONE,
        instagram_url: env.INSTAGRAM_URL,
        facebook_url: env.FACEBOOK_URL,
        year: new Date().getFullYear(),
        gym_address: env.GYM_ADDRESS,
    };
}

async function loadFee(feeRecordId) {
    const fee = await prisma.feeRecord.findUnique({
        where: { id: feeRecordId },
        include: { member: true, plan: true },
    });
    if (!fee) throw new Error(`FeeRecord ${feeRecordId} not found`);
    if (['PAID', 'WAIVED'].includes(fee.status)) return null; // nothing to chase
    if (!fee.member.email) {
        console.warn(`Member ${fee.member.id} has no email, skipping`);
        return null;
    }
    return fee;
}

async function deliverMembershipMail(member, { subject, html, text, sentField, automatic = true}) {
    const sent = await sendEmail({ to: member.email, subject, html, text });
    if (!sent) throw new Error(`Failed to send "${subject}" to ${member.email}`);

    const latestFee = await prisma.feeRecord.findFirst({
        where: { memberId: member.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
    });

    const operations = [
        prisma.user.update({
            where: { id: member.id },
            data: { [sentField]: member.membershipEnd }, // dedupe key = the expiry date it was sent for
        }),
        prisma.notification.create({
            data: { userId: member.id, title: subject, body: text, channel: 'EMAIL' },
        }),
    ];

    if (latestFee) {
        operations.push(
            prisma.feeReminder.create({
                data: { feeRecordId: latestFee.id, channel: 'EMAIL', automatic },
            })
        );
    } else {
        console.warn(`Member ${member.id} has no fee record, skipping FeeReminder log`);
    }

    await prisma.$transaction(operations);
    console.log(`Sent "${subject}" to ${member.email}`);
}

// Send + log in FeeReminder
async function deliver(fee, { subject, html, text, automatic }) {
    const sent = await sendEmail({
        to: fee.member.email,
        subject: subject,
        html,
        text: text,
    });
    if (!sent) throw new Error(`Failed to send "${subject}" to ${fee.member.email}`);
    await prisma.$transaction([
        prisma.feeReminder.create({
            data: { feeRecordId: fee.id, channel: 'EMAIL', automatic },
        }),
        prisma.notification.create({
            data: {
                userId: fee.member.id,
                title: subject,
                body: text,
                channel: 'EMAIL',
            },
        }),
    ]);
    console.log(`Sent "${subject}" to ${fee.member.email}`);
}

const overdueText = (days) =>
    days > 0 ? `${days} ${days === 1 ? 'day' : 'days'} ago` : null;

async function sendFeeReminderEmail(feeRecordId, { automatic = true } = {}) {
    const fee = await loadFee(feeRecordId);
    if (!fee) return null;

    const daysLeft = daysBetween(new Date(), fee.dueDate);
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const template = await loadTemplate(FEE_REMINDER_TEMPLATE_PATH, __dirname);
    const html = Mustache.render(template, {
        ...baseVars(fee),
        days_left_label: daysLeftLabel(daysLeft),
    });

    return deliver(fee, {
        subject: `Reminder: your fee is due ${daysLeftLabel(daysLeft)} ⏰`,
        html,
        text: `Hi ${fee.member.name}, your ${fee.plan.name} fee of ₹${fmtMoney(Number(fee.amount) - Number(fee.paidAmount ?? 0))} is due on ${fmtDate(fee.dueDate)}.`,
        automatic,
    });
}

// ── 2. Overdue (after the due date) ─────────────────────────────────────────
async function sendFeeOverdueEmail(feeRecordId, { automatic = true } = {}) {
    const fee = await loadFee(feeRecordId);
    if (!fee) return null;

    const daysOverdue = Math.max(daysBetween(fee.dueDate, new Date()), 1);
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const template = await loadTemplate(FEE_OVERDUE_TEMPLATE_PATH, __dirname);
    const html = Mustache.render(template, {
        ...baseVars(fee),
        days_overdue_text: overdueText(daysOverdue),
    });

    return deliver(fee, {
        subject: `Action needed: your fee is ${daysOverdue} day${daysOverdue > 1 ? 's' : ''} overdue`,
        html,
        text: `Hi ${fee.member.name}, your ${fee.plan.name} fee was due on ${fmtDate(fee.dueDate)} and is still unpaid. Please pay as soon as possible.`,
        automatic,
    });
}

function formatHour(hoursLeft) {
    if(hoursLeft <= 1) return 'an hour';
    if(hoursLeft <= 24) return `${hoursLeft} hours`;
    const days = Math.floor(hoursLeft / 24);
    if(days === 1) return 'a day';
    if(days <= 30) return `${days} days`;
    const months = Math.floor(days / 30);
    if(months === 1) return 'a month';
    return `${months} months`;
}

async function sendExpiryReminderEmail(member, now = new Date(), { automatic = true } = {}) {
    const hoursLeft = Math.max(Math.ceil((member.membershipEnd - now) / (60 * 60 * 1000)), 1);
    const label = hoursLeft <= 1 ? 'within an hour' : `in about ${formatHour(hoursLeft)}`;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const template = await loadTemplate(FEE_REMINDER_TEMPLATE_PATH, __dirname);
    const html = Mustache.render(template, {
        ...membershipBaseVars(member),
        due_date: fmtDateTime(member.membershipEnd),
        days_left_label: label,
    });

    return deliverMembershipMail(member, {
        sentField: 'expiryReminderSentFor',
        subject: `Your membership expires ${label} ⏰`,
        automatic,
        html,
        text: `Hi ${member.name}, your ${member.membershipPlan.name} membership expires on ${fmtDateTime(member.membershipEnd)}. Renew to keep your access.`,
    });
}

async function sendExpiredNoticeEmail(member, now = new Date(), { automatic = true } = {}) {
    const daysOverdue = Math.floor((now - member.membershipEnd) / DAY); // 0 on the first day; template hides it then

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const template = await loadTemplate(FEE_OVERDUE_TEMPLATE_PATH, __dirname);
    const html = Mustache.render(template, {
        ...membershipBaseVars(member),
        due_date: fmtDate(member.membershipEnd),
        days_overdue_text: overdueText(daysOverdue),
    });

    return deliverMembershipMail(member, {
        sentField: 'expiredEmailSentFor',
        subject: 'Your membership has expired – renew to continue',
        automatic,
        html,
        text: `Hi ${member.name}, your ${member.membershipPlan.name} membership expired on ${fmtDate(member.membershipEnd)}. Please renew to continue using the gym.`,
    });
}

export {
    sendOtpEmail, sendWelcomeEmail, sendRenewalEmail,
    sendFeeReminderEmail, sendFeeOverdueEmail,
    sendExpiryReminderEmail, sendExpiredNoticeEmail,
};
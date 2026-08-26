import Mustache from 'mustache';
import { loadTemplate } from './load-template.js'; // adjust path to match your project
import { sendEmail } from '../config/brevo.js'; // adjust path to match your project
import env from '../config/env.js'; // adjust path to match your project
import { fileURLToPath } from 'url';
import path from 'path';

const OTP_TEMPLATE_PATH = '../components/otp-template.html';
const WELCOME_TEMPLATE_PATH = '../components/welcome-template.html';

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

export { sendOtpEmail, sendWelcomeEmail };
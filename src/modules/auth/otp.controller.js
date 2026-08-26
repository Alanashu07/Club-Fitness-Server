import prisma from '../../config/db.js';
import { hashPassword, comparePassword } from '../../utils/password.js';
import { generateTokenSet } from '../../utils/jwt.js';
import { sendOtpEmail } from '../../utils/mailer.js';
import { generateOtp } from '../../utils/generate-otp.js';
import { sendMsg91Otp, verifyMsg91Otp, normalizePhone } from '../../utils/msg-utils.js';

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

const PUBLIC_USER_FIELDS = {
    id: true,
    name: true,
    email: true,
    phone: true,
    role: true,
    status: true,
    profileImageUrl: true,
    membershipPlanId: true,
    membershipEnd: true,
};

// ── helper: persist a freshly-issued rotation token (mirrors auth.controller.js) ──
const persistRotationToken = async function (rotationToken, userId) {
    const { decodeToken } = await import('../../utils/jwt.js');
    const payload = decodeToken(rotationToken);
    await prisma.rotationToken.create({
        data: {
            tokenId: payload.tokenId,
            userId,
            expiresAt: new Date(payload.exp * 1000),
        },
    });
};

// ── POST /api/auth/otp/request ──────────────────────────────────────────────
// Body: { email }
const requestEmailOtp = async function (req, res, next) {
    try {
        const { email } = req.body;
        if (!email) {
            const failure = { title: "Missing email", message: "An email is required to request an OTP.", code: 400 };
            return res.status(400).json({ error: 'email is required', code: 'MISSING_EMAIL', failure });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Cooldown: block rapid resend requests for the same email
        const recent = await prisma.otpToken.findFirst({
            where: { email: normalizedEmail, consumedAt: null },
            orderBy: { createdAt: 'desc' },
        });
        if (recent) {
            const secondsSinceLast = (Date.now() - recent.createdAt.getTime()) / 1000;
            if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
                return res.status(429).json({
                    error: `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast)}s before requesting another code`,
                    code: 'OTP_COOLDOWN',
                });
            }
        }

        // Invalidate any previous unconsumed OTPs for this email
        await prisma.otpToken.updateMany({
            where: { email: normalizedEmail, consumedAt: null },
            data: { consumedAt: new Date() },
        });

        const otp = generateOtp(6);
        const otpHash = await hashPassword(otp);

        await prisma.otpToken.create({
            data: {
                email: normalizedEmail,
                otpHash,
                expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
            },
        });

        // Personalize with existing name if this email already belongs to a user
        const existingUser = await prisma.user.findFirst({
            where: { email: normalizedEmail },
            select: { name: true },
        });

        if (existingUser) {
            await sendOtpEmail(normalizedEmail, otp, { name: existingUser?.name, ttlMinutes: OTP_TTL_MINUTES });
        }

        // Deliberately generic response — don't reveal whether the email is registered
        return res.status(200).json({ message: 'If the email is valid, a verification code has been sent' });
    } catch (err) {
        next(err);
    }
};

// ── POST /api/auth/otp/verify ────────────────────────────────────────────────
// Body: { email, otp, name?, phone? } → name/phone only used on first-time signup
const verifyEmailOtp = async function (req, res, next) {
    try {
        const { email, otp, name, phone } = req.body;
        if (!email || !otp) {
            const failure = { title: "Missing email or OTP", message: "An email and OTP are required to verify.", code: 400 };
            return res.status(400).json({ error: 'email and otp are required', code: 'MISSING_FIELDS', failure });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const record = await prisma.otpToken.findFirst({
            where: { email: normalizedEmail, consumedAt: null },
            orderBy: { createdAt: 'desc' },
        });

        if (!record) {
            const failure = { title: "No active code for this email", message: "Please request a new code.", code: 400 };
            return res.status(400).json({ error: 'No active code for this email', code: 'OTP_NOT_FOUND', failure });
        }

        if (record.expiresAt < new Date()) {
            const failure = { title: "Code has expired", message: "Please request a new code.", code: 400 };
            return res.status(400).json({ error: 'Code has expired', code: 'OTP_EXPIRED', failure });
        }

        if (record.attempts >= MAX_ATTEMPTS) {
            const failure = { title: "Too many incorrect attempts", message: "Please request a new code.", code: 400 };
            return res.status(429).json({ error: 'Too many incorrect attempts, request a new code', code: 'OTP_LOCKED', failure });
        }

        const matches = await comparePassword(otp, record.otpHash);
        if (!matches) {
            await prisma.otpToken.update({
                where: { id: record.id },
                data: { attempts: { increment: 1 } },
            });
            const failure = { title: "Incorrect code", message: "Please try again.", code: 401 };
            return res.status(401).json({ error: 'Incorrect code', code: 'OTP_INVALID', failure });
        }

        await prisma.otpToken.update({
            where: { id: record.id },
            data: { consumedAt: new Date() },
        });

        // Find-or-create user — this endpoint doubles as passwordless signup
        let user = await prisma.user.findFirst({ where: { email: normalizedEmail } });

        if (!user) {
            user = await prisma.user.create({
                data: {
                    email: normalizedEmail,
                    name: name || normalizedEmail.split('@')[0],
                    phone: phone || null,
                },
                select: PUBLIC_USER_FIELDS,
            });
        } else {
            if (user.status === 'SUSPENDED') {
                const failure = { title: "Account suspended", message: "Please contact support.", code: 403 };
                return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED', failure });
            }
            const { passwordHash, ...safeUser } = user;
            user = safeUser;
        }

        const tokens = generateTokenSet({ id: user.id, role: user.role });
        await persistRotationToken(tokens.rotationToken, user.id);

        return res.status(200).json({ user, ...tokens });
    } catch (err) {
        next(err);
    }
};

const requestPhoneOtp = async function (req, res, next) {
    try {
        const { phone } = req.body;
        if (!phone) {
            const failure = { title: "Missing phone number", message: "A phone number is required to request an OTP.", code: 400 };
            return res.status(400).json({ error: 'phone is required', code: 'MISSING_PHONE', failure });
        }

        const existingUser = await prisma.user.findFirst({ where: { phone } });
        if (existingUser && existingUser.status === 'SUSPENDED') {
            return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
        }

        try {
            await sendMsg91Otp(phone);
        } catch (err) {
            return res.status(502).json({ error: 'Failed to send OTP', code: 'MSG91_SEND_FAILED' });
        }

        return res.status(200).json({ message: 'OTP sent', phone });
    } catch (err) {
        next(err);
    }
};

const verifyPhoneOtp = async function (req, res, next) {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) {
            return res.status(400).json({ error: 'phone and otp are required', code: 'MISSING_FIELDS' });
        }

        let isValid;
        try {
            isValid = await verifyMsg91Otp(phone, otp);
        } catch (err) {
            return res.status(502).json({ error: 'OTP verification service error', code: 'MSG91_VERIFY_FAILED' });
        }

        if (!isValid) {
            return res.status(401).json({ error: 'Invalid or expired OTP', code: 'INVALID_OTP' });
        }

        let user = await prisma.user.findFirst({ where: { phone } });

        if (!user) {
            user = await prisma.user.create({
                data: {
                    phone,
                    name: `User ${phone.slice(-4)}`, // placeholder until user sets their real name
                },
                select: PUBLIC_USER_FIELDS,
            });
        } else {
            if (user.status === 'SUSPENDED') {
                return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
            }

            const { passwordHash, firebaseUid, ...safeUser } = user;
            user = safeUser;
        }

        const tokens = generateTokenSet({ id: user.id, role: user.role });
        await persistRotationToken(tokens.rotationToken, user.id);

        return res.status(200).json({ user, ...tokens });
    } catch (err) {
        next(err);
    }
};

export default {
    requestEmailOtp,
    verifyEmailOtp,
    requestPhoneOtp,
    verifyPhoneOtp
};
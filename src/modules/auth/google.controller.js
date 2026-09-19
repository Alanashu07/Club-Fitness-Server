import prisma from '../../config/db.js';
import { generateTokenSet, decodeToken } from '../../utils/jwt.js';
import { sendWelcomeEmail } from '../../utils/mailer.js';
import { verifyGoogleIdToken } from '../../utils/google-auth.js';

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
    const payload = decodeToken(rotationToken);
    await prisma.rotationToken.create({
        data: {
            tokenId: payload.tokenId,
            userId,
            expiresAt: new Date(payload.exp * 1000),
        },
    });
};

// ── POST /api/auth/google ────────────────────────────────────────────────────
// Body: { idToken } → ID token obtained from google_sign_in on the Flutter side
const googleLogin = async function (req, res, next) {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ error: 'idToken is required', code: 'MISSING_ID_TOKEN' });
        }

        let payload;
        try {
            payload = await verifyGoogleIdToken(idToken);
        } catch (err) {
            return res.status(401).json({ error: 'Invalid Google token', code: 'INVALID_GOOGLE_TOKEN' });
        }

        if (!payload.email_verified) {
            return res.status(401).json({ error: 'Google email not verified', code: 'GOOGLE_EMAIL_UNVERIFIED' });
        }

        const normalizedEmail = payload.email.trim().toLowerCase();

        let user = await prisma.user.findFirst({ where: { email: normalizedEmail } });

        if (!user) {
            // First time signing in — create a new account, no password set
            user = await prisma.user.create({
                data: {
                    email: normalizedEmail,
                    name: payload.name || normalizedEmail.split('@')[0],
                    profileImageUrl: payload.picture || null,
                    googleId: payload.sub,
                    phone: '',
                },
                select: PUBLIC_USER_FIELDS,
            });
            await sendWelcomeEmail(user.email, {name: user.name, memberId: user.id});
            // const failure = { title: "Account not found", message: "No Account with this email found. Please continue with Phone number instead.", code: 403 };
            // return res.status(403).json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND', failure: failure });
        } else {
            if (user.status === 'SUSPENDED') {
                return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
            }

            if (!user.googleId) {
                // Existing email/password account — link Google as an additional sign-in method
                user = await prisma.user.update({
                    where: { id: user.id },
                    data: { googleId: payload.sub },
                    select: PUBLIC_USER_FIELDS,
                });
            } else {
                const { passwordHash, googleId, ...safeUser } = user;
                user = safeUser;
            }
        }

        const tokens = generateTokenSet({ id: user.id, role: user.role });
        await persistRotationToken(tokens.rotationToken, user.id);

        return res.status(200).json({ user, ...tokens });
    } catch (err) {
        next(err);
    }
};

export default { googleLogin };
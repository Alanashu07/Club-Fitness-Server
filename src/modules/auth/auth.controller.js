import prisma from '../../config/db.js';
import { hashPassword, comparePassword, validatePassword } from '../../utils/password.js';
import {
    generateTokenSet,
    generateAccessToken,
    generateRefreshToken,
    verifyToken,
    decodeToken,
} from '../../utils/jwt.js';

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

// ── helper: persist a freshly-issued rotation token so it can be revoked later ──
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

// ── helper: load a rotation token row and make sure it's still usable ──────────
const getActiveRotationRecord = async function (tokenId) {
    const record = await prisma.rotationToken.findUnique({ where: { tokenId } });
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt < new Date()) return null;
    return record;
};

// ── POST /api/auth/register ─────────────────────────────────────────────────
const register = async function (req, res, next) {
    try {
        const { name, phone, email, password } = req.body;

        if (!validatePassword(password)) {
            return res.status(400).json({
                error: 'Password must be at least 8 characters and include uppercase, lowercase, and a number',
                code: 'WEAK_PASSWORD',
            });
        }

        const existing = await prisma.user.findFirst({
            where: { OR: [{ phone }, ...(email ? [{ email }] : [])] },
            select: { id: true },
        });
        if (existing) {
            return res.status(409).json({ error: 'Phone or email already in use', code: 'USER_EXISTS' });
        }

        const passwordHash = await hashPassword(password);

        const user = await prisma.user.create({
            data: { name, phone, email, passwordHash },
            select: PUBLIC_USER_FIELDS,
        });

        const tokens = generateTokenSet({ id: user.id, role: user.role });
        await persistRotationToken(tokens.rotationToken, user.id);

        return res.status(201).json({ user, ...tokens });
    } catch (err) {
        next(err);
    }
};

// ── POST /api/auth/login ────────────────────────────────────────────────────
const login = async function (req, res, next) {
    try {
        const { identifier, password } = req.body;

        const user = await prisma.user.findFirst({
            where: { OR: [{ phone: identifier }, { email: identifier }] },
        });

        if (!user || !user.passwordHash) {
            return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        }

        const passwordMatches = await comparePassword(password, user.passwordHash);
        if (!passwordMatches) {
            return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        }

        if (user.status === 'SUSPENDED') {
            return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
        }

        const tokens = generateTokenSet({ id: user.id, role: user.role });
        await persistRotationToken(tokens.rotationToken, user.id);

        const { passwordHash, ...safeUser } = user;

        return res.status(200).json({ user: safeUser, ...tokens });
    } catch (err) {
        next(err);
    }
};

// ── POST /api/auth/refresh ──────────────────────────────────────────────────
// Body: { refreshToken } → short-lived renewal, no DB hit, no rotation.
const refresh = async function (req, res, next) {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            const failure = { title: "Missing refresh token", message: "A refresh token is required to refresh your session. Please login again.", code: 400 };
            return res.status(400).json({ error: 'refreshToken is required', code: 'MISSING_REFRESH_TOKEN', failure });
        }

        let payload;
        try {
            payload = verifyToken(refreshToken, 'refresh');
        } catch (err) {
            const code = err.message === 'Token expired' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
            const failure = { title: "Invalid or expired refresh token", message: "Your session has expired. Please login again.", code: 401 };
            return res.status(401).json({ error: 'Invalid or expired refresh token', code, failure });
        }

        const user = await prisma.user.findUnique({
            where: { id: payload.id },
            select: { id: true, role: true, status: true },
        });

        if (!user || user.status === 'SUSPENDED') {
            const failure = { title: "Ineligible user", message: "Your account is no longer eligible. Please contact support.", code: 401 };
            return res.status(401).json({ error: 'User no longer eligible', code: 'USER_INELIGIBLE', failure });
        }

        const accessToken = generateAccessToken({ id: user.id, role: user.role });
        const newRefreshToken = generateRefreshToken({ id: user.id, role: user.role });

        return res.status(200).json({ accessToken, refreshToken: newRefreshToken });
    } catch (err) {
        next(err);
    }
};

// ── POST /api/auth/rotate ───────────────────────────────────────────────────
// Body: { rotationToken } → use when access+refresh have both expired
// (e.g. user reopens the app after days away). One-time use: the old
// rotation token is revoked and a brand new full token set is issued.
const rotate = async function (req, res, next) {
    try {
        const { rotationToken } = req.body;
        if (!rotationToken) {
            const failure = { title: "Missing rotation token", message: "A rotation token is required to refresh your session. Please login again.", code: 400 };
            return res.status(400).json({ error: 'rotationToken is required', code: 'MISSING_ROTATION_TOKEN', failure });
        }

        let payload;
        try {
            payload = verifyToken(rotationToken, 'rotation');
        } catch (err) {
            const code = err.message === 'Token expired' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
            const failure = { title: "Invalid or expired rotation token", message: "Your session has expired. Please login again.", code: 401 };
            return res.status(401).json({ error: 'Invalid or expired rotation token', code, failure });
        }

        const record = await getActiveRotationRecord(rotationToken);
        if (!record) {
            // Either revoked (blacklisted/logged out) or unknown — treat the same.
            const failure = { title: "Revoked rotation token", message: "Your session has been revoked. Please login again.", code: 401 };
            return res.status(401).json({ error: 'Rotation token has been revoked', code: 'ROTATION_TOKEN_REVOKED', failure });
        }

        const user = await prisma.user.findUnique({
            where: { id: payload.id },
            select: { id: true, role: true, status: true },
        });
        if (!user || user.status === 'SUSPENDED') {
            const failure = { title: "Ineligible user", message: "Your account is no longer eligible. Please contact support.", code: 401 };
            return res.status(401).json({ error: 'User no longer eligible', code: 'USER_INELIGIBLE', failure });
        }

        // Revoke the used rotation token, then issue a fresh full token set.
        await prisma.rotationToken.update({
            where: { tokenId: rotationToken },
            data: { revokedAt: new Date() },
        });

        const tokens = generateTokenSet({ id: user.id, role: user.role });
        await persistRotationToken(tokens.rotationToken, user.id);

        return res.status(200).json(tokens);
    } catch (err) {
        next(err);
    }
};

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
const me = async function (req, res, next) {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: PUBLIC_USER_FIELDS,
        });
        if (!user) {
            return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
        }
        return res.status(200).json({ user });
    } catch (err) {
        next(err);
    }
};

// ── POST /api/auth/logout ───────────────────────────────────────────────────
// Body: { rotationToken } → blacklists that specific rotation token so
// /rotate can never be used with it again. Access/refresh tokens already
// in flight will simply expire on their own short clocks.
const logout = async function (req, res, next) {
    try {
        const { rotationToken } = req.body;
        if (!rotationToken) {
            // Nothing to blacklist — client just drops its tokens.
            return res.status(200).json({ message: 'Logged out' });
        }

        let payload;
        try {
            payload = decodeToken(rotationToken); // decode, not verify — logout should work even on an expired token
        } catch {
            return res.status(200).json({ message: 'Logged out' });
        }

        if (payload?.tokenId) {
            await prisma.rotationToken.updateMany({
                where: { tokenId: payload.tokenId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        }

        return res.status(200).json({ message: 'Logged out' });
    } catch (err) {
        next(err);
    }
};

// ── POST /api/auth/logout-all ───────────────────────────────────────────────
// Mount behind `authenticate`. Revokes every active rotation token for the
// current user — e.g. "log out of all devices" after a password change.
const logoutAll = async function (req, res, next) {
    try {
        await prisma.rotationToken.updateMany({
            where: { userId: req.user.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        return res.status(200).json({ message: 'Logged out of all devices' });
    } catch (err) {
        next(err);
    }
};

const firebasePhoneLogin = async function (req, res, next) {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ error: 'idToken is required', code: 'MISSING_ID_TOKEN' });
        }
 
        let decoded;
        try {
            decoded = await verifyFirebaseIdToken(idToken);
        } catch (err) {
            return res.status(401).json({ error: 'Invalid Firebase token', code: 'INVALID_FIREBASE_TOKEN' });
        }
 
        const phone = decoded.phone_number;
        if (!phone) {
            // Token wasn't issued via phone auth (e.g. someone passed a Google-auth Firebase token here)
            return res.status(400).json({ error: 'Token has no verified phone number', code: 'NO_PHONE_ON_TOKEN' });
        }
 
        let user = await prisma.user.findFirst({ where: { phone } });
 
        if (!user) {
            user = await prisma.user.create({
                data: {
                    phone,
                    name: `User ${phone.slice(-4)}`, // placeholder until user sets their real name
                    firebaseUid: decoded.uid,
                },
                select: PUBLIC_USER_FIELDS,
            });
        } else {
            if (user.status === 'SUSPENDED') {
                return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
            }
 
            if (!user.firebaseUid) {
                user = await prisma.user.update({
                    where: { id: user.id },
                    data: { firebaseUid: decoded.uid },
                    select: PUBLIC_USER_FIELDS,
                });
            } else {
                const { passwordHash, firebaseUid, ...safeUser } = user;
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

export default {
    register,
    login,
    refresh,
    rotate,
    me,
    logout,
    logoutAll,
    firebasePhoneLogin
};
// middlewares/auth.middleware.js
//
// authenticate  -> verifies the Bearer JWT, loads the user, attaches req.user
// authorize     -> role guard factory, use AFTER authenticate
//
// Usage:
//   router.use(authenticate);
//   router.get('/admin', authorize('ADMIN'), handler);
//   router.get('/staff-area', authorize('ADMIN', 'STAFF'), handler);
//
import { verifyToken } from '../utils/jwt.js';
import prisma from '../config/db.js';
import env from '../config/env.js';

export async function authenticate(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const [scheme, token] = header.split(' ');

        if (scheme !== 'Bearer' || !token) {
            const failure = { title: "Not authenticated", message: "You are not authenticated. Please login again.", code: 401 };
            return res.status(401).json({ error: 'Missing or malformed Authorization header', code: 'MISSING_AUTH_HEADER', failure });
        }

        let payload;
        try {
            payload = verifyToken(token, "access");
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                const failure = { title: "Token expired", message: "Your session has expired. Please login again.", code: 401 };
                return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED', failure });
            }
            const failure = { title: "Invalid token", message: "Your session has expired. Please login again.", code: 401 };
            return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN', failure });
        }

        const user = await prisma.user.findUnique({
            where: { id: payload.sub || payload.id },
            select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                role: true,
                status: true,
                profileImageUrl: true,
            },
        });

        if (!user) {
            const failure = { title: "User no longer exists", message: "Your session has expired. Please login again.", code: 401 };
            return res.status(401).json({ error: 'User no longer exists', code: 'USER_NO_LONGER_EXISTS', failure });
        }

        if (user.status === 'SUSPENDED') {
            const failure = { title: "Account suspended", message: "Your account has been suspended. Please contact support.", code: 403 };
            return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED', failure });
        }

        req.user = user;
        next();
    } catch (err) {
        next(err);
    }
}

// authorize(...roles) — call after authenticate. Pass one or more allowed roles.
export function authorize(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            const failure = { title: "Not authenticated", message: "You are not authenticated. Please login again.", code: 401 };
            return res.status(401).json({ error: 'Not authenticated', code: 'NOT_AUTHENTICATED', failure });
        }
        if (!roles.includes(req.user.role)) {
            const failure = { title: "Forbidden", message: "You do not have access to this resource.", code: 403 };
            return res.status(403).json({ error: 'You do not have access to this resource', code: 'FORBIDDEN', failure });
        }
        next();
    };
}

export async function checkMembership(req, res, next) {
    const user = req.user;
    if (!user) {
        const failure = { title: "User no longer exists", message: "Your session has expired. Please login again.", code: 401 };
        return res.status(401).json({ error: 'User no longer exists', code: 'USER_NO_LONGER_EXISTS', failure });
    }

    if(['ADMIN', 'STAFF'].includes(user.role)) {
        return next();
    }

    if (user.status === 'SUSPENDED') {
        const failure = { title: "Account suspended", message: "Your account has been suspended. Please contact support.", code: 403 };
        return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED', failure });
    }

    const status = req.user.status;
    
    const forbiddenStatus = ['SUSPENDED', 'EXPIRED'];

    if (forbiddenStatus.includes(status)) {
        const failure = { title: "No active membership", message: "You do not have an active membership. Please renew your membership.", code: 403 };
        return res.status(403).json({ error: 'No active membership', code: 'NO_ACTIVE_MEMBERSHIP', failure });
    }
    
    next();
}

export default { authenticate, authorize, checkMembership };
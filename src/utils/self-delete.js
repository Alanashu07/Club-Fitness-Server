// // ─────────────────────────────────────────────────────────────────────────────
// // Self-service account deletion
// //
// //   POST /api/account/delete        (authenticated, acts on req.user.id)
// //   body: { "mode": "hard" | "soft", "confirm": true }   // mode defaults to "hard"
// //
// // Behaviour
// //   mode = "soft" → account is de-activated (SUSPENDED + blocked), device access removed.
// //   mode = "hard" → try a permanent delete via hardDeleteUser().
// //                   If it can't be done (authored content, FK constraints, unexpected
// //                   failure) the account is SUSPENDED and flagged for an admin to delete.
// //
// // Response shape (always the same top-level keys, success or failure)
// //   {
// //     status:  one of ACCOUNT_STATUS below,
// //     message: user-facing text (identical in `error.message` on failures),
// //     mode, accountState, logout, requestedAt,
// //     error?: { title, message, code }   // failures only
// //   }
// // ─────────────────────────────────────────────────────────────────────────────

// import prisma from '../config/db.js';
// import checkinService from '../modules/device/checkin.service.js';
// import { hardDeleteUser } from './userDeletion.service.js'; // the file containing hardDeleteUser

// export const ACCOUNT_STATUS = Object.freeze({
//     DELETED: 'DELETED',                           // hard delete completed
//     DEACTIVATED: 'DEACTIVATED',                   // soft delete completed (user's choice)
//     PENDING_ADMIN_DELETION: 'PENDING_ADMIN_DELETION', // hard delete blocked → suspended, awaiting admin
//     ALREADY_PENDING: 'ALREADY_PENDING',           // a deletion request is already waiting for admin
//     ALREADY_DEACTIVATED: 'ALREADY_DEACTIVATED',   // soft delete requested for an already suspended account
//     INVALID_REQUEST: 'INVALID_REQUEST',           // bad mode / missing confirmation
//     NOT_ALLOWED: 'NOT_ALLOWED',                   // e.g. admin accounts can't self-delete
//     NOT_FOUND: 'NOT_FOUND',
//     FAILED: 'FAILED',                             // unexpected error, nothing was changed
// });

// const MESSAGES = {
//     DELETED: 'Your account and its data have been permanently deleted.',
//     DEACTIVATED: 'Your account has been de-activated. Contact the gym if you want it restored.',
//     PENDING_ADMIN_DELETION:
//         'We could not delete your account right now, so it has been suspended. An admin will review and permanently delete it shortly.',
//     ALREADY_PENDING: 'Your deletion request is already with an admin. Your account stays suspended until they finish.',
//     ALREADY_DEACTIVATED: 'Your account is already de-activated.',
//     INVALID_REQUEST: 'Please confirm that you want to delete your account and choose a valid option.',
//     NOT_ALLOWED: 'This account cannot be deleted from the app. Please contact support.',
//     NOT_FOUND: 'We could not find your account.',
//     FAILED: 'Something went wrong and your account was not changed. Please try again later.',
// };

// const HTTP = {
//     DELETED: 200,
//     DEACTIVATED: 200,
//     PENDING_ADMIN_DELETION: 202, // accepted, completes later
//     ALREADY_PENDING: 200,
//     ALREADY_DEACTIVATED: 200,
//     INVALID_REQUEST: 400,
//     NOT_ALLOWED: 403,
//     NOT_FOUND: 404,
//     FAILED: 500,
// };

// const FAILURE_STATUSES = new Set(['INVALID_REQUEST', 'NOT_ALLOWED', 'NOT_FOUND', 'FAILED']);
// const FAILURE_TITLES = {
//     INVALID_REQUEST: 'Invalid request',
//     NOT_ALLOWED: 'Cannot delete account',
//     NOT_FOUND: 'Account not found',
//     FAILED: 'Could not delete account',
// };

// // Roles that must never remove themselves (avoids orphaning the system). Adjust to your enum.
// const PROTECTED_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

// function respond(res, key, { mode = null, accountState = null, requestedAt = null } = {}) {
//     const message = MESSAGES[key];
//     const body = {
//         status: ACCOUNT_STATUS[key],
//         message,
//         mode,
//         accountState, // 'DELETED' | 'DEACTIVATED' | 'SUSPENDED' | null
//         // Client should clear tokens/session whenever the account is gone or locked.
//         logout: ['DELETED', 'DEACTIVATED', 'PENDING_ADMIN_DELETION', 'ALREADY_PENDING', 'ALREADY_DEACTIVATED'].includes(key),
//         requestedAt,
//     };
//     if (FAILURE_STATUSES.has(key)) {
//         body.error = { title: FAILURE_TITLES[key], message, code: ACCOUNT_STATUS[key] };
//     }
//     return res.status(HTTP[key]).json(body);
// }

// // Suspend + block device. `pendingDeletion` also flags the account for an admin.
// async function suspendAccount(member, { pendingDeletion }) {
//     if (member.devicePin && member.deviceSN) {
//         try {
//             await checkinService.blockUserHard(member.deviceSN, member.devicePin);
//         } catch (err) {
//             // Don't fail the request: the DB suspension below still blocks app access,
//             // and an admin can remove the device entry manually.
//             console.error('blockUserHard failed during self-suspend', { id: member.id, err });
//         }
//     }

//     const requestedAt = new Date();
//     await prisma.user.update({
//         where: { id: member.id },
//         data: {
//             status: 'SUSPENDED',
//             blocked: true,
//             ...(pendingDeletion ? { deletionRequestedAt: requestedAt } : {}), // needs the new column, see notes
//         },
//     });

//     // TODO: revoke active sessions so existing JWT/refresh tokens stop working, e.g.
//     // await prisma.rotationToken.deleteMany({ where: { userId: member.id } });

//     return requestedAt;
// }

// export const requestAccountDeletion = asyncHandler(async (req, res) => {
//     const id = req.user.id;
//     const mode = req.body?.mode ?? 'hard';

//     if (req.body?.confirm !== true || !['hard', 'soft'].includes(mode)) {
//         return respond(res, 'INVALID_REQUEST', { mode: typeof mode === 'string' ? mode : null });
//     }

//     const member = await prisma.user.findUnique({
//         where: { id },
//         select: {
//             id: true, role: true, status: true, deviceSN: true, devicePin: true,
//             deletionRequestedAt: true,
//         },
//     });
//     if (!member) return respond(res, 'NOT_FOUND', { mode });
//     if (PROTECTED_ROLES.has(member.role)) return respond(res, 'NOT_ALLOWED', { mode });

//     // Idempotency: don't re-run anything if a request is already waiting on an admin.
//     if (member.deletionRequestedAt) {
//         return respond(res, 'ALREADY_PENDING', {
//             mode, accountState: 'SUSPENDED', requestedAt: member.deletionRequestedAt,
//         });
//     }

//     try {
//         // ── Soft delete ──────────────────────────────────────────────────────
//         if (mode === 'soft') {
//             if (member.status === 'SUSPENDED') {
//                 return respond(res, 'ALREADY_DEACTIVATED', { mode, accountState: 'SUSPENDED' });
//             }
//             const requestedAt = await suspendAccount(member, { pendingDeletion: false });
//             return respond(res, 'DEACTIVATED', { mode, accountState: 'SUSPENDED', requestedAt });
//         }

//         // ── Hard delete ──────────────────────────────────────────────────────
//         let result;
//         try {
//             result = await hardDeleteUser(id);
//         } catch (err) {
//             // hardDeleteUser only throws on unexpected errors; its transaction rolled back,
//             // so nothing was deleted. Treat like "cannot be done right now" and fall back.
//             console.error('hardDeleteUser threw during self-delete', { id, err });
//             result = { ok: false, status: 500 };
//         }

//         if (result.ok) {
//             return respond(res, 'DELETED', { mode, accountState: 'DELETED', requestedAt: new Date() });
//         }
//         if (result.status === 404) {
//             return respond(res, 'NOT_FOUND', { mode });
//         }

//         // Blocked (authored content / FK constraint) or unexpected failure → suspend for admin.
//         const requestedAt = await suspendAccount(member, { pendingDeletion: true });
//         return respond(res, 'PENDING_ADMIN_DELETION', { mode, accountState: 'SUSPENDED', requestedAt });
//     } catch (err) {
//         console.error('requestAccountDeletion failed', { id, err });
//         return respond(res, 'FAILED', { mode });
//     }
// });

// // ── Route ────────────────────────────────────────────────────────────────────
// // router.post('/account/delete', authenticate, requestAccountDeletion);
// //
// // ── Prisma schema (needed for the admin queue) ───────────────────────────────
// // model User {
// //   ...
// //   deletionRequestedAt DateTime?
// //   @@index([deletionRequestedAt])
// // }
// // then: npx prisma migrate dev --name add_deletion_requested_at
// //
// // Admin side: list users where deletionRequestedAt != null, review the blockers with
// // getDeletionImpact(id), and call hardDeleteUser(id) once they're cleared.
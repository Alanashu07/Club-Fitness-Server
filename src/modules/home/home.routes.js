import express from 'express';
import { authenticate, authorize, checkMembership } from '../../middlewares/auth.middleware.js';
import homeController from './home.controller.js';

const router = express.Router();

// All routes below require a logged-in user.
router.use(authenticate);

// ── Available to ANY authenticated user ─────────────────────────────────────
router.get('/', checkMembership, homeController.getHome); // dispatches to admin/trainer/member payload based on req.user.role
router.get('/announcements', homeController.getAnnouncementsFeed);
router.get('/notifications/unread-count', homeController.getUnreadNotificationCount);

// ── ADMIN only ───────────────────────────────────────────────────────────────
router.get('/admin', authorize('ADMIN'), homeController.getAdminHome);

// ── STAFF (trainer) only ─────────────────────────────────────────────────────
router.get('/trainer', authorize('STAFF'), homeController.getTrainerHome);

// ── MEMBER only ───────────────────────────────────────────────────────────────
router.get('/member', authorize('MEMBER'), checkMembership, homeController.getMemberHome);

export default router;
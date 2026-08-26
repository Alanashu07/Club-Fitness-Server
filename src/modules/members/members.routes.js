import express from 'express';
import memberController from './members.controller.js';
import { validateCreateMemberInput } from '../../validators/member.validator.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';

const router = express.Router();

router.use(authenticate, authorize('ADMIN', 'STAFF'));

router.get('/', memberController.listMembers);
router.post('/', validateCreateMemberInput, memberController.createMember);
router.get('/trainers', memberController.getAllTrainers);
router.get('/membership-plans', memberController.getAllMembershipPlans);
router.post('/membership-plans', memberController.createMembershipPlan);
router.patch('/membership-plans/:id', memberController.updateMembershipPlan);
router.delete('/membership-plans/:id', memberController.deleteMembershipPlan);

export default router;
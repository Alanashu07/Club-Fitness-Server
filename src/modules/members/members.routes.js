import express from 'express';
import memberController from './members.controller.js';
import { validateCreateMemberInput, validateUpdateMemberInput } from '../../validators/member.validator.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';
import { uploadReceipt, cleanupOnError } from '../../config/multer.js';

const router = express.Router();

router.use(authenticate, authorize('ADMIN', 'STAFF'));

router.get('/', memberController.listMembers);
router.post('/', validateCreateMemberInput, memberController.createMember);
router.get('/trainers', memberController.getAllTrainers);
router.patch('/:id/reactivate', memberController.reactivateMember);
router.get('/membership-plans', memberController.getAllMembershipPlans);
router.post('/membership-plans', memberController.createMembershipPlan);
router.patch('/membership-plans/:id', memberController.updateMembershipPlan);
router.delete('/membership-plans/:id', memberController.deleteMembershipPlan);
router.get('/:id', memberController.getMemberDetails);
router.patch('/:id', validateUpdateMemberInput, memberController.updateMember);
router.delete('/:id', memberController.deleteMember);
router.patch('/:id/suspend', memberController.suspendMember);
router.post('/:id/renew', uploadReceipt, cleanupOnError, memberController.renewMembership);

export default router;
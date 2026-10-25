import express from 'express';
import trainers from './trainers.controller.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';
import { uploadReceipt, uploadProfileImage, cleanupOnError } from '../../config/multer.js';

const router = express.Router();

router.use(authenticate, authorize('ADMIN'));

router.get('/', trainers.getAllTrainers);
router.get('/:id', trainers.getTrainer);
router.post('/', uploadProfileImage, cleanupOnError, trainers.createTrainer);
router.patch('/:id', uploadProfileImage, cleanupOnError, trainers.updateTrainer);
router.patch('/:id/status', trainers.setTrainerStatus);
router.delete('/:id', trainers.deleteTrainer);

export default router;
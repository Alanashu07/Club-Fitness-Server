import express from 'express';
import coreController from './core.controller.js';

const router = express.Router();

router.get('/privacy-policy', coreController.privacyPolicy);

export default router;
import express from 'express';
import deepLinkController from './deep_link.controller.js';

const router = express.Router();

router.get(/^\/(.*)/, deepLinkController.handleDeepLink);

export default router;
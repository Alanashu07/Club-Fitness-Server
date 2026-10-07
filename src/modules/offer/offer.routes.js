import express from 'express';
import offers from './offer.controller.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';

const router = express.Router();

router.use(authenticate);

// ── Routes ──────────────────────────────────────────────────────────────────
router.post('/', authorize('ADMIN', 'STAFF'), offers.createOffer);
router.get('/', offers.listOffers);
router.get('/:id', offers.getOffer);
router.patch('/:id', authorize('ADMIN', 'STAFF'), offers.updateOffer);
router.delete('/:id', authorize('ADMIN', 'STAFF'), offers.deleteOffer);
router.get('/membership-plans/:planId', offers.listOffersForPlan);

export default router;
import express from 'express';
import offers from './offer.controller.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';

const router = express.Router();

router.use(authenticate);

// ── Routes ──────────────────────────────────────────────────────────────────
router.post('/offers', authorize('ADMIN', 'STAFF'), offers.createOffer);
router.get('/offers', offers.listOffers);
router.get('/offers/:id', offers.getOffer);
router.patch('/offers/:id', authorize('ADMIN', 'STAFF'), offers.updateOffer);
router.delete('/offers/:id', authorize('ADMIN', 'STAFF'), offers.deleteOffer);
router.get('/membership-plans/:planId/offers', offers.listOffersForPlan);

export default router;
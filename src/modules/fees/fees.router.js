import express from 'express';
import feeController from './fees.controller.js';
import pdfController from './fees-pdf.controller.js';
import {
    validateCreateFeeInput,
    validateMarkPaidInput,
    validateReminderInput,
} from '../../validators/fee.validator.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';

const router = express.Router();

router.use(authenticate, authorize('ADMIN', 'STAFF'));

router.get('/', feeController.listFees);
router.post('/', validateCreateFeeInput, feeController.createFee);
router.get('/summary', feeController.getFeeSummary);
router.get('/export/pdf', feeController.exportFeesPdf);
router.get('/:id', feeController.getFeeById);
router.get('/:id/invoice', pdfController.generateFeeInvoicePdf);
router.patch('/:id', feeController.updateFee);
router.delete('/:id', feeController.deleteFee);

router.patch('/:id/approve', feeController.approveFee);
router.patch('/:id/reject', feeController.rejectFee);
router.patch('/:id/mark-paid', validateMarkPaidInput, feeController.markFeePaid);
router.patch('/:id/waive', feeController.waiveFee);
router.post('/:id/remind', validateReminderInput, feeController.sendFeeReminder);
router.post('/:id/receipt', feeController.attachReceipt);

export default router;
import { Router } from 'express';
import reportController from './report.controller.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';

const router = Router();

// Reports are staff-facing only — every route here requires an ADMIN or
// STAFF session, same guard style as your other protected routers.
router.use(authenticate, authorize('ADMIN', 'STAFF'));

// GET /api/v1/reports/sales?range=30D&trendMonths=6&txLimit=20
router.get('/sales', reportController.getSalesReport);

// GET /api/v1/reports/sales/export/pdf?range=30D&txLimit=500
router.get('/sales/export/pdf', reportController.exportSalesPdf);

// GET /api/v1/reports/sales/export/excel?range=30D&txLimit=500
router.get('/sales/export/excel', reportController.exportSalesExcel);

export default router;
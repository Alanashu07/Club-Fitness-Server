import { Router } from 'express';
import authController from './auth.controller.js';
import otpController from './otp.controller.js';
import googleController from './google.controller.js';
import { validateLoginInput, validateRegisterInput } from '../../validators/auth.validator.js';
import { authenticate } from '../../middlewares/auth.middleware.js';

const router = Router();

router.post('/register', validateRegisterInput, authController.register);
router.post('/login', validateLoginInput, authController.login);
router.post('/refresh', authController.refresh);
router.post('/rotate', authController.rotate);
router.post('/logout', authController.logout);
router.post('/logout-all', authenticate, authController.logoutAll);
router.get('/me', authenticate, authController.me);

router.post('/email/otp/request', otpController.requestEmailOtp);
router.post('/email/otp/verify', otpController.verifyEmailOtp);
router.post('/phone/otp/request', otpController.requestPhoneOtp);
router.post('/phone/otp/verify', otpController.verifyPhoneOtp);
router.post('/google', googleController.googleLogin);
router.post('/firebase-phone-login', authController.firebasePhoneLogin);
export default router;
import { Router } from 'express';
import deviceController from './device.controller.js';

const router = Router();

router.get('/iclock/cdata', deviceController.handshake);
router.post('/iclock/cdata', deviceController.receiveData);
router.get('/iclock/getrequest', deviceController.getRequest);
router.post('/iclock/devicecmd', deviceController.acknowledgeCommand);

export default router;
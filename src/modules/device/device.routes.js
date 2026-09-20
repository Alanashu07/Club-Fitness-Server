import { Router } from 'express';
import bodyParser from 'body-parser';
import deviceController from './device.controller.js';

const router = Router();

// ADMS sends text/plain-ish, sometimes unlabeled, form-style bodies — never
// JSON. Parsing is scoped to this router only so it never shadows your
// app-wide JSON parser used by /api/v1 routes.
router.use(bodyParser.text({ type: '*/*' }));

// Paths intentionally match the eSSL/ZKTeco ADMS spec exactly — the device
// is hardcoded to call these and cannot send auth headers, so this router
// must be mounted at the app root, never under /api/v1 or behind the
// `authenticate` middleware. See app.js wiring note.
//
// NOTE: this specific firmware (confirmed via raw request logging) calls
// the .aspx-suffixed variant of every endpoint (e.g. /iclock/cdata.aspx),
// not the bare path — a known quirk on some eSSL firmware builds that
// carries over ASP.NET-style naming regardless of what's actually serving
// it. Both variants are registered pointing at the same handlers so this
// keeps working even if a future device/firmware uses the bare path instead.
router.get('/iclock/cdata', deviceController.handshake);
router.get('/iclock/cdata.aspx', deviceController.handshake);

router.post('/iclock/cdata', deviceController.receiveData);
router.post('/iclock/cdata.aspx', deviceController.receiveData);

router.get('/iclock/getrequest', deviceController.getRequest);
router.get('/iclock/getrequest.aspx', deviceController.getRequest);

router.post('/iclock/devicecmd', deviceController.acknowledgeCommand);
router.post('/iclock/devicecmd.aspx', deviceController.acknowledgeCommand);

export default router;

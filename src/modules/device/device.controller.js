import checkinService from './checkin.service.js';
import commandQueue from './device-command-queue.service.js';
import env from '../../config/env.js';

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ── GET /iclock/cdata ────────────────────────────────────────────────────────
// Device handshake / heartbeat. When options=all, device is asking for its
// server-side config on registration — Realtime=1 makes it push each ATTLOG
// event immediately instead of batching.
const handshake = asyncHandler(async (req, res) => {
    const { SN, options } = req.query;

    res.type('text/plain');

    if (options === 'all') {
        return res.send(
            `GET OPTION FROM: ${SN}\n` +
            `Stamp=9999\n` +
            `OpStamp=9999\n` +
            `ErrorDelay=10\n` +
            `Delay=1\n` +
            `TransFlag=TransData AttLog\tOpLog\tUserInfo\n` +
            `Realtime=1\n` +
            `Encrypt=None\n`
        );
    }

    return res.send('OK');
});

// ── POST /iclock/cdata ───────────────────────────────────────────────────────
// Device pushes attendance logs (and user/op logs) here.
const receiveData = asyncHandler(async (req, res) => {
    const { SN, table } = req.query;
    const body = typeof req.body === 'string' ? req.body : '';

    res.type('text/plain');

    if (table === 'ATTLOG') {
        const lines = body.split('\n').filter(Boolean);
        for (const line of lines) {
            const [pin, timestamp] = line.split('\t');
            if (!pin || !timestamp) continue;

            const devicePin = parseInt(pin, 10);
            if (Number.isNaN(devicePin)) continue;

            await checkinService.handleCheckInEvent({
                deviceSN: SN,
                devicePin,
                eventTime: new Date(timestamp.replace(' ', 'T')),
            });
        }
    }

    return res.send('OK');
});

// ── GET /iclock/getrequest ───────────────────────────────────────────────────
// Device polls this for any pending command (enroll, block, unblock, etc.).
const getRequest = asyncHandler(async (req, res) => {
    const { SN } = req.query;
    res.type('text/plain');

    const cmd = await commandQueue.dequeueNextCommand(SN);
    return res.send(cmd ? cmd.command : 'OK');
});

// ── POST /iclock/devicecmd ───────────────────────────────────────────────────
// Device reports back the result of executing a command.
const acknowledgeCommand = asyncHandler(async (req, res) => {
    const { SN } = req.query;
    const body = typeof req.body === 'string' ? req.body : '';
    await commandQueue.acknowledgeCommand(SN, body);
    res.type('text/plain').send('OK');
});

const getDeviceInfo = asyncHandler(async (req, res) => {
    const command = "GET OPTION UserCount,MaxUserCount,FaceCount,MaxFaceCount,FPCount,MaxFingerCount";
    await commandQueue.queueCommand(env.DEFAULT_DEVICE_SN, command);
});

export default { handshake, receiveData, getRequest, acknowledgeCommand, getDeviceInfo };
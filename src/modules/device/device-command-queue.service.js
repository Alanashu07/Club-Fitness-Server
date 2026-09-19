import prisma from '../../config/db.js';

// ── enqueue a raw ADMS command string for a device to pick up next poll ────
const queueCommand = async function (deviceSN, command) {
    return prisma.deviceCommand.create({
        data: { deviceSN, command, status: 'PENDING' },
    });
};

// ── called from GET /iclock/getrequest — hand the device its oldest pending command ──
const dequeueNextCommand = async function (deviceSN) {
    const cmd = await prisma.deviceCommand.findFirst({
        where: { deviceSN, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
    });
    if (!cmd) return null;

    await prisma.deviceCommand.update({
        where: { id: cmd.id },
        data: { status: 'SENT', sentAt: new Date() },
    });
    return cmd;
};

// ── called from POST /iclock/devicecmd — device reporting command execution result ──
// NOTE: correlating this back to a specific DeviceCommand row reliably needs the
// numeric ID the device echoes back (parsed from `ID=<n>` in the ack body) to match
// an ID you embedded when building the command string. Logged for now; tighten this
// if you need guaranteed delivery confirmation per command.
const acknowledgeCommand = async function (deviceSN, rawBody) {
    console.log(`[DEVICE ACK] ${deviceSN}:`, rawBody);
};

export default { queueCommand, dequeueNextCommand, acknowledgeCommand };
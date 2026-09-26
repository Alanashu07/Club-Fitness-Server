import prisma from '../../config/db.js';

// ── short, monotonically-increasing command IDs ─────────────────────────────
// Some ADMS firmwares expect the "C:<id>:..." id to be a small integer they
// can echo back in the ack — a 13-digit Date.now() value can silently break
// parsing on those firmwares (command gets fetched, never executed, no
// visible error). Keep it compact and stable instead.
let commandIdCounter = Math.floor(Date.now() / 1000) % 1000000;
const nextCommandId = function () {
    commandIdCounter = (commandIdCounter + 1) % 1000000;
    return commandIdCounter;
};

// ── enqueue a raw ADMS command string for a device to pick up next poll ────
const queueCommand = async function (deviceSN, commandBody) {
    const command = `C:${nextCommandId()}:${commandBody}`;
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
// ── called from POST /iclock/devicecmd — device reporting command execution result ──
const acknowledgeCommand = async function (deviceSN, rawBody) {
    const params = new URLSearchParams(rawBody);
    const commandId = params.get('ID');
    const returnCode = params.get('Return');

    if (commandId === null || returnCode === null) {
        console.warn(`[DEVICE ACK] Unparseable ack from ${deviceSN}:`, rawBody);
        return null;
    }

    // Commands are stored as "C:<id>:<body>" — match the echoed ID back to
    // the SENT row we're waiting on for this device.
    const cmd = await prisma.deviceCommand.findFirst({
        where: {
            deviceSN,
            command: { startsWith: `C:${commandId}:` },
            status: 'SENT',
        },
        orderBy: { createdAt: 'desc' },
    });

    if (!cmd) {
        console.warn(`[DEVICE ACK] No matching SENT command for ${deviceSN} id=${commandId}, return=${returnCode}`, rawBody);
        return null;
    }

    const success = returnCode === '0';

    return prisma.deviceCommand.update({
        where: { id: cmd.id },
        data: {
            status: success ? 'ACKED' : 'FAILED',
            ackedAt: new Date(),
        },
    });
};

export default { queueCommand, dequeueNextCommand, acknowledgeCommand };
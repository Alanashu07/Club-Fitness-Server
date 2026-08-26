import prisma from '../config/db.js';
import env from '../config/env.js';

// ============================================================================
// Lightweight multi-channel notification dispatcher.
// Swap the three `send*` functions below for real provider SDKs (FCM/Expo
// for push, WhatsApp Cloud API for whatsapp, Twilio/MSG91 for sms) when
// you're ready to go live — the calling code (fees.controller.js) only
// depends on the sendReminderNotification(...) contract below.
// ============================================================================

const PROVIDERS_CONFIGURED = {
    push: Boolean(env.FCM_SERVER_KEY),
    whatsapp: Boolean(env.WHATSAPP_API_TOKEN),
    sms: Boolean(env.SMS_API_KEY),
};

async function sendPush(member, message) {
    if (!PROVIDERS_CONFIGURED.push) {
        console.warn(`[notifications] FCM_SERVER_KEY not set — skipping push to ${member.id}`);
        return { channel: 'push', status: 'skipped', reason: 'not_configured' };
    }
    if (!member.pushToken) {
        return { channel: 'push', status: 'skipped', reason: 'no_push_token' };
    }

    try {
        // Replace with an actual FCM/APNs/Expo push call.
        // await fcm.send({ token: member.pushToken, notification: { title: 'Fee Reminder', body: message } });
        return { channel: 'push', status: 'sent' };
    } catch (err) {
        console.error(`[notifications] push send failed for ${member.id}:`, err.message);
        return { channel: 'push', status: 'failed', reason: err.message };
    }
}

async function sendWhatsapp(member, message) {
    if (!PROVIDERS_CONFIGURED.whatsapp) {
        console.warn(`[notifications] WHATSAPP_API_TOKEN not set — skipping WhatsApp to ${member.id}`);
        return { channel: 'whatsapp', status: 'skipped', reason: 'not_configured' };
    }
    if (!member.phone) {
        return { channel: 'whatsapp', status: 'skipped', reason: 'no_phone' };
    }

    try {
        // Replace with a WhatsApp Cloud API call.
        // await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
        //   method: 'POST',
        //   headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}`, 'Content-Type': 'application/json' },
        //   body: JSON.stringify({ messaging_product: 'whatsapp', to: member.phone, type: 'text', text: { body: message } }),
        // });
        return { channel: 'whatsapp', status: 'sent' };
    } catch (err) {
        console.error(`[notifications] whatsapp send failed for ${member.id}:`, err.message);
        return { channel: 'whatsapp', status: 'failed', reason: err.message };
    }
}

async function sendSms(member, message) {
    if (!PROVIDERS_CONFIGURED.sms) {
        console.warn(`[notifications] SMS_API_KEY not set — skipping SMS to ${member.id}`);
        return { channel: 'sms', status: 'skipped', reason: 'not_configured' };
    }
    if (!member.phone) {
        return { channel: 'sms', status: 'skipped', reason: 'no_phone' };
    }

    try {
        // Replace with a Twilio/MSG91/etc. call.
        // await smsClient.messages.create({ to: member.phone, from: process.env.SMS_SENDER_ID, body: message });
        return { channel: 'sms', status: 'sent' };
    } catch (err) {
        console.error(`[notifications] sms send failed for ${member.id}:`, err.message);
        return { channel: 'sms', status: 'failed', reason: err.message };
    }
}

const CHANNEL_SENDERS = {
    push: sendPush,
    whatsapp: sendWhatsapp,
    sms: sendSms,
};

// ── sendReminderNotification({ memberId, channels, message }) ──────────────
// Looks up the member's contact details, fans the message out across the
// requested channels in parallel, and returns a per-channel result array
// so the caller (e.g. the fee reminder endpoint) can report back to the UI
// which channels actually went out.
export async function sendReminderNotification({ memberId, channels = ['push'], message }) {
    if (!message) {
        throw new Error('sendReminderNotification requires a message');
    }

    const member = await prisma.user.findUnique({
        where: { id: memberId },
        select: { id: true, name: true, phone: true, email: true, pushToken: true },
    });
    if (!member) {
        throw new Error(`sendReminderNotification: member ${memberId} not found`);
    }

    const uniqueChannels = [...new Set(channels)].filter((c) => CHANNEL_SENDERS[c]);

    const results = await Promise.all(
        uniqueChannels.map((channel) => CHANNEL_SENDERS[channel](member, message)),
    );

    return results;
}

export default { sendReminderNotification };
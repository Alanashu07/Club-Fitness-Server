import axios from 'axios';
import env from '../config/env.js';
import { generateOtp } from './generate-otp.js';

const MSG91_AUTH_KEY = env.MSG91_AUTH_KEY;
const MSG91_TEMPLATE_ID = env.MSG91_TEMPLATE_ID;
const MSG91_BASE_URL = 'https://control.msg91.com/api/v5/otp';

// ---- Helpers ----

const normalizePhone = (phone) => {
    // Expect E.164-ish input; MSG91 wants number without leading '+'
    return phone.replace(/^\+/, '').trim();
};

const sendMsg91Otp = async (phone) => {
    const mobile = normalizePhone(phone);
    const otp = generateOtp();
    const { data } = await axios.get(MSG91_BASE_URL, {
        params: {
            template_id: MSG91_TEMPLATE_ID,
            mobile,
            authkey: MSG91_AUTH_KEY,
            otp_length: 6, var1: otp,
        },
    });

    if (data.type !== 'success') {
        const err = new Error(data.message || 'Failed to send OTP');
        err.code = 'MSG91_SEND_FAILED';
        throw err;
    }

    return data;
};

const verifyMsg91Otp = async (phone, otp) => {
    const mobile = normalizePhone(phone);
    const { data } = await axios.get(`${MSG91_BASE_URL}/verify`, {
        params: {
            mobile,
            otp,
            authkey: MSG91_AUTH_KEY,
        },
    });

    // MSG91 returns type: 'success' on valid OTP, 'error' otherwise
    return data.type === 'success';
};

export { sendMsg91Otp, verifyMsg91Otp, normalizePhone };
import crypto from 'crypto';

export function generateOtp(length = 6) {
    const min = 10 ** (length - 1);   // 100000
    const max = 10 ** length - 1;     // 999999

    return crypto.randomInt(min, max + 1).toString();
}

import { OAuth2Client } from 'google-auth-library';
import env from '../config/env.js';

const client = new OAuth2Client(env.GOOGLE_AUTH_CLIENT_ID);

// ── verifies a Google ID token and returns its payload ──────────────────────
// Throws if the token is invalid, expired, or was not issued for our client.
export async function verifyGoogleIdToken(idToken) {
    const ticket = await client.verifyIdToken({
        idToken,
        audience: env.GOOGLE_AUTH_CLIENT_ID,
    });

    return ticket.getPayload(); // { email, email_verified, name, picture, sub, ... }
}
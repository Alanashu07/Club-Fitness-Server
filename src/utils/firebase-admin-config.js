import admin from 'firebase-admin';
import env from '../config/env.js';

// Service account JSON downloaded from Firebase Console → Project Settings → Service Accounts
// Store its contents as a single-line JSON string in env.FIREBASE_SERVICE_ACCOUNT
const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

// ── verifies a Firebase ID token and returns its decoded claims ─────────────
// Throws if the token is invalid, expired, or was issued for a different project.
export async function verifyFirebaseIdToken(idToken) {
    return admin.auth().verifyIdToken(idToken); // { uid, phone_number, ... }
}
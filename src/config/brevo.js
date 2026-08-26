import { BrevoClient } from '@getbrevo/brevo';
import env from './env.js';

const brevo = new BrevoClient({
  apiKey: env.BREVO_API_KEY,
});

export async function sendEmail({ to, subject, html, text }) {
  try {
    await brevo.transactionalEmails.sendTransacEmail({
      subject,
      htmlContent: html,
      textContent: text,
      sender: {
        name: "Club Fitness",
        email: "alanashu07@gmail.com"
      },
      to: [
        {
          email: to
        }
      ],
    });
    return true;
  } catch (err) {
    console.error("Brevo error:", err.response?.body || err);
    return false;
  }
}
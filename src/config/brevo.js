import { BrevoClient } from '@getbrevo/brevo';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import env from './env.js';

const BREVO_DAILY_LIMIT = 300;
const SENDER = { name: 'Club Fitness', email: 'alanashu07@gmail.com' };
const COUNTER_FILE = path.resolve(process.cwd(), '.mail-counter.json');

const brevo = new BrevoClient({
  apiKey: env.BREVO_API_KEY,
});

// Gmail SMTP with App Password (env.GMAIL_SMTP holds the app password)
const smtpTransport = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: 'am.developerstvm@gmail.com',
    pass: env.GMAIL_SMTP,
  },
});

// ---------- Daily counter (resets at 12:00 AM IST) ----------

// "YYYY-MM-DD" for the current date in IST
function todayIST() {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function loadCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    if (data.date === todayIST() && Number.isFinite(data.count)) return data;
  } catch {
    // missing or corrupt file -> start fresh
  }
  return { date: todayIST(), count: 0 };
}

let counter = loadCounter();

function saveCounter() {
  try {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter));
  } catch (err) {
    console.error('Failed to persist mail counter:', err);
  }
}

// Rolls the counter over when the IST date changes
function getCount() {
  const today = todayIST();
  if (counter.date !== today) {
    counter = { date: today, count: 0 };
    saveCounter();
  }
  return counter.count;
}

function incrementCount() {
  getCount(); // ensure rollover
  counter.count += 1;
  saveCounter();
}

function markBrevoExhausted() {
  getCount();
  counter.count = Math.max(counter.count, BREVO_DAILY_LIMIT);
  saveCounter();
}

// ---------- Brevo limit detection ----------

function isBrevoLimitError(err) {
  const status =
    err?.statusCode ?? err?.status ?? err?.response?.status ?? err?.response?.statusCode;
  const body = err?.response?.body ?? err?.body ?? err?.response?.data;
  const code = body?.code ?? err?.code;
  const message = String(body?.message ?? err?.message ?? '');

  if (status === 429) return true; // rate / daily limit reached
  if (status === 402) return true; // payment / credits required
  if (
    ['too_many_requests', 'not_enough_credits', 'account_under_validation'].includes(
      String(code)
    )
  ) {
    return true;
  }
  return /limit|quota|credit|too many/i.test(message) && (status === 400 || status === 403);
}

// ---------- Senders ----------

async function sendViaBrevo({ to, subject, html, text }) {
  await brevo.transactionalEmails.sendTransacEmail({
    subject,
    htmlContent: html,
    textContent: text,
    sender: SENDER,
    to: [{ email: to }],
  });
}

async function sendViaSmtp({ to, subject, html, text }) {
  await smtpTransport.sendMail({
    from: `"${SENDER.name}" <am.developerstvm@gmail.com>`,
    to,
    subject,
    html,
    text,
  });
}

export async function sendEmail({ to, subject, html, text }) {
  const mail = { to, subject, html, text };

  // Brevo's daily quota used up -> go straight to Gmail SMTP
  if (getCount() >= BREVO_DAILY_LIMIT) {
    return trySmtp(mail);
  }

  try {
    await sendViaBrevo(mail);
    incrementCount();
    return true;
  } catch (err) {
    if (isBrevoLimitError(err)) {
      console.warn('Brevo limit reached, switching to Gmail SMTP for the rest of the day.');
      markBrevoExhausted();
      return trySmtp(mail);
    }
    console.error('Brevo error:', err.response?.body || err);
    return false;
  }
}

async function trySmtp(mail) {
  try {
    await sendViaSmtp(mail);
    return true;
  } catch (err) {
    console.error('Gmail SMTP error:', err);
    return false;
  }
}
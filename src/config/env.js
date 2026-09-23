import dotenv from 'dotenv';
dotenv.config(); // Load env variables here

const required = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`❌ Missing environment variable: ${key}`);
  }
  return value;
};

export default {
  PORT: process.env.PORT || 3000,

  DATABASE_URL: required('DATABASE_URL'),

  JWT_SECRET: required('JWT_SECRET'),

  ADMIN_COOKIE_SECRET: required('ADMIN_COOKIE_SECRET'),

  NODE_ENV: process.env.NODE_ENV || 'development',

  GOOGLE_AUTH_CLIENT_ID: required('GOOGLE_AUTH_CLIENT_ID'),

  FIREBASE_SERVICE_ACCOUNT: required('FIREBASE_SERVICE_ACCOUNT'),

  BREVO_API_KEY: required('BREVO_API_KEY'),

  LOGO_URL: process.env.LOGO_URL,

  LOGO_TRANSPARENT: process.env.LOGO_TRANSPARENT,

  APP_STORE_URL: process.env.APP_STORE_URL,

  PLAY_STORE_URL: process.env.PLAY_STORE_URL,

  APP_URL: process.env.APP_URL,

  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL,

  SUPPORT_PHONE: process.env.SUPPORT_PHONE,

  GYM_ADDRESS: process.env.GYM_ADDRESS,

  INSTAGRAM_URL: process.env.INSTAGRAM_URL,

  FACEBOOK_URL: process.env.FACEBOOK_URL,

  MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY,

  MSG91_TEMPLATE_ID: process.env.MSG91_TEMPLATE_ID,

  FCM_SERVER_KEY: process.env.FCM_SERVER_KEY,

  WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN,

  SMS_API_KEY: process.env.SMS_API_KEY,

  GRACE_ENTRIES_ALLOWED: process.env.GRACE_ENTRIES_ALLOWED || 3,

  DEFAULT_DEVICE_DOOR_ID: process.env.DEFAULT_DEVICE_DOOR_ID || 1,

  DEFAULT_DEVICE_SN: process.env.DEFAULT_DEVICE_SN,

  BLOCKED_DEVICE_TIME_ZONE_ID: process.env.BLOCKED_DEVICE_TIME_ZONE_ID || '2',
  
  DEFAULT_DEVICE_TIME_ZONE_ID: process.env.DEFAULT_DEVICE_TIME_ZONE_ID || '1',
};

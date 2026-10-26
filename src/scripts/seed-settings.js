import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const settings = [
  { key: "app_name", value: "Club Fitness", description: "Name of the app / gym shown across the UI" },
  { key: "logo_url", value: "https://example.com/assets/logo.png", description: "Primary logo (for light backgrounds)" },
  { key: "transparent_logo_url", value: "https://example.com/assets/logo-transparent.png", description: "Transparent logo (for dark backgrounds / overlays)" },
  { key: "tagline", value: "Train hard. Stay consistent.", description: "Short tagline shown on splash / login screens" },
  { key: "gym_address", value: "Club Fitness, Main Road, Thiruvananthapuram, Kerala 695001", description: "Physical address of the gym" },
  { key: "support_phone", value: "+91 90000 00000", description: "Support / reception phone number" },
  { key: "support_email", value: "support@example.com", description: "Support email address" },
  { key: "website", value: "https://example.com", description: "Public website URL" },
  {
    key: "opening_hours",
    value: JSON.stringify({
      mon: "05:30-22:00",
      tue: "05:30-22:00",
      wed: "05:30-22:00",
      thu: "05:30-22:00",
      fri: "05:30-22:00",
      sat: "06:00-20:00",
      sun: "07:00-12:00",
    }),
    description: "Weekly opening hours (JSON, 24h format)",
  },
  { key: "about", value: "Club Fitness is a community-driven gym with modern equipment, expert trainers and group classes for every fitness level.", description: "About the gym" },
  { key: "whatsapp_number", value: "+919000000000", description: "WhatsApp number for member queries" },
  { key: "instagram_url", value: "https://instagram.com/yourgym", description: "Instagram profile URL" },
  { key: "facebook_url", value: "https://facebook.com/yourgym", description: "Facebook page URL" },
  { key: "google_maps_url", value: "https://maps.google.com/?q=Club+Fitness", description: "Google Maps link to the gym" },
  { key: "currency_symbol", value: "₹", description: "Currency symbol used for prices" },
];

async function main() {
  const force = process.argv.includes("--force");

  for (const s of settings) {
    await prisma.siteSetting.upsert({
      where: { key: s.key },
      // Default: don't overwrite values already edited by admin.
      // With --force: reset value + description to the seed defaults.
      update: force ? { value: s.value, description: s.description } : { description: s.description },
      create: s,
    });
  }

  console.log(`✅ Seeded ${settings.length} site settings${force ? " (forced overwrite)" : ""}`);
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
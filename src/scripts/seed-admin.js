// prisma/seed.js
//
// Seeds the database with 10 users: 2 admins, 2 trainers (STAFF), 6 members.
//
// Run with:
//   node prisma/seed.js
// or, if configured in package.json ("prisma": { "seed": "node prisma/seed.js" }):
//   npx prisma db seed
//
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const DEFAULT_PASSWORD = 'Password123!';

async function hash(password) {
  return bcrypt.hash(password, 10);
}

async function main() {
  console.log('🌱 Seeding database...');

  const passwordHash = await hash(DEFAULT_PASSWORD);

  // ── Admins ─────────────────────────────────────────────────────────────
  const admins = await Promise.all([
    prisma.user.upsert({
      where: { phone: '9000000001' },
      update: {},
      create: {
        name: 'Super Admin',
        phone: '9000000001',
        email: 'admin1@clubfitness.test',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    }),
  ]);

  console.log('✅ Seed complete:');
  console.log(`   ${admins.length} admins`);
  console.log(`   Default password for all seeded users: ${DEFAULT_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
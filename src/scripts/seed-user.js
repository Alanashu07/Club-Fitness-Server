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

  // ── Membership Plans ───────────────────────────────────────────────────
  const monthlyPlan = await prisma.membershipPlan.upsert({
    where: { id: 'seed-plan-monthly' },
    update: {},
    create: {
      id: 'seed-plan-monthly',
      name: 'Monthly Plan',
      durationDays: 30,
      price: 1500,
      description: 'Full gym access, billed monthly',
      features: ['Gym Floor', 'Locker', 'Group Classes'],
      isActive: true,
    },
  });

  const annualPlan = await prisma.membershipPlan.upsert({
    where: { id: 'seed-plan-annual' },
    update: {},
    create: {
      id: 'seed-plan-annual',
      name: 'Annual Plan',
      durationDays: 365,
      price: 15000,
      description: 'Full gym access with sauna and classes, billed yearly',
      features: ['Gym Floor', 'Locker', 'Sauna', 'Group Classes', 'Personal Trainer Sessions'],
      isActive: true,
    },
  });

  // ── Admins ─────────────────────────────────────────────────────────────
  const admins = await Promise.all([
    prisma.user.upsert({
      where: { phone: '9000000001' },
      update: {},
      create: {
        name: 'Asha Menon',
        phone: '9000000001',
        email: 'admin1@clubfitness.test',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    }),
    prisma.user.upsert({
      where: { phone: '9000000002' },
      update: {},
      create: {
        name: 'Rohit Sharma',
        phone: '9000000002',
        email: 'admin2@clubfitness.test',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    }),
  ]);

  // ── Trainers (STAFF role) ─────────────────────────────────────────────
  const trainers = await Promise.all([
    prisma.user.upsert({
      where: { phone: '9000000003' },
      update: {},
      create: {
        name: 'Vikram Nair',
        phone: '9000000003',
        email: 'trainer1@clubfitness.test',
        passwordHash,
        role: 'STAFF',
        status: 'ACTIVE',
        staffTitle: 'Personal Trainer',
        hireDate: new Date('2023-01-15'),
      },
    }),
    prisma.user.upsert({
      where: { phone: '9000000004' },
      update: {},
      create: {
        name: 'Priya Pillai',
        phone: '9000000004',
        email: 'trainer2@clubfitness.test',
        passwordHash,
        role: 'STAFF',
        status: 'ACTIVE',
        staffTitle: 'Strength Coach',
        hireDate: new Date('2022-06-01'),
      },
    }),
  ]);

  // ── Members ────────────────────────────────────────────────────────────
  const memberSeeds = [
    { name: 'Anjali Krishnan', phone: '9000000005', email: 'member1@clubfitness.test', plan: monthlyPlan, trainer: trainers[0] },
    { name: 'Karthik Raj', phone: '9000000006', email: 'member2@clubfitness.test', plan: monthlyPlan, trainer: trainers[0] },
    { name: 'Divya Suresh', phone: '9000000007', email: 'member3@clubfitness.test', plan: annualPlan, trainer: trainers[1] },
    { name: 'Manoj Pillai', phone: '9000000008', email: 'member4@clubfitness.test', plan: annualPlan, trainer: trainers[1] },
    { name: 'Sneha Thomas', phone: '9000000009', email: 'member5@clubfitness.test', plan: monthlyPlan, trainer: trainers[0] },
    { name: 'Arjun Das', phone: '9000000010', email: 'member6@clubfitness.test', plan: annualPlan, trainer: trainers[1] },
  ];

  const now = new Date();

  const members = await Promise.all(
    memberSeeds.map((m) => {
      const membershipEnd = new Date(now.getTime() + m.plan.durationDays * 24 * 60 * 60 * 1000);
      return prisma.user.upsert({
        where: { phone: m.phone },
        update: {},
        create: {
          name: m.name,
          phone: m.phone,
          email: m.email,
          passwordHash,
          role: 'MEMBER',
          status: 'ACTIVE',
          membershipPlanId: m.plan.id,
          membershipStart: now,
          membershipEnd,
          assignedTrainerId: m.trainer.id,
        },
      });
    })
  );

  console.log('✅ Seed complete:');
  console.log(`   ${admins.length} admins`);
  console.log(`   ${trainers.length} trainers`);
  console.log(`   ${members.length} members`);
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
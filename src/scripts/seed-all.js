// prisma/seed.js
//
// Seeds the database with at least 10 entries for every model in the schema.
// Safe to re-run: it wipes existing data (in dependency-safe order) before
// reseeding, so you always get a clean, consistent dataset.
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

async function clean() {
  console.log('🧹 Clearing existing data...');
  // Children first, parents last.
  await prisma.document.deleteMany();
  await prisma.feedback.deleteMany();
  await prisma.userBadge.deleteMany();
  await prisma.badge.deleteMany();
  await prisma.attendance.deleteMany();
  await prisma.equipmentBooking.deleteMany();
  await prisma.classBooking.deleteMany();
  await prisma.gymClass.deleteMany();
  await prisma.equipment.deleteMany();
  await prisma.facility.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.announcement.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.productOrder.deleteMany();
  await prisma.product.deleteMany();
  await prisma.bodyMeasurement.deleteMany();
  await prisma.workoutAssignment.deleteMany();
  await prisma.planExercise.deleteMany();
  await prisma.workoutDay.deleteMany();
  await prisma.workoutPlan.deleteMany();
  await prisma.exercise.deleteMany();
  await prisma.feeReminder.deleteMany();
  await prisma.feeRecord.deleteMany();
  await prisma.user.deleteMany();
  await prisma.membershipPlan.deleteMany();
}

async function main() {
  await clean();
  console.log('🌱 Seeding database...');

  const passwordHash = await hash(DEFAULT_PASSWORD);
  const now = new Date();

  // ==========================================================================
  // MEMBERSHIP PLANS (10)
  // ==========================================================================
  const planDefs = [
    { name: 'Daily Pass', durationDays: 1, price: 150 },
    { name: 'Weekly Plan', durationDays: 7, price: 800 },
    { name: 'Monthly Basic', durationDays: 30, price: 1500 },
    { name: 'Monthly Plus', durationDays: 30, price: 2200 },
    { name: 'Quarterly Plan', durationDays: 90, price: 4000 },
    { name: 'Half-Yearly Plan', durationDays: 180, price: 7500 },
    { name: 'Annual Plan', durationDays: 365, price: 15000 },
    { name: 'Annual Premium', durationDays: 365, price: 22000 },
    { name: 'Student Plan', durationDays: 30, price: 1000 },
    { name: 'Corporate Plan', durationDays: 30, price: 1800 },
  ];
  const plans = [];
  for (const p of planDefs) {
    plans.push(
      await prisma.membershipPlan.create({
        data: {
          name: p.name,
          durationDays: p.durationDays,
          price: p.price,
          description: `${p.name} membership`,
          features: ['Gym Floor', 'Locker', 'Group Classes'],
          isActive: true,
        },
      })
    );
  }

  // ==========================================================================
  // USERS (12) — 2 admins, 3 trainers (STAFF), 7 members
  // ==========================================================================
  const adminDefs = [
    { name: 'Asha Menon', phone: '9000000001', email: 'admin1@clubfitness.test' },
    { name: 'Rohit Sharma', phone: '9000000002', email: 'admin2@clubfitness.test' },
  ];
  const admins = [];
  for (const a of adminDefs) {
    admins.push(
      await prisma.user.create({
        data: { ...a, passwordHash, role: 'ADMIN', status: 'ACTIVE' },
      })
    );
  }

  const trainerDefs = [
    { name: 'Vikram Nair', phone: '9000000003', email: 'trainer1@clubfitness.test', staffTitle: 'Personal Trainer' },
    { name: 'Priya Pillai', phone: '9000000004', email: 'trainer2@clubfitness.test', staffTitle: 'Strength Coach' },
    { name: 'Suresh Kumar', phone: '9000000005', email: 'trainer3@clubfitness.test', staffTitle: 'Yoga Instructor' },
  ];
  const trainers = [];
  for (const t of trainerDefs) {
    trainers.push(
      await prisma.user.create({
        data: { ...t, passwordHash, role: 'STAFF', status: 'ACTIVE', hireDate: new Date('2023-01-15') },
      })
    );
  }

  const memberDefs = [
    { name: 'Anjali Krishnan', phone: '9000000006', email: 'member1@clubfitness.test' },
    { name: 'Karthik Raj', phone: '9000000007', email: 'member2@clubfitness.test' },
    { name: 'Divya Suresh', phone: '9000000008', email: 'member3@clubfitness.test' },
    { name: 'Manoj Pillai', phone: '9000000009', email: 'member4@clubfitness.test' },
    { name: 'Sneha Thomas', phone: '9000000010', email: 'member5@clubfitness.test' },
    { name: 'Arjun Das', phone: '9000000011', email: 'member6@clubfitness.test' },
    { name: 'Meera Iyer', phone: '9000000012', email: 'member7@clubfitness.test' },
  ];
  const members = [];
  for (let i = 0; i < memberDefs.length; i++) {
    const m = memberDefs[i];
    const plan = plans[i % plans.length];
    const trainer = trainers[i % trainers.length];
    const membershipEnd = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    members.push(
      await prisma.user.create({
        data: {
          name: m.name,
          phone: m.phone,
          email: m.email,
          passwordHash,
          role: 'MEMBER',
          status: 'ACTIVE',
          membershipPlanId: plan.id,
          membershipStart: now,
          membershipEnd,
          assignedTrainerId: trainer.id,
          referredById: i > 0 ? members[i - 1]?.id : undefined,
        },
      })
    );
  }

  const allUsers = [...admins, ...trainers, ...members];

  // ==========================================================================
  // FEE RECORDS (14) & FEE REMINDERS (14)
  // ==========================================================================
  const feeStatuses = ['PENDING', 'PAID', 'OVERDUE', 'PARTIAL', 'WAIVED'];
  const feeRecords = [];
  for (let i = 0; i < 14; i++) {
    const member = members[i % members.length];
    const plan = plans[i % plans.length];
    const status = feeStatuses[i % feeStatuses.length];
    const dueDate = new Date(now.getTime() + (i - 7) * 24 * 60 * 60 * 1000);
    feeRecords.push(
      await prisma.feeRecord.create({
        data: {
          memberId: member.id,
          planId: plan.id,
          amount: plan.price,
          paidAmount: status === 'PAID' ? plan.price : status === 'PARTIAL' ? Number(plan.price) / 2 : null,
          status,
          dueDate,
          paidDate: status === 'PAID' ? now : null,
          paymentMethod: status === 'PAID' ? 'UPI' : null,
          approvedById: status === 'PAID' ? admins[i % admins.length].id : null,
        },
      })
    );
  }

  const reminderChannels = ['PUSH', 'WHATSAPP', 'SMS'];
  for (let i = 0; i < 14; i++) {
    await prisma.feeReminder.create({
      data: {
        feeRecordId: feeRecords[i % feeRecords.length].id,
        channel: reminderChannels[i % reminderChannels.length],
        automatic: i % 2 === 0,
      },
    });
  }

  // ==========================================================================
  // EXERCISES (10)
  // ==========================================================================
  const exerciseDefs = [
    { name: 'Barbell Bench Press', category: 'Chest', muscle: 'Pectorals' },
    { name: 'Pull Ups', category: 'Back', muscle: 'Lats' },
    { name: 'Squats', category: 'Legs', muscle: 'Quadriceps' },
    { name: 'Deadlift', category: 'Back', muscle: 'Hamstrings' },
    { name: 'Overhead Press', category: 'Shoulders', muscle: 'Deltoids' },
    { name: 'Bicep Curl', category: 'Arms', muscle: 'Biceps' },
    { name: 'Tricep Dips', category: 'Arms', muscle: 'Triceps' },
    { name: 'Plank', category: 'Core', muscle: 'Abdominals' },
    { name: 'Treadmill Run', category: 'Cardio', muscle: 'Full Body' },
    { name: 'Lat Pulldown', category: 'Back', muscle: 'Lats' },
  ];
  const exercises = [];
  for (const e of exerciseDefs) {
    exercises.push(
      await prisma.exercise.create({
        data: { ...e, difficulty: 'Intermediate', isActive: true },
      })
    );
  }

  // ==========================================================================
  // WORKOUT PLANS (10), WORKOUT DAYS (10), PLAN EXERCISES (12), ASSIGNMENTS (10)
  // ==========================================================================
  const workoutPlans = [];
  for (let i = 0; i < 10; i++) {
    workoutPlans.push(
      await prisma.workoutPlan.create({
        data: {
          name: `${i % 2 === 0 ? 'Strength' : 'Cardio'} Plan ${i + 1}`,
          type: i % 2 === 0 ? 'WEEKLY' : 'DAILY',
          isTemplate: i % 3 === 0,
          createdById: trainers[i % trainers.length].id,
          startDate: now,
          endDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        },
      })
    );
  }

  const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const workoutDays = [];
  for (let i = 0; i < 10; i++) {
    workoutDays.push(
      await prisma.workoutDay.create({
        data: {
          planId: workoutPlans[i % workoutPlans.length].id,
          dayOfWeek: daysOfWeek[i % daysOfWeek.length],
          isRestDay: i % 7 === 6,
        },
      })
    );
  }

  for (let i = 0; i < 12; i++) {
    await prisma.planExercise.create({
      data: {
        dayId: workoutDays[i % workoutDays.length].id,
        exerciseId: exercises[i % exercises.length].id,
        sets: 3 + (i % 3),
        reps: 8 + (i % 5),
        restSeconds: 60,
        orderIndex: i % 5,
      },
    });
  }

  for (let i = 0; i < 10; i++) {
    await prisma.workoutAssignment.create({
      data: {
        planId: workoutPlans[i % workoutPlans.length].id,
        memberId: members[i % members.length].id,
        startDate: now,
        endDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        notifySent: i % 2 === 0,
        completedExerciseIds: [],
      },
    });
  }

  // ==========================================================================
  // BODY MEASUREMENTS (12)
  // ==========================================================================
  for (let i = 0; i < 12; i++) {
    await prisma.bodyMeasurement.create({
      data: {
        memberId: members[i % members.length].id,
        weightKg: 60 + i,
        bodyFatPct: 15 + (i % 10),
        chestCm: 90 + i,
        waistCm: 75 + i,
        armsCm: 30 + (i % 5),
        legsCm: 50 + (i % 5),
        recordedAt: new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000),
      },
    });
  }

  // ==========================================================================
  // PRODUCTS (10), PRODUCT ORDERS (10), ORDER ITEMS (12)
  // ==========================================================================
  const productDefs = [
    { name: 'Whey Protein 1kg', category: 'Supplements', price: 2500 },
    { name: 'BCAA Powder', category: 'Supplements', price: 1200 },
    { name: 'Creatine Monohydrate', category: 'Supplements', price: 900 },
    { name: 'Gym T-Shirt', category: 'Apparel', price: 600 },
    { name: 'Gym Shorts', category: 'Apparel', price: 700 },
    { name: 'Shaker Bottle', category: 'Accessories', price: 300 },
    { name: 'Gym Gloves', category: 'Accessories', price: 450 },
    { name: 'Resistance Bands', category: 'Equipment', price: 800 },
    { name: 'Yoga Mat', category: 'Equipment', price: 1000 },
    { name: 'Lifting Belt', category: 'Equipment', price: 1500 },
  ];
  const products = [];
  for (const p of productDefs) {
    products.push(
      await prisma.product.create({
        data: { ...p, stockCount: 25, isActive: true, isFeatured: false },
      })
    );
  }

  const orderStatuses = ['PLACED', 'CONFIRMED', 'READY', 'COLLECTED', 'CANCELLED'];
  const productOrders = [];
  for (let i = 0; i < 10; i++) {
    productOrders.push(
      await prisma.productOrder.create({
        data: {
          memberId: members[i % members.length].id,
          orderType: i % 2 === 0 ? 'PRE_ORDER' : 'WALK_IN',
          status: orderStatuses[i % orderStatuses.length],
          totalAmount: products[i % products.length].price,
          processedById: trainers[i % trainers.length].id,
        },
      })
    );
  }

  for (let i = 0; i < 12; i++) {
    const product = products[i % products.length];
    await prisma.orderItem.create({
      data: {
        orderId: productOrders[i % productOrders.length].id,
        productId: product.id,
        quantity: 1 + (i % 3),
        unitPrice: product.price,
      },
    });
  }

  // ==========================================================================
  // ANNOUNCEMENTS (10) & NOTIFICATIONS (14)
  // ==========================================================================
  const announcementTypes = ['ANNOUNCEMENT', 'OFFER', 'EVENT', 'ALERT', 'MOTIVATION'];
  const announcements = [];
  for (let i = 0; i < 10; i++) {
    announcements.push(
      await prisma.announcement.create({
        data: {
          title: `Announcement ${i + 1}`,
          body: `This is the body for announcement ${i + 1}.`,
          type: announcementTypes[i % announcementTypes.length],
          createdById: admins[i % admins.length].id,
          audienceType: 'ALL',
          channels: ['PUSH'],
          isDraft: i % 5 === 0,
          sentAt: i % 5 === 0 ? null : now,
        },
      })
    );
  }

  for (let i = 0; i < 14; i++) {
    await prisma.notification.create({
      data: {
        userId: allUsers[i % allUsers.length].id,
        announcementId: i % 3 === 0 ? null : announcements[i % announcements.length].id,
        title: `Notification ${i + 1}`,
        body: `Notification body ${i + 1}`,
        channel: reminderChannels[i % reminderChannels.length],
        isRead: i % 2 === 0,
      },
    });
  }

  // ==========================================================================
  // FACILITIES (10), EQUIPMENT (10), GYM CLASSES (10)
  // ==========================================================================
  const facilityDefs = [
    'Main Gym Floor', 'Cardio Zone', 'Free Weights Area', 'Sauna', 'Steam Room',
    'Swimming Pool', 'Yoga Studio', 'Spin Room', 'Locker Room A', 'Locker Room B',
  ];
  const facilities = [];
  for (const name of facilityDefs) {
    facilities.push(
      await prisma.facility.create({
        data: { name, status: 'OPEN', openTime: '06:00', closeTime: '22:00', capacity: 50 },
      })
    );
  }

  const equipmentDefs = [
    'Treadmill', 'Elliptical Machine', 'Rowing Machine', 'Leg Press Machine', 'Smith Machine',
    'Cable Crossover', 'Dumbbell Set', 'Barbell Set', 'Kettlebells', 'Stationary Bike',
  ];
  const equipmentList = [];
  for (const name of equipmentDefs) {
    equipmentList.push(
      await prisma.equipment.create({
        data: { name, category: 'Strength', quantity: 5, status: 'WORKING' },
      })
    );
  }

  const gymClassDefs = [
    { name: 'Zumba', trainerName: trainers[0].name, dayOfWeek: 'Mon' },
    { name: 'Yoga', trainerName: trainers[2].name, dayOfWeek: 'Tue' },
    { name: 'Spinning', trainerName: trainers[1].name, dayOfWeek: 'Wed' },
    { name: 'HIIT', trainerName: trainers[0].name, dayOfWeek: 'Thu' },
    { name: 'Pilates', trainerName: trainers[2].name, dayOfWeek: 'Fri' },
    { name: 'CrossFit', trainerName: trainers[1].name, dayOfWeek: 'Sat' },
    { name: 'Boxing', trainerName: trainers[0].name, dayOfWeek: 'Mon' },
    { name: 'Strength Circuit', trainerName: trainers[1].name, dayOfWeek: 'Wed' },
    { name: 'Stretch & Mobility', trainerName: trainers[2].name, dayOfWeek: 'Fri' },
    { name: 'Aqua Aerobics', trainerName: trainers[0].name, dayOfWeek: 'Sun' },
  ];
  const gymClasses = [];
  for (const c of gymClassDefs) {
    gymClasses.push(
      await prisma.gymClass.create({
        data: { ...c, startTime: '08:00', durationMins: 60, capacity: 20 },
      })
    );
  }

  // ==========================================================================
  // CLASS BOOKINGS (10) & EQUIPMENT BOOKINGS (10)
  // (gymClass / equipment index kept unique per iteration to avoid the
  //  @@unique([gymClassId, memberId]) clash on ClassBooking)
  // ==========================================================================
  const bookingStatuses = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
  for (let i = 0; i < 10; i++) {
    await prisma.classBooking.create({
      data: {
        gymClassId: gymClasses[i].id, // unique index 0-9, guarantees no duplicate pair
        memberId: members[i % members.length].id,
        status: bookingStatuses[i % bookingStatuses.length],
      },
    });
  }

  for (let i = 0; i < 10; i++) {
    const start = new Date(now.getTime() + i * 60 * 60 * 1000);
    await prisma.equipmentBooking.create({
      data: {
        equipmentId: equipmentList[i].id,
        memberId: members[i % members.length].id,
        startTime: start,
        endTime: new Date(start.getTime() + 30 * 60 * 1000),
        status: bookingStatuses[i % bookingStatuses.length],
      },
    });
  }

  // ==========================================================================
  // ATTENDANCE (14)
  // ==========================================================================
  for (let i = 0; i < 14; i++) {
    const checkInAt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    await prisma.attendance.create({
      data: {
        memberId: members[i % members.length].id,
        checkInAt,
        checkOutAt: new Date(checkInAt.getTime() + 90 * 60 * 1000),
        method: i % 2 === 0 ? 'QR' : 'MANUAL',
      },
    });
  }

  // ==========================================================================
  // BADGES (10) & USER BADGES (10)
  // ==========================================================================
  const badgeDefs = [
    '7-Day Streak', '30-Day Streak', '100-Day Streak', 'First Workout', 'First Class',
    'Weight Goal Achiever', 'Early Bird', 'Night Owl', 'Referral Champion', 'Top Spender',
  ];
  const badges = [];
  for (const name of badgeDefs) {
    badges.push(await prisma.badge.create({ data: { name, description: `Earned for: ${name}` } }));
  }

  for (let i = 0; i < 10; i++) {
    await prisma.userBadge.create({
      data: {
        userId: allUsers[i % allUsers.length].id,
        badgeId: badges[i].id, // unique index 0-9, guarantees no duplicate pair
      },
    });
  }

  // ==========================================================================
  // FEEDBACK (10)
  // ==========================================================================
  const feedbackCategories = ['class', 'trainer', 'facility', 'general'];
  for (let i = 0; i < 10; i++) {
    await prisma.feedback.create({
      data: {
        memberId: members[i % members.length].id,
        category: feedbackCategories[i % feedbackCategories.length],
        rating: 1 + (i % 5),
        comment: `Feedback comment ${i + 1}`,
      },
    });
  }

  // ==========================================================================
  // DOCUMENTS (10)
  // ==========================================================================
  const documentDefs = [
    { title: 'Gym Rules', category: 'rules' },
    { title: 'Liability Waiver', category: 'waiver' },
    { title: 'Beginner Workout PDF', category: 'workout-pdf' },
    { title: 'Advanced Workout PDF', category: 'workout-pdf' },
    { title: 'Diet Plan Guide', category: 'other' },
    { title: 'Membership Terms', category: 'rules' },
    { title: 'COVID Safety Guidelines', category: 'rules' },
    { title: 'Personal Trainer Agreement', category: 'waiver' },
    { title: 'Equipment Usage Guide', category: 'other' },
    { title: 'Class Schedule PDF', category: 'other' },
  ];
  const uploaders = [...admins, ...trainers];
  for (let i = 0; i < documentDefs.length; i++) {
    const d = documentDefs[i];
    await prisma.document.create({
      data: {
        title: d.title,
        fileUrl: `https://example.com/docs/${d.title.toLowerCase().replace(/\s+/g, '-')}.pdf`,
        category: d.category,
        uploadedById: uploaders[i % uploaders.length].id,
      },
    });
  }

  console.log('✅ Seed complete — 10+ entries created for every model.');
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
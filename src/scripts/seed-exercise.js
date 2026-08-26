// prisma/seed/exercise-seed.ts
//
// Seeds the `Exercise` table with the exercises used in the Flutter
// `_exerciseLibrary` sample list, plus additional common gym exercises
// per muscle category.
//
// Run with:
//   npx ts-node prisma/seed/exercise-seed.ts
// or wire it into package.json:
//   "prisma": { "seed": "ts-node prisma/seed/exercise-seed.ts" }
// then: npx prisma db seed

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const exercises = [
  // ── Chest ──────────────────────────────────────────────────────────
  { id: 'e1', name: 'Bench Press', category: 'Chest', muscle: 'Pectorals', difficulty: 'Intermediate' },
  { id: 'e2', name: 'Incline Dumbbell Press', category: 'Chest', muscle: 'Upper Chest', difficulty: 'Intermediate' },
  { id: 'e3', name: 'Cable Fly', category: 'Chest', muscle: 'Pectorals', difficulty: 'Beginner' },
  { id: 'e17', name: 'Push-Up', category: 'Chest', muscle: 'Pectorals', difficulty: 'Beginner' },
  { id: 'e18', name: 'Decline Bench Press', category: 'Chest', muscle: 'Lower Chest', difficulty: 'Intermediate' },
  { id: 'e19', name: 'Chest Dip', category: 'Chest', muscle: 'Lower Chest', difficulty: 'Advanced' },
  { id: 'e20', name: 'Pec Deck Machine', category: 'Chest', muscle: 'Pectorals', difficulty: 'Beginner' },
 
  // ── Back ───────────────────────────────────────────────────────────
  { id: 'e4', name: 'Pull-Up', category: 'Back', muscle: 'Lats', difficulty: 'Advanced' },
  { id: 'e5', name: 'Barbell Row', category: 'Back', muscle: 'Rhomboids', difficulty: 'Intermediate' },
  { id: 'e6', name: 'Lat Pulldown', category: 'Back', muscle: 'Lats', difficulty: 'Beginner' },
  { id: 'e21', name: 'Deadlift', category: 'Back', muscle: 'Erector Spinae', difficulty: 'Advanced' },
  { id: 'e22', name: 'Seated Cable Row', category: 'Back', muscle: 'Rhomboids', difficulty: 'Beginner' },
  { id: 'e23', name: 'T-Bar Row', category: 'Back', muscle: 'Lats', difficulty: 'Intermediate' },
  { id: 'e24', name: 'Face Pull', category: 'Back', muscle: 'Rear Deltoids', difficulty: 'Beginner' },
 
  // ── Legs ───────────────────────────────────────────────────────────
  { id: 'e7', name: 'Squat', category: 'Legs', muscle: 'Quadriceps', difficulty: 'Intermediate' },
  { id: 'e8', name: 'Leg Press', category: 'Legs', muscle: 'Quadriceps', difficulty: 'Beginner' },
  { id: 'e9', name: 'Romanian Deadlift', category: 'Legs', muscle: 'Hamstrings', difficulty: 'Intermediate' },
  { id: 'e25', name: 'Leg Extension', category: 'Legs', muscle: 'Quadriceps', difficulty: 'Beginner' },
  { id: 'e26', name: 'Leg Curl', category: 'Legs', muscle: 'Hamstrings', difficulty: 'Beginner' },
  { id: 'e27', name: 'Walking Lunge', category: 'Legs', muscle: 'Quadriceps', difficulty: 'Intermediate' },
  { id: 'e28', name: 'Calf Raise', category: 'Legs', muscle: 'Calves', difficulty: 'Beginner' },
  { id: 'e29', name: 'Hip Thrust', category: 'Legs', muscle: 'Glutes', difficulty: 'Intermediate' },
 
  // ── Shoulders ──────────────────────────────────────────────────────
  { id: 'e10', name: 'Overhead Press', category: 'Shoulders', muscle: 'Deltoids', difficulty: 'Intermediate' },
  { id: 'e11', name: 'Lateral Raise', category: 'Shoulders', muscle: 'Side Deltoids', difficulty: 'Beginner' },
  { id: 'e30', name: 'Arnold Press', category: 'Shoulders', muscle: 'Deltoids', difficulty: 'Intermediate' },
  { id: 'e31', name: 'Front Raise', category: 'Shoulders', muscle: 'Front Deltoids', difficulty: 'Beginner' },
  { id: 'e32', name: 'Shrugs', category: 'Shoulders', muscle: 'Trapezius', difficulty: 'Beginner' },
 
  // ── Arms ───────────────────────────────────────────────────────────
  { id: 'e12', name: 'Tricep Pushdown', category: 'Arms', muscle: 'Triceps', difficulty: 'Beginner' },
  { id: 'e13', name: 'Bicep Curl', category: 'Arms', muscle: 'Biceps', difficulty: 'Beginner' },
  { id: 'e33', name: 'Hammer Curl', category: 'Arms', muscle: 'Brachialis', difficulty: 'Beginner' },
  { id: 'e34', name: 'Skull Crusher', category: 'Arms', muscle: 'Triceps', difficulty: 'Intermediate' },
  { id: 'e35', name: 'Chin-Up', category: 'Arms', muscle: 'Biceps', difficulty: 'Advanced' },
  { id: 'e36', name: 'Preacher Curl', category: 'Arms', muscle: 'Biceps', difficulty: 'Intermediate' },
 
  // ── Core ───────────────────────────────────────────────────────────
  { id: 'e14', name: 'Plank', category: 'Core', muscle: 'Core', difficulty: 'Beginner' },
  { id: 'e37', name: 'Russian Twist', category: 'Core', muscle: 'Obliques', difficulty: 'Beginner' },
  { id: 'e38', name: 'Hanging Leg Raise', category: 'Core', muscle: 'Lower Abs', difficulty: 'Advanced' },
  { id: 'e39', name: 'Crunch', category: 'Core', muscle: 'Abs', difficulty: 'Beginner' },
  { id: 'e40', name: 'Mountain Climbers', category: 'Core', muscle: 'Core', difficulty: 'Beginner' },
 
  // ── Cardio ─────────────────────────────────────────────────────────
  { id: 'e15', name: 'Treadmill', category: 'Cardio', muscle: 'Full Body', difficulty: 'Beginner' },
  { id: 'e16', name: 'Jump Rope', category: 'Cardio', muscle: 'Full Body', difficulty: 'Beginner' },
  { id: 'e41', name: 'Rowing Machine', category: 'Cardio', muscle: 'Full Body', difficulty: 'Beginner' },
  { id: 'e42', name: 'Stationary Bike', category: 'Cardio', muscle: 'Full Body', difficulty: 'Beginner' },
  { id: 'e43', name: 'Burpees', category: 'Cardio', muscle: 'Full Body', difficulty: 'Intermediate' },
  { id: 'e44', name: 'Stair Climber', category: 'Cardio', muscle: 'Legs', difficulty: 'Beginner' },
];
 
async function main() {
 
  console.log(`Seeding ${exercises.length} exercises...`);
 
  const result = await prisma.exercise.createMany({
    data: exercises.map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category,
      muscle: e.muscle,
      difficulty: e.difficulty,
      description: e.description ?? null,
      isActive: true,
    })),
    skipDuplicates: true,
  });
 
  console.log(`Seed complete. Inserted ${result.count} new exercise(s).`);
}
 
main()
  .catch((err) => {
    console.error('Exercise seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
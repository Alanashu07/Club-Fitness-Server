import dateUtil from '../../utils/date.js';
import prisma from '../../config/db.js';
import { hashPassword } from '../../utils/password.js';

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const getTemplates = asyncHandler(async (req, res) => {
  const { search, type, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    isTemplate: true,
    ...(type ? { type: type.toUpperCase() } : {}),
    ...(search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {}),
  };

  const [templates, total] = await Promise.all([
    prisma.workoutPlan.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        days: {
          orderBy: { dayOfWeek: 'asc' },
          include: {
            _count: { select: { exercises: true } },
          },
        },
        _count: { select: { assignments: true } },
      },
    }),
    prisma.workoutPlan.count({ where }),
  ]);

  // Shape each template for the UI card
  const shaped = templates.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    createdBy: t.createdBy,
    startDate: t.startDate,
    endDate: t.endDate,
    timesAssigned: t._count.assignments,
    totalExercises: t.days.reduce(
      (sum, d) => sum + d._count.exercises,
      0
    ),
    dayBreakdown: t.days.map((d) => ({
      day: d.dayOfWeek,
      isRestDay: d.isRestDay,
      exerciseCount: d._count.exercises,
    })),
    createdAt: t.createdAt,
  }));

  res.json({
    templates: shaped,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
    }
  });
});

const getTemplateDetails = asyncHandler(async (req, res) => {
  const template = await prisma.workoutPlan.findUnique({
    where: { id: req.params.id, isTemplate: true },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      days: {
        orderBy: { dayOfWeek: 'asc' },
        include: {
          exercises: {
            orderBy: { orderIndex: 'asc' },
            include: { exercise: true },
          },
        },
      },
      _count: { select: { assignments: true } },
    },
  });

  if (!template) {
    const failure = { title: 'Template not found', code: 404, message: 'Template not found with ID: ' + req.params.id };
    return res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND', failure });
  }

  res.json(template);
});

const saveTemplate = asyncHandler(async (req, res) => {
  const { planId } = req.body;

  if (!planId) {
    return res.status(400).json({ error: 'planId is required' });
  }

  const updated = await prisma.workoutPlan.update({
    where: { id: planId },
    data: { isTemplate: true },
  });

  res.json({ message: 'Plan saved as template', plan: updated });
});

const deleteTemplate = asyncHandler(async (req, res) => {
  const { hardDelete } = req.query;

  if (hardDelete === 'true') {
    await prisma.workoutPlan.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  }

  // Soft: just unflag as template (keeps assignment history intact)
  await prisma.workoutPlan.update({
    where: { id: req.params.id },
    data: { isTemplate: false },
  });

  res.json({ message: 'Template flag removed' });
});

// =============================================================================
// 2. GET ALL EXERCISES + CATEGORIES  (ADMIN + STAFF)
//
// GET /api/workouts/exercises
//
// Returns two parallel lists in a single response:
//   - exercises : full exercise records, filtered + paginated
//   - categories: distinct category names with their exercise counts
//
// The Flutter screen can use `categories` to build the filter chips
// and `exercises` to populate the grid — both in one round-trip.
//
// Query params:
//   category   – filter by category name (exact, case-sensitive)
//   difficulty – 'Beginner' | 'Intermediate' | 'Advanced'
//   search     – partial name match (case-insensitive)
//   page       – default 1
//   limit      – default 50 (exercises are usually shown in a long grid)
// =============================================================================

const getAllExercises = asyncHandler(async (req, res) => {
  const {
    category,
    difficulty,
    search,
    page = 1,
    limit = 50,
  } = req.query;

  const skip = (Number(page) - 1) * Number(limit);

  const exerciseWhere = {
    isActive: true,
    ...(category ? { category } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(search
      ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { muscle: { contains: search, mode: 'insensitive' } },
        ],
      }
      : {}),
  };

  // Run both queries in parallel
  const [exercises, exerciseTotal, categoryGroups] = await Promise.all([
    // Paginated exercises (filtered)
    prisma.exercise.findMany({
      where: exerciseWhere,
      skip,
      take: Number(limit),
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        category: true,
        muscle: true,
        difficulty: true,
        description: true,
        imageUrl: true,
        videoUrl: true,
      },
    }),

    // Total matching exercises (for pagination)
    prisma.exercise.count({ where: exerciseWhere }),

    // All distinct categories with count (always unfiltered — for chip row)
    prisma.exercise.groupBy({
      by: ['category'],
      where: { isActive: true },
      _count: { _all: true },
      orderBy: { category: 'asc' },
    }),
  ]);

  // Build the categories list the Flutter chip row expects:
  // [{ name: 'All', count: N }, { name: 'Chest', count: 3 }, ...]
  const totalActive = await prisma.exercise.count({ where: { isActive: true } });

  const categories = [
    { name: 'All', count: totalActive },
    ...categoryGroups.map((g) => ({
      name: g.category,
      count: g._count._all,
    })),
  ];

  res.json({
    // The two separate lists the screen needs
    exercises,
    categories,

    // Pagination metadata for the exercise list
    pagination: {
      total: exerciseTotal,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(exerciseTotal / Number(limit)),
    },
  });
});

const getExerciseDetails = asyncHandler(async (req, res) => {
  const exercise = await prisma.exercise.findUnique({
    where: { id: req.params.id },
  });
  if (!exercise) {
    return res.status(404).json({ error: 'Exercise not found' });
  }
  res.json(exercise);
});

const createExercise = asyncHandler(async (req, res) => {
  const { name, category, muscle, difficulty, description, videoUrl, imageUrl } =
    req.body;

  if (!name || !category || !muscle) {
    return res
      .status(400)
      .json({ error: 'name, category and muscle are required' });
  }

  const exercise = await prisma.exercise.create({
    data: {
      name,
      category,
      muscle,
      difficulty: difficulty || 'Beginner',
      description,
      videoUrl,
      imageUrl,
    },
  });

  res.status(201).json(exercise);
});

const updateExercise = asyncHandler(async (req, res) => {
  const { name, category, muscle, difficulty, description, videoUrl, imageUrl, isActive } =
    req.body;

  const exercise = await prisma.exercise.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(category !== undefined && { category }),
      ...(muscle !== undefined && { muscle }),
      ...(difficulty !== undefined && { difficulty }),
      ...(description !== undefined && { description }),
      ...(videoUrl !== undefined && { videoUrl }),
      ...(imageUrl !== undefined && { imageUrl }),
      ...(isActive !== undefined && { isActive }),
    },
  });

  res.json(exercise);
});

// =============================================================================
// 3. ASSIGN WORKOUT TO MULTIPLE MEMBERS  (ADMIN + STAFF)
//
// POST /api/workouts/assign
//
// Assigns one WorkoutPlan to one or more members in a single request.
// For each member:
//   - Creates a WorkoutAssignment record
//   - Optionally writes a Notification row (if notifyMembers is true)
//
// Body:
// {
//   planId       : string          — existing WorkoutPlan id
//   memberIds    : string[]        — one or more User ids (role = MEMBER)
//   startDate    : ISO date string
//   endDate      : ISO date string
//   notifyMembers: boolean         — default true; writes Notification rows
// }
//
// Response:
// {
//   assigned     : number          — how many assignments were created
//   skipped      : number          — members who already had this plan active
//   assignments  : Assignment[]    — the newly created records
// }
// =============================================================================

const assignWorkout = asyncHandler(async (req, res) => {
  const {
    planId,
    memberIds,
    startDate,
    endDate,
    notifyMembers = true,
  } = req.body;

  // ── Validation ─────────────────────────────────────────────────────────
  if (!planId || !memberIds || !startDate || !endDate) {
    return res.status(400).json({
      error: 'planId, memberIds, startDate and endDate are required',
    });
  }

  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({
      error: 'memberIds must be a non-empty array',
    });
  }

  const parsedStart = new Date(startDate);
  const parsedEnd = new Date(endDate);

  if (isNaN(parsedStart) || isNaN(parsedEnd)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  if (parsedEnd <= parsedStart) {
    return res.status(400).json({ error: 'endDate must be after startDate' });
  }

  // ── Verify plan exists ─────────────────────────────────────────────────
  const plan = await prisma.workoutPlan.findUnique({
    where: { id: planId },
    select: { id: true, name: true, type: true },
  });

  if (!plan) {
    return res.status(404).json({ error: 'Workout plan not found' });
  }

  // ── Verify all memberIds are real MEMBER-role users ────────────────────
  const members = await prisma.user.findMany({
    where: { id: { in: memberIds }, role: 'MEMBER' },
    select: { id: true, name: true },
  });

  const validMemberIds = members.map((m) => m.id);
  const invalidIds = memberIds.filter((id) => !validMemberIds.includes(id));

  if (invalidIds.length > 0) {
    return res.status(400).json({
      error: 'Some memberIds are not valid MEMBER users',
      invalidIds,
    });
  }

  // ── Find members who already have this exact plan assigned + active ────
  const existing = await prisma.workoutAssignment.findMany({
    where: {
      planId,
      memberId: { in: validMemberIds },
      endDate: { gte: new Date() }, // still active
    },
    select: { memberId: true },
  });

  const alreadyAssignedIds = new Set(existing.map((a) => a.memberId));
  const toAssignIds = validMemberIds.filter(
    (id) => !alreadyAssignedIds.has(id)
  );

  if (toAssignIds.length === 0) {
    return res.status(409).json({
      error: 'All specified members already have this plan assigned and active',
      skipped: validMemberIds.length,
      assigned: 0,
    });
  }

  // ── Create assignments + notifications in a transaction ────────────────
  const [assignments] = await prisma.$transaction(async (tx) => {
    // Bulk-create assignments
    await tx.workoutAssignment.createMany({
      data: toAssignIds.map((memberId) => ({
        planId,
        memberId,
        startDate: parsedStart,
        endDate: parsedEnd,
        notifySent: notifyMembers,
      })),
    });

    // Fetch the created records (createMany doesn't return rows in Prisma)
    const created = await tx.workoutAssignment.findMany({
      where: {
        planId,
        memberId: { in: toAssignIds },
        startDate: parsedStart,
      },
      include: {
        member: { select: { id: true, name: true, phone: true } },
        plan: { select: { id: true, name: true, type: true } },
      },
      orderBy: { assignedAt: 'desc' },
    });

    // Optionally write Notification rows
    if (notifyMembers && toAssignIds.length > 0) {
      await tx.notification.createMany({
        data: toAssignIds.map((userId) => ({
          userId,
          title: 'New Workout Plan Assigned',
          body: `Your trainer has assigned "${plan.name}" starting ${parsedStart.toDateString()}.`,
          channel: 'PUSH',
        })),
      });
    }

    return [created];
  });

  res.status(201).json({
    message: `Workout assigned to ${assignments.length} member(s)`,
    assigned: assignments.length,
    skipped: alreadyAssignedIds.size,
    assignments,
  });
});

// =============================================================================
// BONUS: Workout Plan CRUD  (ADMIN + STAFF)
// These support the full assign workflow from the Flutter screen.
// =============================================================================

const getAllPlans = asyncHandler(async (req, res) => {
  const { search, type, isTemplate, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    ...(type ? { type: type.toUpperCase() } : {}),
    ...(isTemplate !== undefined ? { isTemplate: isTemplate === 'true' } : {}),
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  };

  const [plans, total] = await Promise.all([
    prisma.workoutPlan.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { assignments: true, days: true } },
      },
    }),
    prisma.workoutPlan.count({ where }),
  ]);

  res.json({ plans, pagination: {total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / limit)} });
});

const getPlanDetails = asyncHandler(async (req, res) => {
  const plan = await prisma.workoutPlan.findUnique({
    where: { id: req.params.id },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      days: {
        orderBy: { dayOfWeek: 'asc' },
        include: {
          exercises: {
            orderBy: { orderIndex: 'asc' },
            include: { exercise: true },
          },
        },
      },
      assignments: {
        orderBy: { assignedAt: 'desc' },
        take: 20,
        include: {
          member: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json(plan);
});

// POST /api/workouts/plans — create a full plan with days + exercises
//
// Body shape mirrors the Flutter _WorkoutDay / _PlanExercise model:
// {
//   name       : string
//   type       : 'DAILY' | 'WEEKLY'
//   startDate  : ISO string
//   endDate    : ISO string
//   isTemplate : boolean  (default false)
//   days: [
//     {
//       dayOfWeek : 'Mon' | 'Tue' | ... | string for DAILY
//       isRestDay : boolean
//       exercises : [
//         { exerciseId, sets, reps, restSeconds, notes, orderIndex }
//       ]
//     }
//   ]
// }

const createWorkoutPlan = asyncHandler(async (req, res) => {
  const {
    name,
    type = 'WEEKLY',
    startDate,
    endDate,
    isTemplate = false,
    days = [],
  } = req.body;

  if (!name || !startDate || !endDate) {
    return res
      .status(400)
      .json({ error: 'name, startDate and endDate are required' });
  }

  const plan = await prisma.$transaction(async (tx) => {
    // 1. Create the plan
    const created = await tx.workoutPlan.create({
      data: {
        name,
        type: type.toUpperCase(),
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        isTemplate,
        createdById: req.user.id,
      },
    });

    // 2. Create each day + its exercises
    for (const day of days) {
      const createdDay = await tx.workoutDay.create({
        data: {
          planId: created.id,
          dayOfWeek: day.dayOfWeek,
          isRestDay: day.isRestDay ?? false,
        },
      });

      if (!day.isRestDay && day.exercises?.length > 0) {
        await tx.planExercise.createMany({
          data: day.exercises.map((ex, idx) => ({
            dayId: createdDay.id,
            exerciseId: ex.exerciseId,
            sets: ex.sets ?? 3,
            reps: ex.reps ?? 12,
            restSeconds: ex.restSeconds ?? 60,
            notes: ex.notes ?? '',
            orderIndex: ex.orderIndex ?? idx,
          })),
        });
      }
    }

    // Return with full nested structure
    return tx.workoutPlan.findUnique({
      where: { id: created.id },
      include: {
        days: {
          include: {
            exercises: { include: { exercise: true } },
          },
        },
      },
    });
  });

  res.status(201).json(plan);
});

const deleteWorkoutPlan = asyncHandler(async (req, res) => {
  await prisma.workoutPlan.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

const getMyWorkouts = asyncHandler(async (req, res) => {
  const memberId = req.user.id;
  const now = new Date();

  const [active, history] = await Promise.all([
    prisma.workoutAssignment.findFirst({
      where: {
        memberId,
        startDate: { lte: now },
        endDate: { gte: now },
      },
      orderBy: { assignedAt: 'desc' },
      include: {
        plan: {
          include: {
            days: {
              orderBy: { dayOfWeek: 'asc' },
              include: {
                exercises: {
                  orderBy: { orderIndex: 'asc' },
                  include: { exercise: true },
                },
              },
            },
          },
        },
      },
    }),

    prisma.workoutAssignment.findMany({
      where: { memberId, endDate: { lt: now } },
      orderBy: { assignedAt: 'desc' },
      take: 5,
      include: {
        plan: { select: { id: true, name: true, type: true } },
      },
    }),
  ]);

  res.json({ active, history });
});

// ============================================================================
// Backs WorkoutPlanScreen: a Mon–Sun week strip, a per-day exercise list with
// done/undone state, and daily/weekly progress.
//
// SCHEMA NOTES (read before wiring this up):
//
// 1. WorkoutDay has no "focus" label field (e.g. "Chest & Triceps"). This
//    controller derives one from the exercises' categories as a fallback.
//    For exact control, add `label String?` to WorkoutDay and prefer it
//    over the computed fallback (see computeFocusLabel below).
//
// 2. WorkoutAssignment.completedExerciseIds is a flat String[] of
//    PlanExercise ids. That's ambiguous for a plan that repeats weekly,
//    since the same PlanExercise id recurs every Monday, every Tuesday, etc.
//    To track "done for THIS specific calendar date" without a migration,
//    this controller stores composite keys in that array:
//        `${YYYY-MM-DD}_${planExerciseId}`
//    instead of the bare planExerciseId. If anything else in the codebase
//    reads/writes completedExerciseIds directly, it needs to use the same
//    convention or this will silently disagree with it.
// ============================================================================

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function toDateOnly(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDateKey(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Monday of the week containing `date`.
function mondayOf(date) {
  const d = toDateOnly(date);
  const jsDay = d.getDay(); // 0 = Sun ... 6 = Sat
  const diffToMonday = jsDay === 0 ? -6 : 1 - jsDay;
  d.setDate(d.getDate() + diffToMonday);
  return d;
}

function parseDateParam(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? fallback : toDateOnly(parsed);
}

// Fallback focus label when WorkoutDay has no explicit label: pick the 1-2
// most common exercise categories for the day, e.g. "Chest & Triceps".
function computeFocusLabel(planExercises) {
  if (planExercises.length === 0) return 'Rest Day';
  const counts = new Map();
  for (const pe of planExercises) {
    const cat = pe.exercise.category || 'General';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const topCategories = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cat]) => cat);
  return topCategories.join(' & ');
}

function formatRestLabel(restSeconds) {
  if (!restSeconds || restSeconds <= 0) return '\u2014';
  if (restSeconds % 60 === 0) return `${restSeconds / 60}min`;
  return `${restSeconds}s`;
}

// ── resolve which memberId this request should operate on ──────────────────
// MEMBERs can only ever act on themselves. ADMIN/STAFF can look up or edit
// another member's plan by passing memberId (query for GET, body for POST).
function resolveMemberId(req, requestedMemberId) {
  if (!requestedMemberId || requestedMemberId === req.user.id) {
    return { memberId: req.user.id, ok: true };
  }
  if (['ADMIN', 'STAFF'].includes(req.user.role)) {
    return { memberId: requestedMemberId, ok: true };
  }
  return { memberId: null, ok: false };
}

// ── find the assignment covering a given date for a member ─────────────────
async function findAssignmentForDate(memberId, date) {
  return prisma.workoutAssignment.findFirst({
    where: {
      memberId,
      startDate: { lte: date },
      endDate: { gte: date },
    },
    orderBy: { startDate: 'desc' },
    include: {
      plan: {
        include: {
          days: {
            include: {
              exercises: {
                include: { exercise: true },
                orderBy: { orderIndex: 'asc' },
              },
            },
          },
        },
      },
    },
  });
}

// ============================================================================
// GET /api/workouts/week?weekStart=YYYY-MM-DD&memberId=...
//
// Returns the Mon–Sun week (defaults to the current week) with each day's
// assignment status, exercises, and completion state, plus a week summary.
// ============================================================================
const getWeek = async function (req, res, next) {
  try {
    const { memberId, ok } = resolveMemberId(req, req.query.memberId);
    if (!ok) {
      const failure = { title: 'Forbidden', message: 'You do not have access to this resource.', code: 403 };
      return res.status(403).json({ error: 'You do not have access to this resource', code: 'FORBIDDEN', failure });
    }

    const today = toDateOnly(new Date());
    const weekStart = req.query.weekStart ? parseDateParam(req.query.weekStart, mondayOf(today)) : mondayOf(today);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    // A single assignment can span the whole week (typical case); if a
    // member somehow has back-to-back assignments split mid-week, we look
    // up the covering assignment per-day instead of assuming one for all 7.
    const assignmentsInRange = await prisma.workoutAssignment.findMany({
      where: {
        memberId,
        startDate: { lte: weekEnd },
        endDate: { gte: weekStart },
      },
      orderBy: { startDate: 'asc' },
      include: {
        plan: {
          include: {
            days: {
              include: {
                exercises: {
                  include: { exercise: true },
                  orderBy: { orderIndex: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    function assignmentCovering(date) {
      return assignmentsInRange.find((a) => a.startDate <= date && a.endDate >= date) || null;
    }

    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + i);
      const weekdayLabel = WEEKDAY_LABELS[i];

      const assignment = assignmentCovering(date);
      const workoutDay = assignment?.plan.days.find(
        (d) => d.dayOfWeek === weekdayLabel && !d.isRestDay,
      );
      const planExercises = workoutDay?.exercises ?? [];
      const assigned = Boolean(workoutDay) && planExercises.length > 0;

      const dateKey = formatDateKey(date);
      const completedSet = new Set(assignment?.completedExerciseIds ?? []);

      const exercises = planExercises.map((pe) => ({
        id: pe.id,
        name: pe.exercise.name,
        category: pe.exercise.category,
        sets: pe.sets,
        reps: pe.reps,
        restSeconds: pe.restSeconds,
        restLabel: formatRestLabel(pe.restSeconds),
        tip: pe.notes || pe.exercise.description || '',
        videoUrl: pe.exercise.videoUrl,
        imageUrl: pe.exercise.imageUrl,
        done: completedSet.has(`${dateKey}_${pe.id}`),
      }));

      const doneCount = exercises.filter((e) => e.done).length;

      let status;
      if (!assigned) status = 'notAssigned';
      else if (isSameDay(date, today)) status = 'today';
      else if (date < today) status = 'completed';
      else status = 'upcoming';

      days.push({
        date: dateKey,
        weekday: weekdayLabel,
        assigned,
        focus: assigned ? computeFocusLabel(planExercises) : 'Rest / Not Assigned',
        status,
        exercises,
        doneCount,
        totalCount: exercises.length,
        progress: exercises.length === 0 ? 0 : Number((doneCount / exercises.length).toFixed(4)),
      });
    }

    const assignedDays = days.filter((d) => d.assigned);
    const totalExercises = assignedDays.reduce((s, d) => s + d.totalCount, 0);
    const totalDone = assignedDays.reduce((s, d) => s + d.doneCount, 0);

    return res.status(200).json({
      weekStart: formatDateKey(weekStart),
      weekEnd: formatDateKey(weekEnd),
      days,
      summary: {
        assignedDays: assignedDays.length,
        totalExercises,
        totalDone,
        progress: totalExercises === 0 ? 0 : Number((totalDone / totalExercises).toFixed(4)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// POST /api/workouts/days/:date/exercises/:planExerciseId/toggle
// Body (optional): { memberId }  — ADMIN/STAFF only, to edit on a member's behalf
//
// Toggles one exercise's done state for one specific calendar date. Only
// today's date is editable, mirroring the screen's own rule (past days are
// view-only, upcoming days are shown but not yet actionable).
// ============================================================================
const toggleExercise = async function (req, res, next) {
  try {
    const { memberId, ok } = resolveMemberId(req, req.body?.memberId);
    if (!ok) {
      const failure = { title: 'Forbidden', message: 'You do not have access to this resource.', code: 403 };
      return res.status(403).json({ error: 'You do not have access to this resource', code: 'FORBIDDEN', failure });
    }

    const { date: dateParam, exercise: planExerciseId } = req.params;
    const date = parseDateParam(dateParam, null);
    if (!date) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD', code: 'INVALID_DATE' });
    }

    const today = toDateOnly(new Date());
    if (!isSameDay(date, today)) {
      const failure = {
        title: 'Not editable',
        message: 'Only today\'s exercises can be toggled.',
        code: 403,
      };
      return res.status(403).json({ error: 'Only today\'s exercises can be toggled', code: 'NOT_TODAY', failure });
    }

    const assignment = await findAssignmentForDate(memberId, date);
    if (!assignment) {
      return res.status(404).json({ error: 'No workout assignment covers this date', code: 'ASSIGNMENT_NOT_FOUND' });
    }

    const weekdayLabel = WEEKDAY_LABELS[(date.getDay() + 6) % 7]; // JS Sun=0 -> map to Mon-first index
    const workoutDay = assignment.plan.days.find((d) => d.dayOfWeek === weekdayLabel && !d.isRestDay);
    const planExercise = workoutDay?.exercises.find((pe) => pe.id === planExerciseId);
    if (!planExercise) {
      return res.status(404).json({ error: 'Exercise not found for this date', code: 'EXERCISE_NOT_FOUND' });
    }

    const dateKey = formatDateKey(date);
    const compositeKey = `${dateKey}_${planExerciseId}`;
    const current = assignment.completedExerciseIds ?? [];
    const alreadyDone = current.includes(compositeKey);

    const updatedIds = alreadyDone
      ? current.filter((id) => id !== compositeKey)
      : [...current, compositeKey];

    await prisma.workoutAssignment.update({
      where: { id: assignment.id },
      data: { completedExerciseIds: updatedIds },
    });

    // recompute the day's progress for a convenient response
    const completedSet = new Set(updatedIds);
    const doneCount = workoutDay.exercises.filter((pe) =>
      completedSet.has(`${dateKey}_${pe.id}`),
    ).length;

    return res.status(200).json({
      planExerciseId,
      date: dateKey,
      done: !alreadyDone,
      day: {
        doneCount,
        totalCount: workoutDay.exercises.length,
        progress: Number((doneCount / workoutDay.exercises.length).toFixed(4)),
      },
    });
  } catch (err) {
    next(err);
  }
};


export default {
  getTemplates,
  getTemplateDetails,
  saveTemplate,
  deleteTemplate,
  getAllExercises,
  getExerciseDetails,
  createExercise,
  updateExercise,
  assignWorkout,
  getAllPlans,
  getPlanDetails,
  createWorkoutPlan,
  deleteWorkoutPlan,
  getMyWorkouts, getWeek, toggleExercise
};
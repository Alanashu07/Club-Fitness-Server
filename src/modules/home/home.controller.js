// controllers/home.controller.js
//
// Powers the app's home / dashboard screens.
//   - getMemberHome   -> MEMBER only   (mirrors MemberHomeScreen in the Flutter app)
//   - getTrainerHome  -> STAFF only
//   - getAdminHome    -> ADMIN only
//   - getHome         -> ANY authenticated role, dispatches to the right payload
//   - getAnnouncementsFeed / getUnreadNotificationCount -> ANY authenticated role
//
import prisma from '../../config/db.js';
import dateUtil from '../../utils/date.js';

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const computeStreak = function (dateStrSet, today) {
    let cursor = new Date(today);
    if (!dateStrSet.has(cursor.toDateString())) {
        cursor = dateUtil.subDays(cursor, 1);
        if (!dateStrSet.has(cursor.toDateString())) return 0;
    }
    let streak = 0;
    while (dateStrSet.has(cursor.toDateString())) {
        streak++;
        cursor = dateUtil.subDays(cursor, 1);
    }
    return streak;
};

const nextSessionLabel = function (bookedDayLabels, todayIndex) {
    if (bookedDayLabels.size === 0) return 'Not scheduled';
    for (let offset = 0; offset < 7; offset++) {
        const idx = (todayIndex + offset) % 7;
        if (bookedDayLabels.has(DAY_LABELS[idx])) {
            if (offset === 0) return 'Today';
            if (offset === 1) return 'Tomorrow';
            return DAY_LABELS[idx];
        }
    }
    return 'Not scheduled';
};

// =============================================================================
// MEMBER HOME
// =============================================================================
const getMemberHome = asyncHandler(async (req, res) => {
  const memberId = req.user.id;
  const todayLabel = DAY_LABELS[new Date().getDay()];
  const today = startOfToday();

  const [
    member,
    activeAssignment,
    streakAttendance,
    completedWorkoutCount,
    activeOrderCount,
    announcements,
    shopProducts,
    upcomingBookings,
    latestFee,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        name: true,
        profileImageUrl: true,
        membershipPlan: { select: { id: true, name: true, durationDays: true, price: true } },
        membershipStart: true,
        membershipEnd: true,
        status: true,
        assignedTrainer: { select: { id: true, name: true } },
        createdAt: true,
      },
    }),

    // Currently active workout assignment -> its plan/day matching today
    prisma.workoutAssignment.findFirst({
      where: { memberId, startDate: { lte: today }, endDate: { gte: today } },
      orderBy: { assignedAt: 'desc' },
      include: {
        plan: {
          include: {
            days: {
              where: { dayOfWeek: todayLabel },
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

    // Attendance for streak calculation (last 60 days, checked client-side or simplified count here)
    prisma.attendance.findMany({
      where: { memberId, checkInAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } },
      orderBy: { checkInAt: 'desc' },
      select: { checkInAt: true },
    }),

    prisma.workoutAssignment.count({ where: { memberId } }),

    prisma.productOrder.count({
      where: { memberId, status: { in: ['PLACED', 'CONFIRMED', 'READY'] } },
    }),

    prisma.announcement.findMany({
      where: {
        isDraft: false,
        OR: [{ audienceType: 'ALL' }, { audienceType: 'INDIVIDUAL', audienceUserIds: { has: memberId } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),

    prisma.product.findMany({
      where: { isActive: true },
      orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }],
      take: 8,
    }),

    prisma.classBooking.findMany({
      where: { memberId, status: { in: ['PENDING', 'CONFIRMED'] } },
      orderBy: { bookedAt: 'desc' },
      take: 5,
      include: { gymClass: true },
    }),

    prisma.feeRecord.findFirst({
      where: { memberId },
      orderBy: { dueDate: 'desc' },
      include: { plan: { select: { name: true } } },
    }),
  ]);

  if (!member) {
    const failure = { title: 'Member not found', code: 404, message: 'Member not found with ID: ' + memberId };
    return res.status(404).json({ error: 'Member not found', code: 'MEMBER_NOT_FOUND', failure });
  }

  // Simple consecutive-day streak based on attendance check-ins
  let streak = 0;
  const days = new Set(streakAttendance.map((a) => a.checkInAt.toISOString().slice(0, 10)));
  for (let i = 0; ; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (days.has(d)) streak++;
    else break;
  }

  const todaysExercises = (activeAssignment?.plan?.days?.[0]?.exercises ?? []).map((pe) => ({
    id: pe.id,
    name: pe.exercise.name,
    sets: pe.sets,
    reps: pe.reps,
    restSeconds: pe.restSeconds,
    completed: activeAssignment.completedExerciseIds.includes(pe.id),
  }));

  res.json({
    profile: {
      id: member.id,
      name: member.name,
      profileImageUrl: member.profileImageUrl,
    },
    membership: {
      plan: member.membershipPlan,
      status: member.status,
      start: member.membershipStart,
      end: member.membershipEnd,
      daysRemaining: member.membershipEnd
        ? Math.max(0, Math.ceil((member.membershipEnd - new Date()) / (24 * 60 * 60 * 1000)))
        : null,
      trainer: member.assignedTrainer,
    },
    todaysWorkout: {
      planName: activeAssignment?.plan?.name ?? null,
      exercises: todaysExercises,
      doneCount: todaysExercises.filter((e) => e.completed).length,
      totalCount: todaysExercises.length,
    },
    quickStats: {
      dayStreak: streak,
      workoutsCompleted: completedWorkoutCount,
      activeOrders: activeOrderCount,
    },
    announcements,
    shopPreview: shopProducts,
    upcomingClasses: upcomingBookings.map((b) => ({
      bookingId: b.id,
      status: b.status,
      gymClass: b.gymClass,
    })),
    feeStatus: latestFee
      ? {
        status: latestFee.status,
        amount: latestFee.amount,
        dueDate: latestFee.dueDate,
        paidDate: latestFee.paidDate,
        planName: latestFee.plan?.name,
      }
      : null,
  });
});

// =============================================================================
// TRAINER HOME (STAFF)
// =============================================================================
const getTrainerHome = asyncHandler(async (req, res) => {
    const trainerId = req.user.id;
    const now = new Date();
    const today = dateUtil.startOfToday();
    const todayIndex = now.getDay();
    const todayLabel = DAY_LABELS[todayIndex];
    const tomorrowLabel = DAY_LABELS[(todayIndex + 1) % 7];

    const weekStart = dateUtil.startOfWeek(now);
    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setDate(nextWeekStart.getDate() + 7);
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekEnd.getDate() + 6);
    nextWeekEnd.setHours(23, 59, 59, 999);

    const trainer = await prisma.user.findUnique({
        where: { id: trainerId },
        select: { id: true, name: true, staffTitle: true, profileImageUrl: true, role: true },
    });
    if (!trainer) return res.status(404).json({ error: 'Trainer not found' });

    const assignedMembersRaw = await prisma.user.findMany({
        where: { assignedTrainerId: trainerId, role: 'MEMBER' },
        select: {
            id: true,
            name: true,
            status: true,
            membershipPlan: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
    });
    const memberIds = assignedMembersRaw.map((m) => m.id);

    const [
        todaysClasses,
        attendanceRows,
        activeWorkoutAssignments,
        classBookingRows,
        pendingFeeRows,
        readyOrderRows,
        weekAttendanceRows,
    ] = await Promise.all([
        // GymClass.trainerName is a free-text snapshot, not a relation — matched
        // by name. If two staff share a name this will collide; consider adding
        // a real trainerId FK on GymClass if that's a concern.
        prisma.gymClass.findMany({
            where: { trainerName: trainer.name, dayOfWeek: todayLabel },
            include: { bookings: { where: { status: { in: ['PENDING', 'CONFIRMED'] } } } },
        }),

        // attendance for assigned members, last 90 days — used for both
        // "checked in today" and streak calculation
        prisma.attendance.findMany({
            where: { memberId: { in: memberIds }, checkInAt: { gte: dateUtil.subDays(today, 90) } },
            select: { memberId: true, checkInAt: true },
        }),

        // who already has a workout plan covering next week
        prisma.workoutAssignment.findMany({
            where: {
                memberId: { in: memberIds },
                startDate: { lte: nextWeekEnd },
                endDate: { gte: nextWeekStart },
            },
            select: { memberId: true },
        }),

        // confirmed/pending class bookings, used to compute nextSession
        prisma.classBooking.findMany({
            where: { memberId: { in: memberIds }, status: { in: ['PENDING', 'CONFIRMED'] } },
            select: { memberId: true, gymClass: { select: { dayOfWeek: true } } },
        }),

        // fee submissions awaiting approval, for this trainer's members
        prisma.feeRecord.findMany({
            where: { memberId: { in: memberIds }, status: 'PENDING', submittedDate: { not: null } },
            orderBy: { submittedDate: 'desc' },
            take: 5,
            include: { member: { select: { id: true, name: true } } },
        }),

        // orders ready for pickup, gym-wide (not member-scoped — pickup desk task)
        prisma.productOrder.findMany({
            where: { status: 'READY' },
            orderBy: { placedAt: 'desc' },
            take: 5,
            include: {
                member: { select: { name: true } },
                items: { include: { product: { select: { name: true } } }, take: 1 },
            },
        }),

        // gym-wide attendance for the current week (Mon → today), for the chart
        prisma.attendance.findMany({
            where: { checkInAt: { gte: weekStart, lte: now } },
            select: { checkInAt: true },
        }),
    ]);

    // ── attendance lookups per member ──────────────────────────────────────
    const attendanceByMember = new Map(); // memberId -> Set<dateString>
    for (const row of attendanceRows) {
        const set = attendanceByMember.get(row.memberId) || new Set();
        set.add(new Date(row.checkInAt).toDateString());
        attendanceByMember.set(row.memberId, set);
    }

    const hasUpcomingWorkoutPlan = new Set(activeWorkoutAssignments.map((a) => a.memberId));

    const bookedDaysByMember = new Map(); // memberId -> Set<dayLabel>
    for (const row of classBookingRows) {
        const set = bookedDaysByMember.get(row.memberId) || new Set();
        if (row.gymClass?.dayOfWeek) set.add(row.gymClass.dayOfWeek);
        bookedDaysByMember.set(row.memberId, set);
    }

    // ── assemble assigned members with derived fields ──────────────────────
    const assignedMembers = assignedMembersRaw.map((m) => {
        const dateSet = attendanceByMember.get(m.id) || new Set();
        return {
            id: m.id,
            name: m.name,
            plan: m.membershipPlan?.name || 'No Plan',
            checkedInToday: dateSet.has(today.toDateString()),
            workoutStreak: computeStreak(dateSet, today),
            nextSession: nextSessionLabel(bookedDaysByMember.get(m.id) || new Set(), todayIndex),
        };
    });
    const checkedInCount = assignedMembers.filter((m) => m.checkedInToday).length;

    // ── recent check-ins (assigned members only, most recent first) ───────
    const recentCheckIns = attendanceRows
        .filter((r) => new Date(r.checkInAt).toDateString() === today.toDateString())
        .sort((a, b) => new Date(b.checkInAt) - new Date(a.checkInAt))
        .slice(0, 5)
        .map((r) => {
            const member = assignedMembersRaw.find((m) => m.id === r.memberId);
            return {
                memberId: r.memberId,
                name: member?.name || 'Unknown',
                time: new Date(r.checkInAt).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                }),
            };
        });

    // ── today's classes, with the next chronological one flagged "upcoming" ──
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const sortedClasses = [...todaysClasses].sort(
        (a, b) => dateUtil.parseHHmmToMinutes(a.startTime) - dateUtil.parseHHmmToMinutes(b.startTime)
    );
    let upcomingMarked = false;
    const formattedClasses = sortedClasses.map((c) => {
        const isUpcoming = !upcomingMarked && dateUtil.parseHHmmToMinutes(c.startTime) > nowMinutes;
        if (isUpcoming) upcomingMarked = true;
        return {
            id: c.id,
            name: c.name,
            time: c.startTime,
            room: c.room,
            enrolled: c.bookings.length,
            capacity: c.capacity,
            upcoming: isUpcoming,
        };
    });

    // ── pending tasks: workout gaps + fee approvals + ready orders ──────────
    const workoutTasks = assignedMembers
        .filter((m) => !hasUpcomingWorkoutPlan.has(m.id))
        .map((m) => ({
            type: 'WORKOUT',
            title: `Assign workout to ${m.name}`,
            subtitle: 'No plan for next week yet',
            refId: m.id,
        }));

    const feeTasks = pendingFeeRows.map((f) => ({
        type: 'FEE',
        title: `Mark fee — ${f.member.name}`,
        subtitle: f.paymentMethod === 'CASH'
            ? 'Cash payment received at counter'
            : 'Awaiting approval',
        refId: f.id,
    }));

    const orderTasks = readyOrderRows.map((o) => ({
        type: 'ORDER',
        title: `Process order #${o.id.slice(-6).toUpperCase()}`,
        subtitle: `${o.items[0]?.product?.name || 'Item'} — ready for pickup`,
        refId: o.id,
    }));

    const pendingTasks = [...workoutTasks, ...feeTasks, ...orderTasks];

    // ── weekly attendance chart, Mon → Sun, gym-wide ───────────────────────
    const weekBuckets = DAY_LABELS.filter((l) => l !== 'Sun' || true); // placeholder, replaced below
    const mondayFirst = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const weekCounts = mondayFirst.map(() => 0);
    for (const row of weekAttendanceRows) {
        const d = new Date(row.checkInAt);
        const idx = (d.getDay() + 6) % 7; // convert Sun-first to Mon-first index
        weekCounts[idx]++;
    }
    const todayMonFirstIndex = (todayIndex + 6) % 7;

    res.json({
        profile: trainer,
        summary: {
            myMembers: assignedMembers.length,
            checkedInToday: checkedInCount,
            classesToday: formattedClasses.length,
            pendingTasks: pendingTasks.length,
        },
        pendingTasks,
        todaysClasses: formattedClasses,
        assignedMembers,
        recentCheckIns,
        weeklyAttendance: {
            labels: mondayFirst,
            counts: weekCounts,
            todayIndex: todayMonFirstIndex,
            total: weekCounts.reduce((a, b) => a + b, 0),
        },
    });
});

// =============================================================================
// ADMIN HOME
// =============================================================================
const percentChange = function (current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
};

const getAdminHome = asyncHandler(async (req, res) => {
  const now = new Date();
  const today = dateUtil.startOfToday();
  const monthStart = dateUtil.startOfMonth(now);
  const lastMonthStart = dateUtil.startOfMonth(dateUtil.subMonths(now, 1));
  const lastMonthEnd = dateUtil.endOfMonth(dateUtil.subMonths(now, 1));
  const twoMonthsAgoStart = dateUtil.startOfMonth(dateUtil.subMonths(now, 2));
  const twoMonthsAgoEnd = dateUtil.endOfMonth(dateUtil.subMonths(now, 2));
  const sevenDaysAgo = dateUtil.subDays(today, 6); // window of 7 days including today
  const sixMonthsAgoStart = dateUtil.startOfMonth(dateUtil.subMonths(now, 5)); // current + previous 5

  const [
    totalMembers,
    newMembersThisMonth,
    activeMembers,
    todayCheckInRows,
    pendingFeesAgg,
    ordersToday,
    ordersReadyToday,
    lowStockProducts,
    thisMonthRevenueAgg,
    lastMonthRevenueAgg,
    twoMonthsAgoRevenueAgg,
    overdueAgg,
    overdueMemberRows,
    monthlyRevenueRows,
    last7DaysRevenueRows,
    revenueByPlanRows,
    pendingPayments,
    recentMembers,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'MEMBER' } }),
    prisma.user.count({ where: { role: 'MEMBER', createdAt: { gte: monthStart } } }),
    prisma.user.count({ where: { role: 'MEMBER', status: 'ACTIVE' } }),
    // distinct members who checked in today (not raw check-in rows)
    prisma.attendance.findMany({
      where: { checkInAt: { gte: today } },
      distinct: ['memberId'],
      select: { memberId: true },
    }),
    prisma.feeRecord.aggregate({
      where: { status: { in: ['PENDING', 'OVERDUE', 'PARTIAL'] } },
      _sum: { amount: true, paidAmount: true },
      _count: { _all: true },
    }),
    prisma.productOrder.count({ where: { placedAt: { gte: today } } }),
    prisma.productOrder.count({ where: { placedAt: { gte: today }, status: 'READY' } }),
    prisma.product.findMany({
      where: { stockCount: { lte: 5 }, isActive: true },
      select: { id: true, name: true, stockCount: true, imageUrl: true },
      take: 10,
    }),
    prisma.feeRecord.aggregate({
      where: { status: 'PAID', paidDate: { gte: monthStart } },
      _sum: { paidAmount: true },
    }),
    prisma.feeRecord.aggregate({
      where: { status: 'PAID', paidDate: { gte: lastMonthStart, lte: lastMonthEnd } },
      _sum: { paidAmount: true },
    }),
    prisma.feeRecord.aggregate({
      where: { status: 'PAID', paidDate: { gte: twoMonthsAgoStart, lte: twoMonthsAgoEnd } },
      _sum: { paidAmount: true },
    }),
    prisma.feeRecord.aggregate({
      where: { status: 'OVERDUE' },
      _sum: { amount: true, paidAmount: true },
    }),
    prisma.feeRecord.findMany({
      where: { status: 'OVERDUE' },
      distinct: ['memberId'],
      select: { memberId: true },
    }),
    // raw rows for the 6-month bar chart — bucketed below
    prisma.feeRecord.findMany({
      where: { status: 'PAID', paidDate: { gte: sixMonthsAgoStart } },
      select: { paidAmount: true, paidDate: true },
    }),
    // raw rows for the 7-day sparkline — bucketed below
    prisma.feeRecord.findMany({
      where: { status: 'PAID', paidDate: { gte: sevenDaysAgo } },
      select: { paidAmount: true, paidDate: true },
    }),
    // raw rows for the "by plan" donut (this month) — grouped below
    prisma.feeRecord.findMany({
      where: { status: 'PAID', paidDate: { gte: monthStart } },
      select: { paidAmount: true, plan: { select: { id: true, name: true } } },
    }),
    prisma.feeRecord.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL'] } },
      orderBy: [{ submittedDate: 'desc' }, { createdAt: 'desc' }],
      take: 5,
      select: {
        id: true,
        amount: true,
        paidAmount: true,
        submittedDate: true,
        createdAt: true,
        member: { select: { id: true, name: true } },
      },
    }),
    prisma.user.findMany({
      where: { role: 'MEMBER' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        name: true,
        createdAt: true,
        membershipPlan: { select: { name: true } },
      },
    }),
  ]);

  const todayCheckIns = todayCheckInRows.length;
  const outstandingAmount =
    Number(pendingFeesAgg._sum.amount || 0) - Number(pendingFeesAgg._sum.paidAmount || 0);
  const overdueAmount =
    Number(overdueAgg._sum.amount || 0) - Number(overdueAgg._sum.paidAmount || 0);
  const thisMonthRevenue = Number(thisMonthRevenueAgg._sum.paidAmount || 0);
  const lastMonthRevenue = Number(lastMonthRevenueAgg._sum.paidAmount || 0);
  const twoMonthsAgoRevenue = Number(twoMonthsAgoRevenueAgg._sum.paidAmount || 0);

  // ── Monthly Revenue bar chart — bucket the last 6 months ──────────────────
  const monthBuckets = [];
  for (let i = 5; i >= 0; i--) {
    const d = dateUtil.subMonths(now, i);
    monthBuckets.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: dateUtil.monthLabel(d), total: 0 });
  }
  for (const row of monthlyRevenueRows) {
    const d = new Date(row.paidDate);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = monthBuckets.find((b) => b.key === key);
    if (bucket) bucket.total += Number(row.paidAmount || 0);
  }

  // ── Last 7 Days sparkline ───────────────────────────────────────────────
  const dayBuckets = [];
  for (let i = 6; i >= 0; i--) {
    dayBuckets.push({ key: dateUtil.subDays(today, i).toDateString(), total: 0 });
  }
  for (const row of last7DaysRevenueRows) {
    const key = new Date(row.paidDate).toDateString();
    const bucket = dayBuckets.find((b) => b.key === key);
    if (bucket) bucket.total += Number(row.paidAmount || 0);
  }

  // ── By Plan donut ────────────────────────────────────────────────────────
  const planTotals = new Map();
  let planRevenueSum = 0;
  for (const row of revenueByPlanRows) {
    const amount = Number(row.paidAmount || 0);
    planRevenueSum += amount;
    const key = row.plan?.id || 'unknown';
    const existing = planTotals.get(key) || { label: row.plan?.name || 'Other', total: 0 };
    existing.total += amount;
    planTotals.set(key, existing);
  }
  const revenueByPlan = Array.from(planTotals.values())
    .sort((a, b) => b.total - a.total)
    .map((p) => ({
      label: p.label,
      amount: p.total,
      fraction: planRevenueSum > 0 ? Number((p.total / planRevenueSum).toFixed(4)) : 0,
    }));

  // ── Pending Approvals ────────────────────────────────────────────────────
  const formattedPendingPayments = pendingPayments.map((p) => ({
    id: p.id,
    memberId: p.member.id,
    name: p.member.name,
    amountDue: Number(p.amount) - Number(p.paidAmount || 0),
    submittedAgo: dateUtil.timeAgo(p.submittedDate || p.createdAt),
  }));

  // ── Recent Members ───────────────────────────────────────────────────────
  const formattedRecentMembers = recentMembers.map((m) => ({
    id: m.id,
    name: m.name,
    plan: m.membershipPlan?.name || 'No Plan',
    joinedAgo: dateUtil.timeAgo(m.createdAt),
  }));

  res.json({
    overview: {
      totalMembers,
      newMembersThisMonth,
      activeMembers,
      todayCheckIns,
      activeTodayPercent: totalMembers > 0
        ? Number(((todayCheckIns / totalMembers) * 100).toFixed(1))
        : 0,
      pendingFeesCount: pendingFeesAgg._count._all,
      outstandingAmount,
      ordersToday,
      ordersReadyToday,
    },
    revenue: {
      thisMonth: thisMonthRevenue,
      thisMonthChangePct: percentChange(thisMonthRevenue, lastMonthRevenue),
      lastMonth: lastMonthRevenue,
      lastMonthChangePct: percentChange(lastMonthRevenue, twoMonthsAgoRevenue),
      overdueAmount,
      overdueMemberCount: overdueMemberRows.length,
      monthly: monthBuckets.map((b) => ({ label: b.label, total: b.total })),
      last7Days: dayBuckets.map((b) => b.total),
      byPlan: revenueByPlan,
    },
    pendingPayments: formattedPendingPayments,
    recentMembers: formattedRecentMembers,
    lowStockProducts,
  });
});

// =============================================================================
// COMMON / SHARED (any authenticated role)
// =============================================================================

// Single entry point that dispatches based on req.user.role.
// Useful if the client just wants "GET /api/home" without knowing the role upfront.
const getHome = asyncHandler(async (req, res, next) => {
  switch (req.user.role) {
    case 'ADMIN':
      return getAdminHome(req, res, next);
    case 'STAFF':
      return getTrainerHome(req, res, next);
    case 'MEMBER':
      return getMemberHome(req, res, next);
    default:
      const failure = { title: "Unknown role", message: "You do not have access to this resource.", code: 403 };
      return res.status(403).json({ error: 'Unknown role', code: 'UNKNOWN_ROLE', failure });
  }
});

const getAnnouncementsFeed = asyncHandler(async (req, res) => {
  const { role, id } = req.user;

  const audienceFilter =
    role === 'STAFF'
      ? [{ audienceType: 'ALL' }, { audienceType: 'STAFF' }]
      : role === 'ADMIN'
        ? [{ audienceType: 'ALL' }, { audienceType: 'STAFF' }]
        : [{ audienceType: 'ALL' }, { audienceType: 'INDIVIDUAL', audienceUserIds: { has: id } }];

  const announcements = await prisma.announcement.findMany({
    where: { isDraft: false, OR: audienceFilter },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  res.json({ announcements });
});

const getUnreadNotificationCount = asyncHandler(async (req, res) => {
  const count = await prisma.notification.count({
    where: { userId: req.user.id, isRead: false },
  });
  res.json({ unreadCount: count });
});

export default {
  getMemberHome,
  getTrainerHome,
  getAdminHome,
  getHome,
  getAnnouncementsFeed,
  getUnreadNotificationCount,
};
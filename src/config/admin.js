// admin.js
//
// AdminJS dashboard for Club Fitness, mounted at BASE_URL/admin.
//
// Usage in your main server file:
//
//   import setupAdmin from './admin.js';
//   await setupAdmin(app);
//
import AdminJS from 'adminjs';
import AdminJSExpress from '@adminjs/express';
import { Database, Resource } from '@adminjs/prisma';
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import prisma from './db.js';
import env from './env.js';

AdminJS.registerAdapter({ Database, Resource });

const PgSession = connectPgSimple(session);

// Helper to fetch a model definition by name from the Prisma DMMF
const getDMMFModelByName = (modelName) => {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) {
    throw new Error(`Model ${modelName} not found in Prisma DMMF`);
  }
  return model;
};

const admin = new AdminJS({
  resources: [
    // ==================
    // USERS & MEMBERSHIP
    // ==================
    {
      resource: { model: getDMMFModelByName('User'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'User Management', icon: 'Users' },
        properties: {
          passwordHash: {
            isVisible: { list: false, filter: false, show: false, edit: false },
          },
          createdAt: {
            isVisible: { list: true, filter: true, show: true, edit: false },
          },
          updatedAt: {
            isVisible: { list: false, filter: false, show: true, edit: false },
          },
          profileImageUrl: { type: 'string' },
          medicalNotes: {
            isVisible: { list: false, filter: false, show: true, edit: true },
          },
          role: {
            availableValues: [
              { value: 'ADMIN', label: 'Admin' },
              { value: 'STAFF', label: 'Staff' },
              { value: 'MEMBER', label: 'Member' },
            ],
          },
          status: {
            availableValues: [
              { value: 'ACTIVE', label: 'Active' },
              { value: 'EXPIRED', label: 'Expired' },
              { value: 'SUSPENDED', label: 'Suspended' },
              { value: 'TRIAL', label: 'Trial' },
            ],
          },
          membershipPlan: {
            isVisible: { list: false, filter: true, show: true, edit: true },
          },
          assignedTrainer: {
            isVisible: { list: false, filter: true, show: true, edit: true },
          },
        },
        listProperties: ['id', 'name', 'phone', 'email', 'role', 'status', 'createdAt'],
        filterProperties: ['name', 'phone', 'email', 'role', 'status', 'membershipPlan'],
        editProperties: [
          'name', 'phone', 'email', 'passwordHash', 'profileImageUrl', 'role', 'status',
          'dateOfBirth', 'emergencyContact', 'medicalNotes', 'membershipPlan',
          'membershipStart', 'membershipEnd', 'contentAccessUntil', 'assignedTrainer',
          'staffTitle', 'hireDate', 'referralCode', 'referredBy',
        ],
        actions: {
          new: {
            before: async (request) => {
              if (request.payload.passwordHash) {
                request.payload.passwordHash = await bcrypt.hash(request.payload.passwordHash, 10);
              }
              return request;
            },
          },
          edit: {
            before: async (request) => {
              if (request.payload.passwordHash && request.payload.passwordHash.length > 0) {
                request.payload.passwordHash = await bcrypt.hash(request.payload.passwordHash, 10);
              } else {
                delete request.payload.passwordHash;
              }
              return request;
            },
          },
        },
      },
    },
    {
      resource: { model: getDMMFModelByName('MembershipPlan'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'User Management', icon: 'CreditCard' },
        properties: {
          price: { type: 'currency', props: { currency: 'INR' } },
          features: { type: 'mixed' },
        },
        listProperties: ['id', 'name', 'durationDays', 'price', 'isActive'],
        filterProperties: ['name', 'isActive'],
      },
    },

    // ==================
    // FEES
    // ==================
    {
      resource: { model: getDMMFModelByName('FeeRecord'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Fees & Payments', icon: 'DollarSign' },
        properties: {
          amount: { type: 'currency', props: { currency: 'INR' } },
          paidAmount: { type: 'currency', props: { currency: 'INR' } },
          status: {
            availableValues: [
              { value: 'PENDING', label: 'Pending' },
              { value: 'PAID', label: 'Paid' },
              { value: 'OVERDUE', label: 'Overdue' },
              { value: 'PARTIAL', label: 'Partial' },
              { value: 'WAIVED', label: 'Waived' },
            ],
          },
          paymentMethod: {
            availableValues: [
              { value: 'CASH', label: 'Cash' },
              { value: 'UPI', label: 'UPI' },
              { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
              { value: 'OTHER', label: 'Other' },
            ],
          },
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
          plan: { isVisible: { list: true, filter: true, show: true, edit: true } },
          approvedBy: { isVisible: { list: false, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'member', 'plan', 'amount', 'status', 'dueDate'],
        filterProperties: ['member', 'plan', 'status', 'dueDate'],
        sort: { sortBy: 'dueDate', direction: 'desc' },
      },
    },
    {
      resource: { model: getDMMFModelByName('FeeReminder'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Fees & Payments', icon: 'Bell' },
        parent: { name: 'Fees & Payments' },
        properties: {
          feeRecord: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'feeRecord', 'channel', 'automatic', 'sentAt'],
        filterProperties: ['feeRecord', 'channel', 'automatic'],
      },
    },

    // ==================
    // WORKOUTS
    // ==================
    {
      resource: { model: getDMMFModelByName('Exercise'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Workouts', icon: 'Activity' },
        listProperties: ['id', 'name', 'category', 'muscle', 'difficulty', 'isActive'],
        filterProperties: ['name', 'category', 'difficulty', 'isActive'],
      },
    },
    {
      resource: { model: getDMMFModelByName('WorkoutPlan'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Workouts', icon: 'Clipboard' },
        properties: {
          createdBy: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'name', 'type', 'isTemplate', 'createdBy', 'startDate', 'endDate'],
        filterProperties: ['name', 'type', 'isTemplate', 'createdBy'],
      },
    },
    {
      resource: { model: getDMMFModelByName('WorkoutDay'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Workouts', icon: 'Calendar' },
        parent: { name: 'Workouts' },
        properties: {
          plan: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'plan', 'dayOfWeek', 'isRestDay'],
        filterProperties: ['plan', 'dayOfWeek', 'isRestDay'],
      },
    },
    {
      resource: { model: getDMMFModelByName('PlanExercise'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Workouts', icon: 'List' },
        parent: { name: 'Workouts' },
        properties: {
          day: { isVisible: { list: true, filter: true, show: true, edit: true } },
          exercise: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'day', 'exercise', 'sets', 'reps', 'restSeconds', 'orderIndex'],
        filterProperties: ['day', 'exercise'],
      },
    },
    {
      resource: { model: getDMMFModelByName('WorkoutAssignment'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Workouts', icon: 'UserCheck' },
        parent: { name: 'Workouts' },
        properties: {
          plan: { isVisible: { list: true, filter: true, show: true, edit: true } },
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
          completedExerciseIds: { type: 'mixed' },
        },
        listProperties: ['id', 'plan', 'member', 'startDate', 'endDate', 'notifySent'],
        filterProperties: ['plan', 'member', 'notifySent'],
      },
    },
    {
      resource: { model: getDMMFModelByName('BodyMeasurement'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Workouts', icon: 'TrendingUp' },
        parent: { name: 'Workouts' },
        properties: {
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'member', 'weightKg', 'bodyFatPct', 'recordedAt'],
        filterProperties: ['member', 'recordedAt'],
        sort: { sortBy: 'recordedAt', direction: 'desc' },
      },
    },

    // ==================
    // SHOP (PRODUCTS & ORDERS)
    // ==================
    {
      resource: { model: getDMMFModelByName('Product'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Shop', icon: 'ShoppingBag' },
        properties: {
          price: { type: 'currency', props: { currency: 'INR' } },
        },
        listProperties: ['id', 'name', 'category', 'price', 'stockCount', 'isActive', 'isFeatured'],
        filterProperties: ['name', 'category', 'isActive', 'isFeatured'],
      },
    },
    {
      resource: { model: getDMMFModelByName('ProductOrder'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Shop', icon: 'Package' },
        properties: {
          totalAmount: { type: 'currency', props: { currency: 'INR' } },
          status: {
            availableValues: [
              { value: 'PLACED', label: 'Placed' },
              { value: 'CONFIRMED', label: 'Confirmed' },
              { value: 'READY', label: 'Ready' },
              { value: 'COLLECTED', label: 'Collected' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
          orderType: {
            availableValues: [
              { value: 'PRE_ORDER', label: 'Pre-order' },
              { value: 'WALK_IN', label: 'Walk-in' },
            ],
          },
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
          processedBy: { isVisible: { list: false, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'member', 'orderType', 'status', 'totalAmount', 'placedAt'],
        filterProperties: ['member', 'orderType', 'status', 'placedAt'],
        sort: { sortBy: 'placedAt', direction: 'desc' },
      },
    },
    {
      resource: { model: getDMMFModelByName('OrderItem'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Shop', icon: 'List' },
        parent: { name: 'Shop' },
        properties: {
          unitPrice: { type: 'currency', props: { currency: 'INR' } },
          order: { isVisible: { list: true, filter: true, show: true, edit: true } },
          product: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'order', 'product', 'quantity', 'unitPrice'],
      },
    },

    // ==================
    // MARKETING (ANNOUNCEMENTS & NOTIFICATIONS)
    // ==================
    {
      resource: { model: getDMMFModelByName('Announcement'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Marketing', icon: 'Megaphone' },
        properties: {
          audiencePlanIds: { type: 'mixed' },
          audienceUserIds: { type: 'mixed' },
          channels: { type: 'mixed' },
          createdBy: { isVisible: { list: true, filter: true, show: true, edit: true } },
          type: {
            availableValues: [
              { value: 'ANNOUNCEMENT', label: 'Announcement' },
              { value: 'OFFER', label: 'Offer' },
              { value: 'EVENT', label: 'Event' },
              { value: 'ALERT', label: 'Alert' },
              { value: 'MOTIVATION', label: 'Motivation' },
            ],
          },
          audienceType: {
            availableValues: [
              { value: 'ALL', label: 'All' },
              { value: 'PLAN_TIER', label: 'Plan Tier' },
              { value: 'INDIVIDUAL', label: 'Individual' },
              { value: 'STAFF', label: 'Staff' },
            ],
          },
        },
        listProperties: ['id', 'title', 'type', 'audienceType', 'isDraft', 'isScheduled', 'sentAt'],
        filterProperties: ['title', 'type', 'audienceType', 'isDraft'],
        sort: { sortBy: 'createdAt', direction: 'desc' },
      },
    },
    {
      resource: { model: getDMMFModelByName('Notification'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Marketing', icon: 'Bell' },
        parent: { name: 'Marketing' },
        properties: {
          user: { isVisible: { list: true, filter: true, show: true, edit: true } },
          announcement: { isVisible: { list: false, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'user', 'title', 'channel', 'isRead', 'sentAt'],
        filterProperties: ['user', 'channel', 'isRead'],
        sort: { sortBy: 'sentAt', direction: 'desc' },
      },
    },

    // ==================
    // FACILITIES, EQUIPMENT & CLASSES
    // ==================
    {
      resource: { model: getDMMFModelByName('Facility'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Facilities & Classes', icon: 'MapPin' },
        properties: {
          imageUrls: { type: 'mixed' },
          status: {
            availableValues: [
              { value: 'OPEN', label: 'Open' },
              { value: 'CLOSED', label: 'Closed' },
              { value: 'MAINTENANCE', label: 'Maintenance' },
            ],
          },
        },
        listProperties: ['id', 'name', 'status', 'capacity', 'openTime', 'closeTime'],
        filterProperties: ['name', 'status'],
      },
    },
    {
      resource: { model: getDMMFModelByName('Equipment'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Facilities & Classes', icon: 'Tool' },
        properties: {
          status: {
            availableValues: [
              { value: 'WORKING', label: 'Working' },
              { value: 'UNDER_REPAIR', label: 'Under Repair' },
              { value: 'RETIRED', label: 'Retired' },
            ],
          },
        },
        listProperties: ['id', 'name', 'category', 'location', 'quantity', 'status'],
        filterProperties: ['name', 'category', 'status'],
      },
    },
    {
      resource: { model: getDMMFModelByName('GymClass'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Facilities & Classes', icon: 'Users' },
        listProperties: ['id', 'name', 'trainerName', 'dayOfWeek', 'startTime', 'durationMins', 'capacity'],
        filterProperties: ['name', 'trainerName', 'dayOfWeek'],
      },
    },
    {
      resource: { model: getDMMFModelByName('ClassBooking'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Facilities & Classes', icon: 'Check' },
        parent: { name: 'Facilities & Classes' },
        properties: {
          gymClass: { isVisible: { list: true, filter: true, show: true, edit: true } },
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
          status: {
            availableValues: [
              { value: 'PENDING', label: 'Pending' },
              { value: 'CONFIRMED', label: 'Confirmed' },
              { value: 'COMPLETED', label: 'Completed' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
        },
        listProperties: ['id', 'gymClass', 'member', 'status', 'bookedAt'],
        filterProperties: ['gymClass', 'member', 'status'],
      },
    },
    {
      resource: { model: getDMMFModelByName('EquipmentBooking'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Facilities & Classes', icon: 'Tool' },
        parent: { name: 'Facilities & Classes' },
        properties: {
          equipment: { isVisible: { list: true, filter: true, show: true, edit: true } },
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
          status: {
            availableValues: [
              { value: 'PENDING', label: 'Pending' },
              { value: 'CONFIRMED', label: 'Confirmed' },
              { value: 'COMPLETED', label: 'Completed' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
        },
        listProperties: ['id', 'equipment', 'member', 'startTime', 'endTime', 'status'],
        filterProperties: ['equipment', 'member', 'status'],
      },
    },

    // ==================
    // ACTIVITY (ATTENDANCE, GAMIFICATION, FEEDBACK, DOCUMENTS)
    // ==================
    {
      resource: { model: getDMMFModelByName('Attendance'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Activity', icon: 'Clock' },
        properties: {
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'member', 'checkInAt', 'checkOutAt', 'method'],
        filterProperties: ['member', 'checkInAt', 'method'],
        sort: { sortBy: 'checkInAt', direction: 'desc' },
      },
    },
    {
      resource: { model: getDMMFModelByName('Badge'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Activity', icon: 'Award' },
        listProperties: ['id', 'name', 'description'],
        filterProperties: ['name'],
      },
    },
    {
      resource: { model: getDMMFModelByName('UserBadge'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Activity', icon: 'Award' },
        parent: { name: 'Activity' },
        properties: {
          user: { isVisible: { list: true, filter: true, show: true, edit: true } },
          badge: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'user', 'badge', 'earnedAt'],
        filterProperties: ['user', 'badge'],
      },
    },
    {
      resource: { model: getDMMFModelByName('Feedback'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Activity', icon: 'MessageSquare' },
        properties: {
          member: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'member', 'category', 'rating', 'createdAt'],
        filterProperties: ['member', 'category', 'rating'],
        sort: { sortBy: 'createdAt', direction: 'desc' },
      },
    },
    {
      resource: { model: getDMMFModelByName('Document'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Activity', icon: 'FileText' },
        properties: {
          uploadedBy: { isVisible: { list: true, filter: true, show: true, edit: true } },
        },
        listProperties: ['id', 'title', 'category', 'uploadedBy', 'createdAt'],
        filterProperties: ['title', 'category', 'uploadedBy'],
      },
    },
  ],

  rootPath: '/admin',

  branding: {
    companyName: 'Club Fitness Admin',
    logo: false,
    softwareBrothers: false,
    theme: {
      colors: {
        primary100: '#4F46E5',
        primary80: '#6366F1',
        primary60: '#818CF8',
        primary40: '#A5B4FC',
        primary20: '#C7D2FE',
        grey100: '#151515',
        grey80: '#333333',
        grey60: '#4D4D4D',
        grey40: '#999999',
        grey20: '#CCCCCC',
        filterBg: '#FFFFFF',
        accent: '#F59E0B',
        hoverBg: '#F3F4F6',
      },
    },
  },

  locale: {
    language: 'en',
    translations: {
      en: {
        resources: {
          User: { name: 'User', navigation: 'Users' },
          MembershipPlan: { name: 'Plan', navigation: 'Membership Plans' },
          FeeRecord: { name: 'Fee', navigation: 'Fees' },
          Product: { name: 'Product', navigation: 'Products' },
          ProductOrder: { name: 'Order', navigation: 'Orders' },
          Announcement: { name: 'Announcement', navigation: 'Announcements' },
        },
      },
    },
  },
});

// Only ADMIN and STAFF roles may log into the dashboard.
const adminRouter = AdminJSExpress.buildAuthenticatedRouter(
  admin,
  {
    authenticate: async (email, password) => {
      const user = await prisma.user.findUnique({ where: { email } });

      if (!user || (user.role !== 'ADMIN' && user.role !== 'STAFF')) {
        return null;
      }

      if (!user.passwordHash) return null;

      const valid = await bcrypt.compare(password, user.passwordHash);
      return valid ? user : null;
    },
    cookieName: 'adminjs',
    cookiePassword: env.ADMIN_COOKIE_SECRET,
  },
  null,
  {
    resave: false,
    saveUninitialized: true,
    store: new PgSession({
      conString: env.DATABASE_URL,
      tableName: 'session',
      createTableIfMissing: true,
    }),
    cookie: {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }
);

export default async (app) => {
  app.use(admin.options.rootPath, adminRouter);
  console.log(`✅ AdminJS available at http://localhost:${env.PORT}${admin.options.rootPath}`);
};
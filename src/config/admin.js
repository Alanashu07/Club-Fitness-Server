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
import checkinService from '../modules/device/checkin.service.js';
import commandQueue from '../modules/device/device-command-queue.service.js';

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
          // ── device check-in fields ─────────────────────────────────────
          devicePin: {
            isVisible: { list: false, filter: true, show: true, edit: true },
            description: 'Numeric PIN enrolled on the biometric device. Assigned automatically on member creation.',
          },
          deviceSN: {
            isVisible: { list: false, filter: true, show: true, edit: true },
            description: 'Serial number of the biometric device this member is enrolled on.',
          },
          blocked: {
            isVisible: { list: true, filter: true, show: true, edit: false },
            description: 'Controlled via the "Block on Device" / "Reactivate" action buttons on this record — not editable directly, so the DB flag and the device stay in sync.',
          },
          graceEntriesUsed: {
            isVisible: { list: false, filter: true, show: true, edit: true },
            description: 'Post-expiry check-ins already consumed against GRACE_ENTRIES_ALLOWED.',
          },
          deviceCheckIns: {
            isVisible: { list: false, filter: false, show: true, edit: false },
          },
        },
        listProperties: ['id', 'name', 'phone', 'email', 'role', 'status', 'blocked', 'createdAt'],
        filterProperties: ['name', 'phone', 'email', 'role', 'status', 'membershipPlan', 'devicePin', 'deviceSN', 'blocked'],
        editProperties: [
          'name', 'phone', 'email', 'passwordHash', 'profileImageUrl', 'role', 'status',
          'dateOfBirth', 'emergencyContact', 'medicalNotes', 'membershipPlan',
          'membershipStart', 'membershipEnd', 'contentAccessUntil', 'assignedTrainer',
          'staffTitle', 'hireDate', 'referralCode', 'referredBy',
          'devicePin', 'deviceSN', 'graceEntriesUsed',
        ],
        showProperties: [
          'id', 'name', 'phone', 'email', 'role', 'status',
          'dateOfBirth', 'emergencyContact', 'medicalNotes', 'membershipPlan',
          'membershipStart', 'membershipEnd', 'contentAccessUntil', 'assignedTrainer',
          'staffTitle', 'hireDate', 'referralCode', 'referredBy',
          'devicePin', 'deviceSN', 'blocked', 'graceEntriesUsed', 'deviceCheckIns',
          'createdAt', 'updatedAt',
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

          // ── device action buttons (shown on the record's Show page) ─────

          blockOnDevice: {
            actionType: 'record',
            icon: 'Lock',
            label: 'Block on Device',
            guard: 'This will revoke door access for this member on the biometric device. Continue?',
            isVisible: (context) =>
              context.record?.params.role === 'MEMBER' && !context.record?.params.blocked,
            component: false,
            handler: async (request, response, context) => {
              const { record, resource, currentAdmin } = context;
              const { deviceSN, devicePin } = record.params;

              if (!deviceSN || !devicePin) {
                return {
                  record: record.toJSON(currentAdmin),
                  notice: { message: 'This member has no device enrollment on file.', type: 'error' },
                };
              }

              await checkinService.blockUserSoft(deviceSN, devicePin);
              await prisma.user.update({ where: { id: record.params.id }, data: { blocked: true } });

              const updated = await resource.findOne(record.params.id);
              return {
                record: updated.toJSON(currentAdmin),
                notice: { message: `Block command queued for PIN ${devicePin} on ${deviceSN}.`, type: 'success' },
              };
            },
          },

          reactivateOnDevice: {
            actionType: 'record',
            icon: 'Unlock',
            label: 'Reactivate',
            guard: 'This clears the block, resets grace entries, and restores door access on the device. Make sure membershipEnd is updated first if this follows a payment. Continue?',
            isVisible: (context) =>
              context.record?.params.role === 'MEMBER' && context.record?.params.blocked,
            component: false,
            handler: async (request, response, context) => {
              const { record, resource, currentAdmin } = context;
              const { deviceSN, devicePin, membershipEnd } = record.params;

              if (!deviceSN || !devicePin) {
                return {
                  record: record.toJSON(currentAdmin),
                  notice: { message: 'This member has no device enrollment on file.', type: 'error' },
                };
              }

              const stillActive = membershipEnd && new Date(membershipEnd) > new Date();

              await prisma.user.update({
                where: { id: record.params.id },
                data: {
                  blocked: false,
                  graceEntriesUsed: 0,
                  status: stillActive ? 'ACTIVE' : record.params.status,
                },
              });
              await checkinService.unblockUser(deviceSN, devicePin);

              const updated = await resource.findOne(record.params.id);
              return {
                record: updated.toJSON(currentAdmin),
                notice: {
                  message: stillActive
                    ? `Unblock command queued for PIN ${devicePin}.`
                    : `Unblock command queued for PIN ${devicePin}. Note: membershipEnd is still in the past — update it if this follows a payment, or the next expiry check will re-block them.`,
                  type: 'success',
                },
              };
            },
          },

          resendEnrollment: {
            actionType: 'record',
            icon: 'RefreshCw',
            label: 'Resend Enrollment',
            guard: 'Re-queues this member\'s PIN/name on the device roster. Use this after a hard block (face template deleted) — the member will still need to walk up and re-enroll their face at the kiosk. Continue?',
            isVisible: (context) => context.record?.params.role === 'MEMBER',
            component: false,
            handler: async (request, response, context) => {
              const { record, currentAdmin } = context;
              const { deviceSN, devicePin, name } = record.params;

              if (!deviceSN || !devicePin) {
                return {
                  record: record.toJSON(currentAdmin),
                  notice: { message: 'This member has no device enrollment on file.', type: 'error' },
                };
              }

              await commandQueue.queueCommand(
                deviceSN,
                `DATA UPDATE USERINFO Pin=${devicePin}\tName=${name}\tPri=0\tPasswd=\tCard=0\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=0`
              );

              return {
                record: record.toJSON(currentAdmin),
                notice: { message: `Enrollment command re-queued for PIN ${devicePin}. Have the member enroll their face at the kiosk.`, type: 'success' },
              };
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
    // DEVICE / CHECK-INS (biometric door lock integration)
    // ==================
    {
      resource: { model: getDMMFModelByName('DeviceCheckInEvent'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Device & Check-Ins', icon: 'LogIn' },
        properties: {
          member: {
            isVisible: { list: true, filter: true, show: true, edit: false },
            description: 'Null when the device PIN did not match any known member (unknown_user).',
          },
          result: {
            availableValues: [
              { value: 'ALLOWED', label: 'Allowed' },
              { value: 'DENIED', label: 'Denied' },
            ],
          },
          reason: { isVisible: { list: true, filter: true, show: true, edit: false } },
          pendingAuth: {
            isVisible: { list: true, filter: true, show: true, edit: false },
            description: 'True if this event was let through while the server was unreachable and is awaiting reconciliation.',
          },
          reviewed: {
            isVisible: { list: true, filter: true, show: true, edit: true },
            description: 'Mark true once staff has reviewed a denied/flagged entry.',
          },
          eventTime: { isVisible: { list: true, filter: true, show: true, edit: false } },
          deviceSN: { isVisible: { list: true, filter: true, show: true, edit: false } },
          devicePin: { isVisible: { list: true, filter: true, show: true, edit: false } },
          createdAt: { isVisible: { list: false, filter: true, show: true, edit: false } },
        },
        listProperties: ['id', 'member', 'devicePin', 'result', 'reason', 'pendingAuth', 'reviewed', 'eventTime'],
        filterProperties: ['member', 'deviceSN', 'devicePin', 'result', 'reason', 'pendingAuth', 'reviewed', 'eventTime'],
        editProperties: ['reviewed'],
        sort: { sortBy: 'eventTime', direction: 'desc' },
        actions: {
          new: { isAccessible: false },
          delete: { isAccessible: false },
          // Events are written only by the device controller — the dashboard
          // can review/flag (`reviewed`) but not fabricate or remove entries.

          retryBlock: {
            actionType: 'record',
            icon: 'Lock',
            label: 'Retry Block Command',
            guard: 'Re-queues the block command for this event\'s device/PIN. Use if the member is still getting in after being flagged. Continue?',
            isVisible: (context) => context.record?.params.result === 'DENIED',
            component: false,
            handler: async (request, response, context) => {
              const { record, currentAdmin } = context;
              const { deviceSN, devicePin } = record.params;

              await checkinService.blockUserSoft(deviceSN, devicePin);

              return {
                record: record.toJSON(currentAdmin),
                notice: { message: `Block command re-queued for PIN ${devicePin} on ${deviceSN}.`, type: 'success' },
              };
            },
          },
        },
      },
    },
    {
      resource: { model: getDMMFModelByName('DeviceCommand'), client: prisma, dmmf: Prisma.dmmf },
      options: {
        navigation: { name: 'Device & Check-Ins', icon: 'Smartphone' },
        parent: { name: 'Device & Check-Ins' },
        properties: {
          status: {
            availableValues: [
              { value: 'PENDING', label: 'Pending' },
              { value: 'SENT', label: 'Sent' },
              { value: 'ACKED', label: 'Acknowledged' },
              { value: 'FAILED', label: 'Failed' },
            ],
          },
          command: { isVisible: { list: true, filter: false, show: true, edit: false } },
          deviceSN: { isVisible: { list: true, filter: true, show: true, edit: false } },
          sentAt: { isVisible: { list: true, filter: true, show: true, edit: false } },
          ackedAt: { isVisible: { list: false, filter: true, show: true, edit: false } },
          createdAt: { isVisible: { list: true, filter: true, show: true, edit: false } },
        },
        listProperties: ['id', 'deviceSN', 'command', 'status', 'createdAt', 'sentAt'],
        filterProperties: ['deviceSN', 'status', 'createdAt'],
        sort: { sortBy: 'createdAt', direction: 'desc' },
        actions: {
          new: { isAccessible: false },
          edit: { isAccessible: false },
          // Queue is populated only by server-side services (checkin.service.js,
          // member.controller.js) — the dashboard is read-only visibility into
          // what's pending/sent/acked for a given device.
        },
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
          method: {
            description: 'QR, MANUAL, or FACE (created automatically on an allowed device check-in).',
          },
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
    favicon: 'https://api.clubfitness.co.in/media/favicon.ico',
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
          DeviceCheckInEvent: { name: 'Check-In Event', navigation: 'Check-In Events' },
          DeviceCommand: { name: 'Device Command', navigation: 'Device Commands' },
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
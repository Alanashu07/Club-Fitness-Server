-- AlterTable
ALTER TABLE "User" ADD COLUMN     "expiredEmailSentFor" TIMESTAMP(3),
ADD COLUMN     "expiryReminderSentFor" TIMESTAMP(3);

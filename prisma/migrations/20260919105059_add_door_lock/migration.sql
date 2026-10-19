/*
  Warnings:

  - A unique constraint covering the columns `[devicePin]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "CheckInResult" AS ENUM ('ALLOWED', 'DENIED');

-- CreateEnum
CREATE TYPE "DeviceCommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKED', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "blocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "devicePin" INTEGER,
ADD COLUMN     "deviceSN" TEXT,
ADD COLUMN     "graceEntriesUsed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DeviceCheckInEvent" (
    "id" TEXT NOT NULL,
    "memberId" TEXT,
    "deviceSN" TEXT NOT NULL,
    "devicePin" INTEGER NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "result" "CheckInResult" NOT NULL,
    "reason" TEXT NOT NULL,
    "pendingAuth" BOOLEAN NOT NULL DEFAULT false,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCheckInEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "id" TEXT NOT NULL,
    "deviceSN" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" "DeviceCommandStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceCheckInEvent_memberId_idx" ON "DeviceCheckInEvent"("memberId");

-- CreateIndex
CREATE INDEX "DeviceCheckInEvent_deviceSN_idx" ON "DeviceCheckInEvent"("deviceSN");

-- CreateIndex
CREATE INDEX "DeviceCheckInEvent_eventTime_idx" ON "DeviceCheckInEvent"("eventTime");

-- CreateIndex
CREATE INDEX "DeviceCommand_deviceSN_status_idx" ON "DeviceCommand"("deviceSN", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_devicePin_key" ON "User"("devicePin");

-- AddForeignKey
ALTER TABLE "DeviceCheckInEvent" ADD CONSTRAINT "DeviceCheckInEvent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

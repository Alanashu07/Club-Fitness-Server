-- AlterTable
ALTER TABLE "FeeRecord" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodStart" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "FeeRecord_appliedAt_periodStart_idx" ON "FeeRecord"("appliedAt", "periodStart");

-- CreateEnum
CREATE TYPE "OfferDiscountType" AS ENUM ('PERCENTAGE', 'FLAT');

-- CreateEnum
CREATE TYPE "OfferAppliesTo" AS ENUM ('NEW_MEMBER', 'RENEWAL', 'BOTH');

-- CreateEnum
CREATE TYPE "RedemptionSource" AS ENUM ('NEW_MEMBER', 'RENEWAL');

-- AlterTable
ALTER TABLE "FeeRecord" ADD COLUMN     "discountAmount" DECIMAL(10,2),
ADD COLUMN     "renewalGroupId" TEXT;

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "discountType" "OfferDiscountType" NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "maxDiscountAmount" DECIMAL(10,2),
    "appliesTo" "OfferAppliesTo" NOT NULL DEFAULT 'BOTH',
    "appliesToAllPlans" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "perUserLimit" INTEGER DEFAULT 1,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserOffer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "feeRecordId" TEXT,
    "source" "RedemptionSource" NOT NULL,
    "offerName" TEXT NOT NULL,
    "discountType" "OfferDiscountType" NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "originalAmount" DECIMAL(10,2) NOT NULL,
    "discountAmount" DECIMAL(10,2) NOT NULL,
    "finalAmount" DECIMAL(10,2) NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_MembershipPlanToOffer" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_MembershipPlanToOffer_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Offer_code_key" ON "Offer"("code");

-- CreateIndex
CREATE INDEX "Offer_isActive_idx" ON "Offer"("isActive");

-- CreateIndex
CREATE INDEX "Offer_validUntil_idx" ON "Offer"("validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "UserOffer_feeRecordId_key" ON "UserOffer"("feeRecordId");

-- CreateIndex
CREATE INDEX "UserOffer_userId_idx" ON "UserOffer"("userId");

-- CreateIndex
CREATE INDEX "UserOffer_offerId_idx" ON "UserOffer"("offerId");

-- CreateIndex
CREATE INDEX "UserOffer_userId_offerId_idx" ON "UserOffer"("userId", "offerId");

-- CreateIndex
CREATE INDEX "_MembershipPlanToOffer_B_index" ON "_MembershipPlanToOffer"("B");

-- CreateIndex
CREATE INDEX "FeeRecord_renewalGroupId_idx" ON "FeeRecord"("renewalGroupId");

-- AddForeignKey
ALTER TABLE "UserOffer" ADD CONSTRAINT "UserOffer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOffer" ADD CONSTRAINT "UserOffer_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOffer" ADD CONSTRAINT "UserOffer_feeRecordId_fkey" FOREIGN KEY ("feeRecordId") REFERENCES "FeeRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MembershipPlanToOffer" ADD CONSTRAINT "_MembershipPlanToOffer_A_fkey" FOREIGN KEY ("A") REFERENCES "MembershipPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MembershipPlanToOffer" ADD CONSTRAINT "_MembershipPlanToOffer_B_fkey" FOREIGN KEY ("B") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

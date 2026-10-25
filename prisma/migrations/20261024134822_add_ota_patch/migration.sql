-- CreateTable
CREATE TABLE "OtaPatch" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'production',
    "targetAppVersion" TEXT NOT NULL,
    "targetVersionCode" INTEGER,
    "version" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "md5" TEXT NOT NULL,
    "signature" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "message" TEXT,
    "forceUpdate" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPermille" INTEGER NOT NULL DEFAULT 1000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtaPatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OtaPatch_channel_targetAppVersion_isActive_idx" ON "OtaPatch"("channel", "targetAppVersion", "isActive");

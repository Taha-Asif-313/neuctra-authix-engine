-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ApiKeyKind" AS ENUM ('secret', 'publishable');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "appId" TEXT,
    "kind" "ApiKeyKind" NOT NULL DEFAULT 'secret',
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "label" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "userDataStorageUsed" INTEGER NOT NULL DEFAULT 0,
    "appDataStorageUsed" INTEGER NOT NULL DEFAULT 0,
    "allowedOrigins" JSONB,
    "allowedIps" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "adminId" TEXT NOT NULL,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppDataItem" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "dataCategory" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "searchText" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppDataItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "otp" TEXT,
    "otpExpiry" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "phone" TEXT,
    "address" TEXT,
    "avatarUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "role" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "settings" JSONB,
    "packageInfo" JSONB,
    "notifications" JSONB,
    "extraInfo" JSONB,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDataItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "dataCategory" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "searchText" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDataItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_adminId_idx" ON "ApiKey"("adminId");

-- CreateIndex
CREATE INDEX "AppDataItem_appId_dataCategory_createdAt_idx" ON "AppDataItem"("appId", "dataCategory", "createdAt");

-- CreateIndex
CREATE INDEX "AppDataItem_appId_createdAt_id_idx" ON "AppDataItem"("appId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "User_appId_createdAt_id_idx" ON "User"("appId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_appId_key" ON "User"("email", "appId");

-- CreateIndex
CREATE INDEX "UserDataItem_appId_dataCategory_createdAt_idx" ON "UserDataItem"("appId", "dataCategory", "createdAt");

-- CreateIndex
CREATE INDEX "UserDataItem_userId_dataCategory_createdAt_idx" ON "UserDataItem"("userId", "dataCategory", "createdAt");

-- CreateIndex
CREATE INDEX "UserDataItem_appId_createdAt_id_idx" ON "UserDataItem"("appId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "UserDataItem_parentId_idx" ON "UserDataItem"("parentId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppDataItem" ADD CONSTRAINT "AppDataItem_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDataItem" ADD CONSTRAINT "UserDataItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDataItem" ADD CONSTRAINT "UserDataItem_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "UserDataItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;


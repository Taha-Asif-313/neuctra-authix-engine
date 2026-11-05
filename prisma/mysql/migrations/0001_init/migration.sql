-- CreateTable
CREATE TABLE `AdminUser` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `isVerified` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AdminUser_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ApiKey` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `kind` ENUM('secret', 'publishable') NOT NULL DEFAULT 'secret',
    `prefix` VARCHAR(191) NOT NULL,
    `hash` VARCHAR(191) NOT NULL,
    `lastFour` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ApiKey_prefix_key`(`prefix`),
    INDEX `ApiKey_adminId_idx`(`adminId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `App` (
    `id` VARCHAR(191) NOT NULL,
    `applicationName` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `userDataStorageUsed` INTEGER NOT NULL DEFAULT 0,
    `appDataStorageUsed` INTEGER NOT NULL DEFAULT 0,
    `allowedOrigins` JSON NULL,
    `allowedIps` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppDataItem` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `dataCategory` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `searchText` TEXT NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AppDataItem_appId_dataCategory_createdAt_idx`(`appId`, `dataCategory`, `createdAt`),
    INDEX `AppDataItem_appId_createdAt_id_idx`(`appId`, `createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NOT NULL,
    `isVerified` BOOLEAN NOT NULL DEFAULT false,
    `otp` VARCHAR(191) NULL,
    `otpExpiry` DATETIME(3) NULL,
    `otpAttempts` INTEGER NOT NULL DEFAULT 0,
    `tokenVersion` INTEGER NOT NULL DEFAULT 0,
    `phone` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `avatarUrl` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `role` VARCHAR(191) NOT NULL DEFAULT 'user',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `settings` JSON NULL,
    `packageInfo` JSON NULL,
    `notifications` JSON NULL,
    `extraInfo` JSON NULL,

    INDEX `User_appId_createdAt_id_idx`(`appId`, `createdAt`, `id`),
    UNIQUE INDEX `User_email_appId_key`(`email`, `appId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserDataItem` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `dataCategory` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `searchText` TEXT NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `parentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserDataItem_appId_dataCategory_createdAt_idx`(`appId`, `dataCategory`, `createdAt`),
    INDEX `UserDataItem_userId_dataCategory_createdAt_idx`(`userId`, `dataCategory`, `createdAt`),
    INDEX `UserDataItem_appId_createdAt_id_idx`(`appId`, `createdAt`, `id`),
    INDEX `UserDataItem_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ApiKey` ADD CONSTRAINT `ApiKey_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `App` ADD CONSTRAINT `App_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AppDataItem` ADD CONSTRAINT `AppDataItem_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `App`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `App`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserDataItem` ADD CONSTRAINT `UserDataItem_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserDataItem` ADD CONSTRAINT `UserDataItem_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `UserDataItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "workflowSnapshot" JSONB;

-- CreateTable
CREATE TABLE "workflow_packages" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "activeRevisionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_package_revisions" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "requestedRevision" TEXT NOT NULL,
    "packagePath" TEXT NOT NULL DEFAULT '',
    "commit" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "transformVersion" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_package_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_workflow_packages" (
    "botId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "alwaysUse" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "bot_workflow_packages_pkey" PRIMARY KEY ("botId","packageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_packages_activeRevisionId_key" ON "workflow_packages"("activeRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_packages_spaceId_userId_alias_key" ON "workflow_packages"("spaceId", "userId", "alias") WHERE "deletedAt" IS NULL;
CREATE INDEX "workflow_packages_spaceId_userId_idx" ON "workflow_packages"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "workflow_package_revisions_digest_idx" ON "workflow_package_revisions"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_package_revisions_packageId_commit_key" ON "workflow_package_revisions"("packageId", "commit");

-- AddForeignKey
ALTER TABLE "workflow_packages" ADD CONSTRAINT "workflow_packages_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_packages" ADD CONSTRAINT "workflow_packages_activeRevisionId_fkey" FOREIGN KEY ("activeRevisionId") REFERENCES "workflow_package_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_package_revisions" ADD CONSTRAINT "workflow_package_revisions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "workflow_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_workflow_packages" ADD CONSTRAINT "bot_workflow_packages_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_workflow_packages" ADD CONSTRAINT "bot_workflow_packages_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "workflow_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE workflow_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_packages_tenant ON workflow_packages USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY workflow_packages_system ON workflow_packages USING (current_setting('app.rls_bypass', true) = 'on');
ALTER TABLE workflow_package_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_package_revisions_tenant ON workflow_package_revisions USING (EXISTS (SELECT 1 FROM workflow_packages p WHERE p.id = "packageId" AND p."spaceId" = NULLIF(current_setting('app.space_id', true), '')));
CREATE POLICY workflow_package_revisions_system ON workflow_package_revisions USING (current_setting('app.rls_bypass', true) = 'on');
ALTER TABLE bot_workflow_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_workflow_packages_tenant ON bot_workflow_packages USING (EXISTS (SELECT 1 FROM workflow_packages p JOIN bots b ON b.id = "botId" WHERE p.id = "packageId" AND p."spaceId" = b."spaceId" AND p."userId" = b."userId" AND p."spaceId" = NULLIF(current_setting('app.space_id', true), '')));
CREATE POLICY bot_workflow_packages_system ON bot_workflow_packages USING (current_setting('app.rls_bypass', true) = 'on');

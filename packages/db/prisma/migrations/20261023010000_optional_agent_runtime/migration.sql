-- Nullable runtime overrides preserve the deployment default for existing bots and runs.
ALTER TABLE "bots" ADD COLUMN "runtime" TEXT;
ALTER TABLE "runs" ADD COLUMN "runtime" TEXT;

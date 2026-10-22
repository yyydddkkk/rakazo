-- Drop tables left unused since the web-only slimming. No code reads or writes them.
-- CASCADE removes their foreign keys, indexes, row-level security policies and grants.
DROP TABLE IF EXISTS "space_voice_preferences" CASCADE;
DROP TABLE IF EXISTS "user_voice_credentials" CASCADE;
DROP TABLE IF EXISTS "ai_data_consents" CASCADE;
DROP TABLE IF EXISTS "passkey" CASCADE;
DROP TABLE IF EXISTS "billing_accounts" CASCADE;
DROP TABLE IF EXISTS "invitation" CASCADE;
DROP TABLE IF EXISTS "security_events" CASCADE;
DROP TABLE IF EXISTS "notification_preferences" CASCADE;
DROP TABLE IF EXISTS "space_memory_configs" CASCADE;

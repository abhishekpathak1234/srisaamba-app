-- ════════════════════════════════════════════════════════════════
-- Phase 5b · Google Calendar inbound-sync columns
-- AutoClient (Sri Saamba AI)
--
-- Stores the Google Calendar push-notification channel state
-- needed for bidirectional sync:
--   google_sync_token     → incremental sync cursor from Google
--   google_channel_id     → UUID we assigned when registering the watch channel
--   google_resource_id    → Google's ID for the watched resource
--   google_channel_expiry → epoch-ms when the channel expires (max 7 days)
--
-- All columns are read/written ONLY by Edge Functions via the
-- service-role key.  Frontend SELECT queries must never include them.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.dealerships
  ADD COLUMN IF NOT EXISTS google_sync_token     text,
  ADD COLUMN IF NOT EXISTS google_channel_id     text,
  ADD COLUMN IF NOT EXISTS google_resource_id    text,
  ADD COLUMN IF NOT EXISTS google_channel_expiry bigint;

-- appointments already has google_event_id from a prior migration;
-- add it idempotently in case it was missed.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS google_event_id text;

COMMENT ON COLUMN public.dealerships.google_sync_token IS
  'Google Calendar incremental sync cursor. Rotated after each webhook delivery.';
COMMENT ON COLUMN public.dealerships.google_channel_id IS
  'UUID of the active Google push-notification channel for this dealership.';
COMMENT ON COLUMN public.dealerships.google_resource_id IS
  'Google resource ID of the watched calendar channel.';
COMMENT ON COLUMN public.dealerships.google_channel_expiry IS
  'Epoch-ms expiry of the push channel. Edge Function must renew before this time.';

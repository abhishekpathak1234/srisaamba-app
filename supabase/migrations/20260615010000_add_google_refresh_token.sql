-- ════════════════════════════════════════════════════════════════
-- Phase 5 · Add google_refresh_token to dealerships
-- AutoClient (Sri Saamba AI)
--
-- The google_calendar_connected and google_calendar_email columns
-- already exist (added in a prior migration).  This adds the
-- refresh_token column needed by the Edge Function to obtain
-- short-lived access tokens server-side.
--
-- Security: this column is read ONLY by Edge Functions via the
-- service-role key.  Frontend queries should never select it.
-- Idempotent (IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.dealerships
  ADD COLUMN IF NOT EXISTS google_refresh_token text;

COMMENT ON COLUMN public.dealerships.google_refresh_token IS
  'Google OAuth 2.0 refresh token — stored server-side only. '
  'Never return this column in frontend SELECT queries.';

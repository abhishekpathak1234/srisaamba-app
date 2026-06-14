-- ════════════════════════════════════════════════════════════════
-- Phase 3 · Calendar Module Extension
-- AutoClient (Sri Saamba AI)
--
--   Extends:  public.appointments
--     + assigned_to_name  text   — salesperson name (denormalised for speed)
--     + notes             text   — free-form appointment notes
--     + source            text   — 'manual' | 'test_drive_sync' | 'ai'
--
--   Updates seed data: backfills demo appointments with realistic
--   salesperson assignments so the Calendar page looks populated
--   out of the box.
--
-- Idempotent (uses IF NOT EXISTS / ON CONFLICT).
-- Apply after Phase 1 and Phase 2 migrations.
-- ════════════════════════════════════════════════════════════════

-- ── 1 · Extend appointments table ───────────────────────────────

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS assigned_to_name text,
  ADD COLUMN IF NOT EXISTS notes            text,
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','test_drive_sync','ai'));

COMMENT ON COLUMN public.appointments.assigned_to_name IS
  'Denormalised salesperson name — avoids a join on the Calendar hot path.';
COMMENT ON COLUMN public.appointments.source IS
  'manual = created via Calendar UI; test_drive_sync = auto-created from Test Drives; ai = booked by AI receptionist.';

-- ── 2 · Backfill demo seed data ─────────────────────────────────
-- Assigns realistic salespeople to existing demo appointments so the
-- Calendar is fully populated the first time a dealer logs in.
-- The CASE branches on appointment_type since we have no per-row
-- identity signal at this point in the seed flow.

UPDATE public.appointments
SET assigned_to_name = CASE appointment_type
  WHEN 'test_drive'         THEN 'Mike Thompson'
  WHEN 'service'            THEN 'Lisa Garcia'
  WHEN 'trade_in_inspection' THEN 'Sarah Mitchell'
  ELSE                           'Team'
END
WHERE assigned_to_name IS NULL;

-- ── 3 · Index for Calendar date-range queries ────────────────────
-- Covers the most common Calendar query pattern:
--   .eq('dealer_id', id).gte('scheduled_at', s).lte('scheduled_at', e)

CREATE INDEX IF NOT EXISTS appointments_calendar_idx
  ON public.appointments (dealer_id, scheduled_at);

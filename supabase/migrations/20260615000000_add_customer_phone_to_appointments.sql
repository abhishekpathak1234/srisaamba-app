-- ════════════════════════════════════════════════════════════════
-- Phase 4 · Add customer_phone to appointments
-- AutoClient (Sri Saamba AI)
--
-- The appointments table was created without a phone column.
-- This adds the denormalised phone field so Calendar create/edit
-- can store it without requiring a customers FK lookup.
--
-- Idempotent (IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS customer_phone text;

COMMENT ON COLUMN public.appointments.customer_phone IS
  'Denormalised customer phone — stored at booking time so the '
  'Calendar page never loses the number when customer_id is null.';

-- Reload PostgREST schema cache so the new column is visible immediately
NOTIFY pgrst, 'reload schema';

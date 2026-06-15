/**
 * sync-google-calendar
 * ─────────────────────────────────────────────────────────────────────────
 * Syncs a single appointment to the dealership's Google Calendar.
 * Called fire-and-forget from the frontend — a failure here NEVER blocks
 * Auto AI appointment operations.
 *
 * Body:  { action: 'create' | 'edit' | 'delete', appointment_id, dealer_id }
 * Auth:  Supabase service-role key (server-side only, no tokens exposed)
 *
 * Secrets required (supabase secrets set --env-file .env.local):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token'
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TYPE_LABEL: Record<string, string> = {
  test_drive:           'Test Drive',
  service:              'Service',
  trade_in_inspection:  'Trade-In Inspection',
}

// ── Token refresh ─────────────────────────────────────────────────────────
async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })
  const json = await res.json()
  if (!json.access_token) {
    throw new Error(`Token refresh failed: ${json.error_description ?? json.error ?? 'unknown'}`)
  }
  return json.access_token as string
}

// ── Build Google Calendar event body ──────────────────────────────────────
function buildEvent(appt: Record<string, unknown>): Record<string, unknown> {
  const typeName = TYPE_LABEL[appt.appointment_type as string] ?? appt.appointment_type
  const summary  = `${appt.customer_name || 'Customer'} (${typeName})`

  const startTime = new Date(appt.scheduled_at as string)
  const endTime   = new Date(startTime.getTime() + 60 * 60 * 1000) // default 1 h

  const descParts: string[] = []
  if (appt.vehicle) descParts.push(`Vehicle: ${appt.vehicle}`)
  if (appt.notes)   descParts.push(`Notes: ${appt.notes}`)

  return {
    summary,
    ...(descParts.length && { description: descParts.join('\n') }),
    start: { dateTime: startTime.toISOString(), timeZone: 'UTC' },
    end:   { dateTime: endTime.toISOString(),   timeZone: 'UTC' },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
const json200 = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const json400 = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// ── Handler ───────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { action, appointment_id, dealer_id } = await req.json() as {
      action:         string
      appointment_id: string
      dealer_id:      string
    }

    if (!action || !appointment_id || !dealer_id) {
      return json400('action, appointment_id, and dealer_id are required')
    }

    // ── 1. Dealership — check connected + get refresh token ───────────────
    const { data: dealer } = await supa
      .from('dealerships')
      .select('google_calendar_connected, google_refresh_token, google_calendar_email')
      .eq('id', dealer_id)
      .single()

    if (!dealer?.google_calendar_connected || !dealer?.google_refresh_token) {
      // Not connected — silently skip, not an error
      return json200({ skipped: true, reason: 'Google Calendar not connected' })
    }

    // ── 2. Appointment ────────────────────────────────────────────────────
    const { data: appt } = await supa
      .from('appointments')
      .select('id, customer_name, appointment_type, vehicle, notes, scheduled_at, google_event_id')
      .eq('id', appointment_id)
      .eq('dealer_id', dealer_id)
      .single()

    if (!appt) return json400('Appointment not found')

    // ── 3. Access token ───────────────────────────────────────────────────
    const accessToken = await getAccessToken(dealer.google_refresh_token as string)
    const calendarId  = (dealer.google_calendar_email as string) || 'primary'
    const authHeader  = `Bearer ${accessToken}`
    const eventsBase  = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`

    // ── 4. Action dispatch ────────────────────────────────────────────────

    // CREATE — or CREATE when edit has no existing event_id yet
    if (action === 'create' || (action === 'edit' && !appt.google_event_id)) {
      const res = await fetch(eventsBase, {
        method:  'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body:    JSON.stringify(buildEvent(appt)),
      })
      const evt = await res.json()
      if (!evt.id) throw new Error(evt.error?.message ?? 'Google Calendar create failed')

      await supa
        .from('appointments')
        .update({ google_event_id: evt.id })
        .eq('id', appointment_id)

      return json200({ success: true, google_event_id: evt.id })
    }

    // EDIT — update existing event
    if (action === 'edit') {
      const res = await fetch(`${eventsBase}/${appt.google_event_id}`, {
        method:  'PUT',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body:    JSON.stringify(buildEvent(appt)),
      })
      const evt = await res.json()
      if (!evt.id) throw new Error(evt.error?.message ?? 'Google Calendar update failed')
      return json200({ success: true })
    }

    // DELETE — remove event (404 is fine — already gone)
    if (action === 'delete') {
      if (!appt.google_event_id) {
        return json200({ skipped: true, reason: 'No google_event_id on this appointment' })
      }
      const res = await fetch(`${eventsBase}/${appt.google_event_id}`, {
        method:  'DELETE',
        headers: { Authorization: authHeader },
      })
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error((errBody as { error?: { message?: string } }).error?.message ?? `Delete failed: HTTP ${res.status}`)
      }
      return json200({ success: true })
    }

    return json400(`Unknown action: ${action}`)

  } catch (err) {
    // Always return 200 — calendar failures must NEVER surface as errors to the frontend
    console.error('[sync-google-calendar]', err)
    return json200({ error: (err as Error).message, skipped: true })
  }
})

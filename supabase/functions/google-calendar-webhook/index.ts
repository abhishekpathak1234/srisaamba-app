/**
 * google-calendar-webhook
 * ─────────────────────────────────────────────────────────────────────────
 * Two entry points:
 *
 *   POST (from Google — X-Goog-Resource-State header present)
 *        → Validation ping (state=sync): acknowledge 200 immediately.
 *        → Change ping (state=exists):   fetch incremental diff via
 *          syncToken, upsert appointments for changed events, rotate token.
 *
 *   POST { action: 'setup', dealer_id }
 *        → Full event list → initial syncToken → register push channel.
 *          Skipped if an active channel already exists (expiry > 1 hour).
 *
 * Deploy with: supabase functions deploy google-calendar-webhook --no-verify-jwt
 *
 * Secrets required:
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
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

// ── Types ─────────────────────────────────────────────────────────────────

interface GCalEvent {
  id:           string
  status:       string       // 'confirmed' | 'tentative' | 'cancelled'
  summary?:     string
  description?: string
  start?:       { dateTime?: string; date?: string }
  end?:         { dateTime?: string; date?: string }
  updated?:     string
}

// ── Helpers ───────────────────────────────────────────────────────────────

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

/**
 * Parses the Google Calendar event summary and description back into
 * appointment fields.  Outbound sync writes:
 *   summary:     "Customer Name (Appointment Type)"
 *   description: "Vehicle: Honda Civic\nNotes: Some note"
 */
function parseGCalEvent(evt: GCalEvent): {
  customer_name:    string
  appointment_type: string
  scheduled_at:     string | null
  notes:            string | null
  vehicle:          string | null
} {
  // ── Parse summary: "Name (Type)" ─────────────────────────────────────
  const raw          = (evt.summary ?? '').trim()
  const parenMatch   = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/)
  const customer_name    = parenMatch ? parenMatch[1].trim() || 'Google Calendar Event' : raw || 'Google Calendar Event'
  const appointment_type = parenMatch ? parenMatch[2].trim().toLowerCase().replace(/\s+/g, '_') : 'other'

  // ── Parse description: "Vehicle: X\nNotes: Y" ─────────────────────────
  const desc    = evt.description ?? ''
  const vehicle = desc.match(/^Vehicle:\s*(.+)$/im)?.[1]?.trim() ?? null
  const notes   = desc.match(/^Notes:\s*(.+)$/im)?.[1]?.trim() ?? (desc || null)

  const scheduled_at = evt.start?.dateTime ?? evt.start?.date ?? null

  return { customer_name, appointment_type, scheduled_at, notes, vehicle }
}

const ok200   = () => new Response('ok', { status: 200, headers: CORS })

const json200 = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status:  200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const jsonErr = (msg: string, status = 400) =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// ── Handler ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS })

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ─────────────────────────────────────────────────────────────────────
  // PATH A: Google push-notification ping
  // ─────────────────────────────────────────────────────────────────────
  const resourceState = req.headers.get('x-goog-resource-state')

  if (resourceState !== null) {
    const channelId  = req.headers.get('x-goog-channel-id')
    const dealerId   = req.headers.get('x-goog-channel-token')  // we set this to dealer_id at setup
    const resourceId = req.headers.get('x-goog-resource-id')

    console.log('[gcal-webhook] ping —',
      'state:', resourceState,
      'channel:', channelId,
      'dealer:', dealerId,
      'resource:', resourceId,
    )

    // Validation ping — acknowledge immediately
    if (resourceState === 'sync') {
      console.log('[gcal-webhook] validation ping OK')
      return ok200()
    }

    if (!dealerId) {
      console.warn('[gcal-webhook] change ping has no x-goog-channel-token — cannot route to dealer')
      return ok200()
    }

    try {
      // ── Fetch dealer credentials ──────────────────────────────────────
      const { data: dealer, error: dealerErr } = await supa
        .from('dealerships')
        .select('google_refresh_token, google_sync_token, google_calendar_email')
        .eq('id', dealerId)
        .single()

      if (dealerErr) {
        console.error('[gcal-webhook] dealer lookup error:', dealerErr.message, 'code:', dealerErr.code)
        return ok200()
      }
      if (!dealer?.google_refresh_token) {
        console.warn('[gcal-webhook] dealer', dealerId, 'has no refresh token')
        return ok200()
      }

      const accessToken = await getAccessToken(dealer.google_refresh_token as string)
      const calendarId  = (dealer.google_calendar_email as string) || 'primary'

      // ── Fetch incremental event list ──────────────────────────────────
      const syncUrl = new URL(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      )
      if (dealer.google_sync_token) {
        syncUrl.searchParams.set('syncToken', dealer.google_sync_token as string)
      } else {
        syncUrl.searchParams.set('maxResults',   '50')
        syncUrl.searchParams.set('orderBy',      'updated')
        syncUrl.searchParams.set('singleEvents', 'true')
      }

      const eventsRes = await fetch(syncUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      // 410 = syncToken stale — clear and let the next ping do a full re-sync
      if (eventsRes.status === 410) {
        console.warn('[gcal-webhook] syncToken expired for dealer', dealerId, '— resetting')
        const { error: resetErr } = await supa.from('dealerships')
          .update({ google_sync_token: null, google_channel_id: null, google_resource_id: null })
          .eq('id', dealerId)
        if (resetErr) console.error('[gcal-webhook] failed to reset sync state:', resetErr.message)
        return ok200()
      }

      if (!eventsRes.ok) {
        console.error('[gcal-webhook] Google events API error:', eventsRes.status, await eventsRes.text())
        return ok200()
      }

      const eventsJson = await eventsRes.json() as {
        nextSyncToken?: string
        items?:         GCalEvent[]
      }

      // Rotate syncToken before processing so even a crash mid-loop doesn't replay
      if (eventsJson.nextSyncToken) {
        const { error: tokenErr } = await supa.from('dealerships')
          .update({ google_sync_token: eventsJson.nextSyncToken })
          .eq('id', dealerId)
        if (tokenErr) {
          console.error('[gcal-webhook] syncToken rotation failed:', tokenErr.message)
        } else {
          console.log('[gcal-webhook] syncToken rotated for dealer', dealerId)
        }
      }

      const items = eventsJson.items ?? []
      console.log(`[gcal-webhook] dealer=${dealerId} changed events=${items.length}`)

      // ── Process each changed event ────────────────────────────────────
      for (const evt of items) {
        console.log('[gcal-webhook] processing event:', evt.id, '| status:', evt.status, '| summary:', evt.summary)

        // ── DELETED ────────────────────────────────────────────────────
        if (evt.status === 'cancelled') {
          const { data: detached, error: detachErr } = await supa
            .from('appointments')
            .update({ google_event_id: null })
            .eq('google_event_id', evt.id)
            .eq('dealer_id', dealerId)
            .select('id')

          if (detachErr) {
            console.error('[gcal-webhook] database error detaching cancelled event:', evt.id, '—', detachErr.message, detachErr.details ?? '')
          } else {
            console.log('[gcal-webhook] detached cancelled event', evt.id, '— affected rows:', detached?.length ?? 0)
          }
          continue
        }

        // ── CREATED OR UPDATED ──────────────────────────────────────────
        const parsed = parseGCalEvent(evt)
        if (!parsed.scheduled_at) {
          console.warn('[gcal-webhook] event', evt.id, 'has no start time — skipping')
          continue
        }

        // Check whether we already have an appointment row for this Google event
        const { data: existing, error: lookupErr } = await supa
          .from('appointments')
          .select('id')
          .eq('google_event_id', evt.id)
          .eq('dealer_id', dealerId)
          .maybeSingle()

        if (lookupErr) {
          console.error('[gcal-webhook] database error looking up event', evt.id, '—', lookupErr.message, lookupErr.details ?? '')
          continue
        }

        if (existing) {
          // ── UPDATE — reschedule (and refresh notes) from Google ───────
          const { error: updateErr } = await supa
            .from('appointments')
            .update({
              scheduled_at: parsed.scheduled_at,
              notes:        parsed.notes,
            })
            .eq('google_event_id', evt.id)
            .eq('dealer_id', dealerId)

          if (updateErr) {
            console.error('[gcal-webhook] database update error for event', evt.id, '—', updateErr.message, updateErr.details ?? '', updateErr.hint ?? '')
          } else {
            console.log('[gcal-webhook] updated appointment', existing.id, '→ scheduled_at:', parsed.scheduled_at)
          }

        } else {
          // ── INSERT — event created directly in Google Calendar ────────
          // Map event.summary ("Name (Type)") + event.id → new appointment row.
          const newRow = {
            dealer_id:        dealerId,
            customer_id:      null,
            source:           'google_calendar',
            customer_name:    parsed.customer_name,
            appointment_type: parsed.appointment_type,
            scheduled_at:     parsed.scheduled_at,
            vehicle:          parsed.vehicle,
            notes:            parsed.notes,
            google_event_id:  evt.id,
          }

          console.log('[gcal-webhook] inserting new appointment from Google event:', evt.id, JSON.stringify(newRow))

          const { data: inserted, error: insertErr } = await supa
            .from('appointments')
            .insert(newRow)
            .select('id')
            .single()

          if (insertErr) {
            console.error('[gcal-webhook] database insert error for event', evt.id, '—', insertErr.message, insertErr.details ?? '', insertErr.hint ?? '')
          } else {
            console.log('[gcal-webhook] inserted new appointment', inserted?.id, 'from Google event', evt.id)
          }
        }
      }

      return ok200()

    } catch (err) {
      // Always 200 to Google — non-200 triggers aggressive retries
      console.error('[gcal-webhook] unhandled ping error:', (err as Error).message, (err as Error).stack)
      return ok200()
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // PATH B: Setup action — register push-notification channel
  // ─────────────────────────────────────────────────────────────────────
  try {
    const body = await req.json() as {
      action?:   string
      dealer_id?: string
      time_min?: string
      time_max?: string
    }

    if (!body.dealer_id) return jsonErr('dealer_id is required')
    const dealerId = body.dealer_id

    // ── BACKFILL action — one-time historical import ──────────────────────
    if (body.action === 'backfill') {
      const { data: dealer, error: dealerErr } = await supa
        .from('dealerships')
        .select('google_refresh_token, google_calendar_email')
        .eq('id', dealerId)
        .single()

      if (dealerErr || !dealer?.google_refresh_token) {
        return jsonErr('Google Calendar not connected for this dealership', 400)
      }

      const accessToken = await getAccessToken(dealer.google_refresh_token as string)
      const calendarId  = (dealer.google_calendar_email as string) || 'primary'

      // Default window: Monday of this week → Sunday of next week (14 days)
      const now      = new Date()
      const dow      = now.getDay()                     // 0=Sun, 1=Mon…
      const monday   = new Date(now)
      monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1))
      monday.setHours(0, 0, 0, 0)
      const endDate  = new Date(monday)
      endDate.setDate(monday.getDate() + 13)            // +13 → end of next week
      endDate.setHours(23, 59, 59, 999)

      const timeMin = body.time_min ?? monday.toISOString()
      const timeMax = body.time_max ?? endDate.toISOString()

      console.log(`[gcal-webhook] backfill starting — dealer:${dealerId} calendar:${calendarId} ${timeMin} → ${timeMax}`)

      let inserted = 0, updated = 0, skipped = 0
      let pageToken: string | undefined

      do {
        const listUrl = new URL(
          `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        )
        listUrl.searchParams.set('timeMin',      timeMin)
        listUrl.searchParams.set('timeMax',      timeMax)
        listUrl.searchParams.set('singleEvents', 'true')
        listUrl.searchParams.set('orderBy',      'startTime')
        listUrl.searchParams.set('maxResults',   '250')
        if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

        const listRes  = await fetch(listUrl.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        })

        if (!listRes.ok) {
          const errBody = await listRes.text()
          console.error('[gcal-webhook] backfill list error:', listRes.status, errBody)
          return jsonErr(`Google Calendar fetch failed (${listRes.status}): ${errBody}`, 500)
        }

        const listJson = await listRes.json() as { nextPageToken?: string; items?: GCalEvent[] }
        pageToken = listJson.nextPageToken

        for (const evt of listJson.items ?? []) {
          if (evt.status === 'cancelled') { skipped++; continue }

          const parsed = parseGCalEvent(evt)
          if (!parsed.scheduled_at) { skipped++; continue }

          const { data: existing, error: lookupErr } = await supa
            .from('appointments')
            .select('id')
            .eq('google_event_id', evt.id)
            .eq('dealer_id', dealerId)
            .maybeSingle()

          if (lookupErr) {
            console.error('[gcal-webhook] backfill lookup error:', evt.id, lookupErr.message)
            skipped++; continue
          }

          if (existing) {
            const { error: upErr } = await supa
              .from('appointments')
              .update({ scheduled_at: parsed.scheduled_at, notes: parsed.notes, vehicle: parsed.vehicle })
              .eq('google_event_id', evt.id)
              .eq('dealer_id', dealerId)
            if (upErr) {
              console.error('[gcal-webhook] backfill update error:', evt.id, upErr.message)
              skipped++
            } else { updated++ }
          } else {
            const { error: insErr } = await supa
              .from('appointments')
              .insert({
                dealer_id:        dealerId,
                customer_id:      null,
                source:           'google_calendar',
                customer_name:    parsed.customer_name,
                appointment_type: parsed.appointment_type,
                scheduled_at:     parsed.scheduled_at,
                vehicle:          parsed.vehicle,
                notes:            parsed.notes,
                google_event_id:  evt.id,
                status:           'confirmed',
              })
            if (insErr) {
              console.error('[gcal-webhook] backfill insert error:', evt.id, insErr.message, insErr.details ?? '')
              skipped++
            } else { inserted++ }
          }
        }
      } while (pageToken)

      console.log(`[gcal-webhook] backfill done — dealer:${dealerId} inserted:${inserted} updated:${updated} skipped:${skipped}`)
      return json200({ success: true, inserted, updated, skipped, timeMin, timeMax })
    }

    // ── SETUP action — register push-notification channel ─────────────────
    if (body.action !== 'setup') {
      return jsonErr('action must be "setup" or "backfill"')
    }

    const { data: dealer, error: dealerErr } = await supa
      .from('dealerships')
      .select('google_refresh_token, google_calendar_email, google_channel_id, google_channel_expiry')
      .eq('id', dealerId)
      .single()

    if (dealerErr) {
      console.error('[gcal-webhook] setup dealer lookup failed:', dealerErr.message)
      return jsonErr('Dealer not found: ' + dealerErr.message, 404)
    }

    if (!dealer?.google_refresh_token) {
      return jsonErr('Google Calendar not connected for this dealership')
    }

    // Skip if an active channel exists with > 1 hour remaining
    const nowMs    = Date.now()
    const expiryMs = Number(dealer.google_channel_expiry ?? 0)
    if (dealer.google_channel_id && expiryMs > nowMs + 60 * 60 * 1000) {
      console.log('[gcal-webhook] active channel exists for dealer', dealerId, '— skipping setup')
      return json200({ skipped: true, reason: 'Active channel already registered', expiry: expiryMs })
    }

    let accessToken: string
    try {
      accessToken = await getAccessToken(dealer.google_refresh_token as string)
      console.log('[gcal-webhook] access token refreshed OK for dealer', dealerId)
    } catch (tokenErr) {
      console.error('[gcal-webhook] STEP FAILED — token refresh:', (tokenErr as Error).message)
      return jsonErr('Token refresh failed: ' + (tokenErr as Error).message, 500)
    }

    const calendarId = (dealer.google_calendar_email as string) || 'primary'
    console.log('[gcal-webhook] setup starting for dealer', dealerId, 'calendar', calendarId)

    // ── Full event list → initial syncToken ───────────────────────────────
    let syncToken: string | null = null
    let pageToken: string | undefined

    do {
      const listUrl = new URL(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      )
      listUrl.searchParams.set('maxResults',   '250')
      listUrl.searchParams.set('singleEvents', 'true')
      if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

      const listRes = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!listRes.ok) {
        const errBody = await listRes.text()
        console.error('[gcal-webhook] STEP FAILED — event list HTTP', listRes.status, ':', errBody)
        throw new Error(`Event list failed (${listRes.status}): ${errBody}`)
      }
      const listJson = await listRes.json() as { nextPageToken?: string; nextSyncToken?: string }
      pageToken = listJson.nextPageToken
      if (!pageToken) syncToken = listJson.nextSyncToken ?? null
    } while (pageToken)

    console.log('[gcal-webhook] syncToken obtained for dealer', dealerId)

    // ── Register push-notification channel ────────────────────────────────
    const channelId  = crypto.randomUUID()
    const webhookUrl = 'https://app.srisaamba.com/api/calendar-webhook'

    console.log('[gcal-webhook] STEP — registering watch channel', channelId, '→', webhookUrl, 'calendar:', calendarId)

    const watchRes  = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:      channelId,
          type:    'web_hook',
          address: webhookUrl,
          token:   dealerId,
        }),
      },
    )
    const watchRaw  = await watchRes.text()
    console.log('[gcal-webhook] Google watch response HTTP', watchRes.status, ':', watchRaw)

    let watchJson: { id?: string; resourceId?: string; expiration?: string; error?: { code: number; message: string; status?: string } }
    try {
      watchJson = JSON.parse(watchRaw)
    } catch {
      console.error('[gcal-webhook] STEP FAILED — watch response not JSON:', watchRaw)
      // Non-fatal: return success:false so caller knows but don't 500
      return json200({ success: false, reason: 'Watch registration returned non-JSON', raw: watchRaw })
    }

    if (watchJson.error || !watchJson.resourceId) {
      const errCode    = watchJson.error?.code ?? watchRes.status
      const errMessage = watchJson.error?.message ?? 'no resourceId in response'
      const errStatus  = watchJson.error?.status  ?? ''
      console.error(
        `[gcal-webhook] STEP FAILED — Google watch registration: HTTP ${errCode} ${errStatus} — ${errMessage}`,
        '\nFull response:', watchRaw,
        '\nFix: verify app.srisaamba.com in Google Cloud Console → APIs & Services → Domain Verification',
      )
      // Return 200 so the browser doesn't see a red 500 — the channel simply won't be active
      return json200({ success: false, reason: errMessage, code: errCode, status: errStatus })
    }

    // ── Persist channel state + syncToken ─────────────────────────────────
    const { error: saveErr } = await supa.from('dealerships').update({
      google_sync_token:     syncToken,
      google_channel_id:     watchJson.id,
      google_resource_id:    watchJson.resourceId,
      google_channel_expiry: Number(watchJson.expiration ?? 0),
    }).eq('id', dealerId)

    if (saveErr) {
      console.error('[gcal-webhook] STEP FAILED — save channel state:', saveErr.message, saveErr.details ?? '')
    } else {
      console.log('[gcal-webhook] channel registered — dealer:', dealerId, 'channel:', watchJson.id, 'expires:', watchJson.expiration)
    }

    return json200({
      success:     true,
      channel_id:  watchJson.id,
      resource_id: watchJson.resourceId,
      expiry:      watchJson.expiration,
    })

  } catch (err) {
    console.error('[gcal-webhook] setup unhandled error:', (err as Error).message, (err as Error).stack)
    return jsonErr((err as Error).message, 500)
  }
})

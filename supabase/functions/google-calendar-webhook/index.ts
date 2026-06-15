/**
 * google-calendar-webhook
 * ─────────────────────────────────────────────────────────────────────────
 * Two entry points:
 *
 *   POST (from Google — X-Goog-Resource-State header present)
 *        → Validation ping (state=sync): acknowledge 200 immediately.
 *        → Change ping (state=exists):   fetch incremental diff via
 *          syncToken, update appointments.scheduled_at for changed events,
 *          clear google_event_id for deleted events, rotate syncToken.
 *
 *   POST { action: 'setup', dealer_id }
 *        → Full event list to obtain initial syncToken, then registers a
 *          push-notification channel with Google.  Skipped if an active
 *          channel already exists (expiry > 1 hour away).
 *          Called automatically from google-calendar-auth callback and
 *          from the frontend loadGoogleCalendarStatus on Settings load.
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
  // Identified by the presence of X-Goog-Resource-State header.
  // Google sends no JSON body — everything is in headers.
  // ─────────────────────────────────────────────────────────────────────
  const resourceState = req.headers.get('x-goog-resource-state')

  if (resourceState !== null) {
    const channelId = req.headers.get('x-goog-channel-id')      // UUID we generated at setup
    const token     = req.headers.get('x-goog-channel-token')   // dealer_id we passed as token
    const resourceId = req.headers.get('x-goog-resource-id')

    console.log('[gcal-webhook] ping received —',
      'state:', resourceState,
      'channelId:', channelId,
      'token/dealerId:', token,
      'resourceId:', resourceId,
    )

    // ── Validation ping: Google sends this once when channel is registered ──
    if (resourceState === 'sync') {
      console.log('[gcal-webhook] validation ping acknowledged')
      return ok200()
    }

    // ── Change ping: one or more events changed ───────────────────────────
    const dealerId = token
    if (!dealerId) {
      console.warn('[gcal-webhook] change ping missing x-goog-channel-token — cannot identify dealer')
      return ok200() // always 200 to Google to prevent retry storms
    }

    try {
      const { data: dealer, error: dealerErr } = await supa
        .from('dealerships')
        .select('google_refresh_token, google_sync_token, google_calendar_email')
        .eq('id', dealerId)
        .single()

      if (dealerErr || !dealer) {
        console.error('[gcal-webhook] dealer lookup failed:', dealerErr?.message)
        return ok200()
      }

      if (!dealer.google_refresh_token) {
        console.warn('[gcal-webhook] dealer has no refresh token — skipping')
        return ok200()
      }

      const accessToken = await getAccessToken(dealer.google_refresh_token as string)
      const calendarId  = (dealer.google_calendar_email as string) || 'primary'

      // ── Fetch incremental event list using stored syncToken ─────────────
      const syncUrl = new URL(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      )
      if (dealer.google_sync_token) {
        syncUrl.searchParams.set('syncToken', dealer.google_sync_token as string)
      } else {
        // No syncToken — pull recent events as fallback
        syncUrl.searchParams.set('maxResults', '50')
        syncUrl.searchParams.set('orderBy',    'updated')
        syncUrl.searchParams.set('singleEvents', 'true')
      }

      const eventsRes = await fetch(syncUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      // 410 Gone = syncToken expired — clear it so next ping does a fresh full sync
      if (eventsRes.status === 410) {
        console.warn('[gcal-webhook] syncToken expired for dealer', dealerId, '— clearing for re-sync')
        await supa.from('dealerships')
          .update({
            google_sync_token:  null,
            google_channel_id:  null,   // force channel re-registration on next Settings load
            google_resource_id: null,
          })
          .eq('id', dealerId)
        return ok200()
      }

      if (!eventsRes.ok) {
        const errBody = await eventsRes.text()
        console.error('[gcal-webhook] events fetch failed:', eventsRes.status, errBody)
        return ok200()
      }

      const eventsJson = await eventsRes.json() as {
        nextSyncToken?: string
        items?: Array<{
          id:           string
          status:       string
          summary?:     string
          start?:       { dateTime?: string; date?: string }
          end?:         { dateTime?: string; date?: string }
          description?: string
          updated?:     string
        }>
      }

      // Rotate the syncToken immediately so the next ping is incremental
      if (eventsJson.nextSyncToken) {
        await supa.from('dealerships')
          .update({ google_sync_token: eventsJson.nextSyncToken })
          .eq('id', dealerId)
        console.log('[gcal-webhook] syncToken rotated for dealer', dealerId)
      }

      const items = eventsJson.items ?? []
      console.log(`[gcal-webhook] dealer=${dealerId} processing ${items.length} changed event(s)`)

      // ── Process each changed event ──────────────────────────────────────
      for (const evt of items) {
        console.log('[gcal-webhook] event:', evt.id, 'status:', evt.status, 'summary:', evt.summary)

        if (evt.status === 'cancelled') {
          // Deleted in Google Calendar — detach from our appointment row.
          // We do NOT delete the appointment: the dealership staff can decide.
          const { data: affected } = await supa.from('appointments')
            .update({ google_event_id: null })
            .eq('google_event_id', evt.id)
            .eq('dealer_id', dealerId)
            .select('id')

          if (affected?.length) {
            console.log('[gcal-webhook] detached deleted event from appointment', affected[0].id)
          }

        } else {
          // Updated in Google Calendar — sync the new time back to our appointment.
          const scheduledAt = evt.start?.dateTime ?? evt.start?.date
          if (!scheduledAt) continue

          const { data: affected } = await supa.from('appointments')
            .update({ scheduled_at: scheduledAt })
            .eq('google_event_id', evt.id)
            .eq('dealer_id', dealerId)
            .select('id, scheduled_at')

          if (affected?.length) {
            console.log('[gcal-webhook] updated appointment', affected[0].id, '→', scheduledAt)
          } else {
            // No matching appointment — event was created directly in Google Calendar.
            // We log it but don't create a new appointment row (insufficient data).
            console.log('[gcal-webhook] no matching appointment for google_event_id', evt.id)
          }
        }
      }

      return ok200()

    } catch (err) {
      // Always return 200 to Google — a non-200 triggers aggressive retries
      console.error('[gcal-webhook] ping processing error:', (err as Error).message)
      return ok200()
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // PATH B: Setup action — register a new push-notification channel
  // Called from google-calendar-auth callback AND from frontend on
  // Settings load when channel is missing or near-expiry.
  // ─────────────────────────────────────────────────────────────────────
  try {
    const body = await req.json() as { action?: string; dealer_id?: string }

    if (body.action !== 'setup' || !body.dealer_id) {
      return jsonErr('action must be "setup" and dealer_id is required')
    }

    const dealerId = body.dealer_id

    const { data: dealer, error: dealerErr } = await supa
      .from('dealerships')
      .select('google_refresh_token, google_calendar_email, google_channel_id, google_channel_expiry')
      .eq('id', dealerId)
      .single()

    if (dealerErr || !dealer) {
      return jsonErr('Dealer not found: ' + (dealerErr?.message ?? 'unknown'), 404)
    }

    if (!dealer.google_refresh_token) {
      return jsonErr('Google Calendar not connected for this dealership')
    }

    // Skip if an active channel already exists with > 1 hour remaining
    const nowMs    = Date.now()
    const expiryMs = Number(dealer.google_channel_expiry ?? 0)
    if (dealer.google_channel_id && expiryMs > nowMs + 60 * 60 * 1000) {
      console.log('[gcal-webhook] active channel exists for dealer', dealerId, '— skipping setup')
      return json200({
        skipped:    true,
        reason:     'Active channel already registered',
        channel_id: dealer.google_channel_id,
        expiry:     expiryMs,
      })
    }

    const accessToken = await getAccessToken(dealer.google_refresh_token as string)
    const calendarId  = (dealer.google_calendar_email as string) || 'primary'

    console.log('[gcal-webhook] starting setup for dealer', dealerId, 'calendar', calendarId)

    // ── 1. Full event list → obtain initial syncToken ─────────────────────
    let syncToken: string | null = null
    let pageToken: string | undefined

    do {
      const listUrl = new URL(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      )
      listUrl.searchParams.set('maxResults',   '250')
      listUrl.searchParams.set('singleEvents', 'true')
      if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

      const listRes  = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!listRes.ok) {
        const errBody = await listRes.text()
        throw new Error(`Event list failed (${listRes.status}): ${errBody}`)
      }

      const listJson = await listRes.json() as {
        nextPageToken?: string
        nextSyncToken?: string
      }
      pageToken = listJson.nextPageToken
      if (!pageToken) syncToken = listJson.nextSyncToken ?? null
    } while (pageToken)

    console.log('[gcal-webhook] obtained syncToken for dealer', dealerId)

    // ── 2. Register push-notification channel ─────────────────────────────
    const channelId  = crypto.randomUUID()
    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar-webhook`

    console.log('[gcal-webhook] registering channel', channelId, '→', webhookUrl)

    const watchRes  = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id:      channelId,
          type:    'web_hook',
          address: webhookUrl,
          token:   dealerId,  // returned as X-Goog-Channel-Token on every ping
        }),
      },
    )

    const watchJson = await watchRes.json() as {
      id?:         string
      resourceId?: string
      expiration?: string
      error?:      { code: number; message: string; status?: string }
    }

    if (watchJson.error || !watchJson.resourceId) {
      console.error('[gcal-webhook] watch registration failed:', JSON.stringify(watchJson))
      return jsonErr(
        watchJson.error?.message ?? 'Google watch registration failed — check domain verification',
        500,
      )
    }

    // ── 3. Persist channel state + syncToken ──────────────────────────────
    await supa.from('dealerships').update({
      google_sync_token:     syncToken,
      google_channel_id:     watchJson.id,
      google_resource_id:    watchJson.resourceId,
      google_channel_expiry: Number(watchJson.expiration ?? 0),
    }).eq('id', dealerId)

    console.log(
      '[gcal-webhook] channel registered — dealer:', dealerId,
      'channel:', watchJson.id,
      'resourceId:', watchJson.resourceId,
      'expires:', watchJson.expiration,
    )

    return json200({
      success:     true,
      channel_id:  watchJson.id,
      resource_id: watchJson.resourceId,
      expiry:      watchJson.expiration,
    })

  } catch (err) {
    console.error('[gcal-webhook] setup error:', (err as Error).message)
    return jsonErr((err as Error).message, 500)
  }
})

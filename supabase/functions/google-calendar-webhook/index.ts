/**
 * google-calendar-webhook
 * ─────────────────────────────────────────────────────────────────────────
 * Handles bidirectional Google Calendar sync.  Two entry points:
 *
 *   POST { action: 'setup', dealer_id }
 *        → Gets initial syncToken via full event list, then registers a
 *          Google push-notification channel pointing back at this function.
 *          Stores channelId / resourceId / syncToken in dealerships row.
 *
 *   POST  (from Google — identified by X-Goog-Resource-State header)
 *        → Receives change pings, fetches incremental diff via syncToken,
 *          upserts affected appointments, stores new syncToken.
 *
 * Deploy with: supabase functions deploy google-calendar-webhook --no-verify-jwt
 *
 * Secrets required (same as google-calendar-auth):
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

const ok200 = () => new Response('ok', { status: 200, headers: CORS })

const json200 = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
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

  // ── Google push-notification ping (no JSON body; identified by header) ──
  const resourceState = req.headers.get('x-goog-resource-state')
  if (resourceState) {
    // Validation ping — Google sends this once when the channel is registered.
    if (resourceState === 'sync') return ok200()

    // Change ping — 'exists' means one or more events changed.
    const dealerId = req.headers.get('x-goog-channel-token')
    if (!dealerId) {
      console.warn('[gcal-webhook] ping missing x-goog-channel-token')
      return ok200() // always 200 to Google
    }

    try {
      const { data: dealer } = await supa
        .from('dealerships')
        .select('google_refresh_token, google_sync_token, google_calendar_email')
        .eq('id', dealerId)
        .single()

      if (!dealer?.google_refresh_token) return ok200()

      const accessToken = await getAccessToken(dealer.google_refresh_token as string)
      const calendarId  = (dealer.google_calendar_email as string) || 'primary'

      // ── Fetch incremental changes ───────────────────────────────────────
      const syncUrl = new URL(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      )
      if (dealer.google_sync_token) {
        syncUrl.searchParams.set('syncToken', dealer.google_sync_token as string)
      }
      syncUrl.searchParams.set('singleEvents', 'true')

      const eventsRes = await fetch(syncUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      // 410 Gone = syncToken expired.  Clear it so the next ping triggers a full re-sync.
      if (eventsRes.status === 410) {
        console.warn('[gcal-webhook] syncToken expired for dealer', dealerId)
        await supa.from('dealerships')
          .update({ google_sync_token: null, google_channel_id: null, google_resource_id: null })
          .eq('id', dealerId)
        return ok200()
      }

      const eventsJson = await eventsRes.json() as {
        nextSyncToken?: string
        items?: Array<{
          id: string
          status: string
          summary?: string
          start?: { dateTime?: string; date?: string }
          end?:   { dateTime?: string; date?: string }
          description?: string
        }>
      }

      // Rotate the syncToken for the next delivery
      if (eventsJson.nextSyncToken) {
        await supa.from('dealerships')
          .update({ google_sync_token: eventsJson.nextSyncToken })
          .eq('id', dealerId)
      }

      // ── Process changed events ──────────────────────────────────────────
      const items = eventsJson.items ?? []
      console.log(`[gcal-webhook] dealer=${dealerId} changed events=${items.length}`)

      for (const evt of items) {
        if (evt.status === 'cancelled') {
          // Event deleted in Google Calendar — clear google_event_id so we
          // don't try to update/delete a ghost event in future syncs.
          // We do NOT delete the appointment row; the user can review and delete.
          await supa.from('appointments')
            .update({ google_event_id: null })
            .eq('google_event_id', evt.id)
            .eq('dealer_id', dealerId)
        } else {
          // Event updated in Google Calendar — update scheduled_at.
          const scheduledAt = evt.start?.dateTime ?? evt.start?.date
          if (scheduledAt) {
            await supa.from('appointments')
              .update({ scheduled_at: scheduledAt })
              .eq('google_event_id', evt.id)
              .eq('dealer_id', dealerId)
          }
        }
      }

      return ok200()

    } catch (err) {
      // Always return 200 to Google — a non-200 causes it to retry aggressively.
      console.error('[gcal-webhook] ping processing error:', err)
      return ok200()
    }
  }

  // ── POST body: setup action ───────────────────────────────────────────────
  try {
    const body = await req.json() as { action?: string; dealer_id?: string }

    if (body.action !== 'setup' || !body.dealer_id) {
      return jsonErr('action must be "setup" and dealer_id is required')
    }

    const { data: dealer } = await supa
      .from('dealerships')
      .select('google_refresh_token, google_calendar_email, google_channel_id, google_channel_expiry')
      .eq('id', body.dealer_id)
      .single()

    if (!dealer?.google_refresh_token) {
      return jsonErr('Google Calendar not connected for this dealership')
    }

    // Skip if an active channel already exists (expires > 1 hour from now)
    const nowMs = Date.now()
    const expiryMs = Number(dealer.google_channel_expiry ?? 0)
    if (dealer.google_channel_id && expiryMs > nowMs + 60 * 60 * 1000) {
      return json200({ skipped: true, reason: 'Active channel already registered', expiry: expiryMs })
    }

    const accessToken = await getAccessToken(dealer.google_refresh_token as string)
    const calendarId  = (dealer.google_calendar_email as string) || 'primary'

    // ── 1. Full event list to obtain initial syncToken ──────────────────────
    let syncToken:  string | null = null
    let pageToken:  string | undefined

    do {
      const listUrl = new URL(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      )
      listUrl.searchParams.set('maxResults', '250')
      listUrl.searchParams.set('singleEvents', 'true')
      if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

      const listRes  = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const listJson = await listRes.json() as { nextPageToken?: string; nextSyncToken?: string }

      pageToken = listJson.nextPageToken
      if (!pageToken) syncToken = listJson.nextSyncToken ?? null
    } while (pageToken)

    // ── 2. Register push-notification channel ───────────────────────────────
    const channelId  = crypto.randomUUID()
    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar-webhook`

    const watchRes  = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:      channelId,
          type:    'web_hook',
          address: webhookUrl,
          token:   body.dealer_id,   // echoed back as X-Goog-Channel-Token on every ping
        }),
      },
    )
    const watchJson = await watchRes.json() as {
      id?: string; resourceId?: string; expiration?: string; error?: { message: string }
    }

    if (!watchJson.resourceId) {
      console.error('[gcal-webhook] watch registration failed:', watchJson)
      return jsonErr(watchJson.error?.message ?? 'Google watch registration failed', 500)
    }

    // ── 3. Persist channel info + syncToken ─────────────────────────────────
    await supa.from('dealerships').update({
      google_sync_token:     syncToken,
      google_channel_id:     watchJson.id,
      google_resource_id:    watchJson.resourceId,
      google_channel_expiry: Number(watchJson.expiration ?? 0),
    }).eq('id', body.dealer_id)

    console.log('[gcal-webhook] channel registered for dealer', body.dealer_id, 'expires', watchJson.expiration)

    return json200({
      success:    true,
      channel_id: watchJson.id,
      expiry:     watchJson.expiration,
    })

  } catch (err) {
    console.error('[gcal-webhook] setup error:', err)
    return jsonErr((err as Error).message, 500)
  }
})

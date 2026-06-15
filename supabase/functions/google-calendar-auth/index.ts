/**
 * google-calendar-auth
 * ─────────────────────────────────────────────────────────────────────────
 * Handles the Google OAuth 2.0 flow for connecting a dealership's Google
 * Calendar.  Three entry points:
 *
 *   POST { action: 'connect', dealer_id }
 *        → returns { url } — the Google consent screen URL — so the
 *          frontend can redirect the browser (JWT passed via invoke()).
 *
 *   GET  ?code=...&state=...
 *        → OAuth callback from Google: exchange code, store refresh_token,
 *          immediately register push-notification channel, redirect to
 *          dashboard #settings.
 *
 *   POST { action: 'disconnect', dealer_id }
 *        → clear all Google tokens and channel state from dealerships row.
 *
 * Deploy with: supabase functions deploy google-calendar-auth --no-verify-jwt
 *
 * Secrets required:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI   (must match Google Cloud Console exactly)
 *   APP_URL               (e.g. https://app.srisaamba.com)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token'
const GOOGLE_INFO_URL     = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

// ── Shared helpers ────────────────────────────────────────────────────────

function buildGoogleUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(GOOGLE_AUTH_URL)
  u.searchParams.set('client_id',     clientId)
  u.searchParams.set('redirect_uri',  redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope',         SCOPES)
  u.searchParams.set('access_type',   'offline')
  u.searchParams.set('prompt',        'consent')  // forces refresh_token every time
  u.searchParams.set('state',         state)
  return u.toString()
}

async function getAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
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
 * Registers a Google Calendar push-notification channel for the given
 * dealership and stores the resulting state in the dealerships row.
 * Called immediately after the OAuth callback stores the refresh_token.
 */
async function registerWatchChannel(opts: {
  supa:         ReturnType<typeof createClient>
  dealerId:     string
  accessToken:  string
  calendarId:   string
}): Promise<void> {
  const { supa, dealerId, accessToken, calendarId } = opts

  // ── 1. Full event list → obtain initial syncToken ─────────────────────
  let syncToken: string | null = null
  let pageToken: string | undefined

  do {
    const listUrl = new URL(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    )
    listUrl.searchParams.set('maxResults',    '250')
    listUrl.searchParams.set('singleEvents',  'true')
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

    const listRes  = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const listJson = await listRes.json() as { nextPageToken?: string; nextSyncToken?: string }
    pageToken  = listJson.nextPageToken
    if (!pageToken) syncToken = listJson.nextSyncToken ?? null
  } while (pageToken)

  // ── 2. Register push-notification channel ─────────────────────────────
  const channelId  = crypto.randomUUID()
  const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar-webhook`

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
        token:   dealerId,  // echoed back as X-Goog-Channel-Token on every ping
      }),
    },
  )
  const watchJson = await watchRes.json() as {
    id?: string; resourceId?: string; expiration?: string
    error?: { code: number; message: string }
  }

  if (!watchJson.resourceId) {
    // Log but don't throw — we don't want a watch failure to prevent the user
    // from connecting. The frontend will retry setup next time Settings loads.
    console.error('[gcal-auth] watch registration failed:', JSON.stringify(watchJson))
    return
  }

  // ── 3. Persist channel state + syncToken ──────────────────────────────
  await supa.from('dealerships').update({
    google_sync_token:     syncToken,
    google_channel_id:     watchJson.id,
    google_resource_id:    watchJson.resourceId,
    google_channel_expiry: Number(watchJson.expiration ?? 0),
  }).eq('id', dealerId)

  console.log(
    '[gcal-auth] push channel registered — dealer:', dealerId,
    'channel:', watchJson.id,
    'expires:', watchJson.expiration,
  )
}

// ── Request handler ───────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS })

  const url           = new URL(req.url)
  const clientId      = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret  = Deno.env.get('GOOGLE_CLIENT_SECRET')!
  const redirectUri   = Deno.env.get('GOOGLE_REDIRECT_URI')!
  const appUrl        = Deno.env.get('APP_URL') ?? 'https://app.srisaamba.com'

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── POST { action: 'connect' }  →  return Google OAuth URL ───────────
  // ── POST { action: 'disconnect' }  →  clear all tokens ───────────────
  if (req.method === 'POST') {
    try {
      const body = await req.json() as { action?: string; dealer_id?: string }

      if (body.action === 'connect') {
        if (!body.dealer_id) {
          return new Response('Missing dealer_id', { status: 400, headers: CORS })
        }
        const state = btoa(JSON.stringify({ dealer_id: body.dealer_id, ts: Date.now() }))
        return new Response(
          JSON.stringify({ url: buildGoogleUrl(clientId, redirectUri, state) }),
          { headers: { ...CORS, 'Content-Type': 'application/json' } },
        )
      }

      if (body.action === 'disconnect') {
        if (!body.dealer_id) {
          return new Response('Missing dealer_id', { status: 400, headers: CORS })
        }
        await supa.from('dealerships').update({
          google_calendar_connected: false,
          google_calendar_email:     null,
          google_refresh_token:      null,
          google_sync_token:         null,
          google_channel_id:         null,
          google_resource_id:        null,
          google_channel_expiry:     null,
        }).eq('id', body.dealer_id)

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...CORS, 'Content-Type': 'application/json' } },
        )
      }

      return new Response('Bad request', { status: 400, headers: CORS })

    } catch (err) {
      console.error('[gcal-auth] POST error:', err)
      return new Response(
        JSON.stringify({ error: (err as Error).message }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }
  }

  // ── GET ?code=...&state=...  →  OAuth callback from Google ────────────
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (url.searchParams.get('error') || !code || !state) {
    console.error('[gcal-auth] OAuth error or missing params:', url.searchParams.toString())
    return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)
  }

  try {
    const { dealer_id } = JSON.parse(atob(state)) as { dealer_id: string; ts: number }

    // ── 1. Exchange auth code for tokens ──────────────────────────────────
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    })
    const tokens = await tokenRes.json() as {
      access_token?:  string
      refresh_token?: string
      error?:         string
    }

    if (!tokens.refresh_token) {
      console.error('[gcal-auth] no refresh_token in response:', tokens)
      return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)
    }

    // ── 2. Fetch the connected Google account's email ─────────────────────
    const infoRes = await fetch(GOOGLE_INFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const info = await infoRes.json() as { email?: string }

    // ── 3. Persist OAuth credentials ─────────────────────────────────────
    await supa.from('dealerships').update({
      google_calendar_connected: true,
      google_calendar_email:     info.email ?? null,
      google_refresh_token:      tokens.refresh_token,
    }).eq('id', dealer_id)

    console.log('[gcal-auth] OAuth complete for dealer:', dealer_id, 'email:', info.email)

    // ── 4. Immediately register push-notification channel ─────────────────
    // Uses the access_token we already have — no extra round-trip needed.
    // Failure here is non-fatal: the frontend's loadGoogleCalendarStatus will
    // retry on next Settings page load.
    const calendarId = info.email ?? 'primary'
    await registerWatchChannel({
      supa,
      dealerId:    dealer_id,
      accessToken: tokens.access_token!,
      calendarId,
    })

    return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)

  } catch (err) {
    console.error('[gcal-auth] callback error:', err)
    return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)
  }
})

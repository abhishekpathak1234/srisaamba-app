/**
 * google-calendar-auth
 * ─────────────────────────────────────────────────────────────────────────
 * Handles the Google OAuth 2.0 flow for connecting a dealership's Google
 * Calendar.  Three entry points:
 *
 *   GET  ?action=connect&dealer_id=<uuid>
 *        → 302 redirect to Google consent screen
 *
 *   GET  ?code=<auth_code>&state=<b64_dealer_id>
 *        → exchange code, store refresh_token, redirect to dashboard #settings
 *
 *   POST { action: 'disconnect', dealer_id: <uuid> }
 *        → clear tokens from dealerships row
 *
 * Secrets required:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI   (must match Google Cloud Console exactly)
 *   APP_URL               (e.g. https://app.srisaamba.com)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_INFO_URL  = 'https://www.googleapis.com/oauth2/v2/userinfo'

// calendar.events scope — limited, only manages events (not full calendar admin)
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS })

  const url          = new URL(req.url)
  const clientId     = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!
  const redirectUri  = Deno.env.get('GOOGLE_REDIRECT_URI')!
  const appUrl       = Deno.env.get('APP_URL') ?? 'https://app.srisaamba.com'

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── GET ?action=connect  →  redirect to Google consent ────────────────
  if (req.method === 'GET' && url.searchParams.get('action') === 'connect') {
    const dealerId = url.searchParams.get('dealer_id')
    if (!dealerId) return new Response('Missing dealer_id', { status: 400 })

    const state     = btoa(JSON.stringify({ dealer_id: dealerId, ts: Date.now() }))
    const googleUrl = new URL(GOOGLE_AUTH_URL)
    googleUrl.searchParams.set('client_id',     clientId)
    googleUrl.searchParams.set('redirect_uri',  redirectUri)
    googleUrl.searchParams.set('response_type', 'code')
    googleUrl.searchParams.set('scope',         SCOPES)
    googleUrl.searchParams.set('access_type',   'offline')
    googleUrl.searchParams.set('prompt',        'consent')   // force refresh_token
    googleUrl.searchParams.set('state',         state)

    return Response.redirect(googleUrl.toString(), 302)
  }

  // ── POST { action: 'connect', dealer_id }  →  return Google OAuth URL ──
  // Allows supa.functions.invoke() to pass JWT, then frontend redirects to URL.
  // ── POST { action: 'disconnect', dealer_id }  →  clear tokens ────────
  if (req.method === 'POST') {
    try {
      const body = await req.json() as { action?: string; dealer_id?: string }

      if (body.action === 'connect') {
        if (!body.dealer_id) return new Response('Missing dealer_id', { status: 400 })
        const state     = btoa(JSON.stringify({ dealer_id: body.dealer_id, ts: Date.now() }))
        const googleUrl = new URL(GOOGLE_AUTH_URL)
        googleUrl.searchParams.set('client_id',     clientId)
        googleUrl.searchParams.set('redirect_uri',  redirectUri)
        googleUrl.searchParams.set('response_type', 'code')
        googleUrl.searchParams.set('scope',         SCOPES)
        googleUrl.searchParams.set('access_type',   'offline')
        googleUrl.searchParams.set('prompt',        'consent')
        googleUrl.searchParams.set('state',         state)
        return new Response(JSON.stringify({ url: googleUrl.toString() }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }

      if (body.action !== 'disconnect' || !body.dealer_id) {
        return new Response('Bad request', { status: 400 })
      }

      await supa
        .from('dealerships')
        .update({
          google_calendar_connected: false,
          google_calendar_email:     null,
          google_refresh_token:      null,
        })
        .eq('id', body.dealer_id)

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }
  }

  // ── GET ?code=...&state=...  →  OAuth callback from Google ────────────
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (url.searchParams.get('error') || !code || !state) {
    console.error('[google-calendar-auth] OAuth error or missing params', url.searchParams.toString())
    return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)
  }

  try {
    // Decode state → dealer_id
    const { dealer_id } = JSON.parse(atob(state)) as { dealer_id: string; ts: number }

    // Exchange auth code for tokens
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
      // This happens when prompt=consent was not respected or the app is already
      // authorized without offline access.  Log and redirect — user can reconnect.
      console.error('[google-calendar-auth] No refresh_token in response:', tokens)
      return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)
    }

    // Fetch the connected Google account's email
    const infoRes = await fetch(GOOGLE_INFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const info = await infoRes.json() as { email?: string }

    // Persist to dealerships
    await supa
      .from('dealerships')
      .update({
        google_calendar_connected: true,
        google_calendar_email:     info.email ?? null,
        google_refresh_token:      tokens.refresh_token,
      })
      .eq('id', dealer_id)

    return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)

  } catch (err) {
    console.error('[google-calendar-auth] callback error:', err)
    return Response.redirect(`${appUrl}/dashboard.html#settings`, 302)
  }
})

/* AutoClient (Sri Saamba AI) — shared Supabase client + auth helpers.
   Load AFTER the supabase-js CDN script on every page:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="app.js"></script>
*/

const SUPABASE_URL = 'https://owrphdyzqzfigovpysaj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_kxonlIAygw7FNq7vzdCLuA_6X_nGeM8';

const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

async function getSession() {
  const { data: { session } } = await supa.auth.getSession();
  return session;
}

// Post-auth routing: every signed-in user goes straight to the dashboard.
// (Onboarding flow removed — no membership checks, no onboarding redirect.)
async function routeAfterAuth() {
  window.location.replace('dashboard.html');
}

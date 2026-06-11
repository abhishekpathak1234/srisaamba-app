/* AutoClient (Sri Saamba AI) — shared Supabase client + tenancy helpers.
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

// Oldest membership for the signed-in user, or null. RLS guarantees a
// user can only ever see their own membership rows.
async function getMembership() {
  const { data, error } = await supa
    .from('dealership_members')
    .select('dealership_id, role')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return error ? null : data;
}

// Capture ?invite=TOKEN from the URL so it survives redirects and the
// Google OAuth round-trip. Returns the remembered token, if any.
function rememberInviteToken() {
  const t = new URLSearchParams(window.location.search).get('invite');
  if (t) localStorage.setItem('autoclient_invite_token', t);
  return localStorage.getItem('autoclient_invite_token');
}

function clearInviteToken() {
  localStorage.removeItem('autoclient_invite_token');
}

/* Post-auth routing, used by login.html (password and Google):
     1. Existing membership            → dashboard.html
     2. Valid invitation (token/email) → join dealership → dashboard.html
     3. No membership                  → onboarding.html               */
async function routeAfterAuth() {
  if (await getMembership()) {
    clearInviteToken();
    window.location.replace('dashboard.html');
    return;
  }

  const token = rememberInviteToken();
  if (token) {
    const { error } = await supa.rpc('accept_invitation', { p_token: token });
    clearInviteToken(); // one shot — drop it whether it worked or not
    if (!error) {
      window.location.replace('dashboard.html');
      return;
    }
  }

  // No explicit token — accept any pending invitation sent to this email
  const { data: joined } = await supa.rpc('claim_pending_invitations');
  if (joined) {
    window.location.replace('dashboard.html');
    return;
  }

  window.location.replace('onboarding.html');
}

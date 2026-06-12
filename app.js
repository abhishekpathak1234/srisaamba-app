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

// Dealership KPIs for the signed-in tenant. Every query is RLS-scoped to
// the user's own dealer_id. dealership_metrics holds running aggregates;
// the live counts come from call_logs / appointments / tasks.
async function fetchDealerMetrics() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const month = monthStart.toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [metrics, callsMonth, apptsMonth, afterHoursMonth, afterHoursWeek, recoveredWeek, urgentOpen] = await Promise.all([
    supa.from('dealership_metrics').select('*').maybeSingle(),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('call_status', 'answered').gte('created_at', month),
    supa.from('appointments').select('id', { count: 'exact', head: true })
      .gte('created_at', month),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('call_type', 'after_hours').gte('created_at', month),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('call_type', 'after_hours').gte('created_at', weekAgo),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('call_status', 'recovered').gte('created_at', weekAgo),
    supa.from('tasks').select('id', { count: 'exact', head: true })
      .eq('status', 'open').in('priority', ['urgent', 'high']),
  ]);

  const m = metrics.data || {};
  const callsAnswered = m.calls_answered || callsMonth.count || 0;
  const appointmentsBooked = m.appointments_booked || apptsMonth.count || 0;

  return {
    callsAnswered,
    appointmentsBooked,
    urgentCallbacks: urgentOpen.count || 0,
    revenueProtected: Number(m.revenue_protected || 0),
    missedCallsRecovered: m.missed_calls_recovered || 0,
    afterHoursMonth: afterHoursMonth.count || 0,
    afterHoursWeek: afterHoursWeek.count || 0,
    recoveredWeek: recoveredWeek.count || 0,
    bookingRate: callsAnswered ? Math.round((appointmentsBooked / callsAnswered) * 100) : 0,
  };
}

/* AutoClient (Sri Saamba AI) — shared Supabase client, auth helpers, and
   dashboard data loading.
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

async function routeAfterAuth() {
  window.location.replace('dashboard.html');
}

/* ── Dealership KPIs ───────────────────────────────────────────── */
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

/* ── Dashboard live data ───────────────────────────────────────── */
const escHtml = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const custName = c => c ? escHtml(((c.first_name || '') + ' ' + (c.last_name || '')).trim() || 'Unknown') : 'Unknown';
const fmtTime = ts => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtDay  = ts => new Date(ts).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
const agoText = ts => {
  const m = Math.max(1, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' hr ago';
  return Math.round(h / 24) + ' d ago';
};

const APPT_PILL = {
  confirmed: '<span class="badge-pill t-green">● Confirmed</span>',
  pending:   '<span class="badge-pill t-amber">◌ Pending</span>',
  requested: '<span class="badge-pill t-blue">↩ Requested</span>',
  completed: '<span class="badge-pill t-green">✓ Completed</span>',
  cancelled: '<span class="badge-pill t-red">✕ Cancelled</span>',
};
const TASK_TAG = {
  escalation:   '<span class="tag t-red">🚨 Urgent</span>',
  hot_lead:     '<span class="tag t-orange">Hot lead</span>',
  follow_up:    '<span class="tag t-amber">Follow-up</span>',
  confirmation: '<span class="tag t-green">Confirm</span>',
};

function setKpi(id, val, prefix) {
  const el = document.getElementById(id);
  if (!el || val == null) return;
  el.dataset.count = Math.round(Number(val));
  if (prefix) el.dataset.prefix = prefix;
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

window.loadLiveData = async function (dealerId) {
  let { data: metricsRow, error: mErr } = await supa.from('dealership_metrics').select('*').maybeSingle();
  if (mErr) throw mErr;
  if (!metricsRow) {
    await supa.rpc('seed_demo_data');
    ({ data: metricsRow } = await supa.from('dealership_metrics').select('*').maybeSingle());
  }

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400000);

  const [callsToday, todays, allAppts, openTasks, recentCalls, dm] = await Promise.all([
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('call_status', 'answered').gte('created_at', dayStart.toISOString()),
    supa.from('appointments').select('*, customers(first_name,last_name,phone,lead_source)')
      .gte('scheduled_at', dayStart.toISOString()).lt('scheduled_at', dayEnd.toISOString())
      .order('scheduled_at'),
    supa.from('appointments').select('*, customers(first_name,last_name,phone,lead_source)')
      .order('scheduled_at', { ascending: false }).limit(25),
    supa.from('tasks').select('*, customers(first_name,last_name,phone)')
      .eq('status', 'open').order('created_at', { ascending: false }),
    supa.from('call_logs').select('*').order('created_at', { ascending: false }).limit(6),
    fetchDealerMetrics(),
  ]);

  const tasks = openTasks.data || [];

  // Daily digest
  setText('digest-title', "Today's Digest — " + fmtDay(Date.now()));
  setText('digest-date', 'Updated ' + fmtTime(Date.now()));
  setText('digest-calls', callsToday.count ?? 0);
  setText('digest-appts', (todays.data || []).length);
  setText('digest-callbacks', dm.urgentCallbacks);
  setText('digest-angry', tasks.filter(t => t.task_type === 'escalation').length);
  setText('digest-revenue', '$' + dm.revenueProtected.toLocaleString());

  // KPI cards
  setKpi('kpi-missed', dm.missedCallsRecovered);
  setKpi('kpi-revenue', dm.revenueProtected, '$');
  setKpi('kpi-afterhours', dm.afterHoursWeek);
  if (typeof animateCounters === 'function') animateCounters();

  // Sidebar badges
  setText('badge-actions', tasks.length);
  setText('badge-missed', dm.recoveredWeek);

  // Hot lead banner
  const hot = tasks.find(t => t.priority === 'urgent');
  const banner = document.getElementById('hot-banner');
  if (banner) {
    if (hot) {
      banner.style.display = 'flex';
      setText('hot-text', '🔥 ' + hot.title);
      setText('hot-sub', hot.description || '');
    } else {
      banner.style.display = 'none';
    }
  }

  // Today's test drives + all bookings
  const apptRow = (a, withRef) => {
    const c = a.customers;
    const when = withRef
      ? fmtDay(a.scheduled_at) + ' · ' + fmtTime(a.scheduled_at)
      : fmtTime(a.scheduled_at);
    return '<tr>'
      + (withRef ? '<td class="td-ref">AC-' + escHtml(String(a.id).slice(0, 4).toUpperCase()) + '</td>' : '')
      + '<td><div class="td-name">' + custName(c) + '</div><div class="td-vehicle">' + escHtml((c && c.phone) || '') + '</div></td>'
      + '<td>' + escHtml(a.vehicle || a.appointment_type.replace(/_/g, ' ')) + '</td>'
      + '<td class="td-time">' + when + '</td>'
      + '<td>' + (APPT_PILL[a.status] || escHtml(a.status)) + '</td>'
      + (withRef ? '<td><span class="tag t-blue">' + escHtml((c && c.lead_source) || '—') + '</span></td>' : '')
      + '</tr>';
  };
  if (todays.data) {
    document.getElementById('todays-bookings-body').innerHTML =
      todays.data.length
        ? todays.data.map(a => apptRow(a, false)).join('')
        : '<tr><td colspan="4" class="empty">No test drives scheduled today</td></tr>';
  }
  if (allAppts.data) {
    document.getElementById('all-bookings-body').innerHTML =
      allAppts.data.length
        ? allAppts.data.map(a => apptRow(a, true)).join('')
        : '<tr><td colspan="6" class="empty">No bookings yet</td></tr>';
  }

  // Action Center
  setText('ac-title', 'Action Center — ' + fmtDay(Date.now()) + ' · ' + tasks.length + ' actions waiting');
  if (typeof pages !== 'undefined') pages.todo.sub = tasks.length + ' actions waiting';
  const taskCard = t =>
    '<div class="todo-item">'
    + '<div class="ti-name">' + escHtml(t.title) + '</div>'
    + '<div class="ti-desc">' + escHtml(t.description || '') + '</div>'
    + (TASK_TAG[t.task_type] || '')
    + '</div>';
  const renderCol = (itemsId, countId, list) => {
    const wrap = document.getElementById(itemsId);
    if (!wrap) return;
    wrap.innerHTML = list.length ? list.map(taskCard).join('') : '<div class="empty">Nothing waiting</div>';
    setText(countId, list.length);
  };
  renderCol('ac-callback-items', 'ac-callback-count', tasks.filter(t => t.task_type === 'hot_lead' || t.task_type === 'escalation'));
  renderCol('ac-textback-items', 'ac-textback-count', tasks.filter(t => t.task_type === 'follow_up'));
  renderCol('ac-confirm-items', 'ac-confirm-count', tasks.filter(t => t.task_type === 'confirmation'));

  // Live activity feed
  const events = [];
  (recentCalls.data || []).forEach(c => events.push({
    ts: c.created_at,
    color: c.call_status === 'recovered' ? 'var(--orange)'
         : (c.call_status === 'missed' || c.call_status === 'escalated') ? 'var(--red)'
         : 'var(--blue)',
    html: '<strong>' + escHtml(c.customer_name || 'Unknown caller') + '</strong> — '
      + (c.call_type === 'after_hours' ? 'after-hours call ' : 'call ') + escHtml(c.call_status),
  }));
  (allAppts.data || []).slice(0, 5).forEach(a => events.push({
    ts: a.created_at,
    color: 'var(--green)',
    html: '<strong>' + custName(a.customers) + '</strong> booked ' + escHtml(a.appointment_type.replace(/_/g, ' '))
      + ' — ' + fmtTime(a.scheduled_at) + (a.vehicle ? ' · ' + escHtml(a.vehicle) : ''),
  }));
  tasks.slice(0, 4).forEach(t => events.push({
    ts: t.created_at,
    color: t.task_type === 'escalation' ? 'var(--red)' : 'var(--amber)',
    html: '<strong>' + escHtml(t.title) + '</strong>'
      + (t.task_type === 'escalation' ? ' <span class="escalation-tag">🚨 Needs callback</span>' : ''),
  }));
  events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const feed = document.getElementById('activity-feed');
  if (feed && events.length) {
    feed.innerHTML = events.slice(0, 7).map(e =>
      '<div class="activity-item"><div class="ai-dot" style="background:' + e.color + '"></div>'
      + '<div><div class="ai-text">' + e.html + '</div><div class="ai-ago">' + agoText(e.ts) + '</div></div></div>'
    ).join('');
  } else if (feed) {
    feed.innerHTML = '<div class="empty">No recent account activity logs</div>';
  }

  // Monthly performance view wiring
  setText('month-calls', dm.callsAnswered);
  setText('month-missed', dm.missedCallsRecovered);
  setText('month-booked', dm.appointmentsBooked);
  setText('month-afterhours', dm.afterHoursMonth);
  
  setText('perf-calls', dm.callsAnswered);
  setText('perf-bookrate', dm.bookingRate + '%');
  setText('perf-bookrate-sub', dm.appointmentsBooked + ' of ' + dm.callsAnswered + ' calls → test drive');
  setText('perf-revenue-total', '$' + dm.revenueProtected.toLocaleString() + ' total');
  
  setText('rb-recovered', dm.recoveredWeek);
  setText('rb-afterhours', dm.afterHoursWeek);
  setText('rb-revenue', '$' + (dm.recoveredWeek * 540).toLocaleString());
  setText('bookings-month-count', dm.appointmentsBooked + ' this month');

  // Dynamic layout adjustment: Hide vector path metrics graph lines if metrics evaluate to zero
  const revenueChartPath = document.querySelector('.chart-svg path:nth-child(2)');
  const revenueChartFill = document.querySelector('.chart-svg path:nth-child(1)');
  if (dm.callsAnswered === 0 && revenueChartPath && revenueChartFill) {
    revenueChartPath.style.display = 'none';
    revenueChartFill.style.display = 'none';
  } else if (revenueChartPath && revenueChartFill) {
    revenueChartPath.style.display = 'block';
    revenueChartFill.style.display = 'block';
  }
};

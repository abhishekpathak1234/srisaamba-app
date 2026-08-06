/* AutoClient (Sri Saamba AI) — shared Supabase client, auth helpers, and
   dashboard data loading.
   Load AFTER the supabase-js CDN script on every page:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="app.js"></script>
*/

const SUPABASE_URL = 'https://owrphdyzqzfigovpysaj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_kxonlIAygw7FNq7vzdCLuA_6X_nGeM8';

const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

/* ── Route Registry ────────────────────────────────────────────────────
   Single source of truth for all SPA navigation.
   Key  = URL hash slug.  pageId = DOM section suffix (page-{pageId}).  */
const ROUTES = {
  'dashboard':      { pageId: 'dashboard',      title: 'Dashboard',              sub: '' },
  'today-activity': { pageId: 'today-activity', title: "Today's Activity",       sub: 'All appointments scheduled today' },
  'calendar':       { pageId: 'calendar',       title: 'Calendar',               sub: 'Appointment schedule' },
  'smart-inbox':    { pageId: 'inbox',          title: 'Smart Inbox',            sub: 'Active accounts structure' },
  'action-center':  { pageId: 'todo',           title: 'Action Center',          sub: 'Actions tracking queue' },
  'test-drives':    { pageId: 'bookings',       title: 'Test Drive Bookings',    sub: 'Complete booking ledger' },
  'missed-calls':   { pageId: 'missed',         title: 'Missed Calls Recovered', sub: 'Recovery system analytics' },
  'performance':    { pageId: 'performance',    title: 'Performance',            sub: 'Account diagnostics engine' },
  'settings':       { pageId: 'settings',       title: 'Settings',               sub: 'Dealer profile & account' },
  'profile':        { pageId: 'profile',        title: 'Profile',                sub: 'Your account details' },
  // 'agents':         { pageId: 'agents',         title: 'Agents',           sub: '' },
  // 'billing':        { pageId: 'billing',         title: 'Billing',          sub: '' },
  // 'integrations':   { pageId: 'integrations',    title: 'Integrations',     sub: '' },
  // 'team-members':   { pageId: 'team-members',    title: 'Team Members',     sub: '' },
  // 'ai-preferences': { pageId: 'ai-preferences',  title: 'AI Preferences',   sub: '' },
};

async function getSession() {
  const { data: { session } } = await supa.auth.getSession();
  return session;
}

async function routeAfterAuth() {
  window.location.replace('dashboard.html');
}

/* ── Dealership KPIs (Explicitly scoped via dealerId) ─────────────────── */
async function fetchDealerMetrics(dealerId) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const month = monthStart.toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  // Every single metric query is explicitly scoped to avoid RLS drift leaks
  const [metrics, callsMonth, apptsMonth, afterHoursMonth, afterHoursWeek, recoveredWeek, urgentOpen] = await Promise.all([
    supa.from('dealership_metrics').select('*').eq('dealer_id', dealerId).maybeSingle(),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).eq('call_status', 'answered').gte('created_at', month),
    supa.from('appointments').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).gte('created_at', month),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).eq('call_type', 'after_hours').gte('created_at', month),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).eq('call_type', 'after_hours').gte('created_at', weekAgo),
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).eq('call_status', 'recovered').gte('created_at', weekAgo),
    supa.from('tasks').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).eq('status', 'open').in('priority', ['urgent', 'high']),
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

function setKpi(id, val, prefix) {
  const el = document.getElementById(id);
  if (!el || val == null) return;

  const num = Math.round(Number(val));
  el.dataset.count = num;

  if (prefix) {
    el.dataset.prefix = prefix;
  }

  el.textContent = (prefix || '') + num.toLocaleString();
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

window.loadLiveData = async function (dealerId) {
  // CRITICAL SECURITY IMPROVEMENT: seed_demo_data RPC trigger completely removed from the runtime query loop
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400000);

  const [callsToday, todays, allAppts, openTasks, recentCalls, dm, upcomingTD] = await Promise.all([
    supa.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).eq('call_status', 'answered').gte('created_at', dayStart.toISOString()),
    supa.from('appointments').select('*, customers(first_name,last_name,phone,lead_source)')
      .eq('dealer_id', dealerId).gte('scheduled_at', dayStart.toISOString()).lt('scheduled_at', dayEnd.toISOString())
      .order('scheduled_at'),
    supa.from('appointments').select('*, customers(first_name,last_name,phone,lead_source)')
      .eq('dealer_id', dealerId).order('scheduled_at', { ascending: false }).limit(25),
    supa.from('tasks').select('*, customers(first_name,last_name,phone)')
      .eq('dealer_id', dealerId).eq('status', 'open').order('created_at', { ascending: false }),
    supa.from('call_logs').select('*').eq('dealer_id', dealerId).order('created_at', { ascending: false }).limit(6),
    fetchDealerMetrics(dealerId),
    supa.from('appointments').select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId).eq('appointment_type', 'test_drive').gte('scheduled_at', dayStart.toISOString()),
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

  // Recovery banner data populations (Weekly Scope Alignment)
  setText('rb-recovered', dm.recoveredWeek);
  setText('rb-afterhours', dm.afterHoursWeek);
  setText('rb-revenue', '$' + dm.revenueProtected.toLocaleString());

  // Sidebar badges
  setText('badge-actions', tasks.length);
  setText('badge-missed', dm.recoveredWeek);
  setText('badge-test-drives', upcomingTD.count ?? 0);

  // Derive live KPI values from today's calendar data
  const tdToday     = (todays.data || []).filter(a => a.appointment_type === 'test_drive');
  const confirmedTD = tdToday.filter(a => a.status === 'confirmed');
  const liveRevenue = confirmedTD.length > 0 ? confirmedTD.length * 540 : dm.revenueProtected;

  // KPI overrides — already called above for missed/afterhours; patch revenue + test-drives
  setKpi('kpi-revenue',   liveRevenue, '$');
  setKpi('kpi-afterhours', tdToday.length);

  // Store today's full set globally so the View All page can read it without a re-fetch
  window._todayAppts = todays.data || [];

  // Today's Activity + all bookings table loops
  const apptRow = (a, withRef) => {
    const name  = a.customer_name || custName(a.customers);
    const phone = a.customer_phone || a.customers?.phone || '';
    const veh   = a.vehicle || '';
    const typ   = a.appointment_type ? a.appointment_type.replace(/_/g, ' ') : '';
    const vehicleCell = veh
      ? escHtml(veh) + '<div class="td-vehicle">' + escHtml(typ) + '</div>'
      : escHtml(typ);
    const when  = withRef ? fmtDay(a.scheduled_at) + ' · ' + fmtTime(a.scheduled_at) : fmtTime(a.scheduled_at);
    return '<tr>'
      + (withRef ? '<td class="td-ref">AC-' + escHtml(String(a.id).slice(0, 4).toUpperCase()) + '</td>' : '')
      + '<td><div class="td-name">' + escHtml(name) + '</div>'
        + (phone ? '<div class="td-phone">' + escHtml(phone) + '</div>' : '')
        + '</td>'
      + '<td>' + vehicleCell + '</td>'
      + '<td class="td-time">' + when + '</td>'
      + '<td>' + (APPT_PILL[a.status] || escHtml(a.status)) + '</td>'
      + '</tr>';
  };

  if (todays.data) {
    document.getElementById('todays-bookings-body').innerHTML = window._todayAppts.length
        ? window._todayAppts.map(a => apptRow(a, false)).join('')
        : '<tr><td colspan="4"><div class="db-empty"><span class="db-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4M8 2v4M3 10h5"/><path d="m17.5 17.5-1.5-1.25V14"/><circle cx="16" cy="16" r="6"/></svg><span class="sparkle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg></span></span><p class="db-empty-title">Your AI assistant hasn\'t scheduled any appointments today.</p><p class="db-empty-sub">Bookings will automatically appear here in real time.</p></div></td></tr>';
  }
  if (allAppts.data) {
    document.getElementById('all-bookings-body').innerHTML = allAppts.data.length
        ? allAppts.data.map(a => apptRow(a, true)).join('')
        : '<tr><td colspan="5" class="empty">No bookings yet</td></tr>';
  }

  // Action Center rendering scopes
  const taskCard = t => `<div class="todo-item"><div class="ti-name">${escHtml(t.title)}</div><div class="ti-desc">${escHtml(t.description || '')}</div></div>`;
  const renderCol = (itemsId, countId, list) => {
    const wrap = document.getElementById(itemsId);
    if (!wrap) return;
    wrap.innerHTML = list.length ? list.map(taskCard).join('') : '<div class="empty">Nothing waiting</div>';
    setText(countId, list.length);
  };
  renderCol('ac-callback-items', 'ac-callback-count', tasks.filter(t => t.task_type === 'hot_lead' || t.task_type === 'escalation'));
  renderCol('ac-textback-items', 'ac-textback-count', tasks.filter(t => t.task_type === 'follow_up'));
  renderCol('ac-confirm-items', 'ac-confirm-count', tasks.filter(t => t.task_type === 'confirmation'));

  // Activity log processing
  const feed = document.getElementById('activity-feed');
  if (feed) {
    feed.innerHTML = '<div class="db-empty compact"><span class="db-empty-icon sm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/><circle cx="12" cy="12" r="1"/></svg></span><p class="db-empty-title">No recent AI events</p><p class="db-empty-sub narrow">Your dealership is running smoothly. Calls, replies and bookings stream here as they happen.</p></div>';
  }

  // Monthly views calculations
  setText('month-calls', dm.callsAnswered);
  setText('month-missed', dm.missedCallsRecovered);
  setText('month-booked', dm.appointmentsBooked);
  setText('month-afterhours', dm.afterHoursMonth);
  setText('perf-calls', dm.callsAnswered);
  setText('perf-bookrate', dm.bookingRate + '%');
  setText('perf-bookrate-sub', dm.appointmentsBooked + ' of ' + dm.callsAnswered + ' calls → test drive');
  setText('perf-revenue-total', '$' + dm.revenueProtected.toLocaleString() + ' total');

  // Dynamically switch charts visibility off on empty dashboards
  const revenueChartPath = document.querySelector('.chart-svg path:nth-child(2)');
  const revenueChartFill = document.querySelector('.chart-svg path:nth-child(1)');
  if (dm.callsAnswered === 0 && revenueChartPath && revenueChartFill) {
    revenueChartPath.style.display = 'none';
    revenueChartFill.style.display = 'none';
  } else if (revenueChartPath && revenueChartFill) {
    revenueChartPath.style.display = 'block';
    revenueChartFill.style.display = 'block';
  }

  // Pre-fill dealer profile form fields from current dealership record
  const d = window.currentDealership;
  if (d) {
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('dp-name',     d.name);
    setVal('dp-tagline',  d.tagline);
    setVal('dp-email',    d.contact_email);
    setVal('dp-street',   d.street_address);
    setVal('dp-city',     d.city);
    setVal('dp-state',    d.state);
    setVal('dp-zip',      d.zip_code);
    setVal('dp-country',  d.country);
    setVal('dp-timezone', d.timezone);
  }
};

/* ── Profile page population (read-only, no new DB queries beyond session) ── */
async function loadProfilePage() {
  const d = window.currentDealership;
  if (d) {
    setText('prof-dealer',        d.name          || '—');
    setText('prof-tagline',       d.tagline        || '—');
    setText('prof-contact-email', d.contact_email  || '—');
    setText('prof-street',        d.street_address || '—');
    setText('prof-city',          d.city           || '—');
    setText('prof-state',         d.state          || '—');
    setText('prof-zip',           d.zip_code       || '—');
    setText('prof-country',       d.country        || '—');
    setText('prof-timezone',      d.timezone       || '—');
  }
  const session = await getSession();
  if (session?.user) {
    setText('prof-email', session.user.email || '—');
    const raw = session.user.created_at;
    setText('prof-created', raw
      ? new Date(raw).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—');
    const lastLogin = session.user.last_sign_in_at;
    setText('prof-last-login', lastLogin
      ? new Date(lastLogin).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '—');
  }
}

function toggleEditProfile() {
  const note = document.getElementById('prof-edit-note');
  if (note) note.style.display = note.style.display === 'none' ? 'block' : 'none';
}

async function handleSecurePasswordChange() {
  const currentPassword = document.getElementById('pw-current')?.value || '';
  const newPassword     = document.getElementById('pw-new')?.value     || '';
  const confirmPassword = document.getElementById('pw-confirm')?.value || '';
  const btn    = document.getElementById('pw-save-btn');
  const status = document.getElementById('pw-status');

  const setStatus = (msg, type) => {
    if (status) { status.textContent = msg; status.className = 'form-status' + (type ? ' ' + type : ''); }
  };

  setStatus('', '');

  if (newPassword.length < 8) {
    setStatus('New password must be at least 8 characters.', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    setStatus('New passwords do not match.', 'error');
    return;
  }

  const session = await getSession();
  if (!session?.user?.email) {
    setStatus('Session expired. Please sign in again.', 'error');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

  const { error: verifyErr } = await supa.auth.signInWithPassword({
    email: session.user.email,
    password: currentPassword,
  });

  if (verifyErr) {
    setStatus('Current password is incorrect.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
    return;
  }

  if (btn) btn.textContent = 'Updating…';

  const { error: updateErr } = await supa.auth.updateUser({ password: newPassword });

  if (updateErr) {
    setStatus('Update failed: ' + updateErr.message, 'error');
  } else {
    setStatus('Password updated successfully.', 'success');
    ['pw-current', 'pw-new', 'pw-confirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    setTimeout(() => {
      if (typeof togglePwForm === 'function') {
        const expand = document.getElementById('pw-expand');
        if (expand && expand.style.display !== 'none') togglePwForm();
      }
    }, 1500);
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
}

/* ── Dealer Profile update (strictly scoped to currentDealership.id) ── */
async function saveDealerProfile() {
  const id = window.currentDealership?.id;
  if (!id) return;

  const btn    = document.getElementById('dp-save-btn');
  const status = document.getElementById('dp-status');
  if (btn)    { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (status) { status.textContent = ''; status.className = 'form-status'; }

  const getVal = elId => (document.getElementById(elId)?.value || '').trim();

  const payload = {
    name:           getVal('dp-name'),
    tagline:        getVal('dp-tagline'),
    contact_email:  getVal('dp-email'),
    street_address: getVal('dp-street'),
    city:           getVal('dp-city'),
    state:          getVal('dp-state'),
    zip_code:       getVal('dp-zip'),
    country:        getVal('dp-country'),
    timezone:       getVal('dp-timezone'),
  };

  const { error } = await supa
    .from('dealerships')
    .update(payload)
    .eq('id', id);

  if (error) {
    if (status) { status.textContent = 'Save failed: ' + error.message; status.className = 'form-status error'; }
  } else {
    Object.assign(window.currentDealership, payload);
    setText('sb-dealer-name', payload.name || window.currentDealership.name);
    if (status) { status.textContent = 'Profile saved successfully.'; status.className = 'form-status success'; }
    setTimeout(() => { if (typeof closeDpForm === 'function') closeDpForm(); }, 1200);
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Save Profile'; }
}

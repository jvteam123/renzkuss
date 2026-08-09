/* ============================================================================
   PaddleStack Admin — /admin

   A separate, static, admin-only page that talks to the same Supabase
   project as the main app. It never trusts itself to gate access: every
   admin action goes through an `admin_*` RPC (see supabase-schema.sql) that
   re-checks is_admin() server-side. The worst a compromised or tampered copy
   of this file can do is make failed requests — Postgres is the real guard.

   NOTE: SUPABASE_URL / SUPABASE_ANON_KEY must match the ones in ../script.js
   (same project, same anon key — it's the same site, just a different page).
   ========================================================================= */

/* ---- theme (shared with the main app — same localStorage key, so if
   someone already picked dark/light there, /admin opens matching it) ---- */
const THEME_KEY = 'paddleStackTheme';
function getStoredTheme(){ try{ return localStorage.getItem(THEME_KEY); }catch(e){ return null; } }
function preferredTheme(){
  const stored = getStoredTheme();
  if (stored === 'dark' || stored === 'light') return stored;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const iconUse = document.getElementById('themeToggleIconUse');
  if (iconUse) iconUse.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}
applyTheme(preferredTheme());
document.getElementById('themeToggleBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
});

const SUPABASE_URL = 'https://xqogfjttzsewrtnbwatv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhxb2dmanR0enNld3J0bmJ3YXR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2OTM3NzMsImV4cCI6MjEwMTI2OTc3M30.IEnaOjWzu7pmnEiiIvdw6NmZWPfa4q3CQ40GlKIB05k';
const AUTH_STORAGE_KEY = 'renzkuAdminAuthSession'; // deliberately its own key —
  // separate from the main app's session, so being logged into one doesn't
  // silently sign you into the other.

function $(sel, root){ return (root || document).querySelector(sel); }
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/* ---- confirm / prompt (replaces native confirm()/prompt() popups, mirrors
   the main app's #confirmOverlay in script.js) ----
   A single global "in-flight resolver" was the bug in the original version
   of this pattern: if a second showConfirm()/showPrompt() call ever came in
   while one was already awaiting a response, it would silently clobber the
   first call's resolver, leaving the first caller's `await` hanging forever.
   Queuing pending requests instead of overwriting fixes that — the second
   dialog simply opens right after the first one closes. */
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmMessageEl = document.getElementById('confirmMessage');
const confirmOkBtn = document.getElementById('confirmOkBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');
const promptOverlay = document.getElementById('promptOverlay');
const promptTitleEl = document.getElementById('promptTitle');
const promptMessageEl = document.getElementById('promptMessage');
const promptInputEl = document.getElementById('promptInput');
const promptOkBtn = document.getElementById('promptOkBtn');
const promptCancelBtn = document.getElementById('promptCancelBtn');

const dialogQueue = []; // { kind: 'confirm'|'prompt', message, opts, resolve }
let dialogActive = null;

function runNextDialog(){
  if (dialogActive || dialogQueue.length === 0) return;
  dialogActive = dialogQueue.shift();
  const { kind, message, opts } = dialogActive;
  if (kind === 'confirm'){
    confirmTitleEl.textContent = opts.title || 'Please confirm';
    confirmMessageEl.textContent = message;
    confirmOkBtn.textContent = opts.confirmLabel || 'Confirm';
    confirmCancelBtn.textContent = opts.cancelLabel || 'Cancel';
    confirmOkBtn.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    confirmOverlay.hidden = false;
    confirmOkBtn.focus();
  } else {
    promptTitleEl.textContent = opts.title || 'Add a note';
    promptMessageEl.textContent = message;
    promptInputEl.value = opts.defaultValue || '';
    promptOverlay.hidden = false;
    promptInputEl.focus();
  }
}
function closeActiveDialog(result){
  if (!dialogActive) return;
  const { kind, resolve } = dialogActive;
  if (kind === 'confirm') confirmOverlay.hidden = true; else promptOverlay.hidden = true;
  dialogActive = null;
  resolve(result);
  runNextDialog();
}
/** Promise<boolean> — true if confirmed, false if cancelled/dismissed. */
function showConfirm(message, opts){
  return new Promise((resolve) => {
    dialogQueue.push({ kind: 'confirm', message, opts: opts || {}, resolve });
    runNextDialog();
  });
}
/** Promise<string|null> — the entered text, or null if skipped/cancelled. */
function showPrompt(message, opts){
  return new Promise((resolve) => {
    dialogQueue.push({ kind: 'prompt', message, opts: opts || {}, resolve });
    runNextDialog();
  });
}
confirmOkBtn.addEventListener('click', () => closeActiveDialog(true));
confirmCancelBtn.addEventListener('click', () => closeActiveDialog(false));
confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) closeActiveDialog(false); });
promptOkBtn.addEventListener('click', () => closeActiveDialog(promptInputEl.value.trim() || null));
promptCancelBtn.addEventListener('click', () => closeActiveDialog(null));
promptOverlay.addEventListener('click', (e) => { if (e.target === promptOverlay) closeActiveDialog(null); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!confirmOverlay.hidden) closeActiveDialog(false);
  else if (!promptOverlay.hidden) closeActiveDialog(null);
});

/* ---- toast (mirrors the main app's, minus the tone auto-detection) ---- */
const toastWrap = $('#toastWrap');
function toast(msg, kind){
  const el = document.createElement('div');
  el.className = 'toast toast-' + (kind || 'info');
  el.innerHTML = '<span class="toast-msg"></span><span class="toast-progress"></span>';
  el.querySelector('.toast-msg').textContent = msg;
  toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 2600);
}

/* ---- hCaptcha (same site key/behavior as the main app's login form) ---- */
const HCAPTCHA_SITE_KEY = '07e29e48-5c84-4020-a036-36ba3aa4758e';
let hcaptchaReady = false;
let hcaptchaWidgetId = null;
window.onHcaptchaReady = function(){ hcaptchaReady = true; mountHcaptchaWidget(); };
if (window.__hcaptchaApiReady) window.onHcaptchaReady();
function mountHcaptchaWidget(){
  const box = document.getElementById('hcaptchaBox');
  if (!box || !hcaptchaReady || !window.hcaptcha) return;
  box.innerHTML = '';
  hcaptchaWidgetId = window.hcaptcha.render(box, { sitekey: HCAPTCHA_SITE_KEY });
}
function resetHcaptcha(){
  if (window.hcaptcha && hcaptchaWidgetId !== null){ try{ window.hcaptcha.reset(hcaptchaWidgetId); }catch(e){} }
}

/* ---- auth (email+password only — no signup here; admin accounts are
   promoted via SQL bootstrap or the Accounts tab, never created fresh) ---- */
let authSession = null;

function b64UrlDecode(str){
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}
function decodeJwt(token){ try{ return JSON.parse(b64UrlDecode(token.split('.')[1])); }catch(e){ return null; } }

function saveAuthSession(session){
  authSession = session;
  try{
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }catch(e){}
}
function loadAuthSession(){
  try{ const raw = localStorage.getItem(AUTH_STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
  catch(e){ return null; }
}
function applyAuthResponse(data){
  const claims = decodeJwt(data.access_token);
  saveAuthSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
    user: { id: claims && claims.sub, email: (claims && claims.email) || (data.user && data.user.email) || '' }
  });
}
async function authRequest(path, body, captchaToken){
  const payload = captchaToken ? Object.assign({}, body, { gotrue_meta_security: { captcha_token: captchaToken } }) : body;
  const res = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify(payload)
  });
  let data = {};
  try{ data = await res.json(); }catch(e){}
  if (!res.ok){
    const err = new Error(data.error_description || data.msg || data.error || 'Something went wrong — try again');
    err.code = data.error_code || data.code || data.error || '';
    throw err;
  }
  return data;
}
async function signInEmail(email, password, captchaToken){
  const data = await authRequest('/auth/v1/token?grant_type=password', { email, password }, captchaToken);
  applyAuthResponse(data);
}
async function ensureFreshToken(){
  if (!authSession) return null;
  if (Date.now() < authSession.expires_at - 60000) return authSession.access_token;
  try{
    const data = await authRequest('/auth/v1/token?grant_type=refresh_token', { refresh_token: authSession.refresh_token });
    applyAuthResponse(data);
    return authSession.access_token;
  }catch(e){ saveAuthSession(null); return null; }
}
async function signOut(){
  try{
    if (authSession){
      await fetch(SUPABASE_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + authSession.access_token }
      });
    }
  }catch(e){}
  saveAuthSession(null);
  showLoggedOut();
}

/* Generic authenticated REST/RPC call. Every admin_* call goes through
   this — none of them work without a fresh token, since they all key off
   auth.uid() server-side. */
async function sb(path, options){
  const token = await ensureFreshToken();
  if (!token) throw new Error('Session expired — please log in again.');
  const headers = Object.assign({
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json'
  }, (options && options.headers) || {});
  const res = await fetch(SUPABASE_URL + path, Object.assign({}, options, { headers }));
  let data = null;
  try{ data = await res.json(); }catch(e){}
  if (!res.ok){
    const msg = (data && (data.message || data.error_description || data.hint)) || 'Request failed';
    throw new Error(msg);
  }
  return data;
}
function rpc(name, args){ return sb('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(args || {}) }); }

/* ============================================================= UI wiring */
const loginCard = $('#adminLoginCard');
const deniedCard = $('#adminDeniedCard');
const dashboard = $('#adminDashboard');
const whoamiEl = $('#adminWhoami');
const logoutBtn = $('#adminLogoutBtn');
const menuBtn = $('#adminMenuBtn');
const sidebar = $('#adminSidebar');
const sidebarBackdrop = $('#adminSidebarBackdrop');
const sidebarEmailEl = $('#adminSidebarEmail');
const avatarEl = $('#adminAvatar');

function initials(email){
  const name = (email || '').split('@')[0] || 'A';
  return name.slice(0, 2).toUpperCase();
}
function closeMobileNav(){ dashboard.classList.remove('admin-nav-open'); }
menuBtn.addEventListener('click', () => dashboard.classList.toggle('admin-nav-open'));
sidebarBackdrop.addEventListener('click', closeMobileNav);

function showLoggedOut(){
  loginCard.hidden = false; deniedCard.hidden = true; dashboard.hidden = true;
  whoamiEl.hidden = true; logoutBtn.hidden = true; menuBtn.hidden = true;
  resetHcaptcha();
}
function showDenied(){
  loginCard.hidden = true; deniedCard.hidden = false; dashboard.hidden = true;
  whoamiEl.hidden = true; logoutBtn.hidden = true; menuBtn.hidden = true;
}
function showDashboard(){
  loginCard.hidden = true; deniedCard.hidden = true; dashboard.hidden = false;
  whoamiEl.hidden = false; whoamiEl.textContent = authSession.user.email;
  logoutBtn.hidden = false; menuBtn.hidden = false;
  sidebarEmailEl.textContent = authSession.user.email;
  avatarEl.textContent = initials(authSession.user.email);
  loadAccounts(); loadLiveSessions(); loadSettings(); loadCreditRequests();
}

async function afterLogin(){
  let isAdmin = false;
  try{ isAdmin = !!(await rpc('is_admin_me')); }
  catch(e){ toast(e.message || 'Could not verify admin access', 'error'); showLoggedOut(); return; }
  if (isAdmin) showDashboard(); else showDenied();
}

$('#adminLogoutBtn').addEventListener('click', signOut);
$('#adminDeniedLogoutBtn').addEventListener('click', signOut);

const loginForm = $('#adminLoginForm');
const loginFieldset = $('#adminLoginFieldset');
const loginError = $('#adminLoginError');
const loginSubmit = $('#adminLoginSubmit');
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const email = $('#adminEmailInput').value.trim();
  const password = $('#adminPasswordInput').value;
  const captchaToken = window.hcaptcha && hcaptchaWidgetId !== null ? window.hcaptcha.getResponse(hcaptchaWidgetId) : '';
  if (hcaptchaReady && !captchaToken){
    loginError.textContent = 'Please complete the captcha.'; loginError.hidden = false; return;
  }
  loginFieldset.disabled = true; loginSubmit.textContent = 'Please wait…';
  try{
    await signInEmail(email, password, captchaToken);
    await afterLogin();
  }catch(err){
    loginError.textContent = (err && err.message) || 'Log in failed';
    loginError.hidden = false;
  }finally{
    resetHcaptcha();
    loginFieldset.disabled = false; loginSubmit.textContent = 'Log in';
  }
});

/* ---- tabs ---- */
$('#adminTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  $('#adminTabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  ['accounts','live','credits','settings'].forEach(name => {
    $('#tab-' + name).hidden = (name !== btn.dataset.tab);
  });
  closeMobileNav();
});

/* ============================================================== KPI row */
let liveSessionsCache = [];
let creditRequestsCache = [];
function renderKpis(){
  const wrap = $('#adminKpiRow');
  const total = accountsCache.length;
  const admins = accountsCache.filter(a => a.is_admin).length;
  const suspended = accountsCache.filter(a => a.is_suspended).length;
  const liveNow = liveSessionsCache.length;
  const pendingCredits = creditRequestsCache.filter(r => r.status === 'pending').length;
  wrap.innerHTML = `
    <div class="admin-kpi-card">
      <div class="admin-kpi-label"><svg viewBox="0 0 24 24"><use href="#i-user"/></svg>Accounts</div>
      <div class="admin-kpi-value">${total}</div>
    </div>
    <div class="admin-kpi-card">
      <div class="admin-kpi-label"><svg viewBox="0 0 24 24"><use href="#i-cloud"/></svg>Live now</div>
      <div class="admin-kpi-value turf">${liveNow}</div>
    </div>
    <div class="admin-kpi-card">
      <div class="admin-kpi-label"><svg viewBox="0 0 24 24"><use href="#i-cloud"/></svg>Credit requests</div>
      <div class="admin-kpi-value${pendingCredits ? ' danger' : ''}">${pendingCredits}</div>
    </div>
    <div class="admin-kpi-card">
      <div class="admin-kpi-label"><svg viewBox="0 0 24 24"><use href="#i-lock"/></svg>Admins</div>
      <div class="admin-kpi-value">${admins}</div>
    </div>
    <div class="admin-kpi-card">
      <div class="admin-kpi-label"><svg viewBox="0 0 24 24"><use href="#i-gear"/></svg>Suspended</div>
      <div class="admin-kpi-value${suspended ? ' danger' : ''}">${suspended}</div>
    </div>
  `;
}

/* ============================================================= Accounts */
let accountsCache = [];
async function loadAccounts(){
  const wrap = $('#accountsTableWrap');
  wrap.innerHTML = '<div class="admin-skeleton"></div><div class="admin-skeleton" style="width:80%"></div><div class="admin-skeleton" style="width:60%"></div>';
  try{
    accountsCache = await rpc('admin_list_accounts') || [];
    renderAccounts();
    renderKpis();
  }catch(e){
    wrap.innerHTML = '<p class="admin-empty">' + esc(e.message || 'Could not load accounts') + '</p>';
  }
}
function renderAccounts(){
  const wrap = $('#accountsTableWrap');
  const q = ($('#accountsSearch').value || '').trim().toLowerCase();
  const rows = accountsCache.filter(a => !q || (a.email || '').toLowerCase().includes(q));
  if (!rows.length){ wrap.innerHTML = '<p class="admin-empty">No matching accounts.</p>'; return; }
  wrap.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Account</th><th>Joined</th><th>Status</th>
        <th>Used today</th><th>Daily limit</th><th>Credit balance</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${rows.map(a => `
          <tr data-id="${esc(a.id)}">
            <td class="wrap" data-label="Account">
              <div class="admin-cell-identity">
                <span class="admin-row-avatar">${esc(initials(a.email))}</span>
                <div>
                  <div>${esc(a.email || '(no email)')}</div>
                  ${(a.is_admin || a.is_suspended) ? `<div class="admin-cell-badges">${a.is_admin ? '<span class="admin-badge admin">Admin</span>' : ''}${a.is_suspended ? '<span class="admin-badge suspended">Suspended</span>' : ''}</div>` : ''}
                </div>
              </div>
            </td>
            <td data-label="Joined">${a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}</td>
            <td data-label="Status">${a.is_suspended ? '<span class="admin-badge suspended">Suspended</span>' : '<span class="admin-badge ok">Active</span>'}</td>
            <td data-label="Used today">${a.sessions_today} / ${a.host_daily_limit == null ? 'default' : a.host_daily_limit}</td>
            <td data-label="Daily limit"><input type="number" min="0" class="admin-limit-input" data-role="limit" placeholder="default" value="${a.host_daily_limit == null ? '' : a.host_daily_limit}"></td>
            <td data-label="Credit balance">${typeof a.credit_balance === 'number' ? a.credit_balance : '—'}</td>
            <td class="admin-cell-full" data-label="Actions">
              <div class="admin-row-actions">
                <button type="button" class="btn ghost sm" data-action="save-limit">Save limit</button>
                <button type="button" class="btn ghost sm" data-action="toggle-suspend">${a.is_suspended ? 'Unsuspend' : 'Suspend'}</button>
                <button type="button" class="btn ghost sm" data-action="toggle-admin">${a.is_admin ? 'Remove admin' : 'Make admin'}</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
$('#accountsSearch').addEventListener('input', renderAccounts);
$('#accountsRefreshBtn').addEventListener('click', loadAccounts);

$('#accountsTableWrap').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('tr');
  const id = row.dataset.id;
  const account = accountsCache.find(a => a.id === id);
  if (!account) return;

  if (btn.dataset.action === 'save-limit'){
    const input = row.querySelector('[data-role="limit"]');
    const raw = input.value.trim();
    const value = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
    btn.disabled = true;
    try{
      await rpc('admin_set_host_limit', { target_id: id, new_limit: value });
      toast('Daily limit updated for ' + account.email, 'success');
      await loadAccounts();
    }catch(err){ toast(err.message || 'Could not update limit', 'error'); }
    finally{ btn.disabled = false; }
    return;
  }

  if (btn.dataset.action === 'toggle-suspend'){
    const next = !account.is_suspended;
    if (next && !(await showConfirm(`Suspend ${account.email}? This blocks new and resumed hosting for this account until unsuspended.`, {title: 'Suspend account?', confirmLabel: 'Suspend', danger: true}))) return;
    btn.disabled = true;
    try{
      await rpc('admin_set_suspended', { target_id: id, suspended: next });
      toast((next ? 'Suspended ' : 'Unsuspended ') + account.email, 'success');
      await loadAccounts();
    }catch(err){ toast(err.message || 'Could not update account', 'error'); }
    finally{ btn.disabled = false; }
    return;
  }

  if (btn.dataset.action === 'toggle-admin'){
    const next = !account.is_admin;
    const msg = next
      ? `Make ${account.email} an admin? They'll get full access to this portal, including managing other accounts.`
      : `Remove admin access from ${account.email}?`;
    if (!(await showConfirm(msg, {title: next ? 'Grant admin access?' : 'Remove admin access?', confirmLabel: next ? 'Make admin' : 'Remove access', danger: !next}))) return;
    btn.disabled = true;
    try{
      await rpc('admin_set_admin', { target_id: id, make_admin: next });
      toast((next ? 'Promoted ' : 'Demoted ') + account.email, 'success');
      await loadAccounts();
    }catch(err){ toast(err.message || 'Could not update admin status', 'error'); }
    finally{ btn.disabled = false; }
    return;
  }
});

/* ========================================================= Live sessions */
async function loadLiveSessions(){
  const wrap = $('#liveTableWrap');
  wrap.innerHTML = '<div class="admin-skeleton"></div><div class="admin-skeleton" style="width:70%"></div>';
  try{
    liveSessionsCache = await rpc('admin_list_live_sessions') || [];
    renderKpis();
    if (!liveSessionsCache.length){ wrap.innerHTML = '<p class="admin-empty">Nothing live right now.</p>'; return; }
    wrap.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Host</th><th>Session</th><th>Code</th><th>Started</th><th>Actions</th></tr></thead>
        <tbody>
          ${liveSessionsCache.map(r => `
            <tr data-id="${esc(r.id)}">
              <td class="wrap" data-label="Host">
                <div class="admin-cell-identity">
                  <span class="admin-row-avatar">${esc(initials(r.host_email))}</span>
                  <span>${esc(r.host_email || '—')}</span>
                </div>
              </td>
              <td class="wrap" data-label="Session">${esc(r.session_name || '—')}</td>
              <td data-label="Code"><code>${esc(r.invite_code)}</code></td>
              <td data-label="Started">${new Date(r.created_at).toLocaleString()}</td>
              <td class="admin-cell-full" data-label="Actions"><button type="button" class="btn danger sm" data-action="end">End session</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }catch(e){
    wrap.innerHTML = '<p class="admin-empty">' + esc(e.message || 'Could not load live sessions') + '</p>';
  }
}
$('#liveRefreshBtn').addEventListener('click', loadLiveSessions);
$('#liveTableWrap').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="end"]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  if (!(await showConfirm('End this live session now? Viewers will lose the feed immediately.', {title: 'End live session?', confirmLabel: 'End session', danger: true}))) return;
  btn.disabled = true;
  try{
    await rpc('admin_end_session', { session_id: id });
    toast('Session ended', 'success');
    await loadLiveSessions();
  }catch(err){ toast(err.message || 'Could not end session', 'error'); }
  finally{ btn.disabled = false; }
});

/* ====================================================== Credit requests */
async function loadCreditRequests(){
  const wrap = $('#creditsTableWrap');
  wrap.innerHTML = '<div class="admin-skeleton"></div><div class="admin-skeleton" style="width:70%"></div>';
  try{
    creditRequestsCache = await rpc('admin_list_credit_requests') || [];
    renderCreditRequests();
    renderKpis();
  }catch(e){
    wrap.innerHTML = '<p class="admin-empty">' + esc(e.message || 'Could not load credit requests') + '</p>';
  }
}
function renderCreditRequests(){
  const wrap = $('#creditsTableWrap');
  if (!creditRequestsCache.length){ wrap.innerHTML = '<p class="admin-empty">No credit requests yet.</p>'; return; }
  // Pending first (oldest first, so the longest-waiting request is reviewed
  // first), then everything already decided, most recent first.
  const rows = creditRequestsCache.slice().sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (b.status === 'pending' && a.status !== 'pending') return 1;
    const dir = a.status === 'pending' ? 1 : -1;
    return dir * (new Date(a.created_at) - new Date(b.created_at));
  });
  wrap.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Host</th><th>Package</th><th>Submitted</th><th>Receipt</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr data-id="${esc(r.id)}">
            <td class="wrap" data-label="Host">
              <div class="admin-cell-identity">
                <span class="admin-row-avatar">${esc(initials(r.host_email))}</span>
                <span>${esc(r.host_email || '—')}</span>
              </div>
            </td>
            <td data-label="Package">${esc(r.package_credits)} credits — \u20b1${esc(r.amount_php)}</td>
            <td data-label="Submitted">${r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
            <td data-label="Receipt"><button type="button" class="btn ghost sm" data-action="view-receipt">View</button></td>
            <td data-label="Status">${
              r.status === 'pending' ? '<span class="admin-badge">Pending</span>'
              : r.status === 'approved' ? '<span class="admin-badge ok">Approved</span>'
              : '<span class="admin-badge suspended">Rejected</span>'
            }</td>
            <td class="admin-cell-full" data-label="Actions">
              ${r.status === 'pending' ? `
                <div class="admin-row-actions">
                  <button type="button" class="btn ghost sm" data-action="approve">Approve</button>
                  <button type="button" class="btn ghost sm" data-action="reject">Reject</button>
                </div>
              ` : (r.admin_note ? `<span class="admin-hint">${esc(r.admin_note)}</span>` : '—')}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
$('#creditsRefreshBtn').addEventListener('click', loadCreditRequests);
$('#creditsTableWrap').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('tr');
  const id = row.dataset.id;
  const request = creditRequestsCache.find(r => r.id === id);
  if (!request) return;

  if (btn.dataset.action === 'view-receipt'){
    btn.disabled = true; btn.textContent = 'Loading…';
    try{
      const url = await signedReceiptUrl(request.receipt_path);
      window.open(url, '_blank', 'noopener');
    }catch(err){ toast(err.message || 'Could not open receipt', 'error'); }
    finally{ btn.disabled = false; btn.textContent = 'View'; }
    return;
  }

  if (btn.dataset.action === 'approve'){
    if (!(await showConfirm(`Approve ${request.package_credits} credits for ${request.host_email}? This adds them to the account's balance immediately.`, {title: 'Approve credit purchase?', confirmLabel: 'Approve'}))) return;
    btn.disabled = true;
    try{
      await rpc('admin_review_credit_purchase', { p_request_id: id, p_approve: true });
      toast('Approved — credits added', 'success');
      await loadCreditRequests();
    }catch(err){ toast(err.message || 'Could not approve request', 'error'); }
    finally{ btn.disabled = false; }
    return;
  }

  if (btn.dataset.action === 'reject'){
    const note = await showPrompt('Optional note for the rejection (shown to you here, not sent to the host automatically):', {title: 'Reject purchase'});
    btn.disabled = true;
    try{
      await rpc('admin_review_credit_purchase', { p_request_id: id, p_approve: false, p_note: note });
      toast('Rejected', 'success');
      await loadCreditRequests();
    }catch(err){ toast(err.message || 'Could not reject request', 'error'); }
    finally{ btn.disabled = false; }
    return;
  }
});
/* Signed URLs are short-lived on purpose — the bucket is private, so
   nothing about a receipt is reachable without an admin session minting
   one of these first. */
async function signedReceiptUrl(path){
  if (!path || typeof path !== 'string' || !path.trim()){
    console.error('signedReceiptUrl called with invalid path:', path);
    throw new Error('This request has no receipt on file (missing receipt_path).');
  }
  const token = await ensureFreshToken();
  if (!token) throw new Error('Session expired — please log in again.');
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/receipts/${path}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.signedURL) throw new Error((data && data.message) || 'Could not sign receipt URL');
  // Supabase's storage REST API returns signedURL WITHOUT the /storage/v1
  // prefix (that's normally added back in by the supabase-js SDK). Since
  // we're calling the REST endpoint directly, we have to add it ourselves.
  const signedPath = data.signedURL.startsWith('/storage/v1') ? data.signedURL : `/storage/v1${data.signedURL}`;
  return SUPABASE_URL + signedPath;
}

/* =========================================================== Settings */
async function loadSettings(){
  const form = $('#settingsForm');
  const errBox = $('#settingsError');
  errBox.hidden = true;
  form.innerHTML = '<div class="admin-skeleton"></div><div class="admin-skeleton" style="width:70%"></div><div class="admin-skeleton" style="width:85%"></div>';
  try{
    const rows = await sb('/rest/v1/site_settings?select=key,value', { method: 'GET' });
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { map[r.key] = r.value; });
    const defLimit = (map.host_daily_limit_default && map.host_daily_limit_default.limit) || 5;
    const maintOn = !!(map.maintenance_mode && map.maintenance_mode.on);
    const maintMsg = (map.maintenance_message && map.maintenance_message.text) || '';
    const annOn = !!(map.announcement && map.announcement.on);
    const annText = (map.announcement && map.announcement.text) || '';

    form.innerHTML = `
      <div class="field">
        <label for="settingDefLimit">Default daily hosting credits</label>
        <input type="number" min="0" id="settingDefLimit" value="${defLimit}">
        <p class="admin-settings-note">Applies to every account without a per-account override on the Accounts tab.</p>
      </div>
      <div class="field">
        <div class="field-row"><input type="checkbox" id="settingMaintOn" ${maintOn ? 'checked' : ''}> <label for="settingMaintOn" style="margin:0">Maintenance mode — pauses new live hosting for everyone except admins</label></div>
        <textarea id="settingMaintMsg" placeholder="Message shown to hosts while paused">${esc(maintMsg)}</textarea>
      </div>
      <div class="field">
        <div class="field-row"><input type="checkbox" id="settingAnnOn" ${annOn ? 'checked' : ''}> <label for="settingAnnOn" style="margin:0">Show announcement banner</label></div>
        <textarea id="settingAnnText" placeholder="Announcement text">${esc(annText)}</textarea>
      </div>
      <button type="button" class="btn primary" id="settingsSaveBtn" style="width:100%">Save settings</button>
    `;
    $('#settingsSaveBtn').addEventListener('click', saveSettings);
  }catch(e){
    form.innerHTML = '';
    errBox.textContent = e.message || 'Could not load settings';
    errBox.hidden = false;
  }
}
async function saveSettings(){
  const btn = $('#settingsSaveBtn');
  const errBox = $('#settingsError');
  errBox.hidden = true;
  const defLimit = Math.max(0, parseInt($('#settingDefLimit').value, 10) || 0);
  const maintOn = $('#settingMaintOn').checked;
  const maintMsg = $('#settingMaintMsg').value;
  const annOn = $('#settingAnnOn').checked;
  const annText = $('#settingAnnText').value;
  btn.disabled = true; btn.textContent = 'Saving…';
  try{
    await rpc('admin_set_site_setting', { setting_key: 'host_daily_limit_default', setting_value: { limit: defLimit } });
    await rpc('admin_set_site_setting', { setting_key: 'maintenance_mode', setting_value: { on: maintOn } });
    await rpc('admin_set_site_setting', { setting_key: 'maintenance_message', setting_value: { text: maintMsg } });
    await rpc('admin_set_site_setting', { setting_key: 'announcement', setting_value: { on: annOn, text: annText } });
    toast('Site settings saved', 'success');
  }catch(e){
    errBox.textContent = e.message || 'Could not save settings';
    errBox.hidden = false;
  }finally{
    btn.disabled = false; btn.textContent = 'Save settings';
  }
}

/* ============================================================= Boot */
(function boot(){
  authSession = loadAuthSession();
  if (authSession) afterLogin(); else showLoggedOut();
})();

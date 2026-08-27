(function(){
"use strict";

/* ================= IndexedDB layer (with localStorage fallback) ================= */
const DB_NAME = 'paddleStackQueueDB';
const STORE = 'kv';
let idb = null;
let idbFailed = false;

function openDB(){
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) { idbFailed = true; return resolve(null); }
    try{
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { idbFailed = true; resolve(null); };
    }catch(e){ idbFailed = true; resolve(null); }
  });
}

async function idbGet(key){
  if (idbFailed || !idb) return null;
  return new Promise((resolve) => {
    try{
      const tx = idb.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    }catch(e){ resolve(null); }
  });
}

async function idbSet(key, value){
  if (idbFailed || !idb) return false;
  return new Promise((resolve) => {
    try{
      const tx = idb.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    }catch(e){ resolve(false); }
  });
}

// The actual write to disk — always the *current* state at the moment it
// runs (not a snapshot taken when it was scheduled), same idea as
// pushStateNow() picking up whatever's latest by the time its debounce fires.
async function writeStateNow(){
  const ok = await idbSet('state', state);
  if (!ok){
    try{ localStorage.setItem('paddleStackQueueState', JSON.stringify(state)); }catch(e){}
  }
}
let persistDebounceTimer = null;
let persistDirty = false;

// `immediate`: skip both the local-write debounce below AND the usual
// 500ms network debounce, pushing to disk/live viewers right away. Used
// for deliberate, one-off queue edits (reordering the stack, substitutions,
// removing a player) where there's no rapid-fire burst to coalesce and a
// spectator noticing the delay is worse than the extra network request —
// see queueHostPush below.
//
// Every state-changing action in the app calls persist() — dozens of call
// sites, many of them not awaited (fire-and-forget) — so a burst of quick
// taps (dragging someone through the queue, mashing a score button) used to
// mean one full IndexedDB write of the *entire* app state per tap. That's
// wasted work the UI doesn't need to wait on: only the *last* write in a
// burst actually matters, so coalesce them the same way queueHostPush
// already coalesces network pushes. flushPersist() (wired to
// visibilitychange/pagehide below) guarantees a pending write still lands
// before the tab backgrounds or closes, so nothing is lost by debouncing.
async function persist(immediate){
  // A co-host device's local storage is never the source of truth — same
  // principle as viewer mode — so skip the local write entirely and go
  // straight to pushing the change to the shared server row.
  if (!coHostMode){
    if (immediate){
      if (persistDebounceTimer){ clearTimeout(persistDebounceTimer); persistDebounceTimer = null; }
      persistDirty = false;
      await writeStateNow();
    } else {
      persistDirty = true;
      if (!persistDebounceTimer){
        persistDebounceTimer = setTimeout(() => {
          persistDebounceTimer = null;
          if (persistDirty){ persistDirty = false; writeStateNow(); }
        }, 250);
      }
    }
  }
  if (typeof queueHostPush === 'function') queueHostPush(immediate);
}
// Safety net for the debounce above: if a write is still pending when the
// tab backgrounds or closes, flush it immediately instead of leaving it to
// a 250ms timer that may never get to run (mobile browsers can suspend a
// backgrounded tab's timers with no further notice at all).
function flushPersist(){
  if (!persistDebounceTimer || !persistDirty) return;
  clearTimeout(persistDebounceTimer);
  persistDebounceTimer = null;
  persistDirty = false;
  writeStateNow();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPersist(); });
window.addEventListener('pagehide', flushPersist);

async function loadPersisted(){
  let saved = await idbGet('state');
  if (!saved){
    try{
      const raw = localStorage.getItem('paddleStackQueueState');
      if (raw) saved = JSON.parse(raw);
    }catch(e){}
  }
  return saved;
}

/* ================= Player skill levels & court types =================
   Levels are a per-player-name attribute (not per queue-entry), so a
   player's level sticks with them across the whole session — through
   arrivals, the stack, a block, a match, and back into the stack again.
   Courts each have their own assigned level, and matching is strict —
   a player only lands on a court whose level matches theirs exactly,
   "Open Play" included: an Open Play player only joins an Open Play
   court, and an Open Play court only takes Open Play players. */
const PLAYER_LEVELS = ['Open', 'Beginner', 'Advanced Beginner', 'Intermediate', 'Advanced'];
// Internal level keys stay stable (data model, class names, saved sessions);
// this map only swaps in a friendlier label wherever a level is displayed.
const LEVEL_LABELS = { 'Open': 'Open Play' };
function levelLabel(level){
  return LEVEL_LABELS[level] || level;
}
function levelClass(level){
  return 'lvl-' + String(level || 'Open').toLowerCase().replace(/\s+/g, '-');
}
function levelsMatch(playerLevel, courtLevel){
  // "Balanced" matching style prioritizes fair teams/turns over strict skill
  // separation, so it ignores each court's assigned level entirely — any
  // waiting player can fill any open court. Winners/Losers keeps the
  // original strict, exact-level match.
  if (getMatchingStyle() === 'balanced') return true;
  const pl = playerLevel || 'Open', cl = courtLevel || 'Open';
  return pl === cl;
}
function getMatchingStyle(){
  const s = state.session && state.session.matchingStyle;
  // 'skillSeparated' was removed as a selectable style; a session saved
  // while it still existed falls back to 'winnersLosers', which already
  // shares the exact same strict level-matching behavior above.
  return s === 'balanced' ? 'balanced' : 'winnersLosers';
}
function skillLevelsEnabled(){
  return !!(state.session && state.session.skillLevelsEnabled);
}
// Toggles a body class that hides every skill-level control and badge
// (add-player level picker, per-court level select, level badges in the
// stack/blocks/courts/sub-picker) when the feature is switched off in
// Settings. Purely a display concern — everyone still carries an internal
// 'Open' level either way, so matching logic never has to branch on this.
function applyLevelsVisibility(){
  document.body.classList.toggle('levels-on', skillLevelsEnabled());
}
function getPlayerLevel(name){
  return (state.playerLevels && state.playerLevels[name]) || 'Open';
}
function setPlayerLevel(name, level){
  if (!state.playerLevels) state.playerLevels = {};
  state.playerLevels[name] = PLAYER_LEVELS.includes(level) ? level : 'Open';
}
function levelSelectOptionsHtml(selected){
  return PLAYER_LEVELS.map(l => `<option value="${esc(l)}"${l === selected ? ' selected' : ''}>${esc(levelLabel(l))}</option>`).join('');
}
function cyclePlayerLevel(name){
  const cur = getPlayerLevel(name);
  const idx = PLAYER_LEVELS.indexOf(cur);
  const next = PLAYER_LEVELS[(idx + 1) % PLAYER_LEVELS.length];
  setPlayerLevel(name, next);
  toast(name + ' set to ' + levelLabel(next));
  renderAll(); persist();
}

/* ================= State ================= */
function defaultCourts(n){
  return Array.from({length:n}, (_, i) => ({
    id: 'c'+(i+1), name: 'Court '+(i+1), level: 'Open', status:'open', players: [], startTime: null, lastResult: null, swapInfo: null, score: null,
    previewOrder: null, previewSubMap: null, openedAt: Date.now(), pauseStart: null, pausedMs: 0
  }));
}

function freshState(){
  return {
    session: { name: 'PaddleStack', club: '', description: '', createdAt: Date.now(), gameSize: 4, soundOn: true, notifyCallsEnabled: true, autoCallPlayersEnabled: false, status: 'active', targetGamesEnabled: false, targetGamesPerPlayer: 7, avoidRepeatTeammates: false, fixedDuos: [], fixedDuosEnabled: false, scoringEnabled: true, winningScore: 11, autoStartEnabled: false, autoStartMinutes: 1, generationReady: false, matchingStyle: 'winnersLosers', skillLevelsEnabled: false, cohostPermissions: { allowSwap: true, allowSubstitution: true } }, // status: 'active' | 'ended'; matchingStyle: 'balanced' | 'winnersLosers'; skillLevelsEnabled: off by default — everyone plays Open Play until turned on; autoStartMinutes: how long an open, ready court waits before auto-starting (default 1 minute); soundOn: on-site voice announcement only; notifyCallsEnabled: phone notifications on call-up, independent of soundOn; autoCallPlayersEnabled: fires the same Call Players action (voice + phone notify, whichever are on) automatically the instant a court clears, with no confirmation popup — off by default so nothing calls out unexpectedly for a host who hasn't opted in; cohostPermissions: what a co-host device is allowed to do beyond start/score — both default ON, host can turn either off per-session (see setCohostPermission); createdAt: when this session was created, used only for the viewer dashboard's "Session Time" stat — a saved session from before this field existed just won't show an accurate elapsed time, which is harmless; club/description: optional, set via the "Go live" session-name prompt — club shows on the shared-link preview banner, description rides along whenever the live link is copied/shared
    courts: defaultCourts(2),
    arrivals: [],        // {id, name, addedAt} — added but not yet checked in; not part of the live queue
    stack: [],           // {id, name, joinedAt, tag: 'new'|'queued'}
    winnersBlock: [],     // {id, name, joinedAt, tag} — accumulates until gameSize, then flushes to stack as a group (or sooner, if the group's too small to ever fill both blocks — see checkBlockFlush)
    losersBlock: [],      // same shape — accumulates until gameSize, then flushes to stack as a group (or sooner, if the group's too small to ever fill both blocks — see checkBlockFlush)
    history: [],          // {id, courtName, teamA, teamB, winner, startTime, endTime}
    playerStats: {},      // name -> {wins, games}
    teammateHistory: {},   // "nameA||nameB" (sorted) -> number of times paired as teammates this session
    opponentHistory: {},   // "nameA||nameB" (sorted) -> number of times faced each other as opponents this session
    upNextSubMap: {},      // outgoing stack entry id -> incoming stack entry id; host-picked overrides for who
                             // fills a specific "On deck" slot in the Up Next card (see openUpNextSubPicker).
                             // Mirrors a court's previewSubMap: the outgoing player simply keeps their spot in
                             // state.stack, the incoming player is claimed instead. Stale entries (either side
                             // no longer in state.stack) are pruned lazily in renderUpNext().
    playerLevels: {},      // name -> skill level ('Open'|'Beginner'|'Advanced Beginner'|'Intermediate'|'Advanced')
    roster: [],            // known player names, kept across "new session" resets for quick re-adding
    playerCalls: []         // {id, name, court, title, body, ts} — recent "it's your turn" calls issued
                             // by the host (Call Players / Call Out Player). Rides along inside the same
                             // state blob pushed to hosted_sessions, so every spectator device picks it up
                             // on its next poll and matches call.name against its own selected player name.
  };
}

let state = freshState();

let uid = 1;
function nextId(prefix){ return prefix + (Date.now().toString(36)) + (uid++); }

/* ================= DOM refs ================= */
const $ = (sel) => document.querySelector(sel);

/* ================= Service worker registration =================
   Runs unconditionally, at module load, for every visitor — host, local
   player, or spectator alike. (Previously this whole block, plus the
   "Install app" button wiring right after it, lived INSIDE enterViewerMode()
   and so only ever ran for someone who opened a ?join= spectator link — the
   primary host/local-player flow silently never got the offline app shell
   or the install prompt at all. Moving it here fixes that for everyone.) */
let swRegistration = null;
let swWaitingWorker = null; // a new version sitting ready, once the person opts in via the update banner
// Set only by the "Refresh now" click below, and read by the
// controllerchange listener further down — this is the single source of
// truth for "did the person actually ask for this reload", so an
// SW-initiated controller change (e.g. sw.js self-activating on its own)
// can never trigger an unwanted reload loop.
let userRequestedUpdate = false;
const updateOverlay = $('#updateOverlay');
const applyUpdateBtn = $('#applyUpdateBtn');
const dismissUpdateBtn = $('#dismissUpdateBtn');
function showUpdateBanner(worker){
  swWaitingWorker = worker;
  if (updateOverlay) updateOverlay.hidden = false;
}
if (applyUpdateBtn){
  applyUpdateBtn.addEventListener('click', () => {
    if (!swWaitingWorker) return;
    applyUpdateBtn.disabled = true;
    userRequestedUpdate = true;
    swWaitingWorker.postMessage('SKIP_WAITING');
  });
}
// "Later" just dismisses the dialog for this page view — the waiting worker
// stays queued and still takes over (surfacing the dialog again) on the
// next natural reload/nav, so declining now never loses the update.
if (dismissUpdateBtn){
  dismissUpdateBtn.addEventListener('click', () => {
    if (updateOverlay) updateOverlay.hidden = true;
  });
}
if (updateOverlay){
  updateOverlay.addEventListener('click', (e) => {
    if (e.target === updateOverlay) updateOverlay.hidden = true;
  });
}
if ('serviceWorker' in navigator){
  // updateViaCache:'none' stops the browser from serving a stale sw.js out of
  // its own HTTP cache — without this, a plain (non-incognito) tab can keep
  // "seeing" an old service worker for up to 24h even though a new one was
  // deployed, which is exactly what made changes only show up in incognito.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    swRegistration = reg;
    // A worker already sitting in "waiting" (installed while no tab was
    // open, or from a previous visit that never got refreshed) — surface
    // the banner right away instead of only after a fresh 'updatefound'.
    if (reg.waiting) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // 'installed' + an existing controller means this is an UPDATE to
        // an already-running app, not the very first install — that's the
        // case that should prompt for a refresh. A first-ever install has
        // no controller yet and shouldn't nag the person to "update".
        if (installing.state === 'installed' && navigator.serviceWorker.controller){
          showUpdateBanner(installing);
        }
      });
    });
  }).catch(() => {});
  // Fires any time a new worker takes control of this page — which is NOT
  // guaranteed to only happen after the person tapped "Refresh now". If
  // sw.js ever calls self.skipWaiting()/clients.claim() on its own during
  // activation, controllerchange fires on a completely ordinary reload too.
  // Blindly reloading here then causes a reload loop: every reload
  // reactivates the worker, which fires controllerchange again, which
  // reloads again — and since a brand-new script context resets
  // reloadedForUpdate to false each time, the "only once" guard never
  // actually stops it. That loop is what was keeping the viewer banner
  // stuck on "Connecting to live match…": the forced reload kept cutting
  // off enterViewerMode()'s first poll() before it could ever report
  // success.
  //
  // Only reload when the person actually opted in via the update banner
  // (userRequestedUpdate, set above in the "Refresh now" click handler).
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate || !userRequestedUpdate) return;
    reloadedForUpdate = true;
    location.reload();
  });
}

// Manual "Check for updates" button — the browser normally only checks for a
// new sw.js on navigation, and can space those checks out, so this lets
// someone force an immediate check instead of waiting or reaching for
// incognito. reg.update() itself always hits the network for sw.js
// (regardless of updateViaCache), so this check is never served stale.
const syncUpdateBtn = $('#syncUpdateBtn');
if (syncUpdateBtn){
  syncUpdateBtn.addEventListener('click', async () => {
    if (!('serviceWorker' in navigator)){
      toast('Offline mode isn\u2019t supported in this browser.', 'warning');
      return;
    }
    syncUpdateBtn.disabled = true;
    syncUpdateBtn.classList.add('spin');
    try {
      const reg = swRegistration || await navigator.serviceWorker.getRegistration();
      if (!reg){ toast('Nothing to sync yet \u2014 try again in a moment.', 'warning'); return; }
      await reg.update();
      if (reg.waiting){
        showUpdateBanner(reg.waiting);
      } else {
        toast('You\u2019re on the latest version.', 'success');
      }
    } catch {
      toast('Couldn\u2019t check for updates \u2014 check your connection.', 'warning');
    } finally {
      syncUpdateBtn.disabled = false;
      syncUpdateBtn.classList.remove('spin');
    }
  });
}

/* ---- "Install app" (Add to Home Screen) ----
   Installing gives a match an actual standalone app window instead of a
   browser tab, which the OS is far less likely to reclaim/reload mid-game
   — the main thing that can interrupt a match beyond losing internet
   (already handled: queue state lives in IndexedDB and everything but the
   optional live-share features works with no network at all). Chrome/
   Edge/Android fire 'beforeinstallprompt' when the manifest+SW make the
   site eligible; we stash that event and reveal a button instead of
   letting the browser show its own mini-infobar. */
let deferredInstallPrompt = null;
const installAppBtn = $('#installAppBtn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (installAppBtn) installAppBtn.hidden = false;
});
if (installAppBtn){
  installAppBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    installAppBtn.hidden = true;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => {});
    deferredInstallPrompt = null;
  });
}
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installAppBtn) installAppBtn.hidden = true;
});

/* ---- iOS "Add to Home Screen" hint (spectator side) ----
   iOS never fires 'beforeinstallprompt' (that's a Chromium-only event) and,
   more importantly, Safari — and every other iOS browser, since Apple
   requires them all to run on WebKit — has no Notification API at all
   outside a Home-Screen-installed, standalone-launched PWA. So a spectator
   on an iPhone who picks their player name can never get the native "Allow
   Notifications?" permission popup from a normal browser tab, no matter
   which browser they're using. This surfaces the one manual path that
   *does* unlock it, right after they register as a player — shown once per
   device so it doesn't nag on every "Change Player". */
function isIOSBrowserTab(){
  const ua = navigator.userAgent || '';
  const iOSDevice = /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as "Macintosh" but is touch-capable, unlike a real Mac.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!iOSDevice) return false;
  // Already installed and launched from the Home Screen — Notification API
  // is available there (iOS 16.4+), so there's nothing to hint at.
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  return !standalone;
}
const IOS_ADDHOME_DISMISSED_KEY = 'paddleStackIOSAddHomeDismissed';
function iosAddHomeDismissed(){
  try{ return localStorage.getItem(IOS_ADDHOME_DISMISSED_KEY) === '1'; }catch(e){ return false; }
}
function dismissIOSAddHomeHint(){
  try{ localStorage.setItem(IOS_ADDHOME_DISMISSED_KEY, '1'); }catch(e){}
}
const iosAddHomeOverlay = $('#iosAddHomeOverlay');
const iosAddHomeOkBtn = $('#iosAddHomeOkBtn');
function showIOSAddHomeHint(){
  if (!iosAddHomeOverlay || iosAddHomeDismissed()) return;
  iosAddHomeOverlay.hidden = false;
}
function closeIOSAddHomeHint(){
  if (!iosAddHomeOverlay) return;
  iosAddHomeOverlay.hidden = true;
  dismissIOSAddHomeHint();
}
if (iosAddHomeOkBtn) iosAddHomeOkBtn.addEventListener('click', closeIOSAddHomeHint);
if (iosAddHomeOverlay) iosAddHomeOverlay.addEventListener('click', (e) => { if (e.target === iosAddHomeOverlay) closeIOSAddHomeHint(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && iosAddHomeOverlay && !iosAddHomeOverlay.hidden) closeIOSAddHomeHint(); });

/* ================= Keyboard-aware viewport (mobile modals) =================
   On phones, opening the on-screen keyboard shrinks the *visual* viewport
   without necessarily shrinking the *layout* viewport, so our fixed-position
   .overlay (and the bottom-sheet modal docked to it) can end up sized for
   the full screen while the keyboard covers the bottom of it — hiding
   "Done"/submit buttons behind the keyboard. Mirroring visualViewport's
   height into a CSS var lets .overlay track the actually-visible area. */
(function setupViewportFix(){
  const vv = window.visualViewport;
  if (!vv){ return; }
  const update = () => {
    document.documentElement.style.setProperty('--app-vh', vv.height + 'px');
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
})();

/* ================= Theme (dark mode) =================
   Preference is stored separately from the queue/app state so it can be
   applied the instant script.js runs, without waiting on IndexedDB. */
const THEME_KEY = 'paddleStackTheme';
const MOBILE_TAB_KEY = 'paddleStackMobileTab'; // 'stack' | 'courts' — which of the two mobile tabs (Players/Courts) was showing, so a reload doesn't bounce you back to Players
function getStoredTheme(){
  try{ return localStorage.getItem(THEME_KEY); }catch(e){ return null; }
}
function preferredTheme(){
  const stored = getStoredTheme();
  if (stored === 'dark' || stored === 'light') return stored;
  // Dark is the app's default look now (matches the reference design) for
  // every first-time visitor, regardless of the device's system theme —
  // this is a fixed brand identity, not an adaptive light/dark app. The
  // toggle in the topbar still lets anyone switch to light and stay there.
  return 'dark';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const iconUse = $('#themeToggleIconUse');
  if (iconUse) iconUse.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  const btn = $('#themeToggleBtn');
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  // Viewer dashboard's own "Theme" quick-action button mirrors the same icon/label.
  const viewerIconUse = $('#viewerThemeIconUse');
  if (viewerIconUse) viewerIconUse.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  const viewerBtn = $('#viewerThemeBtn');
  if (viewerBtn) viewerBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}
applyTheme(preferredTheme());
const stackList = $('#stackList');
const stackBadge = $('#stackBadge');
const stackCountPill = $('#stackCountPill');
const blocksPanel = $('#blocksPanel');
const winnersBlockList = $('#winnersBlockList');
const losersBlockList = $('#losersBlockList');
const winnersBlockCount = $('#winnersBlockCount');
const losersBlockCount = $('#losersBlockCount');
const addForm = $('#addForm');
const addNameInput = $('#addNameInput');
const addLevelSelect = $('#addLevelSelect');
const courtsGrid = $('#courtsGrid');
const historyList = $('#historyList');
const toastWrap = $('#toastWrap');
const appShell = $('#appShell');
const sessionBanner = $('#sessionBanner');
const resumeSessionBtn = $('#resumeSessionBtn');
const addHintEl = $('#addHint');
const addPlayerOverlay = $('#addPlayerOverlay');
const addPlayerTabBtn = $('#addPlayerTabBtn');
const checkInOverlay = $('#checkInOverlay');
const checkInTabBtn = $('#checkInTabBtn');
const wizardHoldNote = $('#checkInWizardHoldNote');

/* ================= Toasts ================= */
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  error:   '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2Zm0-4h-2V7h2Z"/></svg>',
  warning: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3 1 21h22Zm1 15h-2v-2h2Zm0-4h-2V9h2Z"/></svg>',
  info:    '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-7h2Zm0-9h-2V6h2Z"/></svg>'
};

// Best-effort tone detection so existing toast(msg) call sites automatically
// pick up the right color/icon without needing to be touched individually.
function inferToastType(msg){
  const m = msg.toLowerCase();
  if (/(could not|not valid|invalid|corrupted|not allowed|not enough|error)/.test(m)) return 'error';
  if (/(session has ended|pick|enter both|select|need to be|should be)/.test(m)) return 'warning';
  if (/(added|checked in|resumed|started|exported|imported|saved|fixed as a duo|undone|cleared|removed|erased|queue)/.test(m)) return 'success';
  return 'info';
}

// Toasts used to pop up a full message bubble (icon + text) for every minor
// action, which reads as noisy over a long session. Now it's just a brief,
// silent progress bar — a "something happened" pulse with no text to read,
// no color-coded icon, nothing demanding attention, UNLESS the call site
// opts into `{detailed:true}` as a third argument — reserved for moments
// where the host genuinely needs to read what happened (e.g. Generate
// Match's outcomes), in which case a real icon+message bubble shows for
// longer instead of the silent pulse.
function toast(msg, type, opts){
  const kind = type || inferToastType(msg);
  const detailed = !!(opts && (opts.detailed || opts.action));
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind + (detailed ? ' toast-text' : '');
  let dismissTimer = null;
  const scheduleDismiss = (ms) => {
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, ms);
  };
  if (detailed){
    const action = opts && opts.action; // { label, onClick }
    el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[kind] || TOAST_ICONS.info}</span>` +
      `<span class="toast-body"><span class="toast-msg">${esc(msg)}</span>` +
      (action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : '') +
      `</span>`;
    if (action){
      const btn = el.querySelector('.toast-action');
      // A toast with an action stays up a little longer and pauses its own
      // dismissal on hover/focus, so a host reaching for "Undo" doesn't have
      // it vanish out from under the tap.
      btn.addEventListener('click', () => {
        clearTimeout(dismissTimer);
        try{ action.onClick(); }catch(e){ console.error('toast action failed:', e); }
        el.classList.remove('show');
        setTimeout(() => el.remove(), 250);
      });
      el.addEventListener('mouseenter', () => clearTimeout(dismissTimer));
      el.addEventListener('mouseleave', () => scheduleDismiss(3200));
    }
  } else {
    el.innerHTML = '<span class="toast-progress"></span>';
  }
  toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  scheduleDismiss(detailed ? ((opts && opts.action) ? 5000 : 3200) : 900);
}

/* ================= Confirm dialog (replaces native confirm()) =================
   Pending requests are QUEUED rather than tracked with a single global
   resolver. The old single-resolver version had a real race: if a second
   showConfirm() ever fired while one was still awaiting an answer (e.g. an
   auto-start timer's confirm landing at the same moment as a manual one),
   the second call silently clobbered the first's resolver — the first
   caller's `await` then hung forever, since nothing was left to resolve it.
   Queuing means the second dialog simply opens right after the first one
   closes, and every caller's promise is guaranteed to eventually settle. */
const confirmOverlay = $('#confirmOverlay');
const confirmTitleEl = $('#confirmTitle');
const confirmMessageEl = $('#confirmMessage');
const confirmOkBtn = $('#confirmOkBtn');
const confirmCancelBtn = $('#confirmCancelBtn');
const confirmQueue = []; // { message, opts, resolve }
let confirmActive = null;
function runNextConfirm(){
  if (confirmActive || confirmQueue.length === 0) return;
  confirmActive = confirmQueue.shift();
  const opts = confirmActive.opts;
  confirmTitleEl.textContent = opts.title || 'Please confirm';
  confirmMessageEl.textContent = confirmActive.message;
  confirmOkBtn.textContent = opts.confirmLabel || 'Confirm';
  confirmCancelBtn.textContent = opts.cancelLabel || 'Cancel';
  confirmCancelBtn.hidden = !!opts.alertOnly; // single-button "alert" mode — see showAlert() below
  confirmOkBtn.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
  confirmOverlay.hidden = false;
  confirmOkBtn.focus();
}
/* Returns a Promise<boolean> — true if the user confirmed, false if they
   cancelled, dismissed via backdrop click, or pressed Escape. Callers use
   `if (!(await showConfirm('...'))) return;` in place of window.confirm().
   If another confirm is already open, this one waits its turn instead of
   interrupting it. */
function showConfirm(message, opts){
  return new Promise((resolve) => {
    confirmQueue.push({ message, opts: opts || {}, resolve });
    runNextConfirm();
  });
}
/* Single-button variant of showConfirm — for messages that just need
   acknowledging (nothing to confirm/cancel between). Reuses the same
   overlay/queue, just hides the Cancel button. Returns a Promise that
   resolves once the person dismisses it. */
function showAlert(message, opts){
  return showConfirm(message, Object.assign({ confirmLabel: 'OK' }, opts || {}, { alertOnly: true }));
}
function closeConfirm(result){
  if (!confirmActive) return;
  confirmOverlay.hidden = true;
  const resolve = confirmActive.resolve;
  confirmActive = null;
  resolve(result);
  runNextConfirm();
}
confirmOkBtn.addEventListener('click', () => closeConfirm(true));
confirmCancelBtn.addEventListener('click', () => closeConfirm(false));
confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) closeConfirm(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !confirmOverlay.hidden) closeConfirm(false); });

/* ================= "Call Players" popup dialog =================
   Pops up whenever the host taps "Call Players" on a court card (beside
   Start Game) or the voice-only fallback fires — confirming what was just
   called out and, when phone notifications went out, showing per-player
   delivery status as it resolves. Styled off the same modal/overlay theme
   as every other dialog in the app (see .call-players-modal in style.css). */
const callPlayersOverlay = $('#callPlayersOverlay');
const callPlayersSubtitleEl = $('#callPlayersSubtitle');
const callPlayersStatusListEl = $('#callPlayersStatusList');
const callPlayersOkBtn = $('#callPlayersOkBtn');
const callPlayersCloseX = $('#callPlayersCloseX');

function openCallPlayersModal(subtitle){
  if (!callPlayersOverlay) return;
  if (callPlayersSubtitleEl) callPlayersSubtitleEl.textContent = subtitle || '';
  if (callPlayersStatusListEl) callPlayersStatusListEl.innerHTML = '';
  callPlayersOverlay.hidden = false;
  if (callPlayersOkBtn) callPlayersOkBtn.focus();
}
// Fills in delivery status once presence lookup resolves. No-ops if the
// host already dismissed the dialog before the (async) status came back.
function fillCallPlayersModalStatus(results){
  if (!callPlayersStatusListEl || !callPlayersOverlay || callPlayersOverlay.hidden) return;
  callPlayersStatusListEl.innerHTML = results.map(callStatusLineHtml).join('');
}
function closeCallPlayersModal(){
  if (!callPlayersOverlay) return;
  callPlayersOverlay.hidden = true;
}
if (callPlayersOverlay) callPlayersOverlay.addEventListener('click', (e) => { if (e.target === callPlayersOverlay) closeCallPlayersModal(); });
if (callPlayersOkBtn) callPlayersOkBtn.addEventListener('click', closeCallPlayersModal);
if (callPlayersCloseX) callPlayersCloseX.addEventListener('click', closeCallPlayersModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && callPlayersOverlay && !callPlayersOverlay.hidden) closeCallPlayersModal(); });

/* ================= "It's your turn!" popup — spectator side =================
   Shown on a SPECTATOR device the moment the host calls that device's
   registered player name. This is the guaranteed channel: the OS push
   notification (fireNotification, inside enterViewerMode below) still
   fires alongside it when Notification permission was granted, but most
   phones never grant that (iOS Safari especially), so this in-app dialog —
   which needs no permission at all — is what actually reaches most players.
   Queued the same way the confirm dialog is, in case two calls land close
   together (e.g. the host calls twice in a row). */
const playerCalledOverlay = $('#playerCalledOverlay');
const playerCalledTitleEl = $('#playerCalledTitle');
const playerCalledBodyEl = $('#playerCalledBody');
const playerCalledOkBtn = $('#playerCalledOkBtn');
const playerCalledQueue = [];
let playerCalledActive = false;
function showNextPlayerCalledDialog(){
  if (playerCalledActive || playerCalledQueue.length === 0 || !playerCalledOverlay) return;
  const call = playerCalledQueue.shift();
  playerCalledActive = true;
  if (playerCalledTitleEl) playerCalledTitleEl.textContent = (call && call.title) || "It's your turn!";
  if (playerCalledBodyEl) playerCalledBodyEl.textContent = (call && call.body) || 'The host is calling you to the courts.';
  playerCalledOverlay.hidden = false;
  if (playerCalledOkBtn) playerCalledOkBtn.focus();
  // Vibration doesn't require Notification permission and works on most
  // Android browsers even when the OS notification itself can't fire —
  // an extra nudge in case the phone is face-down on the sideline.
  try{ if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }catch(e){}
}
function closePlayerCalledDialog(){
  if (!playerCalledOverlay) return;
  playerCalledOverlay.hidden = true;
  playerCalledActive = false;
  showNextPlayerCalledDialog();
}
function showPlayerCalledDialog(call){
  playerCalledQueue.push(call || {});
  showNextPlayerCalledDialog();
}
if (playerCalledOkBtn) playerCalledOkBtn.addEventListener('click', closePlayerCalledDialog);
if (playerCalledOverlay) playerCalledOverlay.addEventListener('click', (e) => { if (e.target === playerCalledOverlay) closePlayerCalledDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && playerCalledOverlay && !playerCalledOverlay.hidden) closePlayerCalledDialog(); });

/* ================= Skill-level picker dialog ================= */
/* Tapping a player's skill-level badge opens this dialog instead of
   cycling on a press-and-hold — a clear list of every level beats a
   blind long-press, and it works the same on mouse and touch. */
const levelPickerOverlay = $('#levelPickerOverlay');
const levelPickerNameEl = $('#levelPickerName');
const levelPickerListEl = $('#levelPickerList');
const levelPickerCancelBtn = $('#levelPickerCancelBtn');
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
let levelPickerName = null;
function openLevelPicker(name){
  if (isCoHostRestricted()) return;
  if (!name || !levelPickerOverlay) return;
  levelPickerName = name;
  levelPickerNameEl.textContent = name;
  const current = getPlayerLevel(name);
  levelPickerListEl.innerHTML = PLAYER_LEVELS.map(level => `
    <button type="button" class="level-picker-option${level === current ? ' current' : ''}" data-level="${esc(level)}">
      <span>${esc(levelLabel(level))}</span>
      <span class="level-picker-check">${CHECK_ICON}</span>
    </button>
  `).join('');
  levelPickerOverlay.hidden = false;
}
function closeLevelPicker(){
  if (!levelPickerOverlay || levelPickerOverlay.hidden) return;
  levelPickerOverlay.hidden = true;
  levelPickerName = null;
}
if (levelPickerListEl){
  levelPickerListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-level]');
    if (!btn || !levelPickerName) return;
    const name = levelPickerName;
    const level = btn.dataset.level;
    closeLevelPicker();
    if (level === getPlayerLevel(name)) return;
    setPlayerLevel(name, level);
    toast(name + ' set to ' + levelLabel(level));
    renderAll(); persist();
  });
}
if (levelPickerCancelBtn) levelPickerCancelBtn.addEventListener('click', closeLevelPicker);
if (levelPickerOverlay) levelPickerOverlay.addEventListener('click', (e) => { if (e.target === levelPickerOverlay) closeLevelPicker(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && levelPickerOverlay && !levelPickerOverlay.hidden) closeLevelPicker(); });

/* ================= Sound ================= */
let audioCtx = null;
function ping(){
  if (!state.session.soundOn) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = 740;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.32);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.33);
  }catch(e){}
}

/* ================= Render: Stack ================= */
// Escapes for both text-node and attribute-value contexts. The previous
// textContent->innerHTML trick never escaped quote characters, so a player
// name containing a `"` could break out of attributes like value="..." or
// aria-label="..." and inject markup. This escapes everything that matters.
function esc(s){
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Adds native-<select>-like keyboard support to a themed custom-select
// (trigger button + list-box panel of ".custom-select-option" rows), used
// by both the Match History filters and "Call out a player" > court picker.
// Without this they only responded to a mouse/tap, unlike every other
// dropdown/modal in the app which already closes on Escape.
//   trigger  — the button that opens/closes the panel
//   panel    — the container the ".custom-select-option" rows are rendered into
//   controls — { isOpen(), open(), close(), choose(optionEl) }
function wireCustomSelectKeyboardNav(trigger, panel, controls){
  function optionEls(){ return Array.from(panel.querySelectorAll('.custom-select-option')); }
  function focusOpt(el){ if (el) el.focus(); }
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if (!controls.isOpen()) controls.open();
      const opts = optionEls();
      const selected = opts.find(o => o.getAttribute('aria-selected') === 'true');
      focusOpt(e.key === 'ArrowUp' ? opts[opts.length - 1] : (selected || opts[0]));
    } else if (e.key === 'Escape' && controls.isOpen()){
      e.preventDefault();
      controls.close();
    }
  });
  panel.addEventListener('keydown', (e) => {
    const opts = optionEls();
    const idx = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown'){ e.preventDefault(); focusOpt(opts[Math.min(idx + 1, opts.length - 1)] || opts[0]); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); focusOpt(opts[Math.max(idx - 1, 0)] || opts[0]); }
    else if (e.key === 'Home'){ e.preventDefault(); focusOpt(opts[0]); }
    else if (e.key === 'End'){ e.preventDefault(); focusOpt(opts[opts.length - 1]); }
    else if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); if (idx >= 0) controls.choose(opts[idx]); }
    else if (e.key === 'Escape'){ e.preventDefault(); controls.close(); trigger.focus(); }
    else if (e.key === 'Tab'){ controls.close(); }
  });
}

// Display-only: uppercases a name for the court card, without touching the
// underlying stored name (used as-is everywhere else — stack, rankings, history, etc).
function courtCardName(name){
  return String(name).toUpperCase();
}

// Defense-in-depth: player names are free text and end up as object keys
// (state.playerStats[name], etc). A name literally equal to "__proto__",
// "constructor", or "prototype" would otherwise let bracket assignment
// walk the prototype chain instead of creating a normal own property.
// Blocking these three reserved words keeps every keyed lookup below safe
// regardless of whether the name was typed in or came from an imported
// backup file.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isUnsafeName(name){
  return UNSAFE_OBJECT_KEYS.has(String(name).trim().toLowerCase());
}

const AVATAR_COLORS = ['#0038A8','#CE1126','#C79A00','#00256E','#9E0C1D','#3B6EA5','#8A5FBE','#5A7A9C'];
function avatarColor(name){
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name){
  const parts = name.trim().split(/\s+/);
  const raw = ((parts[0]?.[0]||'') + (parts[1]?.[0]||'')).toUpperCase() || '?';
  return esc(raw);
}

/* ================= Player Calling / Notification shared helpers =================
   Used both host-side (building the "call out a player" picker) and viewer-side
   (building the "which player are you?" picker) — same union of every name
   currently anywhere in `state`, so nobody present on the floor is missing from
   either list, whether or not the host has formally added them to the roster. */
function collectAllPlayerNames(){
  const names = new Set();
  const add = (n) => { const t = n && String(n).trim(); if (t) names.add(t); };
  (state.roster || []).forEach(add);
  (state.stack || []).forEach(p => add(p.name));
  (state.arrivals || []).forEach(p => add(p.name));
  (state.winnersBlock || []).forEach(p => add(p.name));
  (state.losersBlock || []).forEach(p => add(p.name));
  (state.courts || []).forEach(c => (c.players || []).forEach(add));
  return [...names].sort((a, b) => a.localeCompare(b));
}
// Shared name-comparison normalizer: trims, lowercases, collapses internal
// whitespace runs, and folds accents/diacritics (e.g. "José" vs "Jose")
// — used for every duplicate/collision check so two names that a human
// would call "the same" can't slip past as different players just because
// of a stray double space or an accent mark. Never used for anything that
// touches DISPLAY (the name typed in is always what's stored and shown).
function normalizeName(name){
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
function namesMatch(a, b){
  return normalizeName(a) === normalizeName(b);
}
function getStats(name){
  if (isUnsafeName(name)) return { wins: 0, games: 0, scoreSum: 0, scoreGames: 0 };
  if (!Object.prototype.hasOwnProperty.call(state.playerStats, name)) state.playerStats[name] = { wins: 0, games: 0, scoreSum: 0, scoreGames: 0 };
  if (state.playerStats[name].scoreSum === undefined) state.playerStats[name].scoreSum = 0;
  if (state.playerStats[name].scoreGames === undefined) state.playerStats[name].scoreGames = 0;
  return state.playerStats[name];
}
function getGamesPlayed(name){
  const s = state.playerStats[name];
  return s ? (s.games || 0) : 0;
}
function gamesChipHtml(games){
  const label = games === 1 ? 'GAME PLAYED' : 'GAMES PLAYED';
  const atTarget = state.session.targetGamesEnabled && games >= state.session.targetGamesPerPlayer;
  const cls = 'games-chip' + (atTarget ? ' at-target' : '');
  const title = atTarget
    ? `${games} ${games === 1 ? 'game' : 'games'} played this session — target reached`
    : `${games} ${games === 1 ? 'game' : 'games'} played this session`;
  return `<span class="${cls}" title="${title}">${games} ${label}${atTarget ? ' ✓' : ''}</span>`;
}

/* ---- Target Games: smart match selection ----
   When enabled, picks the next match from the stack by prioritizing players
   with fewer games played (so everyone reaches the target as evenly as
   possible), while keeping FIFO order as the tie-break for equal game counts.
   This never removes/reorders the underlying stack itself — it only decides
   which entries get pulled for the next match. Players are never skipped
   permanently: once the below-target pool runs dry, at-/above-target players
   are pulled in normal FIFO order to keep courts moving. */
function selectMatchEntries(gameSize, sourceStack){
  const stack = sourceStack || state.stack;
  let base;
  if (!state.session.targetGamesEnabled || stack.length === 0){
    base = stack.slice(0, gameSize);
  } else {
    const indexed = stack.map((entry, idx) => ({
      entry, idx, games: getGamesPlayed(entry.name)
    }));
    indexed.sort((a, b) => (a.games - b.games) || (a.idx - b.idx));
    const chosen = indexed.slice(0, gameSize);
    chosen.sort((a, b) => a.idx - b.idx); // restore original stack (FIFO) order for display/team-split
    base = chosen.map(c => c.entry);
  }
  return applyFixedDuoToSelection(base, stack, gameSize);
}
/* Fixed Duos affect how a chosen foursome gets split into teams (see
   bestTeamSplit's findFixedDuo) — if both members of a fixed duo happen to
   already be in the match, they're kept on the same team. That alone isn't
   enough, though: a Fixed Duo is one team, not two independent players, and
   that has to be enforced at SELECTION time too, or the duo can simply
   never end up in the same match to begin with.

   So first, if a duo has exactly one member already selected, this reaches
   into the ENTIRE pool passed in (not just the next player in line) for
   the missing partner. `pool` here is always the full remaining candidate
   list for this match/court/level — the same one selectMatchEntries drew
   `base` from — so as long as the partner hasn't already been claimed by a
   court/group formed earlier in this same pass, they WILL be found and
   pulled in, no matter how far back in FIFO order they happen to sit. This
   is what keeps a duo together for an entire session (24 players, many
   rotations, multiple courts) instead of only for the first few games —
   the old "only the very next player in line" reach could, and eventually
   would, let a duo drift apart once their partner fell more than one spot
   behind. (When the partner has already been locked into a DIFFERENT
   match/court formed earlier this same pass, that's a cross-group split —
   see reconcileFixedDuosAcrossGroups, which handles that case instead.)

   The player displaced by the incoming partner is simply the one of the
   four already-selected players who has waited the LEAST long (last in
   FIFO order) — they keep their exact queue position and are simply first
   in line for the very next match, so nobody actually loses a turn.

   Second, once the duo is confirmed together, this also looks at who ELSE
   ended up in the match (their opponents) and, within a small bounded
   lookahead, prefers opponents the duo (and the other flex player) haven't
   already faced/teamed with repeatedly — see optimizeFlexOpponents. */
function applyFixedDuoToSelection(base, pool, gameSize){
  if (gameSize !== 4 || !state.session.avoidRepeatTeammates || state.session.fixedDuosEnabled === false) return base;
  const duos = state.session.fixedDuos || [];
  if (duos.length === 0 || base.length === 0 || base.length > pool.length) return base;
  const idxOf = new Map();
  pool.forEach((e, i) => idxOf.set(e.id, i));
  let result = base.slice();
  duos.forEach(duo => {
    const names = result.map(e => e.name);
    const hasA = names.includes(duo.a), hasB = names.includes(duo.b);
    if (hasA === hasB) return; // both already together, or neither in this match — nothing to adjust
    const presentName = hasA ? duo.a : duo.b;
    const missingName = hasA ? duo.b : duo.a;
    const resultIds = new Set(result.map(e => e.id));
    // Reach anywhere in the eligible pool for the missing partner — not
    // just the very next waiting player. This is the fix for fixed duos
    // eventually drifting apart over a long session.
    const missingEntry = pool.find(e => e.name === missingName && !resultIds.has(e.id));
    if (!missingEntry) return; // partner isn't available in this pool at all right now — nothing to do here
    // Swap the incoming partner into the LAST slot that isn't the duo member
    // already in the match. `result` is in FIFO order, so the true last slot
    // can sometimes BE the present duo member themselves (they just happen to
    // be the most-recently-queued of the four) — overwriting that slot would
    // eject the very player we're trying to keep in, bouncing them back to
    // the front of the queue instead of pairing them with their partner.
    let displaceIdx = -1;
    for (let i = result.length - 1; i >= 0; i--){
      if (result[i].name !== presentName){ displaceIdx = i; break; }
    }
    if (displaceIdx === -1) return; // shouldn't happen, but never displace the duo member itself
    result[displaceIdx] = missingEntry; // swap them into the match's last available (non-duo) slot
  });
  // Restore stack (FIFO) order so display and team-splitting stay consistent.
  result.sort((a, b) => (idxOf.get(a.id) ?? 0) - (idxOf.get(b.id) ?? 0));

  // With the duo now confirmed together (if one is present), see if a
  // better set of opponents is available nearby in the queue.
  const activeDuo = findFixedDuo(result.map(e => e.name));
  if (activeDuo){
    result = optimizeFlexOpponents(result, pool, activeDuo);
    result.sort((a, b) => (idxOf.get(a.id) ?? 0) - (idxOf.get(b.id) ?? 0));
  }
  return result;
}

// How far past the players already selected this is willing to look for a
// fresher opponent. Small on purpose — this is a courtesy improvement over
// straight FIFO, not a re-sort of the whole queue, so it never meaningfully
// delays anyone else's turn.
const FLEX_OPPONENT_WINDOW = 3;
/* Once a Fixed Duo is locked into a match, the other two seats decide who
   the duo actually faces. Left to pure FIFO, the same "next in line" pair
   can keep landing in those seats match after match (especially with the
   winners/losers block, which flushes in strict arrival order) —
   recreating the exact same match-up repeatedly, which is bug #4/#5 in the
   fix request. This looks a few players further down the SAME pool for a
   replacement for each non-duo seat, and only swaps them in if doing so
   provably lowers the total repeat cost (teammate + opponent history) of
   the match that would result — see bestTeamSplit. Players who are
   themselves half of a (different) fixed duo are never pulled in this way,
   since doing so would just create a new "duo split across matches"
   problem for this function to have to fix on a later pass. */
function optimizeFlexOpponents(result, pool, duo){
  const flexIdxs = [];
  result.forEach((e, i) => { if (e.name !== duo.a && e.name !== duo.b) flexIdxs.push(i); });
  if (flexIdxs.length === 0) return result;
  let working = result.slice();
  let workingIds = new Set(working.map(e => e.id));
  const costOf = (arr) => bestTeamSplit(arr.map(e => e.name)).cost;
  flexIdxs.forEach(flexIdx => {
    const candidates = pool.filter(e => !workingIds.has(e.id) && !isInFixedDuo(e.name)).slice(0, FLEX_OPPONENT_WINDOW);
    if (candidates.length === 0) return;
    let bestCost = costOf(working);
    let bestCandidate = null;
    candidates.forEach(cand => {
      const trial = working.slice();
      trial[flexIdx] = cand;
      const cost = costOf(trial);
      if (cost < bestCost){
        bestCost = cost;
        bestCandidate = cand;
      }
    });
    if (bestCandidate){
      workingIds.delete(working[flexIdx].id);
      working[flexIdx] = bestCandidate;
      workingIds.add(bestCandidate.id);
    }
  });
  return working;
}
/* Fixed Duos, continued: the "next in line" reach above only catches a
   partner who hasn't been claimed by ANY group yet. It can't help when both
   groups have already formed separately and each grabbed one half of the
   duo — e.g. Marcus lands in the very next match while Logan, his fixed
   duo partner, is buried three matches deeper and already locked into that
   match too. When that happens, unite them with a straight swap: the
   EARLIER group's duo member moves down to join their partner in the LATER
   group, trading places with whoever currently fills the last non-duo seat
   there. That displaced player simply takes over the mover's now-empty seat
   in the earlier group — nobody outside the trade skips ahead of anyone
   they weren't already sharing a group with, unlike reaching deep into the
   still-unclaimed queue (which the "next in line" rule deliberately avoids).
   `levelForGroup`, if given, is called with a group's index and must return
   its required skill level — the swap is skipped if either player wouldn't
   fit the level they're moving into (used for the per-court preview, where
   each court can be locked to a level; omit it for a single flat queue).
   Fixed Duos are a doubles-only concept (a duo IS a team), so this is a
   no-op outside gameSize 4 — same restriction applyFixedDuoToSelection
   already enforces for the same reason. */
function reconcileFixedDuosAcrossGroups(groups, pool, gameSize, levelForGroup){
  if (gameSize !== 4 || !state.session.avoidRepeatTeammates || state.session.fixedDuosEnabled === false || groups.length < 2) return groups;
  const duos = state.session.fixedDuos || [];
  if (duos.length === 0) return groups;
  const idxOf = new Map();
  pool.forEach((e, i) => idxOf.set(e.id, i));
  const result = groups.map(g => g.slice());
  duos.forEach(duo => {
    let groupA = -1, groupB = -1;
    result.forEach((g, gi) => {
      if (g.some(e => e.name === duo.a)) groupA = gi;
      if (g.some(e => e.name === duo.b)) groupB = gi;
    });
    if (groupA === -1 || groupB === -1 || groupA === groupB) return; // together already, or one/both not in a formed group
    const earlier = Math.min(groupA, groupB), later = Math.max(groupA, groupB);
    const moverName = earlier === groupA ? duo.a : duo.b;
    const staysName = earlier === groupA ? duo.b : duo.a;
    const earlierGroup = result[earlier], laterGroup = result[later];
    const moverIdx = earlierGroup.findIndex(e => e.name === moverName);
    if (moverIdx === -1) return;
    let displaceIdx = -1;
    for (let i = laterGroup.length - 1; i >= 0; i--){
      if (laterGroup[i].name !== staysName){ displaceIdx = i; break; }
    }
    if (displaceIdx === -1) return;
    const mover = earlierGroup[moverIdx];
    const displaced = laterGroup[displaceIdx];
    if (levelForGroup){
      const moverLevel = getPlayerLevel(mover.name), displacedLevel = getPlayerLevel(displaced.name);
      if (!levelsMatch(moverLevel, levelForGroup(later)) || !levelsMatch(displacedLevel, levelForGroup(earlier))) return;
    }
    earlierGroup[moverIdx] = displaced;
    laterGroup[displaceIdx] = mover;
    earlierGroup.sort((a, b) => (idxOf.get(a.id) ?? 0) - (idxOf.get(b.id) ?? 0));
    laterGroup.sort((a, b) => (idxOf.get(a.id) ?? 0) - (idxOf.get(b.id) ?? 0));
  });
  return result;
}
function removeEntriesFromStack(entries){
  const ids = new Set(entries.map(e => e.id));
  state.stack = state.stack.filter(e => !ids.has(e.id));
  state.winnersBlock = state.winnersBlock.filter(e => !ids.has(e.id));
  state.losersBlock = state.losersBlock.filter(e => !ids.has(e.id));
}

/* ---- "Off court and free" lookups, shared by all the substitute pickers ----
   A sub candidate can be waiting in the main stack OR parked in either
   accumulating block (winners/losers) — anyone not currently on a court is
   fair game. These helpers search/remove across all three so the picker
   never comes up empty just because the free players happen to be sitting
   in a block instead of the stack. */
function findWaitingEntryById(id){
  let idx = state.stack.findIndex(e => e.id === id);
  if (idx !== -1) return { src: 'stack', idx, entry: state.stack[idx] };
  idx = state.winnersBlock.findIndex(e => e.id === id);
  if (idx !== -1) return { src: 'winnersBlock', idx, entry: state.winnersBlock[idx] };
  idx = state.losersBlock.findIndex(e => e.id === id);
  if (idx !== -1) return { src: 'losersBlock', idx, entry: state.losersBlock[idx] };
  return null;
}
function removeWaitingEntryById(id){
  const found = findWaitingEntryById(id);
  if (!found) return null;
  state[found.src].splice(found.idx, 1);
  return found.entry;
}
function getAllWaitingEntries(){
  return [
    ...state.stack.map(e => ({ ...e, __src: 'stack' })),
    ...state.winnersBlock.map(e => ({ ...e, __src: 'winnersBlock' })),
    ...state.losersBlock.map(e => ({ ...e, __src: 'losersBlock' }))
  ];
}
// Places a (freshly requeued) entry back into whichever waiting pool a sub
// pick came from — the main stack, or one of the accumulating blocks — at
// roughly the slot it was pulled from. This is what makes a substitution a
// true swap: pulling someone out of the winners block to fill a spot puts
// the outgoing player INTO the winners block in their place, instead of
// always dumping them at the back of the main stack and quietly shrinking
// whichever block they were borrowed from.
function insertIntoWaitingSource(srcKey, srcIdx, entry){
  if (srcKey === 'stack'){ state.stack.push(entry); return; }
  const arr = state[srcKey];
  const insertAt = Math.min(srcIdx, arr.length);
  arr.splice(insertAt, 0, entry);
}

/* ---- Avoid Repeating Teammates: best-effort team-pairing ----
   Only meaningful for doubles (2-per-team). Given the players already chosen
   for a match (selection/priority untouched), reorders them so that
   splitTeams() produces the teammate pairing with the fewest prior times
   paired together. Falls back to a repeat only when every possible pairing
   has already happened (last resort). Does not change who is selected to
   play — only how the same four players are split into two teams. */
function pairKey(n1, n2){ return [n1, n2].sort().join('||'); }
function teammateCount(n1, n2){ return state.teammateHistory[pairKey(n1, n2)] || 0; }
function recordTeammates(teamNames){
  for (let i = 0; i < teamNames.length; i++){
    for (let j = i + 1; j < teamNames.length; j++){
      const k = pairKey(teamNames[i], teamNames[j]);
      state.teammateHistory[k] = (state.teammateHistory[k] || 0) + 1;
    }
  }
}
/* ---- Opponent history: mirrors teammateHistory above, but tracks how many
   times two players have ended up on OPPOSING teams instead of the same
   one. Recorded once per finished game (see the endgame confirm handler),
   using the two final team rosters — every player on team A gets an
   opponent-history bump against every player on team B, and vice versa.
   This is what lets matchmaking measure "these two/these two teams have
   already played each other N times" instead of only ever looking at
   teammate repeats. Fixed Duos are just two players like any other here —
   the duo's combined opponent exposure is simply the sum of each member's
   individual opponent counts against the other side, which is exactly what
   groupOpponentCost below computes. */
function opponentCount(n1, n2){ return (state.opponentHistory && state.opponentHistory[pairKey(n1, n2)]) || 0; }
function recordOpponents(teamA, teamB){
  if (!state.opponentHistory) state.opponentHistory = {};
  teamA.forEach(a => {
    teamB.forEach(b => {
      const k = pairKey(a, b);
      state.opponentHistory[k] = (state.opponentHistory[k] || 0) + 1;
    });
  });
}
// Total prior meetings between two 2-player teams, counting every
// cross-team pair once — the standard way to score "how repetitive would
// teamA vs teamB be" for a doubles match-up.
function groupOpponentCost(teamA, teamB){
  let cost = 0;
  teamA.forEach(a => teamB.forEach(b => { cost += opponentCount(a, b); }));
  return cost;
}
/* Fixed Duos: pairs of players who should always end up on the same team
   whenever both are in a match, overriding the repeat-pairing cost logic
   below. Only meaningful (and only editable in Settings) while "Avoid
   Repeating Teammates" is on. */
function findFixedDuo(names){
  const duos = state.session.fixedDuos || [];
  for (const duo of duos){
    if (names.includes(duo.a) && names.includes(duo.b)) return duo;
  }
  return null;
}
// True when `name` is half of an active Fixed Duo — used to lock the
// manual swap-partner control so nobody can drag-and-drop split up a pair
// the host explicitly asked to always keep together. Fixed duos only take
// effect while "Avoid Repeating Teammates" is on, so the lock follows suit.
function isInFixedDuo(name){
  if (!state.session.avoidRepeatTeammates || state.session.fixedDuosEnabled === false) return false;
  const duos = state.session.fixedDuos || [];
  return duos.some(d => d.a === name || d.b === name);
}
// Returns the partner's name when `name` is half of an active Fixed Duo,
// otherwise null. Used by the player-details preview to surface duo status
// alongside the rest of a player's info at a glance.
function fixedDuoPartner(name){
  if (!state.session.avoidRepeatTeammates || state.session.fixedDuosEnabled === false) return null;
  const duos = state.session.fixedDuos || [];
  const d = duos.find(x => x.a === name || x.b === name);
  if (!d) return null;
  return d.a === name ? d.b : d.a;
}
/* Works out the best 2v2 split of exactly four names, and how "costly"
   (repetitive) that split is. Cost combines two things: repeated TEAMMATES
   (pairing the same two people together again) and repeated OPPONENTS
   (pitting the same two pairs against each other again) — without the
   opponent term, a split that minimizes teammate repeats could still
   recreate a match-up these same four players (or their fixed duos) have
   already played several times. A Fixed Duo present in `names` removes the
   teammate choice entirely (they're always on the same team, regardless of
   cost) but the opponent cost of who they're facing still applies and is
   used elsewhere (see optimizeFlexOpponents) to pick better opponents
   *before* this function ever gets called for a duo match. */
function bestTeamSplit(names){
  const duo = findFixedDuo(names);
  if (duo){
    const others = names.filter(n => n !== duo.a && n !== duo.b);
    const teamA = [duo.a, duo.b], teamB = [others[0], others[1]];
    const cost = teammateCount(teamA[0], teamA[1]) + teammateCount(teamB[0], teamB[1]) + groupOpponentCost(teamA, teamB);
    return { order: [duo.a, duo.b, others[0], others[1]], teamA, teamB, cost, forcedDuo: true };
  }
  const [p0, p1, p2, p3] = names;
  const options = [
    { order: [p0,p1,p2,p3], teamA: [p0,p1], teamB: [p2,p3] },
    { order: [p0,p2,p1,p3], teamA: [p0,p2], teamB: [p1,p3] },
    { order: [p0,p3,p1,p2], teamA: [p0,p3], teamB: [p1,p2] }
  ].map(o => ({
    ...o,
    cost: teammateCount(o.teamA[0], o.teamA[1]) + teammateCount(o.teamB[0], o.teamB[1]) + groupOpponentCost(o.teamA, o.teamB)
  }));
  const minCost = Math.min(...options.map(o => o.cost));
  // Deterministic tie-break (first minimal-cost option) rather than Math.random():
  // this is called once to render the "next up" preview and again when
  // "Call next" is actually clicked, so it must return the same answer both
  // times for the same state — a random pick here would let the preview
  // disagree with the match that's actually formed.
  const winner = options.find(o => o.cost === minCost);
  return { ...winner, forcedDuo: false };
}
function computeTeamPairing(names){
  if (!state.session.avoidRepeatTeammates || names.length !== 4) return { order: names.slice(), forcedDuo: false };
  const split = bestTeamSplit(names);
  return { order: split.order, forcedDuo: split.forcedDuo };
}
function orderForTeammatePairing(names){
  return computeTeamPairing(names).order;
}
/* True when both arrays contain exactly the same names (any order, with
   repeats counted) — used to tell whether a manually-set preview arrangement
   still applies to the court's current natural line-up, or whether the
   underlying group of players has moved on and the override should be
   dropped. */
function sameNameMultiset(a, b){
  if (!a || !b || a.length !== b.length) return false;
  const sa = a.slice().sort(), sb = b.slice().sort();
  return sa.every((n, i) => n === sb[i]);
}
/* Compares the "natural" pairing (players in their priority/FIFO order, before
   avoidance) against the pairing actually chosen, and — if they differ —
   describes the swap for the transparency log. Returns null when nothing
   changed (no swap needed) or the feature isn't a fit (not doubles). */
function buildSwapInfo(naturalNames, chosenNames, forcedDuo){
  if (naturalNames.length !== 4) return null;
  if (JSON.stringify(naturalNames) === JSON.stringify(chosenNames)) return null;
  const [natA, natB] = splitTeams(naturalNames);
  const [chA, chB] = splitTeams(chosenNames);
  return {
    naturalTeamA: natA, naturalTeamB: natB,
    chosenTeamA: chA, chosenTeamB: chB,
    naturalCost: teammateCount(natA[0], natA[1]) + teammateCount(natB[0], natB[1]) + groupOpponentCost(natA, natB),
    chosenCost: teammateCount(chA[0], chA[1]) + teammateCount(chB[0], chB[1]) + groupOpponentCost(chA, chB),
    forcedDuo: !!forcedDuo
  };
}

/* ================= Session lock (Resume) =================
   The explicit "End session" trigger (button + endSession()) was removed —
   sessions are no longer locked by a manual action from Settings. This
   lock/resume machinery stays in place purely so a session that was
   already marked 'ended' before this update (or via an older synced
   device/backup) can still be reviewed and resumed normally; nothing new
   can set state.session.status to 'ended' going forward. */
function isSessionEnded(){ return state.session.status === 'ended'; }

function applySessionLockUI(){
  const ended = isSessionEnded();
  document.body.classList.toggle('session-locked', ended);
  sessionBanner.hidden = !ended;
  addNameInput.disabled = ended;
  const addBtn = addForm.querySelector('button[type="submit"]');
  if (addBtn) addBtn.disabled = ended;
  if (addHintEl){
    addHintEl.textContent = ended
      ? 'Session ended — the stack is locked. Resume the session to keep adding players.'
      : 'Add players in the order they arrive. First in, first up.';
  }
}

function resumeSession(){
  if (isCoHostRestricted()) return;
  state.session.status = 'active';
  persist();
  applySessionLockUI();
  renderAll();
  toast('Session resumed');
}

function renderStack(){
  stackBadge.textContent = state.stack.length;
  stackCountPill.textContent = state.stack.length + ' in stack';
  stackList.innerHTML = '';
  if (state.stack.length === 0){
    stackList.innerHTML = `<div class="stack-empty">
      The queue is empty.<br>Tap "Add Player" to get the queue started, or watch live games hosted by others.
      <button type="button" class="btn ghost sm stack-empty-scan-btn" id="stackEmptyScanBtn">
        <svg viewBox="0 0 24 24"><use href="#i-qr"/></svg>Scan QR Code
      </button>
    </div>`;
    return;
  }
  const gameSize = state.session.gameSize;
  const openQueue = computeOpenCourtQueue(gameSize);
  const nextUpIds = new Set();
  openQueue.forEach(slot => { if (slot.taken) slot.taken.forEach(e => nextUpIds.add(e.id)); });

  // The stack is really a set of separate per-level queues sharing one
  // panel: group entries by level (preserving each level's own FIFO order)
  // so it's visually — and, via the up/down handlers below, functionally —
  // a distinct line per court type instead of one mixed-level list.
  const levelsPresent = PLAYER_LEVELS.filter(lvl => state.stack.some(e => getPlayerLevel(e.name) === lvl));
  levelsPresent.forEach(level => {
    const groupEntries = state.stack.filter(e => getPlayerLevel(e.name) === level);
    const groupWrap = document.createElement('div');
    groupWrap.className = 'stack-group';
    groupWrap.innerHTML = `
      <div class="stack-group-head">
        <span class="level-badge ${levelClass(level)}">${esc(levelLabel(level))}</span>
        <span class="stack-group-count">${groupEntries.length} in queue</span>
      </div>
    `;
    groupEntries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'paddle' + (nextUpIds.has(entry.id) ? ' next-up' : '');
      row.dataset.id = entry.id;
      const stats = state.playerStats[entry.name];
      const winChip = (stats && stats.wins > 0) ? `<span class="win-chip">🏆${stats.wins}</span>` : '';
      const games = stats ? (stats.games || 0) : 0;
      const gamesChip = gamesChipHtml(games);
      const tag = entry.tag === 'queued' ? '<span class="tag-pill queued">Queued</span>' : '<span class="tag-pill new">New</span>';
      const levelBadge = `<button type="button" class="level-badge ${levelClass(getPlayerLevel(entry.name))}" data-act="cycle-level" data-name="${esc(entry.name)}" title="Change skill level">${esc(levelLabel(getPlayerLevel(entry.name)))}</button>`;
      row.innerHTML = `
        <span class="pos">${idx+1}</span>
        ${avatarHtml(entry.name)}
        <span class="name-col">
          <span class="name">${esc(entry.name)}${winChip}</span>
          <span class="sub-row">${tag}${levelBadge}${gamesChip}</span>
        </span>
        <span class="reorder">
          <button type="button" data-act="up" aria-label="Move up"><svg viewBox="0 0 24 24"><use href="#i-up"/></svg></button>
          <button type="button" data-act="down" aria-label="Move down"><svg viewBox="0 0 24 24"><use href="#i-down"/></svg></button>
        </span>
        <button type="button" class="remove-btn" data-act="remove" aria-label="Remove ${esc(entry.name)}"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
      `;
      groupWrap.appendChild(row);
    });
    stackList.appendChild(groupWrap);
  });
}

/* ================= Accumulating blocks (winners vs winners, losers vs losers) =================
   Each level accumulates and flushes independently — a Beginner winner and
   an Advanced winner never end up bundled into the same "group" even though
   they share one underlying block array (level is looked up per entry via
   getPlayerLevel, same as everywhere else). */
function blockItemsHtml(entries, readOnly, blockKey){
  return entries.map((entry, idx) => {
    const levelBadge = readOnly
      ? `<span class="level-badge ${levelClass(getPlayerLevel(entry.name))}">${esc(levelLabel(getPlayerLevel(entry.name)))}</span>`
      : `<button type="button" class="level-badge ${levelClass(getPlayerLevel(entry.name))}" data-act="cycle-level" data-name="${esc(entry.name)}" title="Change skill level">${esc(levelLabel(getPlayerLevel(entry.name)))}</button>`;
    const subPermitted = !coHostMode || getCohostPermissions().allowSubstitution;
    const subBtn = (readOnly || !subPermitted) ? '' : `<button type="button" class="block-item-sub-btn" data-block-sub="${blockKey}" data-entry-id="${entry.id}" aria-label="Substitute ${esc(entry.name)}" title="Sub in a replacement for ${esc(entry.name)}"><svg viewBox="0 0 24 24"><use href="#i-sub"/></svg></button>`;
    return `
    <div class="block-item" data-id="${entry.id}">
      <span class="block-item-pos">${idx+1}</span>
      <span class="block-item-name">${esc(entry.name)}</span>
      ${levelBadge}
      ${subBtn}
    </div>
  `;
  }).join('');
}
function blockListHtml(block, gameSize, blockKey, readOnly){
  if (block.length === 0) return '<div class="block-empty">Empty — waiting for a result.</div>';
  const levels = PLAYER_LEVELS.filter(lvl => block.some(e => getPlayerLevel(e.name) === lvl));
  // A single-level block is fully covered by the block header's own count
  // and "Queue now" button, so skip the per-level sub-header here — showing
  // both would just be two identical controls stacked on top of each other.
  if (levels.length <= 1){
    return blockItemsHtml(block, readOnly, blockKey);
  }
  return levels.map(level => {
    const entries = block.filter(e => getPlayerLevel(e.name) === level);
    const flushBtn = readOnly ? '' : `<button type="button" class="block-level-flush-btn" data-block-flush="${blockKey}" data-level-flush="${esc(level)}" aria-label="Move ${esc(levelLabel(level))} group to queue now">Queue now</button>`;
    return `
      <div class="block-level-group">
        <div class="block-level-head">
          <span class="level-badge ${levelClass(level)}">${esc(levelLabel(level))}</span>
          <span class="block-level-count">${entries.length}/${gameSize}</span>
          ${flushBtn}
        </div>
        ${blockItemsHtml(entries, readOnly, blockKey)}
      </div>
    `;
  }).join('');
}

function renderBlocks(){
  const gameSize = state.session.gameSize;
  // A block entry that's already been picked (via the Sub button on an
  // open court's preview matchup) to fill an upcoming game is no longer
  // actually "waiting" — without subtracting those out, subbing a blocked
  // player into a preview left them listed here as still "waiting" right
  // up until the court's match actually started: visually duplicated on
  // both the block panel and the court they'd already been placed on.
  const claimedIds = getPreviewClaimedIds();
  const winnersWaiting = state.winnersBlock.filter(e => !claimedIds.has(e.id));
  const losersWaiting = state.losersBlock.filter(e => !claimedIds.has(e.id));
  const hasAny = winnersWaiting.length > 0 || losersWaiting.length > 0;
  blocksPanel.hidden = !hasAny;
  if (hasAny){
    winnersBlockCount.textContent = winnersWaiting.length + ' waiting';
    losersBlockCount.textContent = losersWaiting.length + ' waiting';
    winnersBlockList.innerHTML = blockListHtml(winnersWaiting, gameSize, 'winnersBlock');
    losersBlockList.innerHTML = blockListHtml(losersWaiting, gameSize, 'losersBlock');

    blocksPanel.querySelector('[data-block="winners"]').disabled = winnersWaiting.length === 0 || isSessionEnded();
    blocksPanel.querySelector('[data-block="losers"]').disabled = losersWaiting.length === 0 || isSessionEnded();
  }

  // Read-only mirror of the same data for the spectator view (no "Queue
  // now" controls — flushing blocks is a host action). Only ever populated
  // and shown in viewer mode — on the host's own screen it stays hidden,
  // since the host already has the full interactive panel above.
  const vPanel = $('#viewerBlocksPanel');
  if (vPanel){
    if (!viewerMode){
      vPanel.hidden = true;
    } else {
      vPanel.hidden = !hasAny;
      if (hasAny){
        $('#viewerWinnersBlockCount').textContent = winnersWaiting.length + ' waiting';
        $('#viewerLosersBlockCount').textContent = losersWaiting.length + ' waiting';
        $('#viewerWinnersBlockList').innerHTML = blockListHtml(winnersWaiting, gameSize, 'winnersBlock', true);
        $('#viewerLosersBlockList').innerHTML = blockListHtml(losersWaiting, gameSize, 'losersBlock', true);
      }
    }
  }
}

// Everyone currently claimed by an OPEN court's preview lineup — the
// court cards' "next up" grouping, including anyone pulled in from a
// winners/losers block via the Sub picker (court.previewSubMap). Shared
// by the blocks panel (so it stops listing someone as "waiting" once
// they're already slotted into a preview) and by the flush actions below
// (so "Queue now" can't double-queue that same person while they're still
// spoken for).
function getPreviewClaimedIds(){
  const claimedIds = new Set();
  computeOpenCourtQueue(state.session.gameSize).forEach(slot => {
    if (slot.taken) slot.taken.forEach(e => claimedIds.add(e.id));
  });
  return claimedIds;
}
// Moves an entire block into the main queue, in order, as an intact group —
// this is what makes callNext() pull "winners vs winners" or "losers vs losers".
function flushBlockToQueue(blockKey){
  const block = state[blockKey];
  if (block.length === 0) return;
  // Anyone already claimed by an open court's preview (via the Sub picker)
  // stays put in the block — they're effectively already on their way to
  // a court, and pushing them into state.stack too would hand them a
  // second, phantom queue spot while court.previewSubMap still points at
  // their original block entry.
  const claimedIds = getPreviewClaimedIds();
  const movable = block.filter(e => !claimedIds.has(e.id));
  if (movable.length === 0) return;
  movable.forEach(entry => state.stack.push(entry));
  state[blockKey] = block.filter(e => claimedIds.has(e.id));
}
// Same idea, but only for one level's slice of the block — leaves every
// other level's entries sitting in the block untouched.
function flushBlockLevelToQueue(blockKey, level){
  const block = state[blockKey];
  const claimedIds = getPreviewClaimedIds();
  const matching = block.filter(e => getPlayerLevel(e.name) === level && !claimedIds.has(e.id));
  if (matching.length === 0) return;
  const matchIds = new Set(matching.map(e => e.id));
  state[blockKey] = block.filter(e => !matchIds.has(e.id));
  matching.forEach(entry => state.stack.push(entry));
}

// Everyone currently checked in and still in the rotation: on the queue
// itself or parked in a winners/losers block. (Players already out on a
// court aren't counted — they'll land back in one of these once their
// game ends.)
function totalCheckedInCount(){
  return state.stack.length + state.winnersBlock.length + state.losersBlock.length;
}
function countOfLevel(arr, level){
  return arr.filter(e => getPlayerLevel(e.name) === level).length;
}

// Auto-flush any block once it reaches gameSize players — evaluated
// separately per skill level, so (say) 4 Beginner winners flush into the
// queue as their own group without waiting on, or mixing with, Advanced
// winners still accumulating in the same block.
function checkBlockFlush(){
  const gameSize = state.session.gameSize;
  const levels = new Set();
  state.winnersBlock.forEach(e => levels.add(getPlayerLevel(e.name)));
  state.losersBlock.forEach(e => levels.add(getPlayerLevel(e.name)));
  levels.forEach(level => {
    if (countOfLevel(state.winnersBlock, level) >= gameSize) flushBlockLevelToQueue('winnersBlock', level);
    if (countOfLevel(state.losersBlock, level) >= gameSize) flushBlockLevelToQueue('losersBlock', level);

    // With a small group of this level (fewer total players than two full
    // blocks would need), the winners block and losers block can never both
    // fill up on their own for that level — there simply aren't enough
    // winners or losers of that level to go around. Rather than stalling
    // that level's courts waiting for players who will never arrive, merge
    // whatever's blocked for this level back into the queue as soon as
    // doing so would let a match start.
    //
    // Players currently out on a court count toward this level's pool too —
    // they'll cycle back into a block (or the stack) once their game ends,
    // so ignoring them made the check think a level was "too small" just
    // because everyone happened to be mid-match at that moment, forcing a
    // premature winners+losers merge instead of waiting for the next court
    // to finish and complete the group properly.
    const hasBlocked = countOfLevel(state.winnersBlock, level) > 0 || countOfLevel(state.losersBlock, level) > 0;
    const stackLevelCount = countOfLevel(state.stack, level);
    const playingLevelCount = state.courts.reduce((sum, c) => {
      if (c.status !== 'playing' || !Array.isArray(c.players)) return sum;
      return sum + c.players.filter(n => n && getPlayerLevel(n) === level).length;
    }, 0);
    const totalLevelCount = stackLevelCount + countOfLevel(state.winnersBlock, level) + countOfLevel(state.losersBlock, level) + playingLevelCount;
    // Only force-flush if this level's whole pool (including people still
    // mid-game) could never fill BOTH blocks to gameSize — i.e. fewer than
    // 2×gameSize players total exist for this level. Otherwise, wait: more
    // winners/losers of this level are still on their way back from courts.
    if (hasBlocked && stackLevelCount < gameSize && totalLevelCount < gameSize * 2){
      flushBlockLevelToQueue('winnersBlock', level);
      flushBlockLevelToQueue('losersBlock', level);
    }
  });
}

blocksPanel.addEventListener('click', (e) => {
  if (isSessionEnded()) return;
  const subBtn = e.target.closest('button[data-block-sub]');
  if (subBtn){
    openBlockSubPicker(subBtn.dataset.blockSub, subBtn.dataset.entryId);
    return;
  }
  // Manually flushing a block (whole or by level) is queue-composition
  // management, not "start games, score, sub" — stays host-only. Subbing
  // a player in the block above (handled just above) is still allowed.
  const levelBtn = e.target.closest('button[data-level-flush]');
  if (levelBtn){
    if (isCoHostRestricted()) return;
    flushBlockLevelToQueue(levelBtn.dataset.blockFlush, levelBtn.dataset.levelFlush);
    toast(levelBtn.dataset.levelFlush + ' group moved to queue');
    renderAll(); persist();
    return;
  }
  const btn = e.target.closest('button[data-block]');
  if (!btn || btn.disabled) return;
  if (isCoHostRestricted()) return;
  const key = btn.dataset.block === 'winners' ? 'winnersBlock' : 'losersBlock';
  const label = btn.dataset.block === 'winners' ? 'Winners block' : 'Losers block';
  flushBlockToQueue(key);
  toast(label + ' moved to queue');
  renderAll(); persist();
});

stackList.addEventListener('click', async (e) => {
  if (isSessionEnded()) return;
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  // Reordering/removing the queue and changing a player's skill level are
  // all queue/roster management — stays host-only for a co-host device.
  if (isCoHostRestricted()) return;
  const act = btn.dataset.act;
  if (act === 'cycle-level'){ openLevelPicker(btn.dataset.name); return; }
  const row = btn.closest('.paddle');
  const id = row.dataset.id;
  const idx = state.stack.findIndex(p => p.id === id);
  if (idx === -1) return;
  if (act === 'remove'){
    const entry = state.stack[idx];
    if (!(await showConfirm('Remove ' + entry.name + ' from the stack?', {title: 'Remove player?', confirmLabel: 'Remove', danger: true}))) return;
    const [removed] = state.stack.splice(idx, 1);
    toast(removed.name + ' removed from stack');
    // Removing someone can be exactly what tips a level below the "these
    // blocks will never both fill up on their own" threshold — re-check
    // right away so a winners/losers block doesn't sit stuck waiting on
    // players who were just removed and are never coming back.
    checkBlockFlush();
  } else if (act === 'up'){
    const lvl = getPlayerLevel(state.stack[idx].name);
    let j = idx - 1;
    while (j >= 0 && getPlayerLevel(state.stack[j].name) !== lvl) j--;
    if (j >= 0) [state.stack[j], state.stack[idx]] = [state.stack[idx], state.stack[j]];
  } else if (act === 'down'){
    const lvl = getPlayerLevel(state.stack[idx].name);
    let j = idx + 1;
    while (j < state.stack.length && getPlayerLevel(state.stack[j].name) !== lvl) j++;
    if (j < state.stack.length) [state.stack[j], state.stack[idx]] = [state.stack[idx], state.stack[j]];
  }
  renderAll(); persist(true);
});

/* ================= Add players ================= */
function registerRoster(name){
  const exists = state.roster.some(r => normalizeName(r) === normalizeName(name));
  if (!exists) state.roster.push(name);
}
function renderRosterList(){
  const rosterList = $('#rosterList');
  if (!rosterList) return;
  rosterList.innerHTML = state.roster.slice().sort((a,b) => a.localeCompare(b))
    .map(name => `<option value="${esc(name)}"></option>`).join('');
}

/* ---- Manage / delete saved roster names (Settings) ---- */
// Fixes the bug where names removed from the stack lingered forever in the
// "keep player names" list with no way to actually delete them.
function removeFromRoster(name){
  const idx = state.roster.findIndex(r => normalizeName(r) === normalizeName(name));
  if (idx === -1) return;
  state.roster.splice(idx, 1);
  const lower = normalizeName(name);
  if (Array.isArray(state.session.fixedDuos)){
    state.session.fixedDuos = state.session.fixedDuos.filter(d => normalizeName(d.a) !== lower && normalizeName(d.b) !== lower);
  }
  renderRosterList();
  renderRosterManageList($('#rosterSearchInput') ? $('#rosterSearchInput').value : '');
  if (!settingsOverlay.hidden){ renderFixedDuoNameOptions(); renderFixedDuoList(); }
  renderCourts();
  persist();
}
function renderRosterManageList(filter){
  const list = $('#rosterManageList');
  if (!list) return;
  const countBadge = $('#rosterManageCount');
  if (countBadge) countBadge.textContent = state.roster.length;
  const q = (filter || '').trim().toLowerCase();
  const names = state.roster.slice().sort((a,b) => a.localeCompare(b))
    .filter(n => !q || n.toLowerCase().includes(q));
  if (names.length === 0){
    list.innerHTML = `<div class="roster-manage-empty">${state.roster.length === 0 ? 'No saved players yet — add someone to the stack to get started.' : 'No names match that filter.'}</div>`;
    return;
  }
  list.innerHTML = names.map(name => {
    const lower = normalizeName(name);
    const waiting = state.arrivals.some(a => normalizeName(a.name) === lower);
    const statusTag = waiting
      ? '<span class="tag-pill queued" title="Added but not checked in yet">Waiting to check in</span>'
      : (isNameActive(name) ? '<span class="tag-pill floor" title="Currently on the floor">On floor</span>' : '');
    return `
    <div class="roster-manage-row">
      <span class="rm-avatar" style="background:${avatarColor(name)}">${initials(name)}</span>
      <span class="rm-name">${esc(name)}</span>
      ${statusTag}
      <button type="button" class="level-badge ${levelClass(getPlayerLevel(name))}" data-level-name="${esc(name)}" aria-label="Change ${esc(name)}'s player type">${esc(levelLabel(getPlayerLevel(name)))}</button>
      <button type="button" class="rm-edit" data-name="${esc(name)}" aria-label="Rename ${esc(name)}"><svg viewBox="0 0 24 24"><use href="#i-pencil"/></svg></button>
      <button type="button" class="rm-del" data-name="${esc(name)}" aria-label="Remove ${esc(name)} from saved players"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </div>
  `;
  }).join('');
}
const rosterManageListEl = $('#rosterManageList');
if (rosterManageListEl){
  rosterManageListEl.addEventListener('click', async (e) => {
    const levelBtn = e.target.closest('[data-level-name]');
    if (levelBtn){ openLevelPicker(levelBtn.dataset.levelName); return; }
    const editBtn = e.target.closest('.rm-edit');
    if (editBtn){ openRenamePlayer(editBtn.dataset.name); return; }
    const btn = e.target.closest('.rm-del');
    if (!btn) return;
    const name = btn.dataset.name;
    if (!(await showConfirm('This just clears the suggestion — it won\'t affect history or rankings.', {title: 'Remove "' + name + '" from saved players?', confirmLabel: 'Remove', danger: true}))) return;
    removeFromRoster(name);
    toast(name + ' removed from saved players');
  });
}

/* ---- Rename a known player (Settings) ----
   Renames the player everywhere they currently appear — arrivals (waiting
   to check in), the stack, a winners/losers block, and any court they're
   playing on — plus their saved roster entry, skill level, fixed-duo
   entries, and teammate-pairing memory. Past history and stats keep the
   name that was recorded at the time, same as a real match record would. */
const renamePlayerOverlay = $('#renamePlayerOverlay');
const renamePlayerForm = $('#renamePlayerForm');
const renamePlayerInput = $('#renamePlayerInput');
const renamePlayerCancelBtn = $('#renamePlayerCancelBtn');
let renamePlayerOriginal = null;
function openRenamePlayer(name){
  if (!name || !renamePlayerOverlay) return;
  renamePlayerOriginal = name;
  renamePlayerInput.value = name;
  renamePlayerOverlay.hidden = false;
  renamePlayerInput.focus();
  renamePlayerInput.select();
}
function closeRenamePlayer(){
  if (!renamePlayerOverlay || renamePlayerOverlay.hidden) return;
  renamePlayerOverlay.hidden = true;
  renamePlayerOriginal = null;
}
function renamePlayerEverywhere(oldName, newName){
  if (isCoHostRestricted()) return;
  const oldLower = normalizeName(oldName);
  state.arrivals.forEach(p => { if (normalizeName(p.name) === oldLower) p.name = newName; });
  state.stack.forEach(p => { if (normalizeName(p.name) === oldLower) p.name = newName; });
  state.winnersBlock.forEach(p => { if (normalizeName(p.name) === oldLower) p.name = newName; });
  state.losersBlock.forEach(p => { if (normalizeName(p.name) === oldLower) p.name = newName; });
  state.courts.forEach(c => {
    c.players = c.players.map(n => normalizeName(n) === oldLower ? newName : n);
  });
  const rIdx = state.roster.findIndex(r => normalizeName(r) === oldLower);
  if (rIdx !== -1) state.roster[rIdx] = newName; else state.roster.push(newName);
  if (state.playerLevels && Object.prototype.hasOwnProperty.call(state.playerLevels, oldName)){
    state.playerLevels[newName] = state.playerLevels[oldName];
    delete state.playerLevels[oldName];
  }
  if (Array.isArray(state.session.fixedDuos)){
    state.session.fixedDuos.forEach(d => {
      if (normalizeName(d.a) === oldLower) d.a = newName;
      if (normalizeName(d.b) === oldLower) d.b = newName;
    });
  }
  if (state.teammateHistory){
    const rebuilt = {};
    Object.keys(state.teammateHistory).forEach(key => {
      const parts = key.split('||');
      const renamed = parts.map(p => p.toLowerCase() === oldLower ? newName : p);
      const newKey = pairKey(renamed[0], renamed[1]);
      rebuilt[newKey] = (rebuilt[newKey] || 0) + state.teammateHistory[key];
    });
    state.teammateHistory = rebuilt;
  }
  if (state.opponentHistory){
    const rebuiltOpp = {};
    Object.keys(state.opponentHistory).forEach(key => {
      const parts = key.split('||');
      const renamed = parts.map(p => p.toLowerCase() === oldLower ? newName : p);
      const newKey = pairKey(renamed[0], renamed[1]);
      rebuiltOpp[newKey] = (rebuiltOpp[newKey] || 0) + state.opponentHistory[key];
    });
    state.opponentHistory = rebuiltOpp;
  }
}
if (renamePlayerForm){
  renamePlayerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!renamePlayerOriginal) return closeRenamePlayer();
    const oldName = renamePlayerOriginal;
    const newName = renamePlayerInput.value.trim();
    if (!newName){ toast('Enter a name'); return; }
    if (newName === oldName){ closeRenamePlayer(); return; }
    const newLower = normalizeName(newName);
    const collision = newLower !== normalizeName(oldName) && (state.roster.some(n => normalizeName(n) === newLower) || isNameActive(newName));
    if (collision){ toast(newName + ' is already in use by another player'); return; }
    renamePlayerEverywhere(oldName, newName);
    closeRenamePlayer();
    renderAll(); persist();
    toast(oldName + ' renamed to ' + newName);
  });
}
if (renamePlayerCancelBtn) renamePlayerCancelBtn.addEventListener('click', closeRenamePlayer);
if (renamePlayerOverlay) renamePlayerOverlay.addEventListener('click', (e) => { if (e.target === renamePlayerOverlay) closeRenamePlayer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && renamePlayerOverlay && !renamePlayerOverlay.hidden) closeRenamePlayer(); });
const rosterClearAllBtn = $('#rosterClearAllBtn');
if (rosterClearAllBtn){
  rosterClearAllBtn.addEventListener('click', async () => {
    if (isCoHostRestricted()) return;
    if (state.roster.length === 0) return;
    if (!(await showConfirm('This clears every saved suggestion — it won\'t affect history, rankings, or anyone currently on the floor.', {title: 'Clear all ' + state.roster.length + ' known players?', confirmLabel: 'Clear all', danger: true}))) return;
    state.roster = [];
    if (Array.isArray(state.session.fixedDuos)) state.session.fixedDuos = [];
    renderRosterList();
    renderRosterManageList($('#rosterSearchInput') ? $('#rosterSearchInput').value : '');
    if (!settingsOverlay.hidden){ renderFixedDuoNameOptions(); renderFixedDuoList(); }
    renderCourts();
    persist();
    toast('All known players cleared');
  });
}
const rosterSearchInputEl = $('#rosterSearchInput');
if (rosterSearchInputEl){
  rosterSearchInputEl.addEventListener('input', (e) => renderRosterManageList(e.target.value));
}
function isNameActive(name){
  const norm = normalizeName(name);
  if (state.arrivals.some(p => normalizeName(p.name) === norm)) return true;
  if (state.stack.some(p => normalizeName(p.name) === norm)) return true;
  if (state.winnersBlock.some(p => normalizeName(p.name) === norm)) return true;
  if (state.losersBlock.some(p => normalizeName(p.name) === norm)) return true;
  if (state.courts.some(c => c.players.some(n => normalizeName(n) === norm))) return true;
  return false;
}
/* Players land here first (added, but not yet on the floor). They only join the
   live stack once someone checks them in as arrived — see checkInArrival(s) below. */
/* A "duplicate" here means a name that's already active somewhere in this
   session right now (waiting, in the stack, a block, or on a court) — see
   isNameActive. Two different people can share a name, so this doesn't
   block the add outright; it surfaces a proper confirm dialog (the same
   queued modal system every other confirmation in the app uses — see
   showConfirm above) and lets the host/co-host decide per name, instead
   of the old behavior of silently skipping it with just a toast. */
async function addNamesToArrivals(names, level){
  if (isCoHostRestricted()) return;
  const lvl = PLAYER_LEVELS.includes(level) ? level : 'Open';
  const added = [];
  const rejected = [];
  // Sequential (not Promise.all) on purpose: showConfirm's own queue would
  // serialize concurrent calls anyway, and going one at a time keeps each
  // dialog's "already active" check honest against names just added a
  // moment earlier in the same batch (so pasting the same name twice in
  // one bulk add still prompts for the second occurrence too).
  for (const name of names){
    if (isUnsafeName(name)){
      rejected.push(name);
      continue;
    }
    if (isNameActive(name)){
      const proceed = await showConfirm(
        '\u201c' + name + '\u201d is already waiting, in the stack, a block, or on a court. Add another player with this same name anyway?',
        { title: 'Duplicate name', confirmLabel: 'Add anyway', cancelLabel: 'Skip' }
      );
      if (!proceed) continue;
    }
    state.arrivals.push({ id: nextId('a'), name, addedAt: Date.now() });
    setPlayerLevel(name, lvl);
    registerRoster(name);
    added.push(name);
  }
  if (added.length){
    toast((added.length > 1 ? added.length + ' players' : added[0]) + ' added — check in when they arrive');
  }
  if (rejected.length){
    toast('"' + rejected.join('", "') + '" is not a valid player name');
  }
  renderRosterList();
  renderAll(); persist();
}
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isSessionEnded()){ toast('Session has ended — resume it to add players'); return; }
  const raw = addNameInput.value.trim();
  if (!raw) return;
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  addNameInput.value = '';
  await addNamesToArrivals(names, addLevelSelect ? addLevelSelect.value : 'Open');
});

/* ---- Bulk add: one name per line ---- */
$('#bulkAddBtn').addEventListener('click', async function(){
  if (isSessionEnded()){ toast('Session has ended — resume it to add players'); return; }
  const textarea = $('#bulkNameInput');
  const names = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) return;
  textarea.value = '';
  // Collapse the details panel after adding
  const wrap = $('#bulkAddWrap');
  if (wrap) wrap.removeAttribute('open');
  // addNamesToArrivals already toasts its own "N added" summary (and
  // prompts per duplicate along the way), so no need to double-toast here.
  await addNamesToArrivals(names, addLevelSelect ? addLevelSelect.value : 'Open');
});

/* Whether the Generate Match wizard is currently open. Checked-in players
   land straight in the live stack, and every open court's "up next"
   preview is recomputed from that stack on every render (see
   renderCourts()). If a check-in landed while the wizard was mid-setup,
   that player could get pulled into a court's preview slot for a match
   the host hadn't generated yet — then Generate Match would run against
   a queue that had shifted under it, producing a court/on-deck line-up
   that didn't match what the host saw when they opened the wizard (in
   the worst case, showing the same player as both "already in a court"
   and still "up next"). Simplest fix: check-ins wait for the wizard to
   finish (or be closed) instead of racing its in-progress draft. */
function isGenerateWizardOpen(){
  const el = document.getElementById('generateMatchOverlay');
  return !!(el && !el.hidden);
}
/* ---- Check-in: moves a waiting arrival into the live stack ---- */
async function checkInArrival(id){
  if (isCoHostRestricted()) return;
  if (isGenerateWizardOpen()){ toast('Finish or close the Generate Match wizard before checking players in'); return; }
  const entry = state.arrivals.find(a => a.id === id);
  if (!entry) return;
  if (!(await showConfirm('Add ' + entry.name + ' to the live stack now?', {title: 'Check in ' + entry.name + '?', confirmLabel: 'Check in'}))) return;
  if (isGenerateWizardOpen()){ toast('Finish or close the Generate Match wizard before checking players in'); return; } // opened mid-confirm
  // Re-find by id (not a cached index) after the await: the arrivals array
  // can change while this confirm is open — e.g. a synced state update
  // from a live-hosted session arriving mid-dialog — so an index captured
  // before the await could point at the wrong entry, or one that's already
  // gone, by the time we act on it.
  const idx = state.arrivals.findIndex(a => a.id === id);
  if (idx === -1) return; // arrival was removed/checked in elsewhere while this was open
  state.arrivals.splice(idx, 1);
  const stackEntry = { id: nextId('p'), name: entry.name, joinedAt: Date.now(), tag: 'new' };
  state.stack.push(stackEntry);
  checkBlockFlush();
  toast(entry.name + ' checked in and added to the stack', 'success', { action: {
    label: 'Undo',
    onClick: () => {
      const si = state.stack.findIndex(p => p.id === stackEntry.id);
      if (si !== -1) state.stack.splice(si, 1);
      state.arrivals.unshift(entry);
      renderAll(); persist();
      toast(entry.name + ' moved back to arrivals', 'info', {detailed:true});
    }
  }});
  renderAll(); persist();
}
async function checkInAllArrivals(){
  if (isCoHostRestricted()) return;
  if (isGenerateWizardOpen()){ toast('Finish or close the Generate Match wizard before checking players in'); return; }
  if (state.arrivals.length === 0) return;
  const idsAtOpen = new Set(state.arrivals.map(a => a.id));
  const names = state.arrivals.map(a => a.name);
  const label = names.length > 1 ? names.length + ' players' : names[0];
  if (!(await showConfirm('Add ' + label + ' to the live stack now?', {title: 'Check in ' + label + '?', confirmLabel: 'Check in'}))) return;
  if (isGenerateWizardOpen()){ toast('Finish or close the Generate Match wizard before checking players in'); return; } // opened mid-confirm
  // Only act on the arrivals that were actually present when this dialog
  // opened (matched by id, not a blanket "clear everything") — the list
  // can change while the confirm is open, and blindly wiping state.arrivals
  // afterward would silently drop anyone added in the meantime.
  const toCheckIn = state.arrivals.filter(a => idsAtOpen.has(a.id));
  if (toCheckIn.length === 0) return;
  toCheckIn.forEach(entry => {
    state.stack.push({ id: nextId('p'), name: entry.name, joinedAt: Date.now(), tag: 'new' });
  });
  state.arrivals = state.arrivals.filter(a => !idsAtOpen.has(a.id));
  checkBlockFlush();
  toast(label + ' checked in and added to the stack');
  renderAll(); persist();
}
async function removeArrival(id){
  if (isCoHostRestricted()) return;
  const entryBefore = state.arrivals.find(a => a.id === id);
  if (!entryBefore) return;
  const name = entryBefore.name;
  if (!(await showConfirm('Remove ' + name + ' from the waiting-to-check-in list?', {title: 'Remove from arrivals?', confirmLabel: 'Remove', danger: true}))) return;
  // Re-find by id after the await — see checkInArrival() above for why a
  // pre-await index isn't safe to reuse here.
  const idx = state.arrivals.findIndex(a => a.id === id);
  if (idx === -1) return;
  const [removed] = state.arrivals.splice(idx, 1);
  toast(name + ' removed', 'success', { action: {
    label: 'Undo',
    onClick: () => {
      state.arrivals.splice(Math.min(idx, state.arrivals.length), 0, removed);
      renderAll(); persist();
      toast(name + ' restored to arrivals', 'info', {detailed:true});
    }
  }});
  renderAll(); persist();
}
function renderArrivals(){
  const badge = $('#arrivalsBadge');
  const listEl = $('#arrivalsList');
  const allBtn = $('#checkInAllBtn');
  const emptyNote = $('#arrivalsEmptyNote');
  if (!listEl) return;
  if (badge){
    badge.textContent = state.arrivals.length;
    badge.hidden = state.arrivals.length === 0;
  }
  const wizardOpen = isGenerateWizardOpen();
  if (checkInTabBtn) checkInTabBtn.classList.toggle('has-waiting', state.arrivals.length > 0 && !isSessionEnded());
  if (allBtn) allBtn.disabled = state.arrivals.length === 0 || isSessionEnded() || wizardOpen;
  if (emptyNote) emptyNote.hidden = state.arrivals.length > 0;
  listEl.innerHTML = state.arrivals.map(entry => `
    <div class="arrival-row" data-id="${entry.id}">
      <span class="arrival-name">${esc(entry.name)}</span>
      <button type="button" class="level-badge ${levelClass(getPlayerLevel(entry.name))}" data-act="cycle-level" data-name="${esc(entry.name)}" title="Change skill level">${esc(levelLabel(getPlayerLevel(entry.name)))}</button>
      <button type="button" class="arrival-checkin-btn" data-act="checkin" data-id="${entry.id}" ${wizardOpen ? 'disabled title="Finish the Generate Match wizard first"' : ''}>Check in</button>
      <button type="button" class="arrival-remove-btn" data-act="remove" data-id="${entry.id}" aria-label="Remove ${esc(entry.name)}"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </div>
  `).join('');
  if (wizardHoldNote) wizardHoldNote.hidden = !wizardOpen;
}
const arrivalsListEl = $('#arrivalsList');
if (arrivalsListEl){
  arrivalsListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (isSessionEnded()){ toast('Session has ended — resume it to check players in'); return; }
    if (btn.dataset.act === 'cycle-level'){ openLevelPicker(btn.dataset.name); return; }
    const id = btn.dataset.id;
    if (btn.dataset.act === 'checkin') checkInArrival(id);
    else if (btn.dataset.act === 'remove') removeArrival(id);
  });
}
const checkInAllBtnEl = $('#checkInAllBtn');
if (checkInAllBtnEl){
  checkInAllBtnEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSessionEnded()){ toast('Session has ended — resume it to check players in'); return; }
    checkInAllArrivals();
  });
}

/* ================= Generate Match setup wizard ================= */
const generateMatchOverlay = $('#generateMatchOverlay');
const generateMatchNav = $('#generateMatchNav');
const generateWizardClose = $('#generateWizardClose');
const generateWizardNext = $('#generateWizardNext');
const generateWizardBack = $('#generateWizardBack');
const wizardSummary = $('#wizardSummary');
const wizardAvoidRepeat = $('#wizardAvoidRepeat');
const wizardFixedDuo = $('#wizardFixedDuo');
const wizardScoring = $('#wizardScoring');
const wizardSkillLevels = $('#wizardSkillLevels');
let generateWizardStep = 1;
let generateWizardDraft = null;

function wizardDefaults(){
  return {
    courts: Math.max(1, Math.min(6, state.courts.length || 1)),
    gameSize: state.session.gameSize || 4,
    matchingStyle: getMatchingStyle(),
    avoidRepeat: !!state.session.avoidRepeatTeammates,
    fixedDuos: Array.isArray(state.session.fixedDuos) ? state.session.fixedDuos.map(d => ({a:d.a,b:d.b})) : [],
    scoring: state.session.scoringEnabled !== false,
    skillLevels: !!state.session.skillLevelsEnabled,
    // Per-court level, seeded from each existing court's current level (falls
    // back to 'Open' for any court beyond today's count) — same values the
    // Settings court rows show, just editable here too so a host doesn't have
    // to hop into Settings right after generating.
    courtLevels: Array.from({length:6}, (_,i) => (state.courts[i] && PLAYER_LEVELS.includes(state.courts[i].level)) ? state.courts[i].level : 'Open')
  };
}
function renderWizardFixedDuoOptions(){
  const a = $('#wizardFixedDuoNameA'), b = $('#wizardFixedDuoNameB');
  if (!a || !b) return;
  const names = allKnownNames();
  const opts = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  a.innerHTML = '<option value="">Player A…</option>' + opts;
  b.innerHTML = '<option value="">Player B…</option>' + opts;
}
function renderWizardFixedDuoList(){
  const list = $('#wizardFixedDuoList');
  if (!list || !generateWizardDraft) return;
  const duos = generateWizardDraft.fixedDuos || [];
  if (!duos.length){ list.innerHTML = '<div class="fixed-duo-empty">No fixed duos selected for this generation.</div>'; return; }
  list.innerHTML = duos.map((duo, i) => `
    <div class="fixed-duo-row">
      <span class="fd-names">${esc(duo.a)}<svg viewBox="0 0 24 24"><use href="#i-swap"/></svg>${esc(duo.b)}</span>
      <button type="button" class="rm-del" data-wizard-duo-idx="${i}" aria-label="Remove fixed duo of ${esc(duo.a)} and ${esc(duo.b)}"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </div>`).join('');
}
function renderWizardCourtLevels(){
  const wrap = $('#wizardCourtLevels');
  const list = $('#wizardCourtLevelsList');
  if (!wrap || !list || !generateWizardDraft) return;
  wrap.hidden = !generateWizardDraft.skillLevels;
  if (!generateWizardDraft.skillLevels) return;
  const n = generateWizardDraft.courts;
  const levels = generateWizardDraft.courtLevels || (generateWizardDraft.courtLevels = []);
  list.innerHTML = Array.from({length:n}, (_,i) => {
    const lvl = PLAYER_LEVELS.includes(levels[i]) ? levels[i] : 'Open';
    const name = (state.courts[i] && state.courts[i].name) || ('Court ' + (i+1));
    return `
    <div class="wizard-court-level-row">
      <span>${esc(name)}</span>
      <select class="wizard-court-level-select ${levelClass(lvl)}" data-wizard-court-level-idx="${i}" aria-label="${esc(name)} skill level">${levelSelectOptionsHtml(lvl)}</select>
    </div>`;
  }).join('');
}
function renderGenerateWizard(){
  if (!generateMatchOverlay || !generateWizardDraft) return;
  document.querySelectorAll('[data-wizard-step]').forEach(el => el.classList.toggle('active', Number(el.dataset.wizardStep) === generateWizardStep));
  document.querySelectorAll('[data-step-dot]').forEach(el => {
    const n = Number(el.dataset.stepDot);
    el.classList.toggle('active', n === generateWizardStep);
    el.classList.toggle('done', n < generateWizardStep);
  });
  document.querySelectorAll('#wizardCourtChoices button').forEach(b => b.classList.toggle('active', Number(b.dataset.courts) === generateWizardDraft.courts));
  document.querySelectorAll('#wizardMatchTypeChoices [data-size]').forEach(b => b.classList.toggle('active', Number(b.dataset.size) === generateWizardDraft.gameSize));
  document.querySelectorAll('#wizardStyleChoices [data-style]').forEach(b => b.classList.toggle('active', b.dataset.style === generateWizardDraft.matchingStyle));
  if (wizardSkillLevels) wizardSkillLevels.checked = generateWizardDraft.skillLevels;
  renderWizardCourtLevels();
  wizardAvoidRepeat.checked = generateWizardDraft.avoidRepeat;
  const wizardFixedDuoSub = $('#wizardFixedDuoSub');
  if (wizardFixedDuoSub) wizardFixedDuoSub.hidden = !generateWizardDraft.avoidRepeat;
  wizardScoring.checked = generateWizardDraft.scoring;
  if (generateWizardDraft.avoidRepeat){
    renderWizardFixedDuoOptions();
    renderWizardFixedDuoList();
  }
  generateWizardBack.disabled = generateWizardStep === 1;
  generateWizardNext.textContent = generateWizardStep === 4 ? '⚡ Generate Match' : 'Continue';
  if (generateWizardStep === 4){
    const styleLabel = generateWizardDraft.matchingStyle === 'balanced' ? 'Balanced' : 'Winners / Losers';
    const duoCount = (generateWizardDraft.fixedDuos || []).length;
    wizardSummary.innerHTML = `<div><span>Skill levels</span><b>${generateWizardDraft.skillLevels ? 'ON' : 'OFF'}</b></div><div><span>Courts</span><b>${generateWizardDraft.courts}</b></div><div><span>Match type</span><b>${generateWizardDraft.gameSize === 4 ? '2v2 Doubles' : '1v1 Singles'}</b></div><div><span>Matching style</span><b>${styleLabel}</b></div><div><span>Avoid repeating teammates</span><b>${generateWizardDraft.avoidRepeat ? 'ON' : 'OFF'}</b></div><div><span>Fixed duos</span><b>${generateWizardDraft.avoidRepeat ? (duoCount ? `${duoCount} selected` : 'None') : 'OFF'}</b></div><div><span>Scoring</span><b>${generateWizardDraft.scoring ? 'ON' : 'OFF'}</b></div>`;
  }
}
function openGenerateWizard(){
  if (viewerMode || isSessionEnded()) { toast('Match generation is unavailable right now'); return; }
  if (!state.stack.length){
    showAlert('Check players in before generating a match.', {title: 'No players checked in yet'});
    return;
  }
  generateWizardDraft = wizardDefaults();
  generateWizardStep = 1;
  generateMatchOverlay.hidden = false;
  renderGenerateWizard();
  renderArrivals(); // reflect the check-in hold (see isGenerateWizardOpen)
}
function closeGenerateWizard(){
  if (generateMatchOverlay) generateMatchOverlay.hidden = true;
  renderArrivals(); // release the check-in hold now that the wizard's closed
}
async function applyWizardCourtCount(target){
  target = Math.max(1, Math.min(24, Number(target) || 1));
  while (state.courts.length < target){
    const n = state.courts.length + 1;
    state.courts.push({ id: nextId('c'), name: 'Court ' + n, level: 'Open', status:'open', players:[], startTime:null, lastResult:null, swapInfo:null, score:null, previewOrder:null, previewSubMap:null, requeueOrder:null, openedAt: null, pauseStart: null, pausedMs: 0 });
  }
  while (state.courts.length > target){
    const last = state.courts[state.courts.length - 1];
    if (last.status === 'playing'){
      const returning = last.players.map(name => ({ id: nextId('p'), name, joinedAt: Date.now(), tag: 'queued' }));
      state.stack.unshift(...returning);
    }
    if (swapSelection && swapSelection.courtId === last.id) swapSelection = null;
    state.courts.pop();
  }
}
async function generateMatchesFromWizard(){
  const d = generateWizardDraft;
  if (!d) return;
  if (state.stack.length < d.gameSize){
    toast(`Need at least ${d.gameSize} checked-in players to generate a match`, 'warning', {detailed:true});
    return;
  }
  try{
    state.session.gameSize = d.gameSize;
    state.session.matchingStyle = d.matchingStyle;
    state.session.avoidRepeatTeammates = d.avoidRepeat;
    state.session.fixedDuosEnabled = d.avoidRepeat && (d.fixedDuos || []).length > 0;
    state.session.scoringEnabled = d.scoring;
    state.session.skillLevelsEnabled = !!d.skillLevels;
    state.session.fixedDuos = d.avoidRepeat ? (d.fixedDuos || []).map(x => ({a:x.a,b:x.b})) : [];
    state.session.autoStartEnabled = false;
    state.session.generationReady = true;
    await applyWizardCourtCount(d.courts);
    // Apply the per-court levels picked in step 1 (only meaningful once Skill
    // Levels is on — otherwise every court just stays 'Open', same as today).
    if (d.skillLevels && Array.isArray(d.courtLevels)){
      state.courts.forEach((c,i) => { c.level = PLAYER_LEVELS.includes(d.courtLevels[i]) ? d.courtLevels[i] : 'Open'; });
    }
    state.courts.forEach(c => { if (c.status === 'open') { c.openedAt = null; c.previewOrder = null; c.previewSubMap = null; } });
    persist();
    let started = 0;
    for (const court of state.courts){
      if (court.status !== 'open') continue;
      const before = court.status;
      callNext(court);
      if (before !== court.status && court.status === 'playing') started++;
    }
    closeGenerateWizard();
    setMobileTab('courts');
    renderAll();
    if (!started) toast('No complete match could be generated from the checked-in queue', 'warning', {detailed:true});
    else toast(started === 1 ? '1 match generated' : `${started} matches generated`, 'success', {detailed:true});
  } catch (err){
    console.error('generateMatchesFromWizard failed:', err);
    toast('Something went wrong generating the match — please try again', 'error', {detailed:true});
  }
}

/* ---- Generate Match nav button doubles as "End Session" ----
   Once Generate Match has run at least once this session (tracked by the
   existing state.session.generationReady flag), the bottom-nav button
   swaps from "Generate" to "End Session" instead of reopening the wizard.
   Ending presents a choice — clear the saved player list too, or keep it —
   rather than silently picking one, since hosts run both a one-off pickup
   session and a recurring club night through this same button. */
const generateMatchNavLabel = generateMatchNav ? generateMatchNav.querySelector('span:last-child') : null;
const generateMatchNavOrbIcon = generateMatchNav ? generateMatchNav.querySelector('.generate-match-orb use') : null;
/* Desktop-width counterpart of generateMatchNav — the bottom nav (and its
   Generate button) only renders below 880px, so this is the sole way to
   open the Generate Match wizard on wider screens. Mirrors the same
   ready/end-session state instead of duplicating the logic. */
const generateMatchDesktopBtn = $('#generateMatchDesktopBtn');
const generateMatchDesktopLabel = $('#generateMatchDesktopLabel');
const generateMatchDesktopIcon = $('#generateMatchDesktopIcon use');
const endSessionOverlay = $('#endSessionOverlay');
const endSessionKeepBtn = $('#endSessionKeepBtn');
const endSessionClearBtn = $('#endSessionClearBtn');
const endSessionCancelBtn = $('#endSessionCancelBtn');
function hasActiveGeneratedSession(){
  return !!state.session.generationReady && !isSessionEnded();
}
function renderGenerateNav(){
  const ready = hasActiveGeneratedSession();
  if (generateMatchNav){
    generateMatchNav.classList.toggle('is-end-session', ready);
    generateMatchNav.setAttribute('aria-label', ready ? 'End Session' : 'Generate Match');
    if (generateMatchNavLabel) generateMatchNavLabel.textContent = ready ? 'End Session' : 'Generate';
    if (generateMatchNavOrbIcon) generateMatchNavOrbIcon.setAttribute('href', ready ? '#i-x' : '#i-bolt');
  }
  if (generateMatchDesktopBtn){
    generateMatchDesktopBtn.classList.toggle('is-end-session', ready);
    generateMatchDesktopBtn.setAttribute('aria-label', ready ? 'End Session' : 'Generate Match');
    if (generateMatchDesktopLabel) generateMatchDesktopLabel.textContent = ready ? 'End Session' : 'Generate Match';
    if (generateMatchDesktopIcon) generateMatchDesktopIcon.setAttribute('href', ready ? '#i-x' : '#i-bolt');
  }
}
function openEndSessionPrompt(){
  if (isCoHostRestricted() || viewerMode) return;
  if (!endSessionOverlay) return;
  endSessionOverlay.hidden = false;
}
function closeEndSessionPrompt(){ if (endSessionOverlay) endSessionOverlay.hidden = true; }
/* ---- Session recap ----
   startFreshSessionKeepingRoster() (called below) wipes state.history and
   state.playerStats immediately, so any recap has to be captured from the
   live state *before* that reset runs — there's no reconstructing it
   afterward. Shown only when at least one match was actually played;
   ending an empty/just-started session skips straight to the toast. */
function formatRecapDuration(ms){
  if (ms == null || ms <= 0) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function buildSessionRecap(){
  const matches = state.history.length;
  if (matches === 0) return null;
  let earliest = Infinity, latest = 0;
  state.history.forEach(h => {
    if (h.startTime && h.startTime < earliest) earliest = h.startTime;
    if (h.endTime && h.endTime > latest) latest = h.endTime;
  });
  const durationMs = (isFinite(earliest) && latest > earliest) ? (latest - earliest) : null;
  const playerEntries = Object.entries(state.playerStats).filter(([,s]) => s && s.games > 0);
  let mvp = null;
  playerEntries.forEach(([name, s]) => {
    if (!mvp || s.wins > mvp.wins || (s.wins === mvp.wins && s.games > mvp.games)) mvp = { name, wins: s.wins, games: s.games };
  });
  return { matches, playerCount: playerEntries.length, durationMs, mvp };
}
let pendingRecap = null;
function openSessionRecap(recap, closeLabel){
  const overlay = $('#sessionRecapOverlay');
  const grid = $('#recapStatsGrid');
  if (!overlay || !grid) return;
  pendingRecap = recap;
  const dur = formatRecapDuration(recap.durationMs);
  grid.innerHTML = `
    <div class="recap-stat"><span class="recap-stat-num">${recap.matches}</span><span class="recap-stat-label">${recap.matches === 1 ? 'Match' : 'Matches'} played</span></div>
    <div class="recap-stat"><span class="recap-stat-num">${recap.playerCount}</span><span class="recap-stat-label">${recap.playerCount === 1 ? 'Player' : 'Players'}</span></div>
    ${dur ? `<div class="recap-stat"><span class="recap-stat-num">${esc(dur)}</span><span class="recap-stat-label">Duration</span></div>` : ''}
  `;
  const mvpEl = $('#recapMvp');
  if (mvpEl){
    if (recap.mvp && recap.playerCount > 1){
      mvpEl.hidden = false;
      mvpEl.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-trophy"/></svg><span><b>${esc(recap.mvp.name)}</b> \u2014 MVP with ${recap.mvp.wins} ${recap.mvp.wins === 1 ? 'win' : 'wins'} in ${recap.mvp.games} ${recap.mvp.games === 1 ? 'game' : 'games'}</span>`;
    } else {
      mvpEl.hidden = true;
    }
  }
  const doneBtn = $('#recapDoneBtn');
  if (doneBtn) doneBtn.textContent = closeLabel || 'Done';
  overlay.hidden = false;
}
function closeSessionRecap(){
  const overlay = $('#sessionRecapOverlay');
  if (overlay) overlay.hidden = true;
  pendingRecap = null;
}
$('#recapDoneBtn')?.addEventListener('click', closeSessionRecap);
$('#sessionRecapOverlay')?.addEventListener('click', e => { if (e.target.id === 'sessionRecapOverlay') closeSessionRecap(); });
$('#recapShareBtn')?.addEventListener('click', async () => {
  if (!pendingRecap) return;
  const dur = formatRecapDuration(pendingRecap.durationMs);
  const lines = [
    `${pendingRecap.matches} ${pendingRecap.matches === 1 ? 'match' : 'matches'} played`,
    `${pendingRecap.playerCount} ${pendingRecap.playerCount === 1 ? 'player' : 'players'}`,
  ];
  if (dur) lines.push(`${dur} of play`);
  if (pendingRecap.mvp) lines.push(`MVP: ${pendingRecap.mvp.name} (${pendingRecap.mvp.wins}-${pendingRecap.mvp.games - pendingRecap.mvp.wins} win-loss)`);
  const text = `PaddleStack session recap\n${lines.join('\n')}`;
  if (navigator.share){
    try{ await navigator.share({ title: 'Session recap', text }); }
    catch(e){ /* user dismissed the native share sheet — nothing to do */ }
  } else {
    copyText(text);
  }
});

function endSessionAndReset({ clearRoster }){
  const recap = buildSessionRecap();
  startFreshSessionKeepingRoster();
  if (clearRoster){
    state.roster = [];
    renderRosterList();
  }
  // Ending a session should return the court setup AND every session
  // setting (auto-start timing, matching style, target games, scoring,
  // sound, skill levels, fixed duos, cohost permissions) back to their
  // factory defaults — the same set Settings > Restore Defaults resets —
  // not just clear the active queue/courts. This was previously missing,
  // so a renamed/relevelled court (or a tweaked setting) silently carried
  // over into the "new" session. Session identity (name), lifecycle
  // status, and the createdAt timestamp startFreshSessionKeepingRoster
  // just set are kept as-is.
  state.courts.forEach((c, i) => {
    c.name = 'Court ' + (i + 1);
    c.level = 'Open';
  });
  const defaultSession = freshState().session;
  state.session = {
    ...defaultSession,
    name: state.session.name,
    status: state.session.status,
    createdAt: state.session.createdAt,
  };
  state.session.generationReady = false;
  persist();
  closeEndSessionPrompt();
  renderGenerateNav();
  renderAll();
  // If Settings happens to be open behind the End Session prompt, refresh
  // its fields so the reset court names/levels/settings show immediately
  // instead of only on the next open.
  if (settingsOverlay && !settingsOverlay.hidden) openSettings();
  if (recap) openSessionRecap(recap, clearRoster ? 'Done — players cleared' : 'Done — known players kept');
  else toast(clearRoster ? 'Session ended — players cleared' : 'Session ended — known players kept');
}
if (endSessionKeepBtn) endSessionKeepBtn.addEventListener('click', () => endSessionAndReset({ clearRoster: false }));
if (endSessionClearBtn) endSessionClearBtn.addEventListener('click', async () => {
  if (!(await showConfirm('This also erases your saved player list, not just the current queue. This cannot be undone.', {title: 'Clear all saved players too?', confirmLabel: 'End & clear all', danger: true}))) return;
  endSessionAndReset({ clearRoster: true });
});
if (endSessionCancelBtn) endSessionCancelBtn.addEventListener('click', closeEndSessionPrompt);
if (endSessionOverlay) endSessionOverlay.addEventListener('click', e => { if (e.target === endSessionOverlay) closeEndSessionPrompt(); });

function handleGenerateMatchTrigger(){
  if (hasActiveGeneratedSession()) openEndSessionPrompt();
  else openGenerateWizard();
}

/* ---- Desktop keyboard shortcuts ----
   "G" — same as clicking the Generate Match / End Session nav button.
   "N" — starts the first court that's ready to go (same as clicking its
   "Start Game" button), a quick way to call the next match without
   reaching for the mouse. Both bail out while typing in any field, while
   an overlay/modal is open, or in viewer mode — spectators and anyone
   filling in a text box shouldn't have single letters do anything. */
document.addEventListener('keydown', (e) => {
  if (viewerMode || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
  if (document.querySelector('.overlay:not([hidden])')) return;
  const key = e.key.toLowerCase();
  if (key === 'g'){
    e.preventDefault();
    handleGenerateMatchTrigger();
  } else if (key === 'n'){
    const btn = document.querySelector('.court-cta.call:not(:disabled)');
    if (btn){ e.preventDefault(); btn.click(); }
    else toast('No court is ready to start right now', 'info', {detailed:true});
  }
});

if (generateMatchNav) generateMatchNav.addEventListener('click', handleGenerateMatchTrigger);
if (generateMatchDesktopBtn) generateMatchDesktopBtn.addEventListener('click', handleGenerateMatchTrigger);
if (generateWizardClose) generateWizardClose.addEventListener('click', closeGenerateWizard);
if (generateMatchOverlay) generateMatchOverlay.addEventListener('click', e => { if (e.target === generateMatchOverlay) closeGenerateWizard(); });
document.addEventListener('click', e => {
  const courtBtn = e.target.closest('#wizardCourtChoices [data-courts]');
  if (courtBtn && generateWizardDraft){ generateWizardDraft.courts = Number(courtBtn.dataset.courts); renderGenerateWizard(); return; }
  const sizeBtn = e.target.closest('#wizardMatchTypeChoices [data-size]');
  if (sizeBtn && generateWizardDraft){ generateWizardDraft.gameSize = Number(sizeBtn.dataset.size); renderGenerateWizard(); return; }
  const styleBtn = e.target.closest('#wizardStyleChoices [data-style]');
  if (styleBtn && generateWizardDraft){ generateWizardDraft.matchingStyle = styleBtn.dataset.style; renderGenerateWizard(); return; }
  const addDuoBtn = e.target.closest('#wizardFixedDuoAddBtn');
  if (addDuoBtn && generateWizardDraft){
    const a = $('#wizardFixedDuoNameA')?.value, b = $('#wizardFixedDuoNameB')?.value;
    if (!a || !b){ toast('Pick two players first'); return; }
    if (a === b){ toast('Pick two different players'); return; }
    const duos = generateWizardDraft.fixedDuos || (generateWizardDraft.fixedDuos = []);
    const already = duos.some(d => (d.a === a && d.b === b) || (d.a === b && d.b === a));
    if (already){ toast('That duo is already selected'); return; }
    const inOtherDuo = duos.some(d => [d.a,d.b].includes(a) || [d.a,d.b].includes(b));
    if (inOtherDuo){ toast('One of those players is already in a fixed duo'); return; }
    duos.push({a,b});
    renderWizardFixedDuoOptions();
    renderWizardFixedDuoList();
    toast(a + ' & ' + b + ' added as a fixed duo');
    return;
  }
  const removeDuoBtn = e.target.closest('[data-wizard-duo-idx]');
  if (removeDuoBtn && generateWizardDraft){
    const idx = Number(removeDuoBtn.dataset.wizardDuoIdx);
    if (generateWizardDraft.fixedDuos?.[idx]) generateWizardDraft.fixedDuos.splice(idx,1);
    renderWizardFixedDuoOptions();
    renderWizardFixedDuoList();
    return;
  }
});
if (wizardSkillLevels) wizardSkillLevels.addEventListener('change', () => {
  if (!generateWizardDraft) return;
  generateWizardDraft.skillLevels = wizardSkillLevels.checked;
  renderGenerateWizard();
});
const wizardCourtLevelsList = $('#wizardCourtLevelsList');
if (wizardCourtLevelsList) wizardCourtLevelsList.addEventListener('change', (e) => {
  const select = e.target.closest('select[data-wizard-court-level-idx]');
  if (!select || !generateWizardDraft) return;
  const idx = Number(select.dataset.wizardCourtLevelIdx);
  const lvl = PLAYER_LEVELS.includes(select.value) ? select.value : 'Open';
  (generateWizardDraft.courtLevels || (generateWizardDraft.courtLevels = []))[idx] = lvl;
  select.className = `wizard-court-level-select ${levelClass(lvl)}`;
});
if (wizardAvoidRepeat) wizardAvoidRepeat.addEventListener('change', () => {
  if (!generateWizardDraft) return;
  generateWizardDraft.avoidRepeat = wizardAvoidRepeat.checked;
  if (generateWizardDraft.avoidRepeat){
    renderWizardFixedDuoOptions();
    renderWizardFixedDuoList();
  }
  renderGenerateWizard();
});
if (wizardScoring) wizardScoring.addEventListener('change', () => {
  if (!generateWizardDraft) return;
  generateWizardDraft.scoring = wizardScoring.checked;
  renderGenerateWizard(); // was previously missing — the step 4 summary's "Scoring: ON/OFF" line never reflected the toggle until Back/Continue re-rendered the step
});
if (generateWizardBack) generateWizardBack.addEventListener('click', () => { if (generateWizardStep > 1){ generateWizardStep--; renderGenerateWizard(); } });
if (generateWizardNext) generateWizardNext.addEventListener('click', () => { if (generateWizardStep < 4){ generateWizardStep++; renderGenerateWizard(); } else generateMatchesFromWizard(); });

/* ---- Add Player / Check In modals ---- */
function openAddPlayerModal(){
  renderQuickAdd();
  addPlayerOverlay.hidden = false;
  addNameInput.focus();
}
addPlayerTabBtn.addEventListener('click', openAddPlayerModal);
$('#addPlayerDone').addEventListener('click', () => { addPlayerOverlay.hidden = true; });

function openCheckInModal(){
  renderArrivals();
  checkInOverlay.hidden = false;
}
checkInTabBtn.addEventListener('click', openCheckInModal);
$('#checkInDone').addEventListener('click', () => { checkInOverlay.hidden = true; });

/* ---- Quick add from saved roster (handy after a New Session reset) ---- */
function renderQuickAdd(){
  const panel = $('#quickAddPanel');
  const chipsEl = $('#quickAddChips');
  if (!panel || !chipsEl) return;
  const available = state.roster.slice().sort((a,b) => a.localeCompare(b)).filter(n => !isNameActive(n));
  if (available.length === 0){
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  chipsEl.innerHTML = available.map(name => `
    <button type="button" class="quick-add-chip" data-name="${esc(name)}">
      <svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>${esc(name)}
    </button>
  `).join('');
}
const quickAddChipsEl = $('#quickAddChips');
if (quickAddChipsEl){
  quickAddChipsEl.addEventListener('click', (e) => {
    if (isSessionEnded()){ toast('Session has ended — resume it to add players'); return; }
    const btn = e.target.closest('button[data-name]');
    if (!btn) return;
    addNamesToArrivals([btn.dataset.name], addLevelSelect ? addLevelSelect.value : 'Open');
  });
}
const quickAddAllBtnEl = $('#quickAddAllBtn');
if (quickAddAllBtnEl){
  quickAddAllBtnEl.addEventListener('click', () => {
    if (isSessionEnded()){ toast('Session has ended — resume it to add players'); return; }
    const available = state.roster.slice().sort((a,b) => a.localeCompare(b)).filter(n => !isNameActive(n));
    if (available.length === 0) return;
    addNamesToArrivals(available, addLevelSelect ? addLevelSelect.value : 'Open');
  });
}

/* ================= Render: Courts ================= */
function fmtClock(ms){
  const totalSec = Math.floor(ms/1000);
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const s = totalSec%60;
  const pad = (n) => String(n).padStart(2,'0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function splitTeams(names){
  const half = Math.ceil(names.length / 2);
  return [names.slice(0, half), names.slice(half)];
}
function avatarHtml(name){
  return `<span class="avatar" style="background:${avatarColor(name)}">${initials(name)}</span>`;
}
// Shared "Signed in as ..." row shown at the top of every logged-in host-panel
// state — one place so the avatar chip and any status badge (e.g. suspended)
// stay consistent everywhere it appears, instead of six copies drifting apart.
function hostAccountRowHTML(){
  const email = authSession.user.email;
  const suspended = hostAccountInfo && hostAccountInfo.suspended;
  return `
    <div class="host-account-row">
      <div class="host-account-identity">
        ${avatarHtml(email)}
        <span>Signed in as <b>${esc(email)}</b></span>
        ${suspended ? '<span class="host-status-badge suspended">Suspended</span>' : ''}
      </div>
      <div class="host-account-actions">
        <button type="button" class="btn ghost sm" id="hostManageAccountBtn">Manage account</button>
        <button type="button" class="btn ghost sm" id="hostSignOutBtn">Log out</button>
      </div>
    </div>
  `;
}
function playerRowHtml(name, swap, sub){
  const stats = state.playerStats[name];
  const games = stats ? (stats.games || 0) : 0;
  const gamesChip = gamesChipHtml(games);
  const duoLocked = !!(swap && isInFixedDuo(name));
  // A co-host device without the matching permission never even sees these
  // icons — not just CSS-hidden, but left out of the HTML entirely. The
  // real enforcement lives in cohostActionAllowed(), called again at the
  // top of swapCourtPartner/openSubPicker/openBlockSubPicker/performSubstitution,
  // so this is purely about not showing a dead-end tap target.
  const swapPermitted = !coHostMode || getCohostPermissions().allowSwap;
  const subPermitted = !coHostMode || getCohostPermissions().allowSubstitution;
  // While a swap is pending (somewhere on this court or another), every
  // OTHER eligible swap button gets a blinking hint so it's obvious which
  // icons are live tap targets right now, mirroring the text swap-hint.
  const swapTarget = !!(swap && swap.active && !swap.selected && !duoLocked);
  const swapBtn = (swap && swapPermitted)
    ? `<button type="button" class="player-swap-btn action-swap${swap.selected ? ' selecting' : ''}${swapTarget ? ' swap-target' : ''}${duoLocked ? ' duo-locked' : ''}" data-act="swap-partner" data-idx="${swap.idx}" ${duoLocked ? 'disabled' : ''} aria-label="${duoLocked ? (esc(name) + ' is in a fixed duo \u2014 swap disabled') : (swap.selected ? 'Cancel swap' : ('Swap partner with ' + esc(name)))}" title="${duoLocked ? 'Fixed duo \u2014 can\u2019t split them up' : 'Swap partner'}"><svg viewBox="0 0 24 24"><use href="#i-swap"/></svg><span class="action-label">${swap.selected ? 'Cancel' : 'Swap'}</span></button>`
    : '';
  const subBtn = (sub && subPermitted)
    ? `<button type="button" class="player-sub-btn action-sub" data-act="sub-player" data-idx="${sub.idx}" aria-label="Substitute ${esc(name)}" title="Sub in a replacement for ${esc(name)}"><svg viewBox="0 0 24 24"><use href="#i-sub"/></svg><span class="action-label">Sub</span></button>`
    : '';
  const previewBtn = viewerMode ? '' : `<button type="button" class="player-preview-btn action-info" data-act="preview-name" data-name="${esc(name)}" aria-label="View player details for ${esc(name)}" title="Player details"><svg viewBox="0 0 24 24"><use href="#i-info"/></svg><span class="action-label">Info</span></button>`;
  // Name gets its own row with just the avatar, so it has the full column
  // width to wrap into instead of fighting the preview/swap/sub buttons for
  // space — those move to a compact row underneath. Wins used to get their
  // own trophy chip here too, but that's redundant now that the Info
  // button's popup already surfaces games played, wins, and win rate —
  // one less thing crowding this row on narrow cards.
  // Viewers don't get the full Info button/row (swap/sub don't apply and
  // there's no room for the text label) — instead a small round "i" sits
  // right next to their name and opens the exact same popup (see
  // showPlayerDetailsPreview / the shared preview-name click handler on
  // courtsGrid, which already runs regardless of viewer mode).
  const viewerInfoBtn = viewerMode
    ? `<button type="button" class="viewer-player-info-btn" data-act="preview-name" data-name="${esc(name)}" aria-label="View player details for ${esc(name)}" title="Player details"><svg viewBox="0 0 24 24"><use href="#i-info"/></svg></button>`
    : '';
  const viewerLevelSubtitle = (viewerMode && skillLevelsEnabled())
    ? `<span class="viewer-player-level">${esc(levelLabel(getPlayerLevel(name)))}</span>`
    : '';
  return `<span class="player-col">
    <span class="player-row">${avatarHtml(name)}<span class="player-name-txt" title="${esc(name)}">${esc(courtCardName(name))}</span>${viewerInfoBtn}</span>
    ${viewerLevelSubtitle}
    <span class="player-actions-row">${previewBtn}${swapBtn}${subBtn}</span>
    <span class="player-games-row">${gamesChip}</span>
  </span>`;
}
function teamColHtml(names, side, gameSize, swapCtx, subBaseIdx){
  const slots = Math.ceil(gameSize / 2);
  const rows = names.map((n, i) => {
    const swap = swapCtx ? { idx: swapCtx.baseIdx + i, selected: swapCtx.selectedIdx === swapCtx.baseIdx + i, active: !!swapCtx.active } : null;
    const sub = (subBaseIdx !== undefined) ? { idx: subBaseIdx + i } : null;
    return playerRowHtml(n, swap, sub);
  });
  while (rows.length < slots) rows.push(`<span class="empty-slot">—</span>`);
  // Spectator-only colored "Team 1"/"Team 2" label, echoing the reference
  // dashboard's blue/orange scoreboard convention — purely decorative,
  // doesn't touch any data. Hidden entirely for the host.
  const header = viewerMode
    ? `<div class="viewer-team-header viewer-team-header-${side}">Team ${side === 'a' ? '1' : '2'}</div>`
    : '';
  return `<div class="team team-${side}">${header}${rows.join('')}</div>`;
}

/* Sequentially allocates upcoming stack entries to each *open* court, in
   court order, without mutating the real stack. Used both to render each
   open court's "next up" preview and to decide exactly who gets called when
   a specific court's "Call next" is clicked — keeping the two in sync so a
   court never calls a different group of players than what it just showed. */
/* ---- "Up next on this court" (playing courts only) ----
   Open courts already preview their next matchup inline (see
   computeOpenCourtQueue above), but a currently-playing court shows
   nothing about who's queued for it once the game ends — the host has
   to leave the card and check the global "Up next" list instead. This
   gives a lightweight, best-effort peek: if this court finished right
   now, who from the stack (matching its skill level) would likely fill
   it. It's approximate — it doesn't account for other courts finishing
   around the same moment and claiming the same players first — so it's
   presented as a hint, not a guarantee. */
function previewNextForCourt(court, gameSize){
  if (!state.session.generationReady || court.status !== 'playing') return null;
  const alreadyPlaying = new Set();
  state.courts.forEach(c => { if (c.status === 'playing' && Array.isArray(c.players)) c.players.forEach(n => { if (n) alreadyPlaying.add(n); }); });
  const courtLevel = court.level || 'Open';
  const pool = state.stack.filter(e => !alreadyPlaying.has(e.name) && levelsMatch(getPlayerLevel(e.name), courtLevel));
  if (pool.length < gameSize) return null;
  return selectMatchEntries(gameSize, pool).map(e => e.name);
}
function computeOpenCourtQueue(gameSize){
  const queue = new Map();
  // Checked-in players must remain in the main queue until the host explicitly
  // completes the Generate Match wizard. Do not preview/claim them onto open
  // courts during check-in or normal rendering.
  if (!state.session.generationReady) return queue; // courtId -> { taken: entries|null, remaining: number available at this point }
  // Belt-and-suspenders: state.stack should never contain someone who's
  // already actually playing on a live court, but if anything upstream ever
  // leaves it in that state, don't let a preview pick them up and hand them
  // a second lineup spot on top of the one they're already in.
  const alreadyPlaying = new Set();
  state.courts.forEach(c => {
    if (c.status === 'playing' && Array.isArray(c.players)) c.players.forEach(n => { if (n) alreadyPlaying.add(n); });
  });
  let previewStack = state.stack.filter(e => !alreadyPlaying.has(e.name));
  state.courts.forEach(court => {
    if (court.status !== 'open') return;
    const courtLevel = court.level || 'Open';
    const candidatePool = previewStack.filter(e => levelsMatch(getPlayerLevel(e.name), courtLevel));
    const remaining = candidatePool.length;
    if (remaining >= gameSize){
      let taken = selectMatchEntries(gameSize, candidatePool);
      // Honor any pending preview substitutions the host made for this court
      // (swapping a specific waiting player in for one of the naturally
      // selected ones) before finalizing who's claimed. A pick that's gone
      // stale — the target already claimed by an earlier court this pass,
      // or no longer in the stack at all — is silently skipped rather than
      // erroring; the natural pick just stands instead.
      if (court.previewSubMap){
        const usedIncomingIds = new Set();
        Object.keys(court.previewSubMap).forEach(outgoingId => {
          const incomingId = court.previewSubMap[outgoingId];
          const outIdx = taken.findIndex(e => e.id === outgoingId);
          if (outIdx === -1) return;
          // Guard against the same replacement player being wired up for two
          // different slots on this court (stale/duplicated previewSubMap
          // entries) — without this, both writes below would place the same
          // person in two seats of one lineup.
          if (usedIncomingIds.has(incomingId)) return;
          // The pick may be a stack player still in the natural draw pool,
          // or someone parked in an accumulating block — check both.
          const incomingEntry = previewStack.find(e => e.id === incomingId)
            || state.winnersBlock.find(e => e.id === incomingId)
            || state.losersBlock.find(e => e.id === incomingId);
          if (!incomingEntry || !levelsMatch(getPlayerLevel(incomingEntry.name), courtLevel)) return;
          taken = taken.slice();
          taken[outIdx] = incomingEntry;
          usedIncomingIds.add(incomingId);
        });
      }
      // Final safety check: dedupe by id (keep first occurrence) so a bug
      // anywhere above this line can never surface as the same player
      // occupying two seats on the same court.
      const seenIds = new Set();
      taken = taken.filter(e => {
        if (seenIds.has(e.id)) return false;
        seenIds.add(e.id);
        return true;
      });
      const takenIds = new Set(taken.map(e => e.id));
      previewStack = previewStack.filter(e => !takenIds.has(e.id));
      queue.set(court.id, { taken, remaining });
    } else {
      queue.set(court.id, { taken: null, remaining });
    }
  });
  // A fixed duo can still end up split between two DIFFERENT courts here —
  // each already fully formed its own foursome before either one saw the
  // other half of the pair. Reconcile across all the open courts' lineups
  // so the duo actually ends up sharing a court together (see
  // reconcileFixedDuosAcrossGroups for how the swap is chosen).
  const openCourtIds = [];
  const groups = [];
  state.courts.forEach(court => {
    if (court.status !== 'open') return;
    const entry = queue.get(court.id);
    if (entry && entry.taken){ openCourtIds.push(court.id); groups.push(entry.taken); }
  });
  if (groups.length > 1){
    const levelForGroup = (gi) => {
      const court = state.courts.find(c => c.id === openCourtIds[gi]);
      return court ? (court.level || 'Open') : 'Open';
    };
    const reconciled = reconcileFixedDuosAcrossGroups(groups, state.stack, gameSize, levelForGroup);
    reconciled.forEach((taken, gi) => {
      const entry = queue.get(openCourtIds[gi]);
      queue.set(openCourtIds[gi], { ...entry, taken });
    });
  }
  return queue;
}

/* ================= Live Scoring (Settings > Enable Scoring) =================
   Optional in-progress scoreboard on each "playing" court card: point
   steppers, serve tracking (server-only scoring, side-outs, switch to
   serve 2), and short audio cues. Purely additive — when the toggle is
   off, court.score stays null and courts render exactly as before. When a
   winner is reached (or the court is sent to End Game), the tracked score
   flows straight into the existing endgame modal. */
function freshCourtScore(){
  return { a: 0, b: 0, serving: 'A', serverNum: 1, firstServe: true, serveUndo: [], wonAt: null };
}
function safeN(n){ return (n === null || n === undefined || isNaN(n)) ? 0 : n; }
function getWinTarget(){ return state.session.winningScore || 11; }
function detectCourtWinner(sc){
  if (!sc) return null;
  const target = getWinTarget();
  const a = safeN(sc.a), b = safeN(sc.b);
  if (a >= target) return 'a';
  if (b >= target) return 'b';
  return null;
}

let scoreAudioCtx = null;
function scoreTone(freq, duration, type, gainPeak){
  if (!state.session.soundOn) return;
  try{
    scoreAudioCtx = scoreAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = scoreAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(gainPeak || 0.18, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + duration + 0.03);
  }catch(e){ /* audio not available — fail silently */ }
}
function pointUpTone(){ scoreTone(880, 0.13, 'sine', 0.2); }
function pointDownTone(){ scoreTone(320, 0.12, 'sine', 0.16); }
function sideOutTone(){ scoreTone(660, 0.09, 'square', 0.15); setTimeout(() => scoreTone(415, 0.16, 'square', 0.15), 90); }
function winTone(){ [660,880,1100].forEach((f,i) => setTimeout(() => scoreTone(f, 0.18, 'triangle', 0.2), i*110)); }

/* ---- Voice score announcer (Web Speech API) ----
   Speaks the standard doubles pickleball score call: the serving team's
   own score first, then the receiving team's score, then the server
   number — e.g. "2 1 1". Side-outs are announced as "Side out" followed
   by the new call. Follows the same "Sound on call-up" toggle as the
   point/side-out tones above. */
if ('speechSynthesis' in window){
  try{
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener('voiceschanged', function(){ window.speechSynthesis.getVoices(); });
  }catch(e){}
}
function speakNow(text){
  try{
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.volume = 1;
    window.speechSynthesis.speak(utter);
  }catch(e){ /* speech not available — fail silently */ }
}
function speakScoreUtterance(text){
  if (!state.session.soundOn) return;
  if (!('speechSynthesis' in window)) return;
  try{
    window.speechSynthesis.cancel();
    setTimeout(() => speakNow(text), 50);
  }catch(e){}
}
const NUMBER_WORDS_ONES = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const NUMBER_WORDS_TENS = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
function numberToWords(n){
  n = Math.max(0, Math.round(n));
  if (n < 20) return NUMBER_WORDS_ONES[n];
  if (n < 100){
    const tens = Math.floor(n / 10), ones = n % 10;
    return NUMBER_WORDS_TENS[tens] + (ones ? ' ' + NUMBER_WORDS_ONES[ones] : '');
  }
  return String(n);
}
function speakScoreNumber(n){
  if (n === 10) return 'Match';
  if (n >= 11) return numberToWords(n);
  return String(n);
}
function scoreCallText(sc){
  const servingScore = sc.serving === 'A' ? safeN(sc.a) : safeN(sc.b);
  const otherScore = sc.serving === 'A' ? safeN(sc.b) : safeN(sc.a);
  const callServerNum = sc.firstServe ? 2 : sc.serverNum;
  if (servingScore === 10 && otherScore === 10) return `All Match ${speakScoreNumber(callServerNum)}`;
  if (servingScore === 10) return `Match, ${speakScoreNumber(otherScore)} ${speakScoreNumber(callServerNum)}`;
  if (otherScore === 10) return `${speakScoreNumber(servingScore)} Match ${speakScoreNumber(callServerNum)}`;
  if (servingScore === otherScore) return `All ${speakScoreNumber(servingScore)} ${speakScoreNumber(callServerNum)}`;
  return `${speakScoreNumber(servingScore)} ${speakScoreNumber(otherScore)} ${speakScoreNumber(callServerNum)}`;
}
function speakScoreCall(sc){ speakScoreUtterance(scoreCallText(sc)); }
function speakSideOut(sc){ speakScoreUtterance('Side out. ' + scoreCallText(sc)); }
function speakScoreOrMilestone(sc, scoringTeamScore){
  if (scoringTeamScore === getWinTarget()) speakScoreUtterance('Congratulations!');
  else speakScoreCall(sc);
}

/* ---- Voice "Call Players" announcer ----
   Same Web Speech pipeline as the score announcer above (same "Sound on
   call-up" toggle, same speakScoreUtterance gate/cancel behavior) but for
   summoning a court's next lineup instead of calling out a score. The
   lineup is read out, then repeated once more — "Court 2, Alice and Bob
   versus Carol and Dave" twice in a row — so it carries across a noisy
   gym even if someone missed it the first time. */
// Plain "Alice & Bob vs Carol & Dave" matchup text, shared by the spoken
// announcement (repeated below, for the gym) and the "Call Players" popup
// dialog's subtitle (shown once, for the host's screen).
function callPlayersMatchupText(names){
  const gameSize = state.session.gameSize;
  if (gameSize === 2) return `${names[0]} versus ${names[1]}`;
  const [a, b] = splitTeams(names);
  return `${a.join(' & ')} vs ${b.join(' & ')}`;
}
function callPlayersText(court, names){
  const call = `${court.name}. ${callPlayersMatchupText(names)}. Please come to the court.`;
  return `${call} ... ${call}`;
}
function speakCallPlayers(court, names){
  if (!names || names.length === 0) return;
  speakScoreUtterance(callPlayersText(court, names));
}
// Reads a court's up-next lineup out loud (twice) — used by the "Call
// Players" button that sits beside "Start Game" on an open, ready court.
// Pulls straight from court.previewOrder, which renderCourts() keeps in
// sync with whoever's actually about to be called up, so this always
// announces exactly what the card is currently showing.
function announceCallPlayers(court, btnEl, opts){
  opts = opts || {};
  const silent = !!opts.silent;
  const names = court.previewOrder;
  if (!names || names.length === 0){ if (!silent) toast('Not enough players in the stack yet'); return; }
  const voiceOn = !!state.session.soundOn;
  const notifyOn = state.session.notifyCallsEnabled !== false;
  if (!voiceOn && !notifyOn){
    if (!silent) toast('Turn on "Call-up voice" or "Notify players by phone" in Settings to use Call Players');
    return;
  }
  if (voiceOn){
    speakCallPlayers(court, names);
    if (btnEl){
      btnEl.classList.add('speaking');
      setTimeout(() => { btnEl.classList.remove('speaking'); }, 3500);
    }
  }
  const subtitle = `${court.name} — ${callPlayersMatchupText(names)}`;
  // Phone notifications ride alongside (or instead of) the voice
  // announcement — but only mean anything once someone could actually be
  // watching, i.e. this device is currently broadcasting live.
  if (notifyOn && hostSession){
    const calls = issuePlayerCall(names, { courtName: court.name });
    if (silent){
      // Auto Call Players: the whole point is to stay out of the host's
      // way, so this skips the confirmation popup (and the per-player
      // delivery lookup that only exists to fill that popup in) entirely
      // — the call itself (voice + push) still goes out exactly as normal.
      return;
    }
    // Confirm the call with a themed popup right away; per-player delivery
    // status streams in and fills the dialog once presence resolves.
    openCallPlayersModal(subtitle);
    resolveCallStatus(calls).then(fillCallPlayersModalStatus);
  } else if (notifyOn && !hostSession && !voiceOn){
    // They're relying entirely on phone notifications but aren't hosting
    // live — nobody's watching yet, so say so instead of doing nothing.
    if (!silent) toast('Go live in Host Online to notify players by phone');
  } else {
    // Voice-only call (not hosting live, or notifications turned off) —
    // still confirm on-screen what was just announced.
    if (!silent) openCallPlayersModal(subtitle);
  }
}

/* ---- Player Calling / Notification: host side ----
   "Call Players" (per-court, above) and "Call Out Player" (any player, any
   time — see the Call Out Player modal further down) both funnel through
   here. A call is just an entry appended to state.playerCalls, which rides
   along inside the normal full-state push to hosted_sessions — no separate
   network call needed to *deliver* it. Every spectator device already
   polls that same state every 2s and fires a local notification the
   moment it sees a new entry whose name matches the player it registered
   as (see the notify-matching block inside enterViewerMode's poll()). */
function issuePlayerCall(names, opts){
  opts = opts || {};
  if (!Array.isArray(state.playerCalls)) state.playerCalls = [];
  const baseTs = Date.now();
  const calls = names.map((name, i) => ({
    id: nextId('call'),
    name,
    court: opts.courtName || null,
    title: `${name}, it's your turn!`,
    body: opts.courtName ? `Please proceed to ${opts.courtName}.` : 'The host is calling you to the courts.',
    ts: baseTs + i // keep issue order stable even though Date.now() alone can collide
  }));
  state.playerCalls.push(...calls);
  // Bound the log — spectators only ever need to see calls issued since
  // they connected, so there's no reason to let this grow forever.
  if (state.playerCalls.length > 40) state.playerCalls = state.playerCalls.slice(-40);
  persist(true); // immediate push so viewers see the call within one poll cycle
  return calls;
}

// How recently a spectator device's presence heartbeat has to have landed
// for the host to consider that player's phone "connected" right now.
const VIEWER_PRESENCE_WINDOW_MS = 90 * 1000;

// Best-effort: this requires the optional session_viewers table + RPCs
// (see supabase-viewer-presence.sql) to be installed on the Supabase
// project. If they're not there yet, this just resolves to null and the
// host sees "sent" status instead of a confirmed connected/not-connected
// read — the calls themselves still go out either way.
async function fetchViewerPresence(){
  if (!SUPABASE_CONFIGURED || !hostSession) return null;
  try{
    const res = await sbFetch('/rest/v1/rpc/list_viewer_presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: hostSession.invite_code })
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return Array.isArray(data) ? data : null;
  }catch(e){ return null; }
}

// Renders one "✓ Renzku notified" / "⚠ John is not connected" line for a
// single call's delivery result. Shared by the floating call-status card,
// the inline list inside the "Call Out Player" modal, and the "Call
// Players" popup dialog so all three stay visually and textually in sync.
function callStatusLineHtml(r){
  if (r.status === 'connected'){
    return `<div class="call-status-line ok"><svg viewBox="0 0 24 24" style="width:13px;height:13px"><use href="#i-check"/></svg> ${esc(r.name)} notified</div>`;
  }
  if (r.status === 'not-connected'){
    return `<div class="call-status-line warn"><svg viewBox="0 0 24 24" style="width:13px;height:13px"><use href="#i-info"/></svg> ${esc(r.name)} is not connected — they haven\u2019t selected their name on a device</div>`;
  }
  return `<div class="call-status-line unknown"><svg viewBox="0 0 24 24" style="width:13px;height:13px"><use href="#i-bell"/></svg> ${esc(r.name)} called — delivery status unavailable</div>`;
}

// Shows a small floating card (bottom-right) reporting per-player delivery
// status for a just-issued batch of calls — instead of just silently
// hoping it worked. Used by call sites (like "Call Out Player") that don't
// have their own dialog open already to report status into.
function showCallStatusCard(results){
  const wrap = $('#callStatusWrap');
  if (!wrap) return;
  const card = document.createElement('div');
  card.className = 'call-status-card';
  const lines = results.map(callStatusLineHtml).join('');
  card.innerHTML = `<div class="csc-title"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg>Player calls</div>${lines}`;
  wrap.appendChild(card);
  requestAnimationFrame(() => card.classList.add('show'));
  const life = 5200 + results.length * 400;
  setTimeout(() => {
    card.classList.remove('show');
    setTimeout(() => card.remove(), 250);
  }, life);
}

// Looks up per-player delivery status for a just-issued batch of calls,
// without rendering anything — callers decide where the result goes (the
// floating card via reportCallStatus below, or the "Call Players" popup).
async function resolveCallStatus(calls){
  const names = calls.map(c => c.name);
  const presence = await fetchViewerPresence();
  const now = Date.now();
  return names.map(name => {
    if (!presence) return { name, status: 'unknown' };
    const row = presence.find(r => r.role === 'player' && namesMatch(r.player_name, name) &&
      (now - new Date(r.last_seen).getTime()) < VIEWER_PRESENCE_WINDOW_MS);
    return { name, status: row ? 'connected' : 'not-connected' };
  });
}

async function reportCallStatus(calls){
  const results = await resolveCallStatus(calls);
  showCallStatusCard(results);
  return results;
}

function adjustCourtScore(court, team, delta){
  const sc = court.score;
  if (!sc || detectCourtWinner(sc)) return;
  if (sc.serving !== team){
    toast('Only the serving team can score — Team ' + sc.serving + ' is serving.');
    return;
  }
  const key = team === 'A' ? 'a' : 'b';
  const target = getWinTarget();
  sc[key] = Math.min(target, Math.max(0, safeN(sc[key]) + delta));
  const winnerNow = detectCourtWinner(sc);
  if (winnerNow && !sc.wonAt) sc.wonAt = Date.now(); // freeze the match clock right when the game is won
  if (!winnerNow) sc.wonAt = null; // corrected back below target — resume the clock
  persist();
  if (delta > 0){
    pointUpTone();
    speakScoreOrMilestone(sc, sc[key]);
    if (winnerNow) setTimeout(winTone, 140);
  } else {
    pointDownTone();
    speakScoreCall(sc);
  }
  renderCourts();
}
// Lets you pick which team serves first — only allowed before any point
// has been scored on a brand-new game (firstServe still true, 0-0).
function setInitialServer(court, team){
  const sc = court.score;
  if (!sc || !sc.firstServe) return;
  if (safeN(sc.a) !== 0 || safeN(sc.b) !== 0) return;
  sc.serving = team;
  persist();
  renderCourts();
}
function courtSideOut(court){
  const sc = court.score;
  if (!sc || detectCourtWinner(sc)) return;
  if (!sc.firstServe && sc.serverNum !== 2) return;
  sc.serveUndo.push({ serving: sc.serving, serverNum: sc.serverNum, firstServe: sc.firstServe });
  sc.serving = sc.serving === 'A' ? 'B' : 'A';
  sc.serverNum = 1;
  sc.firstServe = false;
  persist();
  sideOutTone();
  speakSideOut(sc);
  renderCourts();
}
function courtAdvanceServe(court){
  const sc = court.score;
  if (!sc || detectCourtWinner(sc)) return;
  if (sc.firstServe || sc.serverNum !== 1) return;
  sc.serveUndo.push({ serving: sc.serving, serverNum: sc.serverNum, firstServe: sc.firstServe });
  sc.serverNum = 2;
  persist();
  sideOutTone();
  speakScoreCall(sc);
  renderCourts();
}
function courtUndoServe(court){
  const sc = court.score;
  if (!sc || !sc.serveUndo || !sc.serveUndo.length) return;
  const snap = sc.serveUndo.pop();
  sc.serving = snap.serving; sc.serverNum = snap.serverNum; sc.firstServe = snap.firstServe;
  persist();
  renderCourts();
}
function scoreboardHtml(court){
  const sc = court.score;
  if (!sc) return '';
  const winnerSide = detectCourtWinner(sc);
  const servingA = sc.serving === 'A', servingB = sc.serving === 'B';
  const serveLabel = sc.firstServe ? '1st Serve' : ('Serve ' + sc.serverNum);

  // Spectators get a read-only scoreboard: numbers and serve indicator only,
  // no scoring/serve controls to tap (those never did anything anyway, since
  // the click handler bails out early for viewerMode — this just makes the
  // UI match that reality instead of showing dead buttons).
  if (viewerMode){
    return `
      <div class="scoreboard-live scoreboard-readonly ${winnerSide ? 'has-winner' : ''}">
        <div class="sbl-row">
          <div class="sbl-team">
            <span class="sbl-label">${winnerSide === 'a' ? '🏆 ' : ''}Team A</span>
            <div class="sbl-servewrap">${servingA ? `<span class="serve-indicator">• ${serveLabel}</span>` : ''}</div>
            <div class="sbl-stepper sbl-stepper-readonly">
              <span class="sbl-num">${safeN(sc.a)}</span>
            </div>
          </div>
          <div class="sbl-team">
            <span class="sbl-label">${winnerSide === 'b' ? '🏆 ' : ''}Team B</span>
            <div class="sbl-servewrap">${servingB ? `<span class="serve-indicator">• ${serveLabel}</span>` : ''}</div>
            <div class="sbl-stepper sbl-stepper-readonly">
              <span class="sbl-num">${safeN(sc.b)}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  const target = getWinTarget();
  const canPickFirstServer = sc.firstServe && safeN(sc.a) === 0 && safeN(sc.b) === 0;
  const serveStatusHtml = (isServing, team) => {
    if (isServing) return `<span class="serve-indicator">• ${serveLabel}</span>`;
    if (canPickFirstServer) return `<button type="button" class="serve-set-btn" data-act="set-first-server" data-team="${team}">Make 1st server</button>`;
    return '';
  };
  return `
    <div class="scoreboard-live ${winnerSide ? 'has-winner' : ''}">
      <div class="sbl-row">
        <div class="sbl-team">
          <span class="sbl-label">${winnerSide === 'a' ? '🏆 ' : ''}Team A</span>
          <div class="sbl-servewrap">${serveStatusHtml(servingA, 'A')}</div>
          <div class="sbl-stepper">
            <button type="button" class="score-btn score-btn-minus" data-act="score-minus" data-team="A" aria-label="Decrease Team A score" ${(winnerSide || !servingA || safeN(sc.a) <= 0) ? 'disabled' : ''}>−</button>
            <span class="sbl-num">${safeN(sc.a)}</span>
            <button type="button" class="score-btn score-btn-plus" data-act="score-plus" data-team="A" aria-label="Increase Team A score" ${(winnerSide || !servingA || safeN(sc.a) >= target) ? 'disabled' : ''}>+</button>
          </div>
        </div>
        <div class="sbl-team">
          <span class="sbl-label">${winnerSide === 'b' ? '🏆 ' : ''}Team B</span>
          <div class="sbl-servewrap">${serveStatusHtml(servingB, 'B')}</div>
          <div class="sbl-stepper">
            <button type="button" class="score-btn score-btn-minus" data-act="score-minus" data-team="B" aria-label="Decrease Team B score" ${(winnerSide || !servingB || safeN(sc.b) <= 0) ? 'disabled' : ''}>−</button>
            <span class="sbl-num">${safeN(sc.b)}</span>
            <button type="button" class="score-btn score-btn-plus" data-act="score-plus" data-team="B" aria-label="Increase Team B score" ${(winnerSide || !servingB || safeN(sc.b) >= target) ? 'disabled' : ''}>+</button>
          </div>
        </div>
      </div>
      <div class="sbl-actions">
        <button type="button" class="sbl-btn" data-act="advance-serve" title="Switch to serve 2" ${(sc.firstServe || sc.serverNum !== 1 || winnerSide) ? 'disabled' : ''}>Serve 2</button>
        <button type="button" class="sbl-btn" data-act="side-out" title="Side out — switch serving team" ${((!sc.firstServe && sc.serverNum !== 2) || winnerSide) ? 'disabled' : ''}>⇄ Side Out</button>
        <button type="button" class="sbl-btn" data-act="undo-serve" title="Undo last serve decision" ${(!sc.serveUndo || !sc.serveUndo.length || winnerSide) ? 'disabled' : ''}>UNDO</button>
      </div>
    </div>`;
}

/* ================= Swap partners (mid-match, or in preview) =================
   Doubles only: lets someone fix a wrong pairing, or just remix the teams,
   without ending the game or losing the score/timer. Tap one player's swap
   icon, then tap another's to trade their court spots; tapping the same
   one again cancels the pick.

   The same icon and handler work on a not-yet-started court's preview
   matchup too — there it reorders court.previewOrder instead of
   court.players, letting the host remix teams before hitting "Start Game". */
let swapSelection = null; // { courtId, idx } | null — first player picked, awaiting a second

/* Looks up who (and which court) the pending swap selection points at, so
   every court's card can show a hint — not just the one the selection was
   made on. Swaps aren't limited to trading two spots on the same court:
   tapping a player on any other court's lineup completes a cross-court
   swap instead, letting the host pull a partner over from a different
   match rather than only reshuffling players already on their own court. */
function pendingSwapInfo(){
  if (!swapSelection) return null;
  const c = state.courts.find(x => x.id === swapSelection.courtId);
  if (!c) return null;
  const arr = c.status === 'open' ? c.previewOrder : c.players;
  const name = arr ? arr[swapSelection.idx] : null;
  return name ? { court: c, idx: swapSelection.idx, name } : null;
}

/* ---- Auto-start: give the host up to 2 minutes after a court opens (a
   previous game there just ended, or it's a freshly added/reset court) to
   tap "Start Game" themselves; if they never do, start it automatically
   once there are enough players for it. The 2-minute window is anchored to
   when the court opened — NOT to whether it briefly looks "enough" or not
   as the stack shuffles around — so it doesn't keep resetting itself and
   never actually firing.

   That open timestamp lives on the court itself (court.openedAt) rather
   than in a separate in-memory map, so it's saved with the rest of the
   state and survives a page reload/reconnect — otherwise a refresh right
   after a game ended would wipe the clock and hand the host a brand new
   window instead of picking up where the real elapsed time left off. ---- */
// How long an open, ready court waits before auto-starting — configurable
// in Settings (Settings > Auto-start Ready Courts), defaults to 1 minute.
function getAutoStartMs(){
  const mins = Number(state.session.autoStartMinutes);
  return (Number.isFinite(mins) && mins > 0 ? mins : 1) * 60 * 1000;
}

function swapCourtPartner(court, idx){
  if (!cohostActionAllowed('allowSwap', 'partner swap')) return;
  const arr0 = court.status === 'open' ? court.previewOrder : court.players;
  if (arr0 && isInFixedDuo(arr0[idx])){
    toast('That pairing is fixed \u2014 can\u2019t swap them apart', 'warning');
    return;
  }
  if (!swapSelection){
    swapSelection = { courtId: court.id, idx };
    renderCourts();
    return;
  }
  if (swapSelection.courtId === court.id && swapSelection.idx === idx){
    swapSelection = null;
    renderCourts();
    return;
  }
  const fromCourt = state.courts.find(c => c.id === swapSelection.courtId);
  if (!fromCourt){ swapSelection = null; renderCourts(); return; }
  const fromArr = fromCourt.status === 'open' ? fromCourt.previewOrder : fromCourt.players;
  const toArr = arr0;
  if (!fromArr || !toArr){ swapSelection = null; renderCourts(); return; }
  const otherIdx = swapSelection.idx;

  if (fromCourt.id === court.id){
    // Same-court swap: trade two spots within one lineup, same as before.
    const nameA = fromArr[otherIdx], nameB = toArr[idx];
    [fromArr[otherIdx], fromArr[idx]] = [fromArr[idx], fromArr[otherIdx]];
    swapSelection = null;
    toast(`Swapped ${nameA} \u2194 ${nameB}`);
    renderAll(); persist();
    return;
  }

  // Cross-court swap: pull a player over from a different court's lineup
  // and send whoever was tapped here back to fill the spot they left —
  // works between two previews, two live matches, or a mix of both.
  const nameA = fromArr[otherIdx];
  const nameB = toArr[idx];

  const fromIsOpen = fromCourt.status === 'open';
  const toIsOpen = court.status === 'open';
  if (fromIsOpen !== toIsOpen){
    // Mixed swap: one side is a *committed* playing-court player (already
    // removed from state.stack), the other is only a *preview* pick that's
    // still sitting in the stack (nothing claims it until "Start Game").
    // Just swapping the two names in place would leave the preview player
    // written onto a live court while their stack entry is untouched — so
    // they'd still be up for grabs the next time a court calls its next
    // group, and could end up listed as playing on two courts at once.
    // Route the swap through the stack instead: actually remove the
    // incoming preview player's stack entry, and actually return the
    // outgoing live player to the stack, same as a normal substitution.
    const openCourt = fromIsOpen ? fromCourt : court;
    const openName = fromIsOpen ? nameA : nameB;
    const liveCourt = fromIsOpen ? court : fromCourt;
    const liveIdx = fromIsOpen ? idx : otherIdx;
    const liveName = fromIsOpen ? nameB : nameA;

    const openQueueNow = computeOpenCourtQueue(state.session.gameSize);
    const slot = openQueueNow.get(openCourt.id);
    const stackEntry = slot && slot.taken ? slot.taken.find(e => e.name === openName) : null;
    if (!stackEntry){ swapSelection = null; renderCourts(); return; }

    removeEntriesFromStack([stackEntry]);
    liveCourt.players[liveIdx] = openName;
    state.stack.push({ id: nextId('p'), name: liveName, joinedAt: Date.now(), tag: 'queued' });
    // The open court's own preview no longer reflects the current stack —
    // let it recompute naturally on the next render instead of leaving a
    // stale manual entry that points at a player who's now playing elsewhere.
    openCourt.previewOrder = null;
    openCourt.previewSubMap = null;

    swapSelection = null;
    toast(`Swapped ${nameA} (${fromCourt.name}) \u2194 ${nameB} (${court.name})`);
    renderAll(); persist();
    return;
  }

  fromArr[otherIdx] = nameB;
  toArr[idx] = nameA;
  swapSelection = null;
  toast(`Swapped ${nameA} (${fromCourt.name}) \u2194 ${nameB} (${court.name})`);
  renderAll(); persist();
}

/* ================= Substitute a player (mid-match, or in preview) =================
   For when someone on a court has to step away (bathroom, phone call, hurt
   ankle, whatever) and can't finish the game. Host taps that player's sub
   icon, picks a replacement from the stack, and the game carries on with
   the sub in their spot — same court, same score/timer. The player being
   subbed out goes to the back of the stack, same as anyone requeuing after
   a normal game.

   The same icon also appears on a not-yet-started court's preview matchup,
   letting the host swap in a different waiting player before hitting "Start
   Game" — see performSubstitution()'s preview branch and
   computeOpenCourtQueue()'s previewSubMap handling. */
let subTarget = null; // { courtId, idx, preview } | null — the slot waiting for a replacement
let subRefreshTimer = null; // keeps the picker's candidate list live while it's open — see closeSubOverlay()
const subOverlay = $('#subOverlay');
const subList = $('#subList');
const subTitle = $('#subTitle');
const subSubtitle = $('#subSubtitle');
const subEmptyNote = $('#subEmptyNote');

// Closes the picker AND stops the live-refresh timer below — every place
// that hides subOverlay should go through this (not set .hidden directly)
// so a stale timer never keeps re-rendering into a closed/reused dialog.
function closeSubOverlay(){
  subOverlay.hidden = true;
  subTarget = null;
  if (subRefreshTimer){ clearInterval(subRefreshTimer); subRefreshTimer = null; }
}
// The stack/blocks/courts can keep changing while this dialog sits open —
// another action on the same device, a synced change from a co-host, a
// block auto-flushing once it fills — so, same idea as the call-out list,
// keep the candidate list live rather than freezing it at open time. Without
// this, tapping a name that's since moved elsewhere silently failed (see
// performSubstitution's !foundIncoming / outIdx===-1 guards) with no
// feedback — the exact "sometimes it just doesn't switch" symptom.
function refreshSubPickerIfOpen(){
  if (!subTarget || subOverlay.hidden) return;
  if (subTarget.upNext){
    // Phase 1 (picking WHICH on-deck player to replace) has no court/incoming
    // candidates to keep live — just re-list the group in case it changed.
    // Phase 2 (subTarget.entryId set) re-renders the actual candidate list.
    if (!subTarget.entryId){ renderUpNextSubChooser(); return; }
    renderSubPicker(null);
    return;
  }
  const court = subTarget.courtId ? state.courts.find(c => c.id === subTarget.courtId) : null;
  if (subTarget.courtId && !court){ closeSubOverlay(); return; } // that court is gone entirely
  renderSubPicker(court);
}
// Opens the "customize this on-deck match" picker for a group of on-deck
// player ids (see the pencil button rendered per row in renderUpNext).
// Two phases sharing the same subOverlay markup: first pick which of the
// group's players to replace (renderUpNextSubChooser), then pick their
// replacement (renderSubPicker, same candidate list logic used for a
// court's own preview subs).
function openUpNextSubPicker(entryIds, groupNum){
  if (!cohostActionAllowed('allowSubstitution', 'substitutions')) return;
  if (isSessionEnded()){ toast('Session has ended'); return; }
  if (!entryIds || entryIds.length === 0) return;
  subTarget = { upNext: true, entryIds, groupNum, entryId: null };
  renderUpNextSubChooser();
  subOverlay.hidden = false;
  if (subRefreshTimer) clearInterval(subRefreshTimer);
  subRefreshTimer = setInterval(refreshSubPickerIfOpen, 1500);
}
function renderUpNextSubChooser(){
  if (!subTarget || !subTarget.upNext) return;
  subTitle.textContent = 'Customize On Deck ' + subTarget.groupNum;
  subSubtitle.textContent = 'Tap a player to pick who fills their spot instead.';
  subEmptyNote.hidden = true;
  subList.innerHTML = subTarget.entryIds.map(id => {
    const entry = state.stack.find(e => e.id === id);
    if (!entry) return '';
    return `
    <div class="subpick-row" data-choose-outgoing="${entry.id}">
      ${avatarHtml(entry.name)}
      <span class="subpick-row-main">
        <span class="subpick-row-top">
          <span class="arrival-name">${esc(entry.name)}</span>
          ${gamesChipHtml(getGamesPlayed(entry.name))}
        </span>
        <span class="subpick-row-meta">
          <span class="level-badge ${levelClass(getPlayerLevel(entry.name))}">${esc(levelLabel(getPlayerLevel(entry.name)))}</span>
        </span>
      </span>
      <svg class="subpick-row-chevron" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
    </div>
  `;
  }).join('');
}
function openSubPicker(court, idx){
  if (!cohostActionAllowed('allowSubstitution', 'substitutions')) return;
  if (isSessionEnded()){ toast('Session has ended'); return; }
  const isPreview = court.status === 'open';
  const outgoingName = isPreview ? (court.previewOrder && court.previewOrder[idx]) : court.players[idx];
  if (!outgoingName) return;
  subTarget = { courtId: court.id, idx, preview: isPreview };
  subTitle.textContent = 'Sub in for ' + outgoingName;
  subSubtitle.textContent = isPreview
    ? outgoingName + ' goes back into the stack once you pick a replacement.'
    : outgoingName + ' goes to the back of the stack once you pick a replacement.';
  renderSubPicker(court);
  subOverlay.hidden = false;
  if (subRefreshTimer) clearInterval(subRefreshTimer);
  subRefreshTimer = setInterval(refreshSubPickerIfOpen, 1500);
}
// Same idea, but for a player currently parked in the winners or losers
// accumulating block (waiting for their level's group to fill up) instead
// of on a live/preview court. Swapping there pulls in any waiting stack
// player and sends the block player back to the end of the main queue —
// handy when someone in the block has to leave or wants to swap out before
// their next game gets called.
function openBlockSubPicker(blockKey, entryId){
  if (!cohostActionAllowed('allowSubstitution', 'substitutions')) return;
  if (isSessionEnded()){ toast('Session has ended'); return; }
  const block = state[blockKey];
  const entry = block && block.find(e => e.id === entryId);
  if (!entry) return;
  subTarget = { block: blockKey, entryId };
  const blockLabel = blockKey === 'winnersBlock' ? 'winners block' : 'losers block';
  subTitle.textContent = 'Sub in for ' + entry.name;
  subSubtitle.textContent = entry.name + ' goes to the back of the queue once you pick a replacement — the incoming player takes their spot in the ' + blockLabel + '.';
  renderSubPicker(null);
  subOverlay.hidden = false;
  if (subRefreshTimer) clearInterval(subRefreshTimer);
  subRefreshTimer = setInterval(refreshSubPickerIfOpen, 1500);
}
function renderSubPicker(court){
  let candidates;
  if (subTarget && subTarget.block){
    // Anyone still off a court is fair game here — main stack or the other
    // block — block members aren't tied to a specific court's level, so no
    // level filtering. But a player already claimed by an open court's own
    // preview (about to be called up next) is off the table: pulling them
    // in here would silently steal them out from under that preview,
    // leaving that court's "up next" lineup pointing at someone who's no
    // longer really available until the next render happens to catch it —
    // exactly the "player was already up next" conflict this guards against.
    const openQueueNow = computeOpenCourtQueue(state.session.gameSize);
    const claimed = new Set();
    openQueueNow.forEach(slot => { if (slot.taken) slot.taken.forEach(e => claimed.add(e.id)); });
    candidates = getAllWaitingEntries().filter(e => e.id !== subTarget.entryId && !claimed.has(e.id));
  } else if (subTarget && subTarget.preview){
    // Anyone already slotted into any open court's own preview (including
    // this one) is off the table — pulling them in here would double-book
    // them. Everyone else off a court — main stack or either accumulating
    // block — matching this court's skill level, shows up as a valid
    // replacement.
    const openQueueNow = computeOpenCourtQueue(state.session.gameSize);
    const claimed = new Set();
    openQueueNow.forEach(slot => { if (slot.taken) slot.taken.forEach(e => claimed.add(e.id)); });
    const courtLevel = court.level || 'Open';
    candidates = getAllWaitingEntries().filter(e => !claimed.has(e.id) && levelsMatch(getPlayerLevel(e.name), courtLevel));
  } else if (subTarget && subTarget.upNext){
    // Same idea, but for the global Up Next card instead of one court's own
    // preview: anyone already claimed by an open court's preview, or already
    // sitting in another rendered on-deck group, is off the table. No level
    // filtering — the Up Next card isn't scoped to a single court.
    const openQueueNow = computeOpenCourtQueue(state.session.gameSize);
    const claimed = new Set();
    openQueueNow.forEach(slot => { if (slot.taken) slot.taken.forEach(e => claimed.add(e.id)); });
    candidates = getAllWaitingEntries().filter(e => e.id !== subTarget.entryId && !claimed.has(e.id) && !upNextGroupClaimedIds.has(e.id));
  } else {
    // Mid-match sub on a live court: anyone off a court right now — stack
    // or either block — can step in.
    candidates = getAllWaitingEntries();
  }
  // A player who's half of an active Fixed Duo must never be offered as a
  // substitute — subbing them in alone would split them from their partner,
  // exactly what Fixed Duos exist to prevent. This is a hard exclusion from
  // the actual candidate list (not just a visual hide) and applies to every
  // picker above: normal court subs, preview subs, and block subs alike.
  candidates = candidates.filter(e => !isInFixedDuo(e.name));
  // Fewest games played first, so the host naturally sees who's most due
  // for court time at the top of the list. Ties keep the original order
  // (usually arrival/queue order) since Array#sort is stable.
  candidates = candidates.slice().sort((a, b) => getGamesPlayed(a.name) - getGamesPlayed(b.name));
  subEmptyNote.hidden = candidates.length > 0;
  subList.innerHTML = candidates.map(entry => {
    const srcTag = entry.__src === 'winnersBlock' ? '<span class="tag-pill queued">Winners block</span>'
      : entry.__src === 'losersBlock' ? '<span class="tag-pill queued">Losers block</span>' : '';
    return `
    <div class="subpick-row" data-id="${entry.id}">
      ${avatarHtml(entry.name)}
      <span class="subpick-row-main">
        <span class="subpick-row-top">
          <span class="arrival-name">${esc(entry.name)}</span>
          ${gamesChipHtml(getGamesPlayed(entry.name))}
        </span>
        <span class="subpick-row-meta">
          <span class="level-badge ${levelClass(getPlayerLevel(entry.name))}">${esc(levelLabel(getPlayerLevel(entry.name)))}</span>
          ${srcTag}
        </span>
      </span>
      <svg class="subpick-row-chevron" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
    </div>
  `;
  }).join('');
}
function performSubstitution(entryId){
  if (!subTarget) return;
  // Defense in depth: re-check even though openSubPicker/openBlockSubPicker
  // already gated getting here — closes the gap where the host flips the
  // permission off while this device already has the picker open.
  if (!cohostActionAllowed('allowSubstitution', 'substitutions')){ closeSubOverlay(); return; }
  const foundIncoming = findWaitingEntryById(entryId);
  if (!foundIncoming){ toast('That player is no longer available — pick another'); closeSubOverlay(); return; }
  const incoming = foundIncoming.entry;
  const incomingSrcKey = foundIncoming.src, incomingSrcIdx = foundIncoming.idx;
  if (subTarget.upNext){
    if (incoming.id === subTarget.entryId){ closeSubOverlay(); return; }
    // Purely a "who fills this on-deck slot" preference — like a court's
    // previewSubMap, this never touches state.stack directly. The outgoing
    // player stays exactly where they are in the queue; renderUpNext()
    // honors this pick on the next render, same as computeOpenCourtQueue
    // does for a court's own preview.
    state.upNextSubMap = state.upNextSubMap || {};
    state.upNextSubMap[subTarget.entryId] = incoming.id;
    toast(`${incoming.name} will fill this on-deck spot`);
    closeSubOverlay();
    renderAll(); persist();
    return;
  }
  if (subTarget.block){
    if (incoming.id === subTarget.entryId){ closeSubOverlay(); return; }
    // Pull the incoming player out of wherever they actually are (main
    // stack or a block) before touching the target block, and re-find the
    // outgoing player's index afterward — removing from the same block
    // array first would otherwise shift indices out from under a stale
    // outIdx.
    removeWaitingEntryById(incoming.id);
    const block = state[subTarget.block];
    const outIdx = block.findIndex(e => e.id === subTarget.entryId);
    if (outIdx === -1){
      // Outgoing player no longer in the block (edge case) — don't strand
      // the incoming player mid-air, just put them back where they came from.
      insertIntoWaitingSource(incomingSrcKey, incomingSrcIdx, incoming);
      toast('That spot changed before the swap went through — nothing moved, try again');
      closeSubOverlay(); renderAll(); persist();
      return;
    }
    const outgoing = block[outIdx];
    block[outIdx] = incoming; // takes the same spot/position in the block
    // The outgoing player swaps into wherever the incoming player was
    // pulled from — if that was another block, the block's headcount
    // doesn't quietly shrink; if it was the main stack, they simply requeue.
    insertIntoWaitingSource(incomingSrcKey, incomingSrcIdx, { id: nextId('p'), name: outgoing.name, joinedAt: Date.now(), tag: 'queued' });
    toast(`${incoming.name} subbed in for ${outgoing.name}`);
    closeSubOverlay();
    renderAll(); persist();
    return;
  }
  const court = state.courts.find(c => c.id === subTarget.courtId);
  const idx = subTarget.idx;
  if (!court){ toast('That court is no longer open'); closeSubOverlay(); return; }
  if (subTarget.preview){
    const outgoingName = court.previewOrder && court.previewOrder[idx];
    if (!outgoingName){ closeSubOverlay(); return; }
    // Preview subs don't touch state.stack directly — the outgoing player
    // stays right where they are in the queue. We just record a pick that
    // computeOpenCourtQueue honors on the next render, claiming the incoming
    // player for this court's preview instead of the natural choice.
    const openQueueNow = computeOpenCourtQueue(state.session.gameSize);
    const myTaken = openQueueNow.get(court.id);
    const outgoingEntry = myTaken && myTaken.taken ? myTaken.taken.find(e => e.name === outgoingName) : null;
    if (!outgoingEntry){ toast('That preview slot changed — try again'); closeSubOverlay(); return; }
    court.previewSubMap = court.previewSubMap || {};
    court.previewSubMap[outgoingEntry.id] = incoming.id;
    if (court.previewOrder) court.previewOrder[idx] = incoming.name;
    toast(`${incoming.name} will sub in for ${outgoingName}`);
  } else {
    if (!court.players[idx]) { toast('That slot is no longer open'); closeSubOverlay(); return; }
    const outgoingName = court.players[idx];
    removeWaitingEntryById(incoming.id); // pulls from stack or whichever block they were parked in
    court.players[idx] = incoming.name;
    // Same swap principle: the player coming off the live court takes the
    // spot the incoming sub vacated, rather than always joining the back
    // of the main stack.
    insertIntoWaitingSource(incomingSrcKey, incomingSrcIdx, { id: nextId('p'), name: outgoingName, joinedAt: Date.now(), tag: 'queued' });
    toast(`${incoming.name} subbed in for ${outgoingName}`);
  }
  closeSubOverlay();
  renderAll(); persist();
}
subList.addEventListener('click', (e) => {
  const chooseRow = e.target.closest('.subpick-row[data-choose-outgoing]');
  if (chooseRow){
    if (!subTarget || !subTarget.upNext) return;
    const outgoingId = chooseRow.dataset.chooseOutgoing;
    const entry = state.stack.find(en => en.id === outgoingId);
    if (!entry) return;
    subTarget.entryId = outgoingId;
    subTitle.textContent = 'Sub in for ' + entry.name;
    subSubtitle.textContent = entry.name + ' stays in the queue \u2014 pick who takes this on-deck spot instead.';
    renderSubPicker(null);
    return;
  }
  const row = e.target.closest('.subpick-row[data-id]');
  if (!row) return;
  performSubstitution(row.dataset.id);
});
$('#subCancel').addEventListener('click', closeSubOverlay);
subOverlay.addEventListener('click', (e) => { if (e.target === subOverlay) closeSubOverlay(); });

/* ---- Swipe position dots (mobile court carousel) ---- */
const courtsSwipeDots = $('#courtsSwipeDots');
let swipeDotsScrollBound = false;
function renderCourtsSwipeDots(){
  if (!courtsSwipeDots) return;
  const n = state.courts.length;
  if (n < 2){ courtsSwipeDots.hidden = true; courtsSwipeDots.innerHTML = ''; return; }
  courtsSwipeDots.hidden = false;
  courtsSwipeDots.innerHTML = state.courts.map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}" data-dot-idx="${i}"></span>`).join('');
  updateCourtsSwipeDots();
  if (!swipeDotsScrollBound && courtsGrid){
    swipeDotsScrollBound = true;
    let raf = null;
    courtsGrid.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; updateCourtsSwipeDots(); });
    }, { passive:true });
  }
}
function updateCourtsSwipeDots(){
  if (!courtsSwipeDots || courtsSwipeDots.hidden || !courtsGrid) return;
  const cards = courtsGrid.querySelectorAll('.court-card');
  if (!cards.length) return;
  // Whichever card's left edge is closest to the scroller's own left edge
  // is the one currently "in view" (each card scroll-snaps to that edge).
  const gridLeft = courtsGrid.getBoundingClientRect().left;
  let closest = 0, closestDist = Infinity;
  cards.forEach((card, i) => {
    const dist = Math.abs(card.getBoundingClientRect().left - gridLeft);
    if (dist < closestDist){ closestDist = dist; closest = i; }
  });
  courtsSwipeDots.querySelectorAll('.dot').forEach((dot, i) => dot.classList.toggle('active', i === closest));
}
courtsSwipeDots && courtsSwipeDots.addEventListener('click', (e) => {
  const dot = e.target.closest('.dot[data-dot-idx]');
  if (!dot) return;
  const cards = courtsGrid.querySelectorAll('.court-card');
  const target = cards[Number(dot.dataset.dotIdx)];
  if (target) target.scrollIntoView({ behavior:'smooth', inline:'start', block:'nearest' });
});

function renderCourts(){
  courtsGrid.innerHTML = '';
  if (state.courts.length === 0){
    // A viewer who hasn't received any snapshot yet (see viewerConnCard
    // above) has genuinely nothing to show — "No courts yet, add some in
    // Settings" is both wrong (they can't add courts) and looks like a
    // real, settled state rather than a still-loading one. Show a couple
    // of skeleton placeholders instead so it reads as "loading", not
    // "empty", until the first real snapshot lands.
    const connCard = document.getElementById('viewerConnCard');
    const isConnecting = viewerMode && connCard && !connCard.hidden;
    courtsGrid.innerHTML = isConnecting
      ? Array.from({length:2}).map(() => `<div class="court-card court-card-skeleton">
          <div class="host-skeleton" style="width:38%;height:18px;margin-top:1.05rem"></div>
          <div class="host-skeleton" style="width:100%;height:70px;margin-top:1rem"></div>
          <div class="host-skeleton" style="width:60%;height:14px;margin-top:.9rem"></div>
        </div>`).join('')
      : '<div class="courts-empty">No courts yet. Add some in Settings.</div>';
    if (courtsSwipeDots){ courtsSwipeDots.hidden = true; courtsSwipeDots.innerHTML = ''; }
    return;
  }
  const gameSize = state.session.gameSize;
  // Preview-only allocation: as we walk through open courts in order, each
  // one "claims" its own group of next-up players so two open courts never
  // preview the exact same players at the same time.
  const openQueue = computeOpenCourtQueue(gameSize);
  state.courts.forEach(court => {
    const card = document.createElement('div');
    card.className = 'court-card' + (court.status === 'playing' ? ' playing' : '');
    card.dataset.id = court.id;

    const courtIcon = `<svg viewBox="0 0 24 24"><use href="#i-court"/></svg>`;
    // Spectator-only footer: how many matches have finished on this specific
    // court this session. Derived from state.history (already synced to
    // viewers) rather than a new counter field, since every finished game
    // already records the court name it was played on.
    // Live court status footer: show the actual state of the current court
    // instead of a static "games played" counter. This is especially useful
    // in spectator/viewer mode where there are no court controls.
    const courtGamesFooter = viewerMode
      ? (() => {
          let status = 'ended';
          let label = 'Game Ended';
          let icon = '#i-check';
          if (court.status === 'playing') {
            if (court.pauseStart) {
              status = 'paused';
              label = 'Game Paused';
              icon = '#i-clock';
            } else {
              status = 'started';
              label = 'Game Started';
              icon = '#i-play';
            }
          } else if (!court.lastResult) {
            // No active match and no previous result means this court is
            // simply waiting for its next game; keep the requested status
            // vocabulary without falsely claiming a finished match.
            status = 'ended';
            label = 'Game Ended';
          }
          return `<div class="court-games-footer court-status-footer ${status}" aria-label="${label}">
            <svg viewBox="0 0 24 24"><use href="${icon}"/></svg>
            <span>${label}</span>
          </div>`;
        })()
      : '';

    if (court.status === 'open'){
      const slot = openQueue.get(court.id) || { taken: null, remaining: state.stack.length };
      const taken = slot.taken;
      const enough = !!taken;
      const canUndo = !!(lastUndo && lastUndo.courtId === court.id);
      const lastResultHtml = court.lastResult ? `
        <div class="last-result">
          <svg viewBox="0 0 24 24"><use href="#i-paddle"/></svg>
          <span>${court.lastResult.winnerNames ? `${esc(court.lastResult.winnerNames.join(' & '))} won last${court.lastResult.scoreLine ? ' — ' + esc(court.lastResult.scoreLine) : ''}` : 'Last game finished'}</span>
          ${canUndo ? `<button type="button" class="undo-result-btn" data-act="undo-result" title="Wrong winner? Undo and pick again">Undo</button>` : ''}
        </div>` : '';
      const ended = isSessionEnded();
      let matchupHtml;
      let swapHint = '';
      let autoStartHtml = '';
      // A court's openedAt is normally stamped the moment it becomes 'open'
      // (game ended, court added, wizard run) so the auto-start window is
      // anchored to real elapsed time. The only case that can slip through
      // is a session saved before this field existed — fall back to "now"
      // rather than leaving it null, so a legacy save doesn't immediately
      // auto-start (or permanently refuse to) the instant it's reopened.
      if (court.openedAt == null) court.openedAt = Date.now();

      if (enough){
        const naturalNames = orderForTeammatePairing(taken.map(p => p.name));
        // Keep any manual swap the host made as long as it's still the same
        // group of players; once the underlying line-up changes (queue moved,
        // a sub landed, etc.) fall back to the natural arrangement.
        let names;
        if (court.previewOrder && sameNameMultiset(court.previewOrder, naturalNames)){
          names = court.previewOrder.slice();
        } else {
          names = naturalNames;
          court.previewOrder = naturalNames.slice();
        }
        const [a, b] = splitTeams(names);
        const canSwapPartners = gameSize > 2;
        const pending = pendingSwapInfo();
        const activeSwap = (pending && pending.court.id === court.id) ? pending.idx : null;
        const swapCtxA = canSwapPartners ? { baseIdx: 0, selectedIdx: activeSwap, active: !!pending } : null;
        const swapCtxB = canSwapPartners ? { baseIdx: a.length, selectedIdx: activeSwap, active: !!pending } : null;
        swapHint = (canSwapPartners && pending)
          ? (pending.court.id === court.id
              ? `<div class="swap-hint">Tap another player to swap with <b>${esc(pending.name)}</b></div>`
              : `<div class="swap-hint swap-hint-remote">Tap a player here to swap with <b>${esc(pending.name)}</b> <span class="swap-hint-court">(${esc(pending.court.name)})</span></div>`)
          : '';
        matchupHtml = `<div class="matchup">${teamColHtml(a,'a',gameSize,swapCtxA,0)}<div class="vs-divider"></div>${teamColHtml(b,'b',gameSize,swapCtxB,a.length)}</div>`;
      } else {
        const lvlNote = court.level ? ` ${levelLabel(court.level)}` : '';
        matchupHtml = `<div class="matchup" style="align-items:center;justify-content:center"><span class="empty-slot">Needs ${Math.max(0, gameSize - slot.remaining)} more${lvlNote} in the stack</span></div>`;
      }
      if (state.session.autoStartEnabled && enough && !ended){
        const msLeft = getAutoStartMs() - (Date.now() - court.openedAt);
        if (msLeft > 0){
          autoStartHtml = `<div class="auto-start-hint" data-role="auto-start-hint">Auto-starts in ${fmtClock(msLeft)}</div>`;
        }
      }
      card.innerHTML = `
        <div class="court-top">
          <span class="court-name-wrap">${courtIcon}<input class="court-name" value="${esc(court.name)}" data-act="rename" maxlength="24" aria-label="Court name"></span>
          <span class="level-badge court-level-badge ${levelClass(court.level)}" aria-label="Court skill level">${esc(levelLabel(court.level || 'Open'))}</span>
          <span class="status-badge open">Open</span>
        </div>
        ${lastResultHtml}
        ${matchupHtml}
        ${swapHint}
        <div class="court-cta-row">
          <button type="button" class="court-cta call-players" data-act="call-players" ${(enough && !ended) ? '' : 'disabled'} aria-label="Announce next players for ${esc(court.name)}" title="Speak the next lineup out loud, twice"><span class="cta-icon">📣</span><span class="cta-text"><span class="cta-title">Call Players</span><span class="cta-sub">Notify players on deck</span></span></button>
          <button type="button" class="court-cta call" data-act="call" ${(enough && !ended) ? '' : 'disabled'}><span class="cta-icon">${ended ? '🔒' : '▶'}</span><span class="cta-text"><span class="cta-title">${ended ? 'Session ended' : 'Start Game'}</span><span class="cta-sub">${ended ? 'Locked for new games' : 'Start match on this court'}</span></span></button>
        </div>
        ${autoStartHtml}
        ${courtGamesFooter}
      `;
    } else {
      // Lazily attach a live score object if scoring was turned on mid-match.
      if (state.session.scoringEnabled && !court.score) court.score = freshCourtScore();
      const scoringOn = state.session.scoringEnabled;
      const sc = court.score;
      // Once a winner is reached, the clock freezes at the moment it was won
      // instead of continuing to run while the court still shows "on court".
      const clockEndTime = (scoringOn && sc && sc.wonAt) ? sc.wonAt : Date.now();
      const elapsed = courtElapsedMs(court, clockEndTime);
      const [a, b] = splitTeams(court.players);
      const scoreboard = scoringOn ? scoreboardHtml(court) : '';
      // When scoring is on, the scoreboard already owns the vertical space,
      // so the timer moves into a compact chip up in the header row instead
      // of its own large centered block.
      const timerChip = scoringOn ? `<span class="timer-chip${court.pauseStart ? ' paused' : ''}" data-role="timer">${fmtClock(elapsed)}</span>` : '';
      const timerBlock = scoringOn ? '' : `<div class="timer${court.pauseStart ? ' paused' : ''}" data-role="timer">${fmtClock(elapsed)}</div>`;
      // Swap-partner icons only make sense in doubles (there's no "partner"
      // to swap in singles) and only once a court actually has its full
      // roster of players on it.
      const canSwapPartners = gameSize > 2 && court.players.length === gameSize;
      const pending = pendingSwapInfo();
      const activeSwap = (pending && pending.court.id === court.id) ? pending.idx : null;
      const swapCtxA = canSwapPartners ? { baseIdx: 0, selectedIdx: activeSwap, active: !!pending } : null;
      const swapCtxB = canSwapPartners ? { baseIdx: a.length, selectedIdx: activeSwap, active: !!pending } : null;
      const swapHint = (canSwapPartners && pending)
        ? (pending.court.id === court.id
            ? `<div class="swap-hint">Tap another player to swap with <b>${esc(pending.name)}</b></div>`
            : `<div class="swap-hint swap-hint-remote">Tap a player here to swap with <b>${esc(pending.name)}</b> <span class="swap-hint-court">(${esc(pending.court.name)})</span></div>`)
        : '';
      card.innerHTML = `
        <div class="court-top">
          <span class="court-name-wrap">${courtIcon}<input class="court-name" value="${esc(court.name)}" data-act="rename" maxlength="24" aria-label="Court name"></span>
          <span class="level-badge court-level-badge ${levelClass(court.level)}" aria-label="Court skill level">${esc(levelLabel(court.level || 'Open'))}</span>
          <span class="court-top-right">
            <span class="status-badge playing${court.pauseStart ? ' paused' : ''}">${court.pauseStart ? 'Paused' : 'On court'}</span>
            ${timerChip}
          </span>
        </div>
        <div class="matchup">${teamColHtml(a,'a',gameSize,swapCtxA,0)}<div class="vs-divider"></div>${teamColHtml(b,'b',gameSize,swapCtxB,a.length)}</div>
        ${swapHint}
        ${scoreboard}
        ${timerBlock}
        ${(() => {
          const nextNames = previewNextForCourt(court, gameSize);
          return nextNames ? `<div class="court-next-up"><svg viewBox="0 0 24 24"><use href="#i-clock"/></svg><span>Up next: ${nextNames.map(esc).join(', ')}</span></div>` : '';
        })()}
        <div class="court-cta-row">
          <button type="button" class="court-cta pause" data-act="pause"><span class="cta-icon">${court.pauseStart ? '▶' : '⏸'}</span><span class="cta-text"><span class="cta-title">${court.pauseStart ? 'Resume' : 'Pause'}</span><span class="cta-sub">${court.pauseStart ? 'Continue the clock' : 'Stop the clock'}</span></span></button>
          <button type="button" class="court-cta end" data-act="end"><span class="cta-icon">⏹</span><span class="cta-text"><span class="cta-title">End Game</span><span class="cta-sub">Record the result</span></span></button>
        </div>
        ${courtGamesFooter}
      `;
    }
    courtsGrid.appendChild(card);
  });
  renderCourtsSwipeDots();
}

/* ---- Player details preview ----
   Card names are uppercased and clamped to two lines to keep the court
   card compact, which is occasionally still not enough room for a very
   long name — and the card itself has no room to show a player's games
   played, wins, skill level, or Fixed Duo status. The INFO button pops
   up all of that at once, right above where it was tapped: full normal-
   case name, skill level, duo pairing (if any), and this session's game/
   win tally. Works even in viewer mode since it doesn't change any state. */
let playerDetailsEl = null;
let playerDetailsHideTimer = null;
function playerDetailsPopupHtml(name){
  const stats = state.playerStats[name] || {};
  const games = stats.games || 0;
  const wins = stats.wins || 0;
  const winRate = games > 0 ? Math.round((wins / games) * 100) : null;
  const level = getPlayerLevel(name);
  const partner = fixedDuoPartner(name);
  const atTarget = state.session.targetGamesEnabled && games >= state.session.targetGamesPerPlayer;
  return `
    <div class="pd-head">
      ${avatarHtml(name)}
      <span class="pd-name">${esc(name)}</span>
    </div>
    <div class="pd-badges">
      <span class="level-badge ${levelClass(level)}">${esc(levelLabel(level))}</span>
      ${partner ? `<span class="pd-badge pd-duo" title="Fixed duo \u2014 always paired with ${esc(partner)}"><svg viewBox="0 0 24 24"><use href="#i-swap"/></svg>Duo w/ ${esc(partner)}</span>` : ''}
      ${atTarget ? `<span class="pd-badge pd-target" title="Target games reached this session"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg>Target reached</span>` : ''}
    </div>
    <div class="pd-stats">
      <span class="pd-stat"><b>${games}</b> ${games === 1 ? 'game played' : 'games played'}</span>
      <span class="pd-stat"><b>${wins}</b> ${wins === 1 ? 'win' : 'wins'}</span>
      ${winRate !== null ? `<span class="pd-stat"><b>${winRate}%</b> win rate</span>` : ''}
    </div>
  `;
}
function showPlayerDetailsPreview(btn, name){
  if (!playerDetailsEl){
    playerDetailsEl = document.createElement('div');
    playerDetailsEl.className = 'player-details-pop';
    document.body.appendChild(playerDetailsEl);
  }
  playerDetailsEl.innerHTML = playerDetailsPopupHtml(name);
  const r = btn.getBoundingClientRect();
  // Measure after content is in place so a wider card (long name, extra
  // badges) still gets clamped fully on-screen rather than overflowing.
  const half = Math.min(160, playerDetailsEl.offsetWidth / 2 || 130);
  const x = Math.min(Math.max(half + 8, r.left + r.width / 2), window.innerWidth - half - 8);
  playerDetailsEl.style.left = x + 'px';
  playerDetailsEl.style.top = Math.max(8, r.top - 6) + 'px';
  // Restart the show transition even if it's already visible for another name.
  playerDetailsEl.classList.remove('show');
  void playerDetailsEl.offsetWidth;
  playerDetailsEl.classList.add('show');
  clearTimeout(playerDetailsHideTimer);
  playerDetailsHideTimer = setTimeout(hidePlayerDetailsPreview, 4200);
}
function hidePlayerDetailsPreview(){
  if (playerDetailsEl) playerDetailsEl.classList.remove('show');
}
document.addEventListener('click', (e) => {
  if (!playerDetailsEl || !playerDetailsEl.classList.contains('show')) return;
  if (e.target.closest('.player-preview-btn, .viewer-player-info-btn')) return;
  hidePlayerDetailsPreview();
});
document.addEventListener('scroll', hidePlayerDetailsPreview, true);

/* ---- Match Info (viewer "Up next" cards only) ----
   Same idea as the player-details popup above, but for a whole upcoming
   matchup at once — every player's avatar, level, and this session's
   games/wins in one card, so a spectator doesn't have to tap each name in
   turn. Read-only, same as everything else in viewer mode. */
let matchInfoEl = null;
let matchInfoHideTimer = null;
function showMatchInfoPreview(btn, names){
  if (!matchInfoEl){
    matchInfoEl = document.createElement('div');
    matchInfoEl.className = 'player-details-pop match-info-pop';
    document.body.appendChild(matchInfoEl);
  }
  matchInfoEl.innerHTML = `<div class="mi-title">Match Info</div>` + names.map(name => {
    const stats = state.playerStats[name] || {};
    const games = stats.games || 0;
    const wins = stats.wins || 0;
    const level = getPlayerLevel(name);
    return `
      <div class="mi-player-row">
        ${avatarHtml(name)}
        <span class="mi-player-name">${esc(name)}</span>
        <span class="level-badge sm ${levelClass(level)}">${esc(levelLabel(level))}</span>
        <span class="mi-player-stats">${games} ${games === 1 ? 'game' : 'games'} · ${wins} ${wins === 1 ? 'win' : 'wins'}</span>
      </div>`;
  }).join('');
  const r = btn.getBoundingClientRect();
  const half = Math.min(170, matchInfoEl.offsetWidth / 2 || 150);
  const x = Math.min(Math.max(half + 8, r.left + r.width / 2), window.innerWidth - half - 8);
  matchInfoEl.style.left = x + 'px';
  matchInfoEl.style.top = Math.max(8, r.top - 6) + 'px';
  matchInfoEl.classList.remove('show');
  void matchInfoEl.offsetWidth;
  matchInfoEl.classList.add('show');
  clearTimeout(matchInfoHideTimer);
  matchInfoHideTimer = setTimeout(hideMatchInfoPreview, 6000);
}
function hideMatchInfoPreview(){
  if (matchInfoEl) matchInfoEl.classList.remove('show');
}
document.addEventListener('click', (e) => {
  if (!matchInfoEl || !matchInfoEl.classList.contains('show')) return;
  if (e.target.closest('.ondeck-info-btn')) return;
  hideMatchInfoPreview();
});
document.addEventListener('scroll', hideMatchInfoPreview, true);
if (historyList){
  historyList.addEventListener('click', (e) => {
    const infoBtn = e.target.closest('button[data-act="match-info"]');
    if (infoBtn){
      const names = (infoBtn.dataset.names || '').split('|').filter(Boolean);
      showMatchInfoPreview(infoBtn, names);
      return;
    }
    const editBtn = e.target.closest('button[data-act="edit-ondeck"]');
    if (editBtn){
      if (viewerMode) return; // host-only — hidden in viewer mode via CSS too, this is belt-and-suspenders
      const ids = (editBtn.dataset.ids || '').split(',').filter(Boolean);
      openUpNextSubPicker(ids, editBtn.dataset.groupNum);
    }
  });
}

courtsGrid.addEventListener('click', (e) => {
  const previewBtn = e.target.closest('button[data-act="preview-name"]');
  if (previewBtn){ showPlayerDetailsPreview(previewBtn, previewBtn.dataset.name); return; }
  if (viewerMode) return;
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.court-card');
  const court = state.courts.find(c => c.id === card.dataset.id);
  if (!court) return;
  if (btn.dataset.act === 'call'){
    if (isSessionEnded()){ toast('Session has ended — resume it to start new matches'); return; }
    callNext(court);
  }
  if (btn.dataset.act === 'call-players'){
    if (isSessionEnded()){ toast('Session has ended'); return; }
    announceCallPlayers(court, btn);
  }
  if (btn.dataset.act === 'end') openEndgame(court);
  if (btn.dataset.act === 'pause') toggleCourtPause(court);
  if (btn.dataset.act === 'undo-result') undoLastResult(court.id);
  if (btn.dataset.act === 'score-plus') adjustCourtScore(court, btn.dataset.team, 1);
  if (btn.dataset.act === 'score-minus') adjustCourtScore(court, btn.dataset.team, -1);
  if (btn.dataset.act === 'side-out') courtSideOut(court);
  if (btn.dataset.act === 'set-first-server') setInitialServer(court, btn.dataset.team);
  if (btn.dataset.act === 'advance-serve') courtAdvanceServe(court);
  if (btn.dataset.act === 'undo-serve') courtUndoServe(court);
  if (btn.dataset.act === 'swap-partner') swapCourtPartner(court, Number(btn.dataset.idx));
  if (btn.dataset.act === 'sub-player') openSubPicker(court, Number(btn.dataset.idx));
});

courtsGrid.addEventListener('change', (e) => {
  if (viewerMode) return;
  const input = e.target.closest('input[data-act="rename"]');
  if (!input) return;
  if (isCoHostRestricted()) return; // court naming is settings territory, not gameplay
  const card = input.closest('.court-card');
  const court = state.courts.find(c => c.id === card.dataset.id);
  if (!court) return;
  court.name = input.value.trim() || court.name;
  persist();
  renderUpNext();
});

/* ---- Pause / resume the in-progress timer for a court ----
   Doesn't touch court.startTime (so history's game-length math and
   everything else keyed off it stays exactly as it was) — instead it just
   tracks how much time has been spent paused, and the live-elapsed helper
   below subtracts that out. Net effect: the clock visibly stops while
   paused (water break, injury, dispute) and picks back up right where it
   left off on resume. */
function courtElapsedMs(court, endTime){
  const now = endTime !== undefined ? endTime : Date.now();
  const pausedMs = (court.pausedMs || 0) + (court.pauseStart ? (now - court.pauseStart) : 0);
  return Math.max(0, now - court.startTime - pausedMs);
}
function toggleCourtPause(court){
  if (court.pauseStart){
    court.pausedMs = (court.pausedMs || 0) + (Date.now() - court.pauseStart);
    court.pauseStart = null;
  } else {
    court.pauseStart = Date.now();
  }
  renderAll(); persist();
}

function callNext(court){
  const gameSize = state.session.gameSize;
  const openQueue = computeOpenCourtQueue(gameSize);
  const slot = openQueue.get(court.id);
  const taken = slot ? slot.taken : null;
  if (!taken){
    toast('Not enough players in the stack yet');
    return;
  }
  removeEntriesFromStack(taken);
  // Starting a fresh match on this court means any previous "undo the last
  // result" snapshot for it is no longer safe to restore (it would blow away
  // the new match), so clear it.
  if (lastUndo && lastUndo.courtId === court.id) lastUndo = null;
  if (swapSelection && swapSelection.courtId === court.id) swapSelection = null;
  court.openedAt = null; // no longer open — reset once it opens again
  court.status = 'playing';
  const naturalNames = taken.map(p => p.name);
  const pairing = computeTeamPairing(naturalNames);
  // If the host manually swapped players around in the preview, keep that
  // arrangement instead of recomputing it — as long as it's still the exact
  // same group of players that ended up selected.
  const chosenNames = (court.previewOrder && sameNameMultiset(court.previewOrder, naturalNames))
    ? court.previewOrder.slice()
    : pairing.order;
  court.players = chosenNames;
  // Keep the true FIFO arrival order separately from the (possibly
  // teammate-reshuffled) display/team order above. "Avoid Repeating
  // Teammates" only ever meant to decide TEAM assignment for this match —
  // it was never supposed to change queue fairness. But court.players was
  // also being used, further down, to decide what order these same four
  // players get pushed back into the stack once the match ends — so a
  // reshuffle made purely to avoid a repeat pairing was silently nudging
  // some players ahead in line and others behind, run after run, compounding
  // over a session into a real games-played gap. Requeuing must always
  // follow this natural order instead, regardless of how the teams
  // themselves were arranged for play.
  court.requeueOrder = naturalNames.slice();
  court.swapInfo = state.session.avoidRepeatTeammates ? buildSwapInfo(naturalNames, chosenNames, pairing.forcedDuo) : null;
  court.startTime = Date.now();
  court.pauseStart = null;
  court.pausedMs = 0;
  court.score = state.session.scoringEnabled ? freshCourtScore() : null;
  court.previewOrder = null;
  court.previewSubMap = null;
  ping();
  toast(court.name + ': ' + court.players.join(', '));
  renderAll(); persist();
}

/* ---- End game modal ---- */
const endgameOverlay = $('#endgameOverlay');
const endgameList = $('#endgameList');
const endgameTitle = $('#endgameTitle');
const winnerPick = $('#winnerPick');
let endgameCourtId = null;
let endgameChoices = {};
let endgameTeams = [[],[]];
let endgameWinnerSide = null; // 'a' | 'b' | null
let endgameScores = { a: '', b: '' }; // raw input string values
let scoresAutoFilled = false; // true when endgameScores were filled in by tapping a winner card, not typed

// Undo support: right before a game result is confirmed, we snapshot the
// entire app state. If the wrong winner gets picked, "Undo" restores that
// snapshot (putting the match back on the court, unwinding stats/history/
// queue changes) and reopens the winner picker so it can be redone.
let lastUndo = null; // { courtId, snapshot: JSON string } | null
function undoLastResult(courtId){
  if (!lastUndo || lastUndo.courtId !== courtId) return;
  let restored;
  try{ restored = JSON.parse(lastUndo.snapshot); }
  catch(e){ toast('Could not undo — snapshot was corrupted', 'error', {detailed:true}); lastUndo = null; return; }
  state = restored;
  lastUndo = null;
  const court = state.courts.find(c => c.id === courtId);
  renderAll(); persist();
  toast('Undone — pick the winner again');
  if (court) openEndgame(court);
}

function openEndgame(court){
  if (swapSelection && swapSelection.courtId === court.id) swapSelection = null;
  endgameCourtId = court.id;
  endgameTitle.textContent = 'End game — ' + court.name;
  endgameChoices = {};
  court.players.forEach(name => { endgameChoices[name] = isSessionEnded() ? 'done' : 'requeue'; });
  endgameTeams = splitTeams(court.players);
  endgameWinnerSide = null;
  endgameScores = { a: '', b: '' };
  scoresAutoFilled = false;
  if (state.session.scoringEnabled && court.score){
    endgameScores = { a: String(safeN(court.score.a)), b: String(safeN(court.score.b)) };
  }
  const lockNote = $('#endgameLockNote');
  if (lockNote) lockNote.style.display = isSessionEnded() ? '' : 'none';
  recomputeWinnerFromScores();
  renderWinnerPick();
  renderEndgameList();
  endgameOverlay.hidden = false;
}
function renderWinnerPick(){
  const [a, b] = endgameTeams;
  const label = state.session.gameSize <= 2 ? 'Player' : 'Team';
  winnerPick.innerHTML = `
    <div class="winner-card ${endgameWinnerSide==='a'?'selected':''}" data-side="a">
      <span class="trophy">🏆</span>
      <div class="team-label">${label} 1</div>
      <div class="team-names">${a.map(esc).join(' &amp; ') || '—'}</div>
      <input class="score-input" type="number" min="0" step="1" inputmode="numeric" placeholder="—" data-side="a" value="${esc(endgameScores.a)}" aria-label="${label} 1 score">
    </div>
    <div class="winner-card ${endgameWinnerSide==='b'?'selected':''}" data-side="b">
      <span class="trophy">🏆</span>
      <div class="team-label">${label} 2</div>
      <div class="team-names">${b.map(esc).join(' &amp; ') || '—'}</div>
      <input class="score-input" type="number" min="0" step="1" inputmode="numeric" placeholder="—" data-side="b" value="${esc(endgameScores.b)}" aria-label="${label} 2 score">
    </div>
  `;
}
// Scores drive the winner automatically — same rule as the tournament bracket:
// higher score wins, equal scores clear the pick, and an empty field is just "not entered yet".
function recomputeWinnerFromScores(){
  const va = endgameScores.a, vb = endgameScores.b;
  if (va === '' || vb === '') return; // incomplete — leave any manual pick alone
  const sa = Number(va), sb = Number(vb);
  if (isNaN(sa) || isNaN(sb)) return;
  if (sa > sb) endgameWinnerSide = 'a';
  else if (sb > sa) endgameWinnerSide = 'b';
  else endgameWinnerSide = null; // tied — caught properly at confirm time
}
function syncWinnerPickSelection(){
  winnerPick.querySelectorAll('.winner-card[data-side]').forEach(card => {
    card.classList.toggle('selected', card.dataset.side === endgameWinnerSide);
  });
}
winnerPick.addEventListener('input', (e) => {
  const input = e.target.closest('.score-input');
  if (!input) return;
  scoresAutoFilled = false;
  endgameScores[input.dataset.side] = input.value;
  recomputeWinnerFromScores();
  // Only toggle the selected-card class — rebuilding the DOM here would
  // destroy and recreate the input mid-keystroke, losing focus and caret position.
  syncWinnerPickSelection();
});
winnerPick.addEventListener('click', (e) => {
  if (e.target.closest('.score-input')) return; // let the input handle its own clicks
  const card = e.target.closest('.winner-card[data-side]');
  if (!card) return;
  const side = card.dataset.side;
  const noRealScore = (endgameScores.a === '' || endgameScores.a === '0') && (endgameScores.b === '' || endgameScores.b === '0');
  if (noRealScore || scoresAutoFilled){
    const newSide = endgameWinnerSide === side ? null : side;
    endgameWinnerSide = newSide;
    if (newSide === null){
      endgameScores = { a: '', b: '' };
      scoresAutoFilled = false;
    } else {
      const target = getWinTarget();
      endgameScores = { a: newSide === 'a' ? String(target) : '0', b: newSide === 'b' ? String(target) : '0' };
      scoresAutoFilled = true;
    }
    renderWinnerPick();
    return;
  }
  // Real scores were typed in already — just toggle the pick without touching them.
  endgameWinnerSide = endgameWinnerSide === side ? null : side;
  syncWinnerPickSelection();
});
function renderEndgameList(){
  const ended = isSessionEnded();
  endgameList.innerHTML = Object.keys(endgameChoices).map(name => `
    <div class="endgame-row">
      <span class="who">${esc(name)}</span>
      <span class="choice">
        <button type="button" class="sel-requeue ${endgameChoices[name]==='requeue'?'active':''}" data-name="${esc(name)}" data-choice="requeue" ${ended ? 'disabled' : ''}>Back in stack</button>
        <button type="button" class="sel-done ${endgameChoices[name]==='done'?'active':''}" data-name="${esc(name)}" data-choice="done">Done for today</button>
      </span>
    </div>
  `).join('');
}
endgameList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-choice]');
  if (!btn || btn.disabled) return;
  endgameChoices[btn.dataset.name] = btn.dataset.choice;
  renderEndgameList();
});
$('#endgameCancel').addEventListener('click', () => { endgameOverlay.hidden = true; });
$('#endgameConfirm').addEventListener('click', async () => {
  const court = state.courts.find(c => c.id === endgameCourtId);
  if (!court) { endgameOverlay.hidden = true; return; }

  const hasScoreA = endgameScores.a !== '';
  const hasScoreB = endgameScores.b !== '';
  if (hasScoreA !== hasScoreB){
    toast('Enter both scores, or leave both blank to skip');
    return;
  }
  let finalScoreA = null, finalScoreB = null;
  if (hasScoreA && hasScoreB){
    finalScoreA = Number(endgameScores.a);
    finalScoreB = Number(endgameScores.b);
    if (isNaN(finalScoreA) || isNaN(finalScoreB)){
      toast('Scores need to be numbers');
      return;
    }
    if (!Number.isInteger(finalScoreA) || !Number.isInteger(finalScoreB) || finalScoreA < 0 || finalScoreB < 0){
      toast('Scores should be whole numbers, 0 or higher');
      return;
    }
    if (finalScoreA === finalScoreB){
      toast('Tie scores are not allowed — adjust the score or clear both to skip');
      return;
    }
  } else if (endgameWinnerSide !== null){
    // Winner picked manually (by tapping a side) with no scores typed in —
    // record a default 11–5 scoreline so it still counts toward average score.
    finalScoreA = endgameWinnerSide === 'a' ? 11 : 5;
    finalScoreB = endgameWinnerSide === 'b' ? 11 : 5;
  }
  if (endgameWinnerSide === null){
    toast('Pick a winner before clearing the court');
    return;
  }
  // Snapshot state now, before anything is mutated, so a wrong pick can be undone.
  lastUndo = { courtId: court.id, snapshot: JSON.stringify(state) };
  const endTime = Date.now();
  const winnerNames = endgameWinnerSide === 'a' ? endgameTeams[0] : endgameWinnerSide === 'b' ? endgameTeams[1] : null;
  const scoreLine = (finalScoreA !== null) ? (endgameWinnerSide === 'a' ? `${finalScoreA}-${finalScoreB}` : `${finalScoreB}-${finalScoreA}`) : null;

  endgameTeams[0].forEach(name => {
    const stats = getStats(name);
    stats.games += 1;
    if (winnerNames && winnerNames.includes(name)) stats.wins += 1;
    if (finalScoreA !== null){ stats.scoreSum = (stats.scoreSum || 0) + finalScoreA; stats.scoreGames = (stats.scoreGames || 0) + 1; }
  });
  endgameTeams[1].forEach(name => {
    const stats = getStats(name);
    stats.games += 1;
    if (winnerNames && winnerNames.includes(name)) stats.wins += 1;
    if (finalScoreB !== null){ stats.scoreSum = (stats.scoreSum || 0) + finalScoreB; stats.scoreGames = (stats.scoreGames || 0) + 1; }
  });
  recordTeammates(endgameTeams[0]);
  recordTeammates(endgameTeams[1]);
  recordOpponents(endgameTeams[0], endgameTeams[1]);

  state.history.unshift({
    id: nextId('h'), courtName: court.name,
    teamA: endgameTeams[0].slice(), teamB: endgameTeams[1].slice(),
    winner: endgameWinnerSide, winnerNames: winnerNames ? winnerNames.slice() : null,
    scoreA: finalScoreA, scoreB: finalScoreB,
    startTime: court.startTime, endTime,
    swapInfo: court.swapInfo || null
  });
  state.history = state.history.slice(0, 100);

  // Requeue in the order these four players naturally arrived in (FIFO),
  // never in court.players' team-paired order — see the comment on
  // court.requeueOrder in callNext() for why that distinction matters.
  // Falls back to endgameChoices' own key order for older in-flight
  // matches saved before requeueOrder existed, and always covers any name
  // requeueOrder might be missing (belt-and-suspenders, shouldn't happen).
  const requeueNames = (court.requeueOrder && court.requeueOrder.length)
    ? court.requeueOrder.slice()
    : Object.keys(endgameChoices);
  Object.keys(endgameChoices).forEach(name => { if (!requeueNames.includes(name)) requeueNames.push(name); });
  requeueNames.forEach(name => {
    const choice = endgameChoices[name];
    if (choice === 'requeue'){
      const entry = { id: nextId('p'), name, joinedAt: Date.now(), tag: 'queued' };
      if (winnerNames && getMatchingStyle() === 'winnersLosers'){
        // A winner was recorded and the Winners/Losers matching style is
        // active — sort into the winners/losers block so the queue later
        // pairs winners vs winners and losers vs losers.
        if (winnerNames.includes(name)) state.winnersBlock.push(entry);
        else state.losersBlock.push(entry);
      } else {
        // Balanced / Skill Separated styles (or no winner recorded) — go
        // straight back into the queue, in order.
        state.stack.push(entry);
      }
    }
  });

  court.lastResult = { winnerNames: winnerNames ? winnerNames.slice() : null, scoreLine };
  court.status = 'open';
  court.players = [];
  court.startTime = null;
  court.pauseStart = null;
  court.pausedMs = 0;
  court.swapInfo = null;
  court.score = null;
  court.previewOrder = null;
  court.previewSubMap = null;
  court.requeueOrder = null;
  court.openedAt = Date.now(); // start the 2-minute auto-start window fresh from right now
  // Only check whether a block should force-flush (not enough players left
  // to ever fill both blocks) AFTER this court's own players are cleared
  // above. checkBlockFlush() counts anyone still mid-game as "on the way
  // back" so it doesn't merge prematurely — but this court's 4 just-finished
  // players are ALSO the ones that were just pushed into the winners/losers
  // blocks a moment ago. Checking before the reset above would count them
  // TWICE (once in the block, once as "still playing" on this court),
  // inflating the total and silently blocking the exact merge this is meant
  // to trigger — which is why a match could get stuck waiting instead of
  // auto-continuing right after the very game that left it short-handed.
  checkBlockFlush();
  endgameOverlay.hidden = true;
  toast(court.name + ' cleared');
  renderAll(); persist();
  // Auto Call Players: renderAll() just recomputed court.previewOrder (the
  // freshly cleared court's next lineup, if the queue already has enough
  // waiting) — fire the same call announceCallPlayers() makes from a manual
  // tap, just silent (no confirmation popup), so the host never has to
  // remember to hit "Call Players" after every single match.
  if (state.session.autoCallPlayersEnabled === true && court.previewOrder && court.previewOrder.length){
    announceCallPlayers(court, null, { silent: true });
  }
});

/* ================= Up Next (queue preview) =================
   The courts-page panel used to repeat the last few finished games, which
   is already covered in full by the Match History modal. Far more useful
   here: who's queued up behind whatever's already previewed on the open
   court cards above — the players who'll get called next once a court
   frees up. */
// "View full schedule" just raises how many upcoming groups this same
// preview logic computes and renders — same selectMatchEntries /
// reconcileFixedDuosAcrossGroups calls as always, just a higher cap.
let upNextExpanded = false;
// Tracks every player id currently claimed by a rendered "On deck" group, as
// of the last renderUpNext() call — used to keep the customize-slot picker
// (openUpNextSubPicker) from offering someone who's already locked into
// another on-deck row.
let upNextGroupClaimedIds = new Set();
function renderUpNext(){
  const expandBtn = $('#upNextExpandBtn');
  // Same permission a co-host needs to actually use the pencil icon below
  // (enforced again in openUpNextSubPicker via cohostActionAllowed) — the
  // host device is never coHostMode, so this is always true for the host.
  const subPermitted = !coHostMode || getCohostPermissions().allowSubstitution;
  // Drop any customize-slot picks that no longer make sense — either side
  // having left state.stack entirely (started a match, got removed, etc).
  // Lazy, cheap, and keeps this from silently accumulating dead entries.
  if (state.upNextSubMap && Object.keys(state.upNextSubMap).length){
    const stackIds = new Set(state.stack.map(e => e.id));
    const pruned = {};
    Object.keys(state.upNextSubMap).forEach(outId => {
      const inId = state.upNextSubMap[outId];
      if (stackIds.has(outId) && stackIds.has(inId)) pruned[outId] = inId;
    });
    state.upNextSubMap = pruned;
  }
  if (state.courts.length === 0){
    historyList.innerHTML = '<div class="ondeck-empty">Add a court to see who plays next.</div>';
    if (expandBtn) expandBtn.hidden = true;
    upNextGroupClaimedIds = new Set();
    updateViewerUpNext();
    return;
  }
  const gameSize = state.session.gameSize;
  // Same rule as the open court cards (see computeOpenCourtQueue): nothing
  // gets grouped into a "next match" preview until the host has actually
  // run Generate Match at least once. Without this, checking players in
  // was enough to see them paired off into On Deck groups on their own —
  // looking like the app had started assigning matches before any wizard
  // setup happened, even though nothing had actually started.
  if (!state.session.generationReady){
    historyList.innerHTML = state.stack.length === 0
      ? '<div class="ondeck-empty">The stack is empty — add players to fill the next match.</div>'
      : '<div class="ondeck-empty">Run Generate Match to build the next matchups — checking players in only adds them to the queue.</div>';
    if (expandBtn) expandBtn.hidden = true;
    upNextGroupClaimedIds = new Set();
    updateViewerUpNext();
    return;
  }
  // Whatever the open court cards above are already previewing doesn't need
  // repeating here — start the "on deck" view from whoever's left after that.
  const openQueue = computeOpenCourtQueue(gameSize);
  const claimed = new Set();
  openQueue.forEach(slot => { if (slot.taken) slot.taken.forEach(e => claimed.add(e.id)); });
  const onDeck = state.stack.filter(e => !claimed.has(e.id));

  if (onDeck.length === 0){
    historyList.innerHTML = state.stack.length === 0
      ? '<div class="ondeck-empty">The stack is empty — add players to fill the next match.</div>'
      : '<div class="ondeck-empty">Everyone waiting is already lined up for an open court.</div>';
    if (expandBtn) expandBtn.hidden = true;
    upNextGroupClaimedIds = new Set();
    updateViewerUpNext();
    return;
  }

  // Build all the upcoming groups first, in order — a fixed duo split
  // across two of THESE groups (each already fully formed) can't be caught
  // by selectMatchEntries alone, since it only reaches players not yet
  // claimed by any group. Reconciling afterward, across the whole set,
  // is what lets Marcus (say, in group 1) actually end up with Logan
  // (already locked into group 3) instead of the two staying split.
  const groupCap = upNextExpanded ? 25 : 3;
  const groups = [];
  let previewStack = onDeck.slice();
  while (previewStack.length >= gameSize && groups.length < groupCap){
    const chosen = selectMatchEntries(gameSize, previewStack);
    const chosenIds = new Set(chosen.map(e => e.id));
    previewStack = previewStack.filter(e => !chosenIds.has(e.id));
    groups.push(chosen);
  }
  const reconciled = reconcileFixedDuosAcrossGroups(groups, onDeck, gameSize);

  // Apply any "customize this on-deck slot" picks the host made (see
  // openUpNextSubPicker / state.upNextSubMap). Same mechanics as a court's
  // previewSubMap: the outgoing player is simply left where they are in
  // state.stack (so they naturally get picked up somewhere else), the
  // incoming player is pulled into this exact slot. A pick that's gone
  // stale — incoming already claimed by an open court or another on-deck
  // group, or would split a fixed duo — is silently skipped, same as the
  // court version.
  if (state.upNextSubMap && Object.keys(state.upNextSubMap).length){
    const usedIncomingIds = new Set();
    reconciled.forEach(group => {
      for (let outIdx = 0; outIdx < group.length; outIdx++){
        const outgoing = group[outIdx];
        const incomingId = state.upNextSubMap[outgoing.id];
        if (!incomingId || usedIncomingIds.has(incomingId)) continue;
        const alreadyPlaced = reconciled.some(g => g.some(e => e.id === incomingId));
        if (alreadyPlaced) continue;
        const incomingEntry = state.stack.find(e => e.id === incomingId);
        if (!incomingEntry || claimed.has(incomingEntry.id)) continue;
        if (isInFixedDuo(outgoing.name) || isInFixedDuo(incomingEntry.name)) continue;
        group[outIdx] = incomingEntry;
        usedIncomingIds.add(incomingId);
      }
    });
  }
  upNextGroupClaimedIds = new Set();
  reconciled.forEach(g => g.forEach(e => upNextGroupClaimedIds.add(e.id)));

  // Numbered "ON DECK 1/2/3" rows with "&"-joined team names on one line
  // and a player-count icon — same layout for host and spectator alike.
  const rows = [];
  reconciled.forEach((chosen, i) => {
    const groupNum = i + 1;
    const names = orderForTeammatePairing(chosen.map(p => p.name));
    let matchup;
    if (gameSize === 2){
      matchup = `<span class="ondeck-team">${esc(names[0])}</span><span class="ondeck-vs">vs</span><span class="ondeck-team">${esc(names[1])}</span>`;
    } else {
      const [a, b] = splitTeams(names);
      matchup = `<span class="ondeck-team">${a.map(esc).join(' &amp; ')}</span><span class="ondeck-vs">vs</span><span class="ondeck-team">${b.map(esc).join(' &amp; ')}</span>`;
    }
    const editIds = chosen.map(p => p.id).join(',');
    // Same rule as every other sub-related control (see playerRowHtml /
    // blockItemsHtml above): a co-host without the Allow Substitution
    // permission never even sees this pencil icon — left out of the HTML
    // entirely, not just CSS-hidden — since tapping it only leads to a
    // dead-end toast from cohostActionAllowed() inside openUpNextSubPicker.
    const editBtnHtml = subPermitted ? `<button type="button" class="ondeck-edit-btn" data-act="edit-ondeck" data-ids="${editIds}" data-group-num="${groupNum}" aria-label="Customize on-deck match ${groupNum}" title="Customize this match"><svg viewBox="0 0 24 24"><use href="#i-pencil"/></svg></button>` : '';
    rows.push(`
      <div class="ondeck-row">
        <span class="ondeck-badge-col">
          <span class="ondeck-badge">On deck</span>
          <span class="ondeck-index">${groupNum}</span>
        </span>
        <span class="ondeck-matchup">${matchup}</span>
        ${editBtnHtml}
        <span class="ondeck-meta"><svg viewBox="0 0 24 24"><use href="#i-user"/></svg>${chosen.length}</span>
      </div>`);
  });
  if (previewStack.length > 0 && !upNextExpanded){
    rows.push(`<div class="ondeck-more">+${previewStack.length} more waiting</div>`);
  }
  if (rows.length === 0){
    const need = gameSize - onDeck.length;
    rows.push(`<div class="ondeck-empty">Waiting on ${need} more player${need === 1 ? '' : 's'} for the next match.</div>`);
  }
  historyList.innerHTML = rows.join('');
  if (expandBtn){
    expandBtn.hidden = false;
    expandBtn.textContent = upNextExpanded ? 'Show less' : 'View full schedule';
  }
  updateViewerUpNext();
}
if ($('#upNextExpandBtn')){
  $('#upNextExpandBtn').addEventListener('click', (e) => {
    // Lives inside <summary> for layout purposes only — stop it from also
    // triggering the native details open/close toggle.
    e.preventDefault(); e.stopPropagation();
    upNextExpanded = !upNextExpanded;
    renderUpNext();
  });
}

/* Mirrors up to the first 2 "On deck" rows (if any) into the floating
   spectator notification card that sits above the courts grid — see
   .viewer-upnext-notify in style.css. Only relevant in viewer mode; a no-op
   (and hidden) otherwise, since hosts already see the full stack rail. The
   old collapsed "Up next" panel further down the page is hidden outright
   in viewer mode (body.viewer-mode .history in style.css) since this card
   now covers the same ground without making a spectator scroll for it. */
let lastViewerUpNextHtml = null;
function updateViewerUpNext(){
  const notify = $('#viewerUpNextNotify');
  const body = $('#viewerUpNextBody');
  if (!notify || !body) return;
  if (!viewerMode){ notify.hidden = true; return; }
  const rows = historyList ? Array.from(historyList.querySelectorAll('.ondeck-row')).slice(0, 2) : [];
  if (rows.length === 0){
    notify.hidden = true;
    lastViewerUpNextHtml = null;
    return;
  }
  notify.hidden = false;
  const tags = ['Next', 'Then'];
  const html = rows.map((row, i) => {
    const matchupEl = row.querySelector('.ondeck-matchup');
    const matchupHtml = matchupEl ? matchupEl.innerHTML : '';
    return `<div class="viewer-upnext-item"><span class="viewer-upnext-tag">${tags[i] || ''}</span>${matchupHtml}</div>`;
  }).join('');
  if (html !== lastViewerUpNextHtml){
    lastViewerUpNextHtml = html;
    body.innerHTML = html;
    // Re-trigger the slide/fade-in so a change in who's up next is visible
    // even if the spectator isn't looking right at the card at that instant.
    notify.querySelector('.viewer-upnext-notify-inner').style.animation = 'none';
    void notify.offsetWidth;
    notify.querySelector('.viewer-upnext-notify-inner').style.animation = '';
  }
}

/* ================= Match History modal (full detail + swap log) ================= */
const matchHistoryOverlay = $('#matchHistoryOverlay');
const matchHistoryFullList = $('#matchHistoryFullList');
const matchHistorySearchInput = $('#matchHistorySearchInput');
const matchHistoryCourtFilter = $('#matchHistoryCourtFilter');
const matchHistoryResultFilter = $('#matchHistoryResultFilter');
const matchHistoryLevelFilter = $('#matchHistoryLevelFilter');
const matchHistoryClearFiltersBtn = $('#matchHistoryClearFiltersBtn');

// Themed dropdown for the Match History filter row (court / result / level) —
// same "custom-select" pattern used for "Call out a player" > court picker,
// so the open list matches the app instead of the OS's own popup. Each
// native <select> above stays the source of truth (kept in sync with the
// existing state.value reads elsewhere); this just keeps a themed trigger +
// panel in sync with whatever options/value the select currently holds.
function initMatchHistoryCustomSelect(selectEl, customEl, triggerEl, labelEl, panelEl){
  let open = false;
  function close(){
    open = false;
    panelEl.hidden = true;
    triggerEl.setAttribute('aria-expanded', 'false');
  }
  function doOpen(){
    open = true;
    render();
    panelEl.hidden = false;
    triggerEl.setAttribute('aria-expanded', 'true');
  }
  function render(){
    const opts = Array.from(selectEl.options).map(o => ({ value: o.value, label: o.textContent }));
    panelEl.innerHTML = opts.map(o => `
      <div class="custom-select-option${o.value === selectEl.value ? ' selected' : ''}" role="option" tabindex="-1" data-value="${esc(o.value)}" aria-selected="${o.value === selectEl.value}">${esc(o.label)}</div>
    `).join('');
    const match = opts.find(o => o.value === selectEl.value);
    labelEl.textContent = match ? match.label : (opts[0] ? opts[0].label : '');
  }
  function choose(optEl){
    if (selectEl.value !== optEl.dataset.value){
      selectEl.value = optEl.dataset.value;
      selectEl.dispatchEvent(new Event('change'));
    }
    close();
    render();
    triggerEl.focus();
  }
  triggerEl.addEventListener('click', () => {
    if (open) close(); else doOpen();
  });
  panelEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.custom-select-option');
    if (!opt) return;
    choose(opt);
  });
  document.addEventListener('click', (e) => {
    if (!open) return;
    if (e.target.closest(`#${customEl.id}`)) return;
    close();
  });
  wireCustomSelectKeyboardNav(triggerEl, panelEl, { isOpen: () => open, open: doOpen, close, choose });
  return { render, close };
}
const matchHistoryCountEl = $('#matchHistoryCount');
// Kept across renders (not reset each render) so re-opening the modal, or a
// live-synced history update while it's open, doesn't clear what the host
// was searching for. Reset explicitly by Clear or on a genuinely fresh open.
let matchHistoryFilters = { search: '', court: 'all', result: 'all', level: 'all' };

function fmtDateTime(ts){
  if (!ts) return '';
  try{
    return new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }catch(e){ return ''; }
}

function swapNoteHtml(swapInfo){
  if (!swapInfo) return '';
  const naturalLine = `${swapInfo.naturalTeamA.map(esc).join(' &amp; ')} vs ${swapInfo.naturalTeamB.map(esc).join(' &amp; ')}`;
  const chosenLine = `${swapInfo.chosenTeamA.map(esc).join(' &amp; ')} vs ${swapInfo.chosenTeamB.map(esc).join(' &amp; ')}`;
  const title = swapInfo.forcedDuo ? 'Swapped to keep a fixed duo together' : 'Swapped to avoid a repeat pairing';
  return `<div class="swap-note">
    <span class="swap-note-title"><svg viewBox="0 0 24 24" style="width:12px;height:12px;vertical-align:-2px;margin-right:.3rem"><use href="#i-swap"/></svg>${title}</span>
    <span class="swap-note-line">Would've been: <s>${naturalLine}</s></span>
    <span class="swap-note-line">Played instead: <b>${chosenLine}</b></span>
  </div>`;
}

function matchFullRowHtml(h){
  const a = (h.teamA||[]).map(esc).join(' &amp; ') || '—';
  const b = (h.teamB||[]).map(esc).join(' &amp; ') || '—';
  const aWon = h.winner === 'a', bWon = h.winner === 'b';
  const scoreTxt = (h.scoreA != null && h.scoreB != null)
    ? (h.winner === 'a' ? `${h.scoreA}-${h.scoreB}` : `${h.scoreB}-${h.scoreA}`)
    : 'No score recorded';
  const dur = (h.startTime && h.endTime) ? fmtClock(h.endTime - h.startTime) : '—';
  const showSwap = state.session.avoidRepeatTeammates && h.swapInfo;
  return `<div class="match-full-row">
    <div class="match-full-head">
      <span class="match-full-court"><svg viewBox="0 0 24 24"><use href="#i-court"/></svg>${esc(h.courtName)}</span>
      <span class="match-full-when">${fmtDateTime(h.endTime)}</span>
    </div>
    <div class="match-full-teams">
      <span class="${aWon?'match-team-won':''}">${aWon?'🏆 ':''}${a}</span>
      <span class="match-full-vs">vs</span>
      <span class="${bWon?'match-team-won':''}">${bWon?'🏆 ':''}${b}</span>
    </div>
    <div class="match-full-meta">${scoreTxt} — ${dur} on court</div>
    ${showSwap ? swapNoteHtml(h.swapInfo) : ''}
  </div>`;
}

// Every player name that appears anywhere in a match entry, used both for
// the search box (name substring match) and the level filter (does this
// match involve anyone currently at the selected level?). Levels aren't
// stored per-match — like everywhere else in the app, a player's level is
// looked up live via getPlayerLevel — so this reflects each player's
// *current* level, not necessarily what it was back when the match played.
function matchPlayerNames(h){
  return [].concat(h.teamA || [], h.teamB || []);
}
function matchMatchesSearch(h, needle){
  if (!needle) return true;
  const hay = (h.courtName + ' ' + matchPlayerNames(h).join(' ')).toLowerCase();
  return hay.includes(needle);
}
const matchHistoryCourtCustomSelect = initMatchHistoryCustomSelect(
  matchHistoryCourtFilter, $('#matchHistoryCourtCustom'), $('#matchHistoryCourtTrigger'), $('#matchHistoryCourtTriggerLabel'), $('#matchHistoryCourtPanel')
);
const matchHistoryResultCustomSelect = initMatchHistoryCustomSelect(
  matchHistoryResultFilter, $('#matchHistoryResultCustom'), $('#matchHistoryResultTrigger'), $('#matchHistoryResultTriggerLabel'), $('#matchHistoryResultPanel')
);
const matchHistoryLevelCustomSelect = initMatchHistoryCustomSelect(
  matchHistoryLevelFilter, $('#matchHistoryLevelCustom'), $('#matchHistoryLevelTrigger'), $('#matchHistoryLevelTriggerLabel'), $('#matchHistoryLevelPanel')
);

function matchMatchesFilters(h){
  const f = matchHistoryFilters;
  if (f.court !== 'all' && h.courtName !== f.court) return false;
  if (f.result === 'scored' && !(h.scoreA != null && h.scoreB != null)) return false;
  if (f.result === 'unscored' && (h.scoreA != null && h.scoreB != null)) return false;
  if (f.level !== 'all' && !matchPlayerNames(h).some(n => getPlayerLevel(n) === f.level)) return false;
  if (f.search && !matchMatchesSearch(h, f.search)) return false;
  return true;
}

// Rebuilds the Court and Level dropdown OPTIONS from what's actually in
// state.history right now (courts get renamed/added over a long session,
// and skill levels are only relevant once the session turns them on) —
// while preserving whatever the host already had picked, so typing a
// search term doesn't reset an active court/level filter out from under
// them. Only called when the modal opens or the underlying history
// changes shape, never on every keystroke.
function refreshMatchHistoryFilterOptions(){
  const courts = [...new Set(state.history.map(h => h.courtName))].sort();
  const keepCourt = courts.includes(matchHistoryFilters.court) ? matchHistoryFilters.court : 'all';
  matchHistoryFilters.court = keepCourt;
  matchHistoryCourtFilter.innerHTML = '<option value="all">All courts</option>' +
    courts.map(c => `<option value="${esc(c)}" ${c === keepCourt ? 'selected' : ''}>${esc(c)}</option>`).join('');

  const matchHistoryLevelCustom = $('#matchHistoryLevelCustom');
  if (state.session.skillLevelsEnabled){
    const levelsPresent = PLAYER_LEVELS.filter(lvl => state.history.some(h => matchPlayerNames(h).some(n => getPlayerLevel(n) === lvl)));
    const keepLevel = levelsPresent.includes(matchHistoryFilters.level) ? matchHistoryFilters.level : 'all';
    matchHistoryFilters.level = keepLevel;
    matchHistoryLevelFilter.innerHTML = '<option value="all">All levels</option>' +
      levelsPresent.map(lvl => `<option value="${esc(lvl)}" ${lvl === keepLevel ? 'selected' : ''}>${esc(levelLabel(lvl))}</option>`).join('');
    matchHistoryLevelFilter.hidden = false;
    if (matchHistoryLevelCustom) matchHistoryLevelCustom.hidden = false;
  } else {
    matchHistoryFilters.level = 'all';
    matchHistoryLevelFilter.hidden = true;
    if (matchHistoryLevelCustom) matchHistoryLevelCustom.hidden = true;
  }
  matchHistoryResultFilter.value = matchHistoryFilters.result;

  // Keep the themed triggers/panels in sync with whatever the (now updated)
  // native selects hold — closing each first so a background refresh (e.g.
  // a live-synced history update) never rewrites an open panel out from
  // under the host mid-pick.
  matchHistoryCourtCustomSelect.close(); matchHistoryCourtCustomSelect.render();
  matchHistoryResultCustomSelect.close(); matchHistoryResultCustomSelect.render();
  matchHistoryLevelCustomSelect.close(); matchHistoryLevelCustomSelect.render();
}

/* ---- Match history CSV export ----
   Exports whatever's currently filtered/searched (not necessarily the
   full history) so "search for Alice, then export" gives just Alice's
   games — matching what the host is actually looking at on screen. */
function csvCell(v){
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function matchHistoryToCsv(rows){
  const header = ['Date','Time','Court','Team A','Team B','Winner','Score A','Score B','Duration (min)'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach(h => {
    const start = h.startTime ? new Date(h.startTime) : null;
    const durMin = (h.startTime && h.endTime) ? Math.max(0, Math.round((h.endTime - h.startTime) / 60000)) : '';
    const winnerLabel = h.winnerNames ? h.winnerNames.join(' & ') : (h.winner === 'a' ? (h.teamA||[]).join(' & ') : h.winner === 'b' ? (h.teamB||[]).join(' & ') : '');
    lines.push([
      start ? start.toLocaleDateString() : '',
      start ? start.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '',
      h.courtName || '',
      (h.teamA || []).join(' & '),
      (h.teamB || []).join(' & '),
      winnerLabel,
      h.scoreA != null ? h.scoreA : '',
      h.scoreB != null ? h.scoreB : '',
      durMin
    ].map(csvCell).join(','));
  });
  return lines.join('\r\n');
}
$('#matchHistoryExportBtn')?.addEventListener('click', () => {
  const rows = state.history.filter(matchMatchesFilters);
  if (!rows.length){ toast('No matches to export' + (state.history.length ? ' — try clearing your filters' : ''), 'warning', {detailed:true}); return; }
  const csv = matchHistoryToCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `paddlestack-match-history-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${rows.length} match${rows.length === 1 ? '' : 'es'} to CSV`, 'success', {detailed:true});
});

// Re-renders just the list + count — safe to call on every keystroke since
// it never touches the filter dropdowns/search input themselves, so focus
// and cursor position in the search box are never disturbed.
function renderMatchHistoryList(){
  const filtered = state.history.filter(matchMatchesFilters);
  const anyFilterActive = matchHistoryFilters.search || matchHistoryFilters.court !== 'all' || matchHistoryFilters.result !== 'all' || matchHistoryFilters.level !== 'all';
  matchHistoryFullList.innerHTML = state.history.length === 0
    ? '<div class="match-history-empty">No games finished yet.</div>'
    : (filtered.length === 0
        ? '<div class="match-history-empty">No matches found — try a different filter.</div>'
        : filtered.map(matchFullRowHtml).join(''));
  matchHistoryCountEl.textContent = state.history.length === 0
    ? ''
    : (anyFilterActive ? `Showing ${filtered.length} of ${state.history.length} matches` : `${state.history.length} match${state.history.length === 1 ? '' : 'es'}`);
}

function renderMatchHistory(){
  refreshMatchHistoryFilterOptions();
  renderMatchHistoryList();
}

function openMatchHistory(){
  renderMatchHistory();
  matchHistorySearchInput.value = matchHistoryFilters.search;
  matchHistoryOverlay.hidden = false;
}
$('#matchHistoryBtn').addEventListener('click', openMatchHistory);
// Bottom-nav "History" tab (phones) mirrors the topbar history button —
// same handler, just a second entry point, so no new logic is introduced.
const tabHistoryNavBtn = $('#tabHistoryNav');
if (tabHistoryNavBtn) tabHistoryNavBtn.addEventListener('click', openMatchHistory);
// Same modal, same renderer — spectators get the exact same read-only match
// history the host sees, just reached via a button in the viewer banner
// instead of the (hidden-for-viewers) top toolbar icon.
const viewerMatchHistoryBtn = $('#viewerMatchHistoryBtn');
if (viewerMatchHistoryBtn) viewerMatchHistoryBtn.addEventListener('click', openMatchHistory);

matchHistorySearchInput.addEventListener('input', () => {
  matchHistoryFilters.search = matchHistorySearchInput.value.trim().toLowerCase();
  renderMatchHistoryList();
});
matchHistoryCourtFilter.addEventListener('change', () => {
  matchHistoryFilters.court = matchHistoryCourtFilter.value;
  renderMatchHistoryList();
});
matchHistoryResultFilter.addEventListener('change', () => {
  matchHistoryFilters.result = matchHistoryResultFilter.value;
  renderMatchHistoryList();
});
matchHistoryLevelFilter.addEventListener('change', () => {
  matchHistoryFilters.level = matchHistoryLevelFilter.value;
  renderMatchHistoryList();
});
matchHistoryClearFiltersBtn.addEventListener('click', () => {
  matchHistoryFilters = { search: '', court: 'all', result: 'all', level: 'all' };
  matchHistorySearchInput.value = '';
  refreshMatchHistoryFilterOptions();
  renderMatchHistoryList();
});
$('#themeToggleBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
});

/* ---- Viewer dashboard quick actions: View / Theme / Notify ----
   Per-device preferences (this browser only), same pattern as THEME_KEY
   above — read once at boot, applied immediately, no server round-trip. */
const VIEWER_LAYOUT_KEY = 'paddleStackViewerLayout'; // 'grid' | 'list'
const VIEWER_NOTIFY_KEY = 'paddleStackViewerNotifyEnabled'; // '1' | '0' | absent
function getViewerLayout(){
  try{ return localStorage.getItem(VIEWER_LAYOUT_KEY) === 'list' ? 'list' : 'grid'; }catch(e){ return 'grid'; }
}
function isViewerNotifyEnabled(){
  try{
    const v = localStorage.getItem(VIEWER_NOTIFY_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  }catch(e){}
  // No explicit choice made on this device yet — mirror whatever the
  // browser permission already is, so someone who granted it earlier via
  // the "Who's watching" player pick doesn't have to separately flip this
  // toggle on too.
  return ('Notification' in window) && Notification.permission === 'granted';
}
function applyViewerLayout(layout){
  if (courtsGrid) courtsGrid.classList.toggle('viewer-list-layout', layout === 'list');
  const iconUse = $('#viewerViewIconUse');
  if (iconUse) iconUse.setAttribute('href', layout === 'list' ? '#i-bars' : '#i-grid');
  const label = $('#viewerViewLabel');
  if (label) label.textContent = layout === 'list' ? 'List' : 'Grid';
  const btn = $('#viewerViewBtn');
  if (btn) btn.setAttribute('aria-label', layout === 'list' ? 'Switch to grid layout' : 'Switch to list layout');
}
function applyViewerNotifyUI(enabled){
  const btn = $('#viewerNotifyBtn');
  if (btn) btn.classList.toggle('muted', !enabled);
  const label = $('#viewerNotifyLabel');
  if (label) label.textContent = enabled ? 'Notify' : 'Off';
  if (btn) btn.setAttribute('aria-label', enabled
    ? "Turn off notifications when the host calls you to play"
    : "Turn on notifications when the host calls you to play");
}
applyViewerLayout(getViewerLayout());
applyViewerNotifyUI(isViewerNotifyEnabled());
const viewerViewBtn = $('#viewerViewBtn');
if (viewerViewBtn) viewerViewBtn.addEventListener('click', () => {
  const next = getViewerLayout() === 'list' ? 'grid' : 'list';
  try{ localStorage.setItem(VIEWER_LAYOUT_KEY, next); }catch(e){}
  applyViewerLayout(next);
});
const viewerThemeBtn = $('#viewerThemeBtn');
if (viewerThemeBtn) viewerThemeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
});
// Standalone permission request helper — deliberately not sharing the
// near-identical one declared inside enterViewerMode() below, since that
// one lives in a closure only created once a spectator link is actually
// opened, while this button (and its click handler) exists on every page
// load. Both just wrap the standard Notification API, so keeping two tiny
// copies is simpler and safer than plumbing one across that boundary.
async function requestBrowserNotifyPermission(){
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try{ return (await Notification.requestPermission()) === 'granted'; }
  catch(e){ return false; }
}
const viewerNotifyBtn = $('#viewerNotifyBtn');
if (viewerNotifyBtn) viewerNotifyBtn.addEventListener('click', async () => {
  const turningOn = !isViewerNotifyEnabled();
  if (turningOn){
    const granted = await requestBrowserNotifyPermission();
    if (!granted){
      // Blocked/denied at the browser level — flipping the in-app toggle
      // on wouldn't actually deliver anything, so leave it off and point
      // the person at their browser's site settings instead.
      alert("Notifications are blocked for this site. Enable them in your browser's site settings, then try again.");
      return;
    }
  }
  try{ localStorage.setItem(VIEWER_NOTIFY_KEY, turningOn ? '1' : '0'); }catch(e){}
  applyViewerNotifyUI(turningOn);
});
$('#matchHistoryDone').addEventListener('click', () => { matchHistoryOverlay.hidden = true; });

/* ================= About modal =================
   On Android (and as an installed PWA especially), the hardware/gesture
   back button doesn't know this overlay exists — with no history entry
   to consume, "back" falls through to closing the whole app instead of
   just dismissing the modal. Fix: push a history entry when the modal
   opens, so back consumes that entry (via popstate) and just closes the
   modal. If the modal is dismissed some other way (Done button, tapping
   the backdrop, Escape) we still owe the browser a matching history.back()
   to remove the entry we pushed, so back/forward stays in sync — but we
   skip that step when we're already responding to a popstate, since the
   entry's gone by then. */
const aboutOverlay = $('#aboutOverlay');
let aboutHistoryPushed = false;
function openAbout(){
  aboutOverlay.hidden = false;
  history.pushState({ modal: 'about' }, '');
  aboutHistoryPushed = true;
}
function closeAbout(fromPopState){
  if (aboutOverlay.hidden) return;
  aboutOverlay.hidden = true;
  if (aboutHistoryPushed){
    aboutHistoryPushed = false;
    if (!fromPopState) history.back();
  }
}
$('#aboutBtn').addEventListener('click', openAbout);
$('#aboutDone').addEventListener('click', () => closeAbout(false));
aboutOverlay.addEventListener('click', (e) => { if (e.target === aboutOverlay) closeAbout(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !aboutOverlay.hidden) closeAbout(false); });
window.addEventListener('popstate', () => { if (!aboutOverlay.hidden) closeAbout(true); });

/* ================= Live timers ================= */
setInterval(() => {
  document.querySelectorAll('.court-card.playing').forEach(card => {
    const court = state.courts.find(c => c.id === card.dataset.id);
    if (!court || !court.startTime) return;
    if (state.session.scoringEnabled && court.score && court.score.wonAt) return; // frozen at the win
    const el = card.querySelector('[data-role="timer"]');
    if (el) el.textContent = fmtClock(courtElapsedMs(court));
  });
}, 1000);

/* ================= Auto-start ready courts ================= */
// Ticks the "auto-starts in…" countdown on any open, ready court, and — if
// the host really did just forget to tap Start Game — starts it for them
// once the configured window has passed since that court opened AND it
// still has enough players. Viewers only ever read state (poll, never
// push), so letting their tick run harmlessly recomputes text nobody acts
// on; the actual start is gated below so it only ever fires on this
// session's own source of truth.
//
// On a live broadcast, a co-host device is a second read/write peer, not
// just a display — if both the host's and a co-host's browser independently
// noticed the window had elapsed, they could both call callNext() for the
// same court a beat apart and race. So the trigger (not the display) only
// ever runs on the device driving the session: local solo play, or the
// broadcasting host — never a joined co-host.
setInterval(() => {
  if (!state.session.autoStartEnabled || isSessionEnded()) return;
  document.querySelectorAll('.court-card[data-id]').forEach(card => {
    const hint = card.querySelector('[data-role="auto-start-hint"]');
    if (!hint) return;
    const court = state.courts.find(c => c.id === card.dataset.id);
    if (!court || court.status !== 'open' || court.openedAt == null) return;
    const msLeft = getAutoStartMs() - (Date.now() - court.openedAt);
    if (msLeft > 0){
      hint.textContent = `Auto-starts in ${fmtClock(msLeft)}`;
    }
  });
  if (cohostSession) return; // never trigger from a joined co-host device
  state.courts.forEach(court => {
    if (court.status !== 'open' || court.openedAt == null) return;
    if (Date.now() - court.openedAt < getAutoStartMs()) return;
    const openQueue = computeOpenCourtQueue(state.session.gameSize);
    const slot = openQueue.get(court.id);
    if (!slot || !slot.taken) return; // still not enough players — keep waiting
    callNext(court); // handles its own toast/renderAll/persist
  });
}, 1000);


/* ================= Session name ================= */

/* ================= Rankings modal ================= */
const rankingsOverlay = $('#rankingsOverlay');
const rankingsModal = $('#rankingsModal');
const rankingsList = $('#rankingsList');
const rankingsSummary = $('#rankingsSummary');
const rankingsSearch = $('#rankingsSearch');
const rankingsExpandBtn = $('#rankingsExpandBtn');
const rankingsShotBtn = $('#rankingsShotBtn');
let rankingsSearchTerm = '';
let rankingsExpanded = false;

function getRankingRows(){
  return Object.entries(state.playerStats)
    .map(([name, stats]) => ({
      name, wins: stats.wins || 0, games: stats.games || 0,
      scoreSum: stats.scoreSum || 0, scoreGames: stats.scoreGames || 0
    }))
    .filter(r => r.games > 0)
    .sort((a,b) => b.wins - a.wins || (b.wins/b.games) - (a.wins/a.games) || b.games - a.games || a.name.localeCompare(b.name));
}

function rankRowHtml(r, rank){
  const losses = r.games - r.wins;
  const pct = Math.round((r.wins / r.games) * 100);
  const topClass = rank <= 3 ? ' top' + rank : '';
  const avgScore = r.scoreGames > 0 ? (r.scoreSum / r.scoreGames) : null;
  const avgHtml = avgScore !== null
    ? `<span class="rank-avg" title="Average score per game">AVG ${avgScore.toFixed(1)}</span>`
    : '';
  const mvpHtml = rank === 1 ? `<span class="mvp-badge" title="Top of the rankings this session">👑 MVP</span>` : '';
  return `
    <div class="rank-row${topClass}">
      <span class="rank-num">${rank}</span>
      <div class="rank-main">
        <div class="rank-top-line">
          <span class="rank-name">${esc(r.name)}</span>
          ${mvpHtml}
          <span class="rank-pct">${pct}%</span>
        </div>
        <div class="rank-meta-line">
          <span class="rank-games" title="${r.games} games played">${r.games} ${r.games === 1 ? 'GAME' : 'GAMES'} PLAYED</span>
          ${avgHtml}
          <span class="rank-record">${r.wins}-${losses}</span>
        </div>
      </div>
    </div>
  `;
}

function renderRankings(){
  const allRows = getRankingRows();

  if (allRows.length === 0){
    rankingsSummary.innerHTML = '';
    rankingsList.innerHTML = '<div class="rankings-empty">No games recorded yet.<br>Rankings fill in once you pick a winner after a match.</div>';
    return;
  }

  const mostGames = Math.max(...allRows.map(r => r.games));
  const avgWinRate = Math.round(allRows.reduce((s, r) => s + (r.wins / r.games), 0) / allRows.length * 100);
  rankingsSummary.innerHTML = `
    <span class="stat-chip"><b>${allRows.length}</b> ${allRows.length === 1 ? 'player' : 'players'}</span>
    <span class="stat-chip"><b>${mostGames}</b> most games played</span>
    <span class="stat-chip"><b>${avgWinRate}%</b> avg win rate</span>
  `;

  const term = rankingsSearchTerm.trim().toLowerCase();
  const rows = term ? allRows.filter(r => r.name.toLowerCase().includes(term)) : allRows;

  if (rows.length === 0){
    rankingsList.innerHTML = `<div class="rankings-empty">No players match "${esc(rankingsSearchTerm)}".</div>`;
    return;
  }

  // Each player's current skill level gets its own leaderboard section (its
  // own #1/MVP and rank numbering), so a session mixing Beginner and
  // Advanced play doesn't end up with one merged ranking across levels.
  const levels = PLAYER_LEVELS.filter(lvl => rows.some(r => getPlayerLevel(r.name) === lvl));
  rankingsList.innerHTML = levels.map(level => {
    const levelRows = rows.filter(r => getPlayerLevel(r.name) === level);
    const body = levelRows.map((r, i) => rankRowHtml(r, i + 1)).join('');
    return `
      <div class="rank-level-group">
        <div class="rank-level-head">
          <span class="level-badge ${levelClass(level)}">${esc(levelLabel(level))}</span>
          <span class="rank-level-count">${levelRows.length} ${levelRows.length === 1 ? 'player' : 'players'}</span>
        </div>
        ${body}
      </div>
    `;
  }).join('');
}

function setRankingsExpandIcon(){
  rankingsExpandBtn.innerHTML = rankingsExpanded
    ? '<svg viewBox="0 0 24 24"><use href="#i-collapse"/></svg>'
    : '<svg viewBox="0 0 24 24"><use href="#i-expand"/></svg>';
  const label = rankingsExpanded ? 'Exit full screen' : 'Expand to full screen';
  rankingsExpandBtn.setAttribute('aria-label', label);
  rankingsExpandBtn.title = label;
  rankingsExpandBtn.classList.toggle('active', rankingsExpanded);
}

function openRankings(){
  rankingsSearchTerm = '';
  rankingsSearch.value = '';
  rankingsExpanded = false;
  rankingsModal.classList.remove('rankings-full');
  setRankingsExpandIcon();
  renderRankings();
  rankingsOverlay.hidden = false;
}
$('#rankingsBtn').addEventListener('click', openRankings);
$('#rankingsDone').addEventListener('click', () => { rankingsOverlay.hidden = true; });

rankingsSearch.addEventListener('input', (e) => {
  rankingsSearchTerm = e.target.value;
  renderRankings();
});

rankingsExpandBtn.addEventListener('click', () => {
  rankingsExpanded = !rankingsExpanded;
  rankingsModal.classList.toggle('rankings-full', rankingsExpanded);
  setRankingsExpandIcon();
});

let html2canvasPromise = null;
function loadHtml2Canvas(){
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (html2canvasPromise) return html2canvasPromise;
  html2canvasPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => { html2canvasPromise = null; reject(new Error('load-failed')); };
    document.head.appendChild(s);
  });
  return html2canvasPromise;
}

rankingsShotBtn.addEventListener('click', async () => {
  if (rankingsShotBtn.disabled) return;
  if (getRankingRows().length === 0){ toast('No rankings to capture yet'); return; }

  rankingsShotBtn.disabled = true;
  rankingsShotBtn.classList.add('spinning');
  try{
    const html2canvas = await loadHtml2Canvas();
    const target = $('#rankingsCaptureArea');
    // Match the capture background to the active theme — this used to be
    // hardcoded to white, which made a dark-mode screenshot come out as
    // pale text on a white background (all but unreadable).
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bg = isDark
      ? (getComputedStyle(document.documentElement).getPropertyValue('--court').trim() || '#0B1220')
      : '#ffffff';
    const canvas = await html2canvas(target, { backgroundColor: bg, scale: 2, useCORS: true });
    const link = document.createElement('a');
    link.download = `rankings-${new Date().toISOString().slice(0,10)}.png`;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast('Rankings image saved');
  } catch(err){
    console.error(err);
    toast('Could not create the image — check your connection and try again');
  } finally {
    rankingsShotBtn.disabled = false;
    rankingsShotBtn.classList.remove('spinning');
  }
});

/* ================= Settings modal ================= */
const settingsOverlay = $('#settingsOverlay');
const settingsSessionName = $('#settingsSessionName');
const gameSizeSeg = $('#gameSizeSeg');
const courtCountNum = $('#courtCountNum');
const courtNameRows = $('#courtNameRows');
const soundToggle = $('#soundToggle');
const notifyCallsToggle = $('#notifyCallsToggle');
const autoCallPlayersToggle = $('#autoCallPlayersToggle');
const targetGamesToggle = $('#targetGamesToggle');
const targetGamesSub = $('#targetGamesSub');
const targetGamesInput = $('#targetGamesInput');
const avoidRepeatToggle = $('#avoidRepeatToggle');
const fixedDuoSub = $('#fixedDuoSub');
const fixedDuoNameA = $('#fixedDuoNameA');
const fixedDuoNameB = $('#fixedDuoNameB');
const fixedDuoList = $('#fixedDuoList');
const scoringToggle = $('#scoringToggle');
const scoringSub = $('#scoringSub');
const winningScoreInput = $('#winningScoreInput');
const autoStartToggle = $('#autoStartToggle');
const autoStartSub = $('#autoStartSub');
const autoStartMinutesInput = $('#autoStartMinutesInput');
const skillLevelsToggle = $('#skillLevelsToggle');
const matchStyleGroup = $('#matchStyleGroup');

function openSettings(){
  // Co-hosts don't just get the generic "ask the host" toast here — settings
  // (and the roster) stay host-only no matter what, so this is worth a real
  // dialog instead of a toast that might get missed.
  if (coHostMode){
    showAlert('Settings are disabled by host', { title: 'Settings locked' });
    return;
  }
  settingsSessionName.value = state.session.name;
  courtCountNum.textContent = state.courts.length;
  soundToggle.checked = state.session.soundOn;
  if (notifyCallsToggle) notifyCallsToggle.checked = state.session.notifyCallsEnabled !== false;
  if (autoCallPlayersToggle) autoCallPlayersToggle.checked = state.session.autoCallPlayersEnabled === true;
  targetGamesToggle.checked = state.session.targetGamesEnabled;
  targetGamesSub.hidden = !state.session.targetGamesEnabled;
  targetGamesInput.value = state.session.targetGamesPerPlayer;
  avoidRepeatToggle.checked = state.session.avoidRepeatTeammates;
  fixedDuoSub.hidden = !state.session.avoidRepeatTeammates;
  scoringToggle.checked = state.session.scoringEnabled;
  scoringSub.hidden = !state.session.scoringEnabled;
  winningScoreInput.value = state.session.winningScore;
  autoStartToggle.checked = state.session.autoStartEnabled;
  autoStartSub.hidden = !state.session.autoStartEnabled;
  autoStartMinutesInput.value = state.session.autoStartMinutes || 1;
  if (skillLevelsToggle) skillLevelsToggle.checked = state.session.skillLevelsEnabled;
  renderMatchStyleGroup();
  renderFixedDuoNameOptions();
  renderFixedDuoList();
  [...gameSizeSeg.children].forEach(b => b.classList.toggle('active', Number(b.dataset.size) === state.session.gameSize));
  renderCourtNameRows();
  if ($('#rosterSearchInput')) $('#rosterSearchInput').value = '';
  renderRosterManageList('');
  settingsOverlay.hidden = false;
}

/* ---- Matching style (Balanced / Winners & Losers) ---- */
function renderMatchStyleGroup(){
  if (!matchStyleGroup) return;
  const current = getMatchingStyle();
  [...matchStyleGroup.children].forEach(card => {
    card.classList.toggle('active', card.dataset.style === current);
  });
}
if (matchStyleGroup){
  matchStyleGroup.addEventListener('click', (e) => {
    const card = e.target.closest('.match-style-card');
    if (!card) return;
    const style = card.dataset.style;
    if (!style || style === getMatchingStyle()) return;
    state.session.matchingStyle = style;
    renderMatchStyleGroup();
    toast('Matching style set to ' + card.querySelector('.match-style-title').textContent);
    persist(); renderAll();
  });
}

/* ---- Fixed Duos (only relevant while Avoid Repeating Teammates is on) ---- */
function allKnownNames(){
  const names = new Set(state.roster);
  state.stack.forEach(p => names.add(p.name));
  return [...names].sort((a,b) => a.localeCompare(b));
}
function renderFixedDuoNameOptions(){
  const names = allKnownNames();
  const opts = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  fixedDuoNameA.innerHTML = '<option value="">Player A…</option>' + opts;
  fixedDuoNameB.innerHTML = '<option value="">Player B…</option>' + opts;
}
function renderFixedDuoList(){
  const duos = state.session.fixedDuos || [];
  if (duos.length === 0){
    fixedDuoList.innerHTML = '<div class="fixed-duo-empty">No fixed duos yet.</div>';
    return;
  }
  fixedDuoList.innerHTML = duos.map((duo, i) => `
    <div class="fixed-duo-row">
      <span class="fd-names">${esc(duo.a)}<svg viewBox="0 0 24 24"><use href="#i-swap"/></svg>${esc(duo.b)}</span>
      <button type="button" class="rm-del" data-idx="${i}" aria-label="Remove fixed duo of ${esc(duo.a)} and ${esc(duo.b)}"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </div>
  `).join('');
}
$('#fixedDuoAddBtn').addEventListener('click', () => {
  const a = fixedDuoNameA.value;
  const b = fixedDuoNameB.value;
  if (!a || !b){ toast('Pick two players first'); return; }
  if (a === b){ toast('Pick two different players'); return; }
  const duos = state.session.fixedDuos || (state.session.fixedDuos = []);
  const already = duos.some(d => (d.a === a && d.b === b) || (d.a === b && d.b === a));
  if (already){ toast('That duo is already fixed'); return; }
  const inOtherDuo = duos.some(d => [d.a, d.b].includes(a) || [d.a, d.b].includes(b));
  if (inOtherDuo){ toast('One of those players is already in a fixed duo'); return; }
  duos.push({ a, b });
  fixedDuoNameA.value = ''; fixedDuoNameB.value = '';
  renderFixedDuoList();
  persist();
  renderCourts();
  toast(a + ' & ' + b + ' fixed as a duo');
});
fixedDuoList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-idx]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const duos = state.session.fixedDuos || [];
  const duo = duos[idx];
  if (!duo) return;
  if (!(await showConfirm('They\'ll go back to being paired up normally by the queue.', {title: 'Remove ' + duo.a + ' & ' + duo.b + ' as a fixed duo?', confirmLabel: 'Remove', danger: true}))) return;
  duos.splice(idx, 1);
  renderFixedDuoList();
  persist();
  renderCourts();
  toast('Fixed duo removed');
});
function renderCourtNameRows(){
  courtNameRows.innerHTML = state.courts.map((c,i) => `
    <div class="court-name-row">
      <input type="text" value="${esc(c.name)}" data-idx="${i}" maxlength="24">
      <select class="court-level-select ${levelClass(c.level)}" data-level-idx="${i}" aria-label="${esc(c.name)} skill level">${levelSelectOptionsHtml(c.level || 'Open')}</select>
    </div>
  `).join('');
}
courtNameRows.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-idx]');
  if (input){
    const idx = Number(input.dataset.idx);
    if (state.courts[idx]) state.courts[idx].name = input.value.trim() || state.courts[idx].name;
    persist();
    return;
  }
  const select = e.target.closest('select[data-level-idx]');
  if (select){
    const idx = Number(select.dataset.levelIdx);
    if (state.courts[idx]) state.courts[idx].level = PLAYER_LEVELS.includes(select.value) ? select.value : 'Open';
    select.className = levelClass(state.courts[idx] ? state.courts[idx].level : 'Open');
    persist();
    renderAll();
  }
});

$('#settingsBtn').addEventListener('click', openSettings);
// Bottom-nav "More" tab (phones) mirrors the topbar settings button — same
// handler, just a second entry point, so no new logic is introduced.
const tabMoreNavBtn = $('#tabMoreNav');
if (tabMoreNavBtn) tabMoreNavBtn.addEventListener('click', openSettings);
$('#settingsDone').addEventListener('click', () => { settingsOverlay.hidden = true; renderAll(); persist(); });

resumeSessionBtn.addEventListener('click', () => { resumeSession(); });

gameSizeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-size]');
  if (!btn) return;
  state.session.gameSize = Number(btn.dataset.size);
  [...gameSizeSeg.children].forEach(b => b.classList.toggle('active', b === btn));
  checkBlockFlush(); // a partial block may now already meet the new (possibly smaller) threshold
  persist(); renderAll();
});

$('#courtPlus').addEventListener('click', () => {
  if (state.courts.length >= 24) return;
  const n = state.courts.length + 1;
  const newCourt = { id: nextId('c'), name: 'Court ' + n, level: 'Open', status:'open', players:[], startTime:null, lastResult:null, swapInfo:null, score:null, previewOrder:null, previewSubMap:null, openedAt: Date.now(), pauseStart: null, pausedMs: 0 };
  state.courts.push(newCourt);
  courtCountNum.textContent = state.courts.length;
  renderCourtNameRows(); persist(); renderAll();
});
$('#courtMinus').addEventListener('click', async () => {
  if (state.courts.length <= 1) return;
  const last = state.courts[state.courts.length - 1];
  if (last.status === 'playing'){
    if (!(await showConfirm('The players on it will be put back at the front of the stack.', {title: last.name + ' is currently in play — remove it anyway?', confirmLabel: 'Remove court', danger: true}))) return;
    // Don't lose the players who were mid-game — send them back to the front of the queue.
    const returning = last.players.map(name => ({ id: nextId('p'), name, joinedAt: Date.now(), tag: 'queued' }));
    state.stack.unshift(...returning);
  }
  // A pending swap (same-court or cross-court) that points at the court
  // being removed would otherwise dangle — pendingSwapInfo() would find no
  // matching court and quietly drop the hint, but the stray selection would
  // still eat the host's next tap on some other court's swap icon instead
  // of starting a fresh pick. Clear it up front so removal always leaves a
  // clean slate.
  if (swapSelection && swapSelection.courtId === last.id) swapSelection = null;
  state.courts.pop();
  courtCountNum.textContent = state.courts.length;
  renderCourtNameRows(); persist(); renderAll();
});

soundToggle.addEventListener('change', () => {
  state.session.soundOn = soundToggle.checked;
  persist();
});

if (notifyCallsToggle){
  notifyCallsToggle.addEventListener('change', () => {
    state.session.notifyCallsEnabled = notifyCallsToggle.checked;
    persist();
  });
}

if (autoCallPlayersToggle){
  autoCallPlayersToggle.addEventListener('change', () => {
    state.session.autoCallPlayersEnabled = autoCallPlayersToggle.checked;
    persist();
  });
}

targetGamesToggle.addEventListener('change', () => {
  state.session.targetGamesEnabled = targetGamesToggle.checked;
  targetGamesSub.hidden = !targetGamesToggle.checked;
  persist(); renderAll();
});

targetGamesInput.addEventListener('change', () => {
  let n = Math.round(Number(targetGamesInput.value));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 99) n = 99;
  targetGamesInput.value = n;
  state.session.targetGamesPerPlayer = n;
  persist(); renderAll();
});

avoidRepeatToggle.addEventListener('change', () => {
  state.session.avoidRepeatTeammates = avoidRepeatToggle.checked;
  fixedDuoSub.hidden = !avoidRepeatToggle.checked;
  if (avoidRepeatToggle.checked){ renderFixedDuoNameOptions(); renderFixedDuoList(); }
  persist(); renderAll();
});

scoringToggle.addEventListener('change', () => {
  state.session.scoringEnabled = scoringToggle.checked;
  scoringSub.hidden = !scoringToggle.checked;
  persist(); renderAll();
});

winningScoreInput.addEventListener('change', () => {
  let n = Math.round(Number(winningScoreInput.value));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 99) n = 99;
  winningScoreInput.value = n;
  state.session.winningScore = n;
  persist(); renderAll();
});

autoStartToggle.addEventListener('change', () => {
  state.session.autoStartEnabled = autoStartToggle.checked;
  autoStartSub.hidden = !autoStartToggle.checked;
  if (autoStartToggle.checked){
    // Give every open court a fresh full window starting now, rather than
    // picking up wherever an old (pre-toggle-off) clock left off.
    state.courts.forEach(c => { if (c.status === 'open') c.openedAt = Date.now(); });
  }
  persist(); renderAll();
});

autoStartMinutesInput.addEventListener('change', () => {
  let n = Math.round(Number(autoStartMinutesInput.value));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 60) n = 60;
  autoStartMinutesInput.value = n;
  state.session.autoStartMinutes = n;
  // Same reasoning as flipping the toggle on: give every open court a
  // fresh full window under the new duration instead of leaving it
  // mid-countdown against the old one.
  state.courts.forEach(c => { if (c.status === 'open') c.openedAt = Date.now(); });
  persist(); renderAll();
});

if (skillLevelsToggle){
  skillLevelsToggle.addEventListener('change', () => {
    state.session.skillLevelsEnabled = skillLevelsToggle.checked;
    toast(skillLevelsToggle.checked ? 'Skill levels turned on' : 'Skill levels turned off');
    persist(); renderAll();
  });
}

settingsSessionName.addEventListener('change', () => {
  state.session.name = settingsSessionName.value.trim() || 'PaddleStack';
  persist();
});

/* ---- Export / Import ---- */
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'paddle-stack-queue-backup.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup exported');
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!(await showConfirm('This will overwrite all current data (stack, courts, history, rankings).', {title: 'Import backup?', confirmLabel: 'Import', danger: true}))){
    e.target.value = '';
    return;
  }
  try{
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.session || !Array.isArray(parsed.courts) || !Array.isArray(parsed.stack)){
      throw new Error('bad shape');
    }
    if (!Array.isArray(parsed.history)) parsed.history = [];
    if (!Array.isArray(parsed.winnersBlock)) parsed.winnersBlock = [];
    if (!Array.isArray(parsed.losersBlock)) parsed.losersBlock = [];
    if (!Array.isArray(parsed.arrivals)) parsed.arrivals = [];
    if (!Array.isArray(parsed.roster)) parsed.roster = [];
    if (!parsed.playerStats || typeof parsed.playerStats !== 'object') parsed.playerStats = {};
    if (!parsed.teammateHistory || typeof parsed.teammateHistory !== 'object') parsed.teammateHistory = {};
    if (!parsed.opponentHistory || typeof parsed.opponentHistory !== 'object') parsed.opponentHistory = {};
    if (!parsed.upNextSubMap || typeof parsed.upNextSubMap !== 'object') parsed.upNextSubMap = {};
    parsed.courts.forEach(c => { if (!('lastResult' in c)) c.lastResult = null; if (!('swapInfo' in c)) c.swapInfo = null; if (!('previewOrder' in c)) c.previewOrder = null; if (!('previewSubMap' in c)) c.previewSubMap = null; if (!('requeueOrder' in c)) c.requeueOrder = null; });
    if (!parsed.session || typeof parsed.session.generationReady !== 'boolean') parsed.session = Object.assign({}, parsed.session || {}, { generationReady: false });
    parsed.stack.forEach(p => { if (!p.tag) p.tag = 'new'; });
    if (!parsed.session.status) parsed.session.status = 'active';
    if (typeof parsed.session.targetGamesEnabled !== 'boolean') parsed.session.targetGamesEnabled = false;
    if (!parsed.session.targetGamesPerPlayer || parsed.session.targetGamesPerPlayer < 1) parsed.session.targetGamesPerPlayer = 7;
    if (typeof parsed.session.avoidRepeatTeammates !== 'boolean') parsed.session.avoidRepeatTeammates = false;
    if (!Array.isArray(parsed.session.fixedDuos)) parsed.session.fixedDuos = [];
    if (typeof parsed.session.fixedDuosEnabled !== 'boolean') parsed.session.fixedDuosEnabled = parsed.session.fixedDuos.length > 0;
    if (typeof parsed.session.scoringEnabled !== 'boolean') parsed.session.scoringEnabled = false;
    if (!parsed.session.winningScore || parsed.session.winningScore < 1) parsed.session.winningScore = 11;
    if (typeof parsed.session.autoStartEnabled !== 'boolean') parsed.session.autoStartEnabled = false;
    if (!Number.isFinite(parsed.session.autoStartMinutes) || parsed.session.autoStartMinutes < 1) parsed.session.autoStartMinutes = 1;
    if (typeof parsed.session.club !== 'string') parsed.session.club = '';
    if (typeof parsed.session.description !== 'string') parsed.session.description = '';
    normalizeCohostPermissions(parsed.session);
    parsed.courts.forEach(c => { if (!('score' in c)) c.score = null; });
    if (!parsed.playerLevels || typeof parsed.playerLevels !== 'object') parsed.playerLevels = {};
    parsed.courts.forEach(c => { if (!c.level || !PLAYER_LEVELS.includes(c.level)) c.level = 'Open'; });
    state = parsed;
    persist();
    renderRosterList();
    renderAll();
    openSettings();
    toast('Backup imported');
  }catch(err){
    toast('Could not read that file');
  }
  e.target.value = '';
});

// Shared by the Settings "Start a new session" button and the Host Online
// panel's "Start a new session & go live" option, so both paths reset state
// identically.
function startFreshSessionKeepingRoster(){
  state.arrivals = [];
  state.stack = [];
  state.winnersBlock = [];
  state.losersBlock = [];
  state.history = [];
  state.playerStats = {};
  state.teammateHistory = {};
  state.opponentHistory = {};
  state.upNextSubMap = {};
  state.session.status = 'active';
  // Session Time on the spectator dashboard is computed from this
  // timestamp (see the ~line-8839 stat4 block) — without resetting it
  // here, "End session (keep players) -> start new" left the old
  // createdAt in place and the clock kept counting up from the *original*
  // session instead of restarting at 0 for the new one.
  state.session.createdAt = Date.now();
  state.courts.forEach(c => { c.status = 'open'; c.players = []; c.startTime = null; c.lastResult = null; c.swapInfo = null; c.previewOrder = null; c.previewSubMap = null; c.requeueOrder = null; c.openedAt = Date.now(); });
  persist();
  applySessionLockUI();
  renderRosterList();
  renderAll();
}

$('#newSessionBtn').addEventListener('click', async () => {
  if (!(await showConfirm('This clears the stack, courts, blocks, and rankings — but keeps your list of player names so you can re-add them quickly. This cannot be undone.', {title: 'Start a new session?', confirmLabel: 'Start new session', danger: true}))) return;
  startFreshSessionKeepingRoster();
  settingsOverlay.hidden = true;
  toast('New session started — player list kept');
});

$('#restoreDefaultsBtn').addEventListener('click', async () => {
  if (!(await showConfirm('This resets all settings — auto-start timing, matching style, target games, scoring, sound, skill levels, and fixed duos — back to their defaults. Your current stack, courts, history, and player list are not touched.', {title: 'Restore default settings?', confirmLabel: 'Restore Defaults', danger: true}))) return;
  const defaults = freshState().session;
  // Keep the session's identity/lifecycle fields — name (host-chosen) and
  // status (active/ended) — everything else in `session` is a "setting"
  // and goes back to its factory default.
  state.session = { ...defaults, name: state.session.name, status: state.session.status };
  persist();
  openSettings();
  renderAll();
  toast('Settings restored to defaults');
});

$('#clearAppDataBtn').addEventListener('click', async () => {
  if (!(await showConfirm('This wipes everything this app has stored on this device — the current session, saved theme, and any host/login info — then reloads the page from scratch. This cannot be undone.', {title: 'Clear app data?', confirmLabel: 'Clear app data', danger: true}))) return;
  try{ localStorage.clear(); }catch(e){}
  try{
    if (idb && typeof idb.close === 'function') idb.close();
  }catch(e){}
  try{
    await new Promise((resolve) => {
      if (!('indexedDB' in window)){ resolve(); return; }
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }catch(e){}
  window.location.reload();
});

$('#resetBtn').addEventListener('click', async () => {
  if (!(await showConfirm('This erases everything — stack, courts, history, rankings, and your player list. This cannot be undone.', {title: 'Erase everything?', confirmLabel: 'Erase everything', danger: true}))) return;
  state = freshState();
  persist();
  applySessionLockUI();
  settingsOverlay.hidden = true;
  renderRosterList();
  renderAll();
  toast('All data erased');
});

/* ================= Mobile tabs ================= */
function setMobileTab(tab){ // 'stack' | 'courts'
  if (tab === 'courts'){
    appShell.classList.add('show-courts'); appShell.classList.remove('show-stack');
    $('#tabCourts').classList.add('active'); $('#tabStack').classList.remove('active');
  } else {
    appShell.classList.add('show-stack'); appShell.classList.remove('show-courts');
    $('#tabStack').classList.add('active'); $('#tabCourts').classList.remove('active');
  }
  try{ localStorage.setItem(MOBILE_TAB_KEY, tab); }catch(e){}
}
$('#tabStack').addEventListener('click', () => setMobileTab('stack'));
$('#tabCourts').addEventListener('click', () => setMobileTab('courts'));

/* ================= Host Online (Supabase) =================
   Lets someone create a free account and broadcast a read-only view of
   their courts + queue to a code or QR code — no account needed to watch.
   Everything above this section keeps working fully offline; this module
   only activates when the host explicitly taps "Host match online".

   NOTE: SUPABASE_ANON_KEY below is a placeholder. Anon/public keys are
   *meant* to ship in client-side code (Row Level Security in the database
   is what actually protects the data) — grab yours from the Supabase
   dashboard: Project Settings → API → "Project API keys" → anon public,
   and paste it in below. Nothing in this feature will work until that's
   filled in. See supabase-schema.sql for the matching database setup. */
const SUPABASE_URL = 'https://xqogfjttzsewrtnbwatv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhxb2dmanR0enNld3J0bmJ3YXR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2OTM3NzMsImV4cCI6MjEwMTI2OTc3M30.IEnaOjWzu7pmnEiiIvdw6NmZWPfa4q3CQ40GlKIB05k';
const SUPABASE_CONFIGURED = !!SUPABASE_ANON_KEY && SUPABASE_ANON_KEY.indexOf('PASTE_') !== 0;
// Fallback only — used if the site_settings row can't be reached for some
// reason. The real default (and any per-account override, and maintenance
// mode / suspension) live in Postgres and are enforced there regardless of
// what this constant says; see supabase-schema.sql and the /admin portal.
const HOST_DAILY_LIMIT_FALLBACK = 5;

const AUTH_STORAGE_KEY = 'renzkuAuthSession';
const HOST_STORAGE_KEY = 'renzkuHostSession';

/* ---- Single-device login ----
   One account can only be "logged in" (i.e. eligible to host) on one
   device at a time. This device's own id is a random token that lives in
   localStorage for as long as the browser keeps it; the currently-claimed
   device for the account lives server-side on profiles.active_device_id
   (see the claim_device_session / force_claim_device_session functions in
   supabase-schema.sql). A human-readable label rides along purely for the
   "log out Chrome on Windows?" wording — it's never used to decide
   anything. */
const DEVICE_ID_KEY = 'renzkuDeviceId';
function getDeviceId(){
  try{
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id){
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }catch(e){ return 'dev-' + Date.now().toString(36); } // storage unavailable (private mode etc.) — still usable, just not stable across reloads
}
function deviceLabel(){
  const ua = navigator.userAgent || '';
  let browser = 'a browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  let os = '';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} on ${os}` : browser;
}

/* ---- hCaptcha (login/signup only — spectators never see this) ---- */
const HCAPTCHA_SITE_KEY = '07e29e48-5c84-4020-a036-36ba3aa4758e';
let hcaptchaReady = false;
let hcaptchaWidgetId = null;

// Called by the ?onload= param on the hCaptcha <script> tag in index.html
// once the library itself has finished loading.
window.onHcaptchaReady = function(){
  hcaptchaReady = true;
  mountHcaptchaWidget();
};
// That hCaptcha <script> tag is `async`, so it can finish loading and invoke
// its onload callback before this deferred script (loaded at the end of
// <body>) has even run. A stub in index.html's <head> catches that early
// call and sets this flag — pick it up now in case we arrived after the fact.
if (window.__hcaptchaApiReady) window.onHcaptchaReady();

// (Re)renders the widget into #hcaptchaBox, if that box is currently in the
// DOM and the library is ready. Safe to call any number of times — e.g.
// every time renderHostPanel() redraws the logged-out form.
function mountHcaptchaWidget(){
  const box = document.getElementById('hcaptchaBox');
  if (!box || !hcaptchaReady || !window.hcaptcha) return;
  box.innerHTML = '';
  hcaptchaWidgetId = window.hcaptcha.render(box, { sitekey: HCAPTCHA_SITE_KEY });
}

// hCaptcha tokens are single-use; call this after every submit attempt
// (success or failure) so the widget is fresh for the next one.
function resetHcaptcha(){
  if (window.hcaptcha && hcaptchaWidgetId !== null){
    try{ window.hcaptcha.reset(hcaptchaWidgetId); }catch(e){}
  }
}

let authSession = null;   // { access_token, refresh_token, expires_at, user:{id,email} } | null
let hostSession = null;   // { id, invite_code } | null — the currently-live broadcast, if any
let viewerMode = false;
let hostPanelMode = 'login'; // 'login' | 'signup' — which auth tab is showing when logged out
let pendingSignupConfirmation = null; // { email, sent:boolean } | null — set right after a
                                       // successful sign-up that needs email confirmation;
                                       // replaces the auth form with a confirmation notice
                                       // until the person dismisses it or logs in
let hostBusy = false;      // true while an auth/go-live/stop request is in flight
let hostErrorMsg = '';
let hostUsageToday = null; // cached count of sessions started today, refreshed on panel open
let hostAccountInfo = null; // { limit: number|null, suspended: boolean, creditBalance: number } for the signed-in
                             // account — null limit means "use the site default"; refreshed
                             // alongside hostUsageToday each time the panel opens
let siteSettingsCache = null; // { maintenanceMode, maintenanceMessage, defaultLimit } — read
                               // from the public site_settings table; refreshed on panel open

/* ---- Buy credits: purchased credits are a separate carry-over balance
   (profiles.credit_balance) — they don't reset daily like the free limit
   does. Going live draws from the daily limit first; only once that's
   used up does the server start spending from this balance. ---- */
const CREDIT_PACKAGES = [
  { credits: 50,  priceLabel: '\u20b1150', amountPhp: 150 },
  { credits: 100, priceLabel: '\u20b1250', amountPhp: 250 }
];
// Cheapest per-credit rate is flagged as "Best value" and the rate itself is
// shown on every card — both computed once here rather than hardcoded, so
// adding/reordering packages above can't silently make the badge wrong.
const bestPkgRate = Math.min(...CREDIT_PACKAGES.map(p => p.amountPhp / p.credits));
CREDIT_PACKAGES.forEach(p => {
  p.rate = p.amountPhp / p.credits;
  p.rateLabel = `\u20b1${p.rate % 1 === 0 ? p.rate : p.rate.toFixed(2)} / credit`;
  p.isBest = p.rate === bestPkgRate;
});
const GCASH_NUMBER = '09624056575';
let hostBuyOpen = false;          // whether the "Buy credits" packages are expanded
let hostSelectedPackage = null;   // the CREDIT_PACKAGES entry the user picked, or null
let hostReceiptFile = null;       // File the user attached, pending upload
let hostCreditBusy = false;       // true while a purchase request is uploading/submitting
let hostPendingCreditRequest = undefined; // undefined = not yet fetched, null = none pending, else the row
let hostPushTimer = null;
let hostPushPending = false;
let hostPushInFlight = false; // true while a PATCH to hosted_sessions is actually in the air —
                               // see the in-flight guard inside pushStateNow
// The host device used to only ever PUSH state up to hosted_sessions and
// never pull it back down — fine when the host's own device was the only
// writer, but once co-host access shipped, a co-host's changes (via
// cohost_push_state) landed on the server row with nothing on the host's
// side ever noticing. The host would sit there showing a stale board, and
// worse, the *next* time the host made any edit of their own, persist()
// would PATCH the row with that same stale local state and silently
// stomp the co-host's change right back out. hostPollTimer/hostPollFn
// close that gap by giving the host device the same "poll the shared row,
// adopt anything newer" loop the co-host already has (see startCohostPoll).
const HOST_POLL_INTERVAL_MS = 2500; // same cadence as COHOST_POLL_INTERVAL_MS below — kept as its
                                     // own named constant since it's declared well before that one
let hostPollTimer = null;
let hostPollFn = null;      // lets the global online/visibility/pageshow handlers trigger an
                             // immediate re-poll, same pattern as cohostPollFn/viewerPollFn
/* Small "Synced Xs ago" line under the LIVE badge in the host panel — reuses
   lastHostStateAt (already tracked below for a different purpose: knowing
   whether an incoming poll is actually newer than what this device just
   sent) since "the last time this device's state matched the server" is
   exactly what a synced-ago readout wants, whether that sync was this
   device pushing out or pulling in a co-host's change. Updates the text
   node directly on a 1s tick rather than going through the full
   renderHostPanel() — that function rebuilds the entire panel's innerHTML,
   which would blow away focus/scroll position while someone has an input
   open in there, for a label that doesn't need anything else on the panel
   to change. */
function formatSyncedAgo(ms){
  if (!ms) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 3) return 'Synced just now';
  if (secs < 60) return `Synced ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `Synced ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `Synced ${hrs}h ago`;
}
setInterval(() => {
  const el = document.getElementById('hostSyncedAgo');
  if (el && hostSession && !hostReconnecting) el.textContent = formatSyncedAgo(lastHostStateAt);
}, 1000);

let lastHostStateAt = 0;    // most recent updated_at (ms) this device has actually applied from
                             // the server — stops a slow/late poll response from clobbering a
                             // newer local edit, and stops this device from re-adopting the very
                             // state it just pushed itself
let viewerPollTimer = null;
let viewerModeInitialized = false;   // guards against enterViewerMode() ever running twice in the
                                      // same page load (a fresh browser refresh already gets a
                                      // brand-new script context, so this is a defensive belt-and-
                                      // suspenders check, not the primary mechanism against dupes)
let hostReconnecting = false;       // true once a push/keepalive to Supabase has failed while
                                     // still (as far as we know) live — drives the "Reconnecting…"
                                     // pill/badge until a request succeeds again
let hostReconnectRetryTimer = null; // fast retry loop, only running while hostReconnecting
let viewerPollFn = null;            // set inside enterViewerMode; lets the global 'online'
                                     // listener trigger an immediate re-poll instead of waiting
                                     // out the rest of the current 2s interval
let viewerSetMsgFn = null;          // ditto, for writing "Reconnecting to live…" into the banner
                                     // the instant the browser reports it went offline
let remoteLiveSession = null; // { id, invite_code, session_name } | null — a live match this
                               // account is already hosting, per the server, that this device
                               // doesn't know about locally (e.g. started on another device
                               // that then went offline/died before it could be stopped)
let remoteLiveChecked = false; // whether we've asked the server yet this "logged out of host
                                // locally" stretch — avoids re-querying on every re-render
let lastStoppedHost = null; // { id, invite_code, session_name } | null — the match this device
                             // just stopped hosting, kept around so the panel can offer to pick
                             // it back up on the same link (same row, re-activated) or start fresh

/* ---- Co-host PIN prompt ----
   Small text-input dialog (same overlay pattern as showConfirm/renamePlayer)
   used once, right after fetchCohostState succeeds for a fresh ?join=&cohost=
   link, when the host has a 4-digit PIN set (state.session.cohostPin — see
   enableCohostAccess below). Not a full queue like showConfirm since only
   one of these is ever relevant at a time (during enterCoHostMode). */
const cohostPinOverlay = $('#cohostPinOverlay');
const cohostPinSubtitle = $('#cohostPinSubtitle');
const cohostPinForm = $('#cohostPinForm');
const cohostPinInput = $('#cohostPinInput');
const cohostPinCancelBtn = $('#cohostPinCancelBtn');
let cohostPinResolve = null;
/* Returns a Promise<string|null> — the 4 digits entered, or null if the
   person cancelled/dismissed. Doesn't judge correctness itself; the caller
   (enterCoHostMode) compares against the real PIN. `attempt`/`maxAttempts`
   (both optional) are shown in the subtitle so a person retrying after a
   miss can see how many tries they have left. */
function openCohostPinPrompt(sessionName, attempt, maxAttempts){
  if (!cohostPinOverlay) return Promise.resolve(null);
  return new Promise((resolve) => {
    cohostPinResolve = resolve;
    if (cohostPinSubtitle){
      const base = 'Ask the host for the 4-digit PIN to finish joining \u201c' + (sessionName || 'this match') + '\u201d.';
      cohostPinSubtitle.textContent = (attempt && maxAttempts && attempt > 1)
        ? base + ' (Attempt ' + attempt + ' of ' + maxAttempts + ')'
        : base;
    }
    if (cohostPinInput) cohostPinInput.value = '';
    cohostPinOverlay.hidden = false;
    setTimeout(() => { if (cohostPinInput) cohostPinInput.focus(); }, 0);
  });
}
function closeCohostPinPrompt(result){
  if (!cohostPinOverlay || cohostPinOverlay.hidden) return;
  cohostPinOverlay.hidden = true;
  const resolve = cohostPinResolve;
  cohostPinResolve = null;
  if (resolve) resolve(result);
}
if (cohostPinForm) cohostPinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  closeCohostPinPrompt((cohostPinInput.value || '').trim());
});
if (cohostPinCancelBtn) cohostPinCancelBtn.addEventListener('click', () => closeCohostPinPrompt(null));
if (cohostPinOverlay) cohostPinOverlay.addEventListener('click', (e) => { if (e.target === cohostPinOverlay) closeCohostPinPrompt(null); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cohostPinOverlay && !cohostPinOverlay.hidden) closeCohostPinPrompt(null); });
/* Random 4-digit PIN as a zero-padded string ('0000'–'9999') — plain
   digits (unlike COHOST_CODE_ALPHABET) since this is meant to be read
   aloud or texted separately from the link, not typed from the URL. */
function generateCohostPin(){
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

/* ---- Co-host mode: a second device manages the same live match ----
   A co-host is NOT a second login on the host's account (that's already
   blocked by the single-device-login claim system above) — it's a scoped,
   no-account credential (a long random code, separate from the read-only
   spectator invite code) that a trusted helper opens via a link. That
   device then runs almost the same UI as the host — start games, keep
   score, handle substitutions — but pushes/pulls state through its own
   RPCs (see supabase-cohost.sql) instead of an authenticated PATCH, and
   never touches this device's local IndexedDB (same principle as viewer
   mode: the server row is the only source of truth here).
   Settings, the player roster, and account/session-lifecycle actions stay
   host-only — enforced both by hiding those controls (body.cohost-mode in
   style.css) and by guarding the underlying functions themselves (see
   isCoHostRestricted below), so a co-host can't reach them even by poking
   at hidden elements. */
const COHOST_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // same safe alphabet as INVITE_CODE_ALPHABET below (no 0/O, 1/I) — duplicated as a literal, not a reference, so this doesn't depend on load order relative to that later `const`
const COHOST_CODE_RE = new RegExp('^[' + COHOST_CODE_ALPHABET + ']{16,32}$');
const COHOST_STORAGE_KEY = 'renzkuCohostSession';
const COHOST_POLL_INTERVAL_MS = 2500;
let cohostSession = null;   // { id, invite_code, cohost_code, session_name } | null — this device's
                             // accepted co-host credential, if any
let coHostMode = false;     // true once this device has actually entered co-host mode this load
let cohostModeInitialized = false; // guards against enterCoHostMode() running twice, same idea as
                                    // viewerModeInitialized above
let cohostPollTimer = null;
let cohostPollFn = null;    // lets the global online/visibility/pageshow handlers trigger an
                             // immediate re-poll, same pattern as viewerPollFn
let lastCohostStateAt = 0;  // most recent updated_at (ms) this device has actually applied —
                             // stops a slow/late poll response from yanking a newer local edit
                             // backward
let hostCohostCode = null;  // the ACTIVE co-host code for hostSession's row, as last fetched by
                             // this (the real host's) device — null if co-host access is off
let hostCohostBusy = false; // true while an enable/disable/regenerate request is in flight

function b64UrlDecode(str){
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}
function decodeJwt(token){
  try{ return JSON.parse(b64UrlDecode(token.split('.')[1])); }
  catch(e){ return null; }
}

function saveAuthSession(session){
  authSession = session;
  try{
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }catch(e){}
}
function loadAuthSession(){
  try{
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function saveHostSession(session){
  hostSession = session;
  // Whatever session we had before (if any) is gone either way — don't carry
  // a stale "reconnecting" pill or a queued push for it into the new state.
  hostReconnecting = false;
  hostPushPending = false;
  stopHostReconnectRetry();
  if (session){ lastHostStateAt = Date.now(); startHostPoll(); }
  else stopHostPoll();
  try{
    if (session) localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(HOST_STORAGE_KEY);
  }catch(e){}
}
function loadHostSession(){
  try{
    const raw = localStorage.getItem(HOST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

function saveCohostSession(session){
  cohostSession = session;
  hostReconnecting = false;
  hostPushPending = false;
  stopHostReconnectRetry();
  try{
    if (session) localStorage.setItem(COHOST_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(COHOST_STORAGE_KEY);
  }catch(e){}
}
function loadCohostSession(){
  try{
    const raw = localStorage.getItem(COHOST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

/* True (and toasts a heads-up) if this device is a co-host and the action
   being attempted is out of scope for one — settings, the player roster,
   and account/session-lifecycle actions stay host-only. Call at the top
   of any such action, before it mutates anything. */
function isCoHostRestricted(){
  if (!coHostMode) return false;
  toast('Co-hosts can\u2019t do that \u2014 ask the host', 'warning');
  return true;
}

/* ---- Co-host fine-grained permissions: Allow Swap / Allow Substitution ----
   Unlike the host-only actions above (always off-limits to a co-host),
   swap and substitution are ALLOWED by default for a co-host, but the
   host can turn either one off per-session. The flags live on
   state.session.cohostPermissions, so — same as every other session
   setting — they ride along on the exact same JSON blob that's already
   pushed to (and polled from) the shared server row, meaning a change
   the host makes applies immediately and survives a refresh/reconnect
   on both sides with no extra plumbing.
   This is called on every path that can (re)assign state.session,
   whether it originates from freshState, a local IndexedDB load, an
   imported backup, or a co-host device fetching/polling the host's
   state — so older saved sessions transparently pick up the defaults. */
function normalizeCohostPermissions(session){
  if (!session) return;
  if (!session.cohostPermissions || typeof session.cohostPermissions !== 'object'){
    session.cohostPermissions = { allowSwap: true, allowSubstitution: true };
    return;
  }
  if (typeof session.cohostPermissions.allowSwap !== 'boolean') session.cohostPermissions.allowSwap = true;
  if (typeof session.cohostPermissions.allowSubstitution !== 'boolean') session.cohostPermissions.allowSubstitution = true;
}
function getCohostPermissions(){
  normalizeCohostPermissions(state.session);
  return state.session.cohostPermissions;
}
/* Gate for the two co-host-toggleable actions themselves (as opposed to
   isCoHostRestricted's always-host-only actions). `key` is
   'allowSwap' or 'allowSubstitution'. Always true for the real host — a
   host device is never coHostMode, so it keeps full access regardless of
   how these toggles are set (the toggles only ever constrain the co-host
   device polling/pushing that same session). Returns false (and toasts)
   when a co-host tries an action the host has turned off. Call this at
   the top of the actual mutating function AND anywhere the corresponding
   button/icon gets rendered, so a co-host can't reach the action even by
   poking at a hidden element or calling the function directly. */
function cohostActionAllowed(key, label){
  if (!coHostMode) return true;
  if (getCohostPermissions()[key]) return true;
  toast('The host has turned off ' + label + ' for co-hosts', 'warning');
  return false;
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
  const payload = captchaToken
    ? Object.assign({}, body, { gotrue_meta_security: { captcha_token: captchaToken } })
    : body;
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

/* Some auth error responses reveal more than they should — e.g. signup
   telling you an email is "already registered" confirms someone has an
   account with that address (email enumeration). Map the sensitive ones to
   a generic message; everything else (bad email format, weak password,
   wrong captcha, rate limited, etc.) isn't sensitive and passes through
   as-is so the person still knows what to fix. */
function normalizeAuthError(err, mode){
  const code = ((err && err.code) || '').toLowerCase();
  const raw = ((err && err.message) || '').toLowerCase();
  if (mode === 'signup' && (code === 'user_already_exists' || code === 'email_exists' || raw.indexOf('already registered') !== -1 || raw.indexOf('already exists') !== -1)){
    return 'Could not create that account \u2014 double-check the email, or log in instead if you already have one.';
  }
  if (mode === 'login' && (code === 'invalid_credentials' || raw.indexOf('invalid login credentials') !== -1)){
    return 'Incorrect email or password.';
  }
  return (err && err.message) || 'Something went wrong — try again';
}

async function signUpEmail(email, password, captchaToken){
  const data = await authRequest('/auth/v1/signup', { email, password }, captchaToken);
  if (data.access_token){ applyAuthResponse(data); return { needsConfirmation: false }; }
  // Supabase's /signup response shape differs depending on whether email
  // confirmation is required: with it off you get a full session (handled
  // above); with it on you get the bare user record back with no session —
  // confirmation_sent_at is the field that actually proves it queued the
  // email, so surface that rather than just assuming from "no access_token".
  const sentAt = data.confirmation_sent_at || (data.user && data.user.confirmation_sent_at) || null;
  return { needsConfirmation: true, confirmationSent: !!sentAt };
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
  }catch(e){
    saveAuthSession(null);
    return null;
  }
}
async function signOutEverywhere(){
  if (hostSession){ try{ await stopHosting(); }catch(e){} }
  remoteLiveSession = null; remoteLiveChecked = false;
  try{
    if (authSession){
      await fetch(SUPABASE_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + authSession.access_token }
      });
    }
  }catch(e){}
  saveAuthSession(null);
  hostUsageToday = null; hostAccountInfo = null; siteSettingsCache = null; hostPendingCreditRequest = undefined; resetBuyCreditsFlow();
  renderHostPanel();
}

/* ---- Single-device login: claim / release / poll ----
   claim_device_session and force_claim_device_session are Postgres
   functions (see supabase-schema.sql) that atomically read-then-write
   profiles.active_device_id so two logins racing on the same account can't
   both "win". Both fail open (treat as claimed) if the call errors —
   e.g. the SQL hasn't been applied to this project yet — so a problem
   here can't lock anyone out of an otherwise-working app. */
async function claimDeviceSession(token){
  try{
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/claim_device_session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ p_device_id: getDeviceId(), p_device_label: deviceLabel() })
    });
    if (!res.ok) throw new Error('claim_device_session failed: HTTP ' + res.status);
    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : data;
    return row || { claimed: true };
  }catch(e){
    console.warn('claimDeviceSession failed, allowing login:', e);
    return { claimed: true };
  }
}
async function forceClaimDeviceSession(token){
  try{
    await fetch(SUPABASE_URL + '/rest/v1/rpc/force_claim_device_session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ p_device_id: getDeviceId(), p_device_label: deviceLabel() })
    });
  }catch(e){}
}
/* Clears this device's session locally only — no server calls beyond what
   already happened (the other device already claimed the account server-
   side). Deliberately does NOT call stopHosting()'s "mark ended" PATCH: if
   this device was mid-match when it got bumped, the match itself should
   stay live for the new device to pick up via the existing cross-device
   resume flow, not get killed out from under it. */
function forceLocalLogout(message){
  saveHostSession(null);
  saveAuthSession(null);
  hostUsageToday = null; hostAccountInfo = null; siteSettingsCache = null; hostPendingCreditRequest = undefined; resetBuyCreditsFlow();
  remoteLiveSession = null; remoteLiveChecked = false;
  updateHostIndicator();
  renderHostPanel();
  toast(message, 'warning');
}
/* Polls whether this device still holds the account's claim. Called on a
   standing interval while logged in, on load, and when the browser comes
   back online — mirrors checkHostStillLive()'s pattern below. */
async function checkDeviceStillActive(){
  if (!authSession) return true;
  try{
    const token = await ensureFreshToken();
    if (!token) return true; // ensureFreshToken already cleared a dead session
    const res = await fetch(SUPABASE_URL + `/rest/v1/profiles?id=eq.${authSession.user.id}&select=active_device_id`, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return true; // migration not applied yet, or a hiccup — don't punish for that
    const rows = await res.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.active_device_id && row.active_device_id !== getDeviceId()){
      forceLocalLogout('You were logged out here \u2014 this account was signed in on another device.');
      return false;
    }
    return true;
  }catch(e){ return true; } // network hiccup — the next scheduled check will catch a real change
}
// Shortened from 2 minutes: this poll is what bounds how long two devices
// can both be editing the same hosted session (and pushing conflicting,
// last-write-wins state via pushStateNow) before the losing device gets
// force-logged-out. 30s keeps that overlap window small without hammering
// the API — device takeover is already an edge case (someone logging in
// elsewhere while a session is live), not a routine event.
setInterval(() => { if (authSession) checkDeviceStillActive(); }, 30 * 1000);

/* Generic helper for the hosted_sessions REST/RPC calls. Pass useAuth=true
   to sign the request as the logged-in host; otherwise it goes out under
   the anon key only (that's all a spectator ever needs). */
async function sbFetch(path, options, useAuth){
  const token = useAuth ? await ensureFreshToken() : null;
  const headers = Object.assign({
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + (token || SUPABASE_ANON_KEY)
  }, (options && options.headers) || {});
  return fetch(SUPABASE_URL + path, Object.assign({}, options, { headers }));
}

const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips look-alike chars (0/O, 1/I)
const INVITE_CODE_RE = new RegExp('^[' + INVITE_CODE_ALPHABET + ']{6}$');

function genInviteCode(){
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 6; i++) out += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  return out;
}

/* ---- Lightweight client-side throttling for the "watch by code" flow ----
   This can't stop a scripted attacker hitting the API directly — that's a
   server/RLS-layer concern — but it raises the floor against casual
   guess-and-check from the UI, and stops a tab left open on a dead/invalid
   code from repolling it forever. */
const WATCH_THROTTLE_KEY = 'renzkuWatchThrottle';
const WATCH_FAIL_LIMIT = 5;                 // failed lookups allowed...
const WATCH_FAIL_WINDOW_MS = 2 * 60 * 1000; // ...within this window...
const WATCH_COOLDOWN_MS = 30 * 1000;        // ...before a cooldown kicks in

function loadWatchFailTimestamps(){
  try{
    const raw = localStorage.getItem(WATCH_THROTTLE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - WATCH_FAIL_WINDOW_MS;
    return Array.isArray(arr) ? arr.filter(t => typeof t === 'number' && t > cutoff) : [];
  }catch(e){ return []; }
}
function recordWatchFailure(){
  const arr = loadWatchFailTimestamps();
  arr.push(Date.now());
  try{ localStorage.setItem(WATCH_THROTTLE_KEY, JSON.stringify(arr)); }catch(e){}
}
function watchCooldownRemainingMs(){
  const arr = loadWatchFailTimestamps();
  if (arr.length < WATCH_FAIL_LIMIT) return 0;
  const remaining = (arr[arr.length - 1] + WATCH_COOLDOWN_MS) - Date.now();
  return remaining > 0 ? remaining : 0;
}

async function getHostUsageToday(){
  if (!authSession) return 0;
  // Local-day boundary (not UTC) — a host's "daily" limit should reset at
  // THEIR midnight, not at 00:00 UTC (which for a UTC+8 host would refresh
  // the quota mid-morning instead of overnight, and be flat-out confusing
  // for anyone west of UTC where it'd refresh the previous afternoon).
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const res = await sbFetch(
    `/rest/v1/hosted_sessions?host_id=eq.${authSession.user.id}&created_at=gte.${startOfDay.toISOString()}&select=id`,
    { method: 'GET', headers: { 'Prefer': 'count=exact' } },
    true
  );
  const range = res.headers.get('content-range'); // e.g. "0-2/3"
  if (range && range.includes('/')){
    const total = range.split('/')[1];
    if (total !== '*') return parseInt(total, 10) || 0;
  }
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data.length : 0;
}

/* Public sitewide defaults an admin sets from the /admin portal's "Site
   settings" tab: the default daily hosting limit, and maintenance mode
   (which pauses new/resumed hosting for everyone except admins). Readable
   by anyone — RLS on site_settings allows select to all — so this works
   even for a signed-out visitor just looking at the panel. */
async function getSiteSettings(){
  try{
    const res = await sbFetch(
      '/rest/v1/site_settings?select=key,value&key=in.(host_daily_limit_default,maintenance_mode,maintenance_message)',
      { method: 'GET' }, false
    );
    if (!res.ok) throw new Error('site_settings fetch failed: HTTP ' + res.status);
    const rows = await res.json();
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { map[r.key] = r.value; });
    return {
      defaultLimit: (map.host_daily_limit_default && map.host_daily_limit_default.limit) || HOST_DAILY_LIMIT_FALLBACK,
      maintenanceMode: !!(map.maintenance_mode && map.maintenance_mode.on),
      maintenanceMessage: (map.maintenance_message && map.maintenance_message.text) ||
        'Online hosting is temporarily paused for maintenance — check back soon.'
    };
  }catch(e){
    // Swallowed on purpose so a hiccup here can't block the whole panel from
    // rendering — but logged, because silently falling back to the generic
    // default here means the effective limit shown could be wrong (see the
    // matching note in getHostAccountInfo below).
    console.warn('getSiteSettings failed, using fallback default:', e);
    return { defaultLimit: HOST_DAILY_LIMIT_FALLBACK, maintenanceMode: false, maintenanceMessage: '' };
  }
}

/* This account's own row from profiles — the per-account hosting credit
   override (null = use the site default above) and whether an admin has
   suspended it. Requires auth since it's a row keyed to this user's id. */
async function getHostAccountInfo(){
  if (!authSession) return { limit: null, suspended: false, creditBalance: 0 };
  try{
    const res = await sbFetch(
      `/rest/v1/profiles?id=eq.${authSession.user.id}&select=host_daily_limit,is_suspended,credit_balance`,
      { method: 'GET' }, true
    );
    // IMPORTANT: don't just call res.json() unconditionally here. sbFetch
    // never throws on a non-2xx response (it just returns whatever the
    // fetch gave back), so a real error — an expired token, a rejected
    // request, anything — comes back as a JSON *error object*, not an
    // array. `Array.isArray(rows)` would be false either way, so treating
    // "not an array" as "no override, fall back to the site default" means
    // a genuine failure here looks identical to a normal "no override" —
    // and this account then gets billed against the SITE default while the
    // real per-account override (still sitting in the database, and still
    // what the server-side trigger actually enforces, since that runs as
    // security definer and doesn't depend on this fetch at all) silently
    // disagrees. That mismatch is exactly what shows up as "the panel says
    // I still have credits left, but going live says the limit's reached".
    if (!res.ok) throw new Error('profiles fetch failed: HTTP ' + res.status);
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return {
      limit: row && row.host_daily_limit != null ? row.host_daily_limit : null,
      suspended: !!(row && row.is_suspended),
      creditBalance: (row && typeof row.credit_balance === 'number') ? row.credit_balance : 0
    };
  }catch(e){
    console.warn('getHostAccountInfo failed \u2014 falling back to "no override"; the actual limit enforced server-side may differ:', e);
    return { limit: null, suspended: false, creditBalance: 0 };
  }
}
// Purchased credits still sitting on this account, unspent — 0 if not
// loaded yet or on a failed fetch (see the warning above).
function hostCreditBalance(){
  return (hostAccountInfo && hostAccountInfo.creditBalance) || 0;
}

/* The most recent credit purchase this account submitted that's still
   awaiting admin review, if any — shown so the person isn't left
   wondering whether their "Go live" is still blocked after they already
   sent a receipt. Cached like hostUsageToday/hostAccountInfo; cleared on
   logout and after a fresh submission. */
async function getPendingCreditRequest(){
  if (!authSession) return null;
  try{
    const res = await sbFetch(
      `/rest/v1/credit_purchase_requests?host_id=eq.${authSession.user.id}&status=eq.pending&select=id,package_credits,amount_php,created_at&order=created_at.desc&limit=1`,
      { method: 'GET' }, true
    );
    if (!res.ok) throw new Error('credit request fetch failed: HTTP ' + res.status);
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0]) || null;
  }catch(e){
    console.warn('getPendingCreditRequest failed:', e);
    return null;
  }
}

/* Uploads the receipt to private storage, then files the purchase request
   row. Two steps because the row references the uploaded object's path —
   if the upload fails we never create a dangling request with no receipt. */
async function submitCreditPurchase(pkg, file){
  const token = await ensureFreshToken();
  if (!token) throw new Error('Session expired — please log in again.');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${authSession.user.id}/${Date.now()}.${ext}`;
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/receipts/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + token,
      'Content-Type': file.type || 'application/octet-stream'
    },
    body: file
  });
  if (!uploadRes.ok){
    const errData = await uploadRes.json().catch(() => null);
    throw new Error((errData && (errData.message || errData.error)) || 'Could not upload receipt');
  }
  const insertRes = await sbFetch('/rest/v1/credit_purchase_requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      host_id: authSession.user.id,
      package_credits: pkg.credits,
      amount_php: pkg.amountPhp,
      receipt_path: path
    })
  }, true);
  const data = await insertRes.json().catch(() => null);
  if (!insertRes.ok){
    throw new Error((data && (data.message || data.error_description || data.hint)) || 'Could not submit purchase request');
  }
  return Array.isArray(data) ? data[0] : data;
}

// Combines the two above into the number that actually governs this
// account right now (a per-account override always wins over the site
// default). Call only after both caches have been populated.
function effectiveHostLimit(){
  const override = hostAccountInfo && hostAccountInfo.limit;
  if (override != null) return override;
  return (siteSettingsCache && siteSettingsCache.defaultLimit) || HOST_DAILY_LIMIT_FALLBACK;
}

async function createHostedSessionOnce(){
  const code = genInviteCode();
  const res = await sbFetch('/rest/v1/hosted_sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      host_id: authSession.user.id,
      invite_code: code,
      session_name: state.session.name,
      state: state,
      status: 'live'
    })
  }, true);
  if (res.status === 409) return { conflict: true };
  const data = await res.json().catch(() => null);
  if (!res.ok){
    throw new Error((data && (data.message || data.error_description || data.hint)) || 'Could not start hosting');
  }
  return { row: Array.isArray(data) ? data[0] : data };
}
async function createHostedSessionWithRetry(){
  for (let i = 0; i < 5; i++){
    const r = await createHostedSessionOnce();
    if (!r.conflict) return r.row;
  }
  return null;
}

async function startHosting(){
  if (!SUPABASE_CONFIGURED){ toast('Online hosting needs a Supabase anon key set in script.js first'); return; }
  if (!authSession) return;
  if (navigator.onLine === false){
    hostErrorMsg = 'You\u2019re offline \u2014 hosting needs an internet connection. Reconnect and try again.';
    renderHostPanel();
    return;
  }
  hostBusy = true; hostErrorMsg = ''; renderHostPanel();
  try{
    if (hostAccountInfo && hostAccountInfo.suspended){
      hostErrorMsg = 'This account has been suspended from online hosting.';
      return;
    }
    if (siteSettingsCache && siteSettingsCache.maintenanceMode){
      hostErrorMsg = siteSettingsCache.maintenanceMessage || 'Online hosting is temporarily paused for maintenance.';
      return;
    }
    const usage = await getHostUsageToday();
    hostUsageToday = usage; // keep the displayed "used today" count in sync with
                             // the number this check just used, not last render's
    const limit = effectiveHostLimit();
    if (usage >= limit && hostCreditBalance() <= 0){
      hostErrorMsg = `You've used all ${limit} live matches for today — try again tomorrow, or buy credits below.`;
      return;
    }
    const row = await createHostedSessionWithRetry();
    if (!row){ hostErrorMsg = 'Could not start hosting — please try again.'; return; }
    // This session just consumed one of today's "used" slots (or, if the
    // free daily allowance was already exhausted, one purchased credit —
    // spent server-side by the same trigger that enforces the limit).
    // Update the local caches to match right away instead of leaving them
    // reflecting the pre-session count/balance: without this, stopping and
    // re-opening the host panel kept showing yesterday's — well, a minute
    // ago's — numbers until the next "Go live" tap forced a fresh fetch,
    // which could let the button look enabled when the account was
    // actually already at its limit (see the stale-cache note on
    // getHostAccountInfo above for why silently trusting a fetch here is
    // risky — this just increments/invalidates what we already confirmed
    // moments ago, it doesn't fetch anything new).
    hostUsageToday = usage + 1;
    if (usage >= limit) hostAccountInfo = null; // this one drew from the credit
                                                  // balance — invalidate so the
                                                  // next render re-fetches the
                                                  // real (now lower) balance
                                                  // instead of showing a stale one
    saveHostSession({ id: row.id, invite_code: row.invite_code });
    lastStoppedHost = null;
    enforceSessionHistoryLimit(); // fire-and-forget: prune anything beyond the 10 most recent
    toast('You\u2019re live \u2014 share the code or QR to invite viewers');
  }catch(e){
    // The client-side checks above are just a UX nicety — the real limit,
    // suspension, and maintenance-mode gating are enforced by a Postgres
    // trigger (see supabase-schema.sql), which raises these exact error
    // codes if any of this is ever raced or bypassed client-side.
    if (e.message && e.message.indexOf('daily_limit_reached') !== -1){
      // The server just rejected this using whatever it actually has on
      // file — which may not match what this tab cached (e.g. an admin
      // changed the limit, or an earlier fetch of it silently failed and
      // fell back to a default that didn't apply). Re-pull everything
      // fresh before wording the message, so what's shown can't disagree
      // with what the server just enforced.
      const [freshUsage, freshAccountInfo, freshSettings] = await Promise.all([
        getHostUsageToday().catch(() => hostUsageToday),
        getHostAccountInfo(),
        getSiteSettings()
      ]);
      hostUsageToday = freshUsage; hostAccountInfo = freshAccountInfo; siteSettingsCache = freshSettings;
      hostErrorMsg = `You've used all ${effectiveHostLimit()} live matches for today — try again tomorrow, or buy credits below.`;
    } else if (e.message && e.message.indexOf('host_suspended') !== -1){
      hostErrorMsg = 'This account has been suspended from online hosting.';
    } else if (e.message && e.message.indexOf('maintenance_mode') !== -1){
      hostErrorMsg = (siteSettingsCache && siteSettingsCache.maintenanceMessage) || 'Online hosting is temporarily paused for maintenance.';
    } else if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e.message || '')){
      // The fetch itself never reached the server — almost always means the
      // connection dropped between the pre-check above and this request,
      // rather than anything Supabase rejected. Say so plainly instead of
      // surfacing the raw "Failed to fetch" browser wording.
      hostErrorMsg = 'Couldn\u2019t reach the server \u2014 check your internet connection and try again.';
    } else {
      hostErrorMsg = e.message || 'Could not start hosting';
    }
  }finally{
    hostBusy = false;
    updateHostIndicator();
    renderHostPanel();
  }
}

/* Re-activates the exact same hosted_sessions row this device just stopped,
   instead of creating a new one — so viewers who still have the old link or
   QR code saved can jump right back in on the same code rather than needing
   a fresh one. This is a PATCH, not an insert, so it doesn't count against
   the daily "live matches started" limit — it's the same match resuming,
   not a new one starting. */
async function resumeHostingSameLink(){
  if (!lastStoppedHost) return;
  const target = lastStoppedHost;
  hostBusy = true; hostErrorMsg = ''; renderHostPanel();
  try{
    const res = await sbFetch(`/rest/v1/hosted_sessions?id=eq.${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'live', ended_at: null, state: state, session_name: state.session.name })
    }, true);
    const data = await res.json().catch(() => null);
    if (!res.ok){
      throw new Error((data && (data.message || data.error_description || data.hint)) || 'Could not resume that link');
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row){ hostErrorMsg = 'Could not resume that link — please try again.'; return; }
    saveHostSession({ id: row.id, invite_code: row.invite_code });
    lastStoppedHost = null;
    toast('You\u2019re live again \u2014 same code as before');
  }catch(e){
    // The old row might be long gone (e.g. cleaned up server-side) — fall
    // back to letting the person start fresh instead of getting stuck here.
    hostErrorMsg = (e.message || 'Could not resume that link') + ' Try starting a new one instead.';
  }finally{
    hostBusy = false;
    updateHostIndicator();
    renderHostPanel();
  }
}

async function stopHosting(){
  if (!hostSession) return;
  const dying = hostSession;
  lastStoppedHost = { id: dying.id, invite_code: dying.invite_code, session_name: state.session.name };
  saveHostSession(null);
  updateHostIndicator();
  renderHostPanel();
  try{
    await sbFetch(`/rest/v1/hosted_sessions?id=eq.${dying.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'ended', ended_at: new Date().toISOString() })
    }, true);
  }catch(e){}
}

/* ---- Cross-device recovery: if this device isn't hosting locally, ask the
   server whether this account already has a live match running (started on
   a device that then died/went offline before "Stop hosting" could run —
   the row itself just stays status:'live' forever otherwise, since nothing
   ever marks it ended). Lets the person resume control from a new device,
   or cleanly end the orphaned one, instead of it just seeming to not exist. */
async function checkRemoteLiveSession(){
  if (!authSession){ remoteLiveSession = null; remoteLiveChecked = true; return; }
  try{
    const res = await sbFetch(
      `/rest/v1/hosted_sessions?host_id=eq.${authSession.user.id}&status=eq.live&select=id,invite_code,session_name&order=created_at.desc&limit=1`,
      { method: 'GET' },
      true
    );
    const data = await res.json().catch(() => []);
    remoteLiveSession = (Array.isArray(data) && data[0]) ? data[0] : null;
  }catch(e){
    remoteLiveSession = null;
  }finally{
    remoteLiveChecked = true;
  }
}

/* Pulls the other device's live match onto this one and takes over pushing
   updates for it. This *replaces* this device's local match with the one
   from the server, since going forward every local change here will be
   broadcast as that live match's new state — so it asks first. */
async function resumeRemoteSession(){
  if (!remoteLiveSession) return;
  if (!(await showConfirm('This will replace this device\u2019s current stack, courts and history with the live match from your other device. That device\u2019s data (courts, stack, history) will take over here.', {title: 'Resume \u201c' + (remoteLiveSession.session_name || 'live match') + '\u201d here?', confirmLabel: 'Resume here'}))) return;
  hostBusy = true; hostErrorMsg = ''; renderHostPanel();
  try{
    const res = await sbFetch(`/rest/v1/hosted_sessions?id=eq.${remoteLiveSession.id}&select=id,invite_code,state`, { method: 'GET' }, true);
    const data = await res.json().catch(() => []);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || !row.state) throw new Error('That live match is gone \u2014 it may have just ended.');
    state = row.state;
    await persist(true); // hostSession is still unset here, so this just saves locally — no re-broadcast; immediate=true since we're about to reload the roster/UI from this exact write
    renderRosterList();
    renderAll();
    saveHostSession({ id: row.id, invite_code: row.invite_code });
    remoteLiveSession = null;
    toast('Resumed \u2014 you\u2019re controlling this live match again');
  }catch(e){
    hostErrorMsg = e.message || 'Could not resume that live match';
  }finally{
    hostBusy = false;
    updateHostIndicator();
    renderHostPanel();
  }
}

/* Cleanly ends the orphaned live match without pulling its data onto this
   device — for when the person just wants to stop it (e.g. they'll start
   fresh here) rather than continue it. */
async function endRemoteSession(){
  if (!remoteLiveSession) return;
  const dying = remoteLiveSession;
  if (!(await showConfirm('End the live match running from your other device? Anyone watching that link will see it as ended.', {title: 'End \u201c' + (dying.session_name || 'live match') + '\u201d?', confirmLabel: 'End it'}))) return;
  hostBusy = true; hostErrorMsg = ''; renderHostPanel();
  try{
    await sbFetch(`/rest/v1/hosted_sessions?id=eq.${dying.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'ended', ended_at: new Date().toISOString() })
    }, true);
    remoteLiveSession = null;
    toast('Ended');
  }catch(e){
    hostErrorMsg = e.message || 'Could not end that live match';
  }finally{
    hostBusy = false;
    renderHostPanel();
  }
}

/* ---- Idle/cron auto-stop detection ----
   A Supabase cron job can flip a stale row's status to 'ended' server-side
   (e.g. after an hour with no activity), but nothing was pulling that
   change back down to the host's own device — so the host kept seeing
   "Live now" and the 🔴 LIVE pill indefinitely, even though anyone who
   scanned the code correctly saw "match ended" (they poll the row
   directly). This checks this device's hostSession against the server and
   clears it locally the moment the row is no longer 'live', whatever the
   reason (idle cron, someone else stopping it via a different device,
   deleted row, etc). Called on load, whenever the host opens the panel
   (the "cloud icon"), and on a standing interval while hosting so the UI
   self-corrects even if the panel is never reopened. */
async function checkHostStillLive(){
  if (!hostSession) return true;
  try{
    const res = await sbFetch(`/rest/v1/hosted_sessions?id=eq.${hostSession.id}&select=status`, { method: 'GET' }, true);
    const data = await res.json().catch(() => []);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || row.status !== 'live'){
      stopHostReconnectRetry();
      saveHostSession(null);
      updateHostIndicator();
      renderHostPanel();
      toast('Your hosted match ended \u2014 it was idle for a while, so it auto-stopped. Go live again to keep sharing.', 'info', {detailed:true});
      return false;
    }
    setHostReconnecting(false); // this request reached the server, so we're clearly connected
    return true;
  }catch(e){
    setHostReconnecting(true); // network hiccup — flag it, but don't clear a possibly-still-live
                                // session over a blip; the retry loop will keep checking
    return true;
  }
}
setInterval(() => { if (hostSession) checkHostStillLive(); }, 2 * 60 * 1000);

// Mirror image of startCohostPoll below: the host device also needs to
// notice state a CO-HOST pushed while this device wasn't the one writing.
// Uses a plain authenticated GET (the host already owns this row, so no
// scoped RPC is needed the way a co-host's anon-key device requires) and
// the same "only adopt if it's actually newer, and never while our own
// edit is mid-flight" guard as the co-host loop, so the two devices can't
// ping-pong each other's snapshots back and forth.
async function fetchHostRowState(){
  const res = await sbFetch(`/rest/v1/hosted_sessions?id=eq.${hostSession.id}&select=state,status,updated_at`, { method: 'GET' }, true);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  return { state: row.state, status: row.status, updated_at_ms: row.updated_at ? new Date(row.updated_at).getTime() : Date.now() };
}
function startHostPoll(){
  if (hostPollTimer){ clearInterval(hostPollTimer); hostPollTimer = null; }
  const poll = async () => {
    if (!hostSession) return;
    // Don't let an incoming snapshot clobber an edit of ours that's still
    // on its way out (or about to be sent) — same reasoning as the
    // in-flight guard in pushStateNow, and the same check startCohostPoll
    // makes before adopting anything.
    if (hostPushPending || hostPushInFlight) return;
    let fetched;
    try{ fetched = await fetchHostRowState(); }catch(e){ return; } // network hiccup — next tick retries
    if (!fetched) return;
    if (fetched.status !== 'live') return; // checkHostStillLive's own timer handles the "ended" toast/cleanup
    // Only adopt a snapshot that's actually newer than what we already
    // have — guards against a slow poll response landing after we've
    // since pushed a newer edit of our own, which would otherwise yank
    // the screen (and the next auto-save) backward.
    if (fetched.updated_at_ms && fetched.updated_at_ms <= lastHostStateAt) return;
    lastHostStateAt = fetched.updated_at_ms || Date.now();
    state = fetched.state;
    renderAll();
  };
  hostPollFn = poll;
  hostPollTimer = setInterval(poll, HOST_POLL_INTERVAL_MS);
}
function stopHostPoll(){
  if (hostPollTimer){ clearInterval(hostPollTimer); hostPollTimer = null; }
  hostPollFn = null;
}

/* ---- Co-host: fetch/claim/push helpers ----
   cohost_fetch_state and cohost_push_state (see supabase-cohost.sql) are
   the only two entry points a co-host device ever calls — both anon-key,
   both re-checking the invite code + cohost code + status='live' server
   side on every call, since there's no login/JWT backing this device's
   access the way there is for the real host. */
async function fetchCohostState(inviteCode, cohostCodeVal){
  try{
    const res = await sbFetch('/rest/v1/rpc/cohost_fetch_state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_invite_code: inviteCode, p_cohost_code: cohostCodeVal })
    }, false);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.id) return null;
    return row; // { id, session_name, status, state, updated_at_ms }
  }catch(e){ return null; }
}

/* Entry point for a device opening a ?join=CODE&cohost=SECRET link, or
   auto-resuming a previously-accepted co-host session on reload (see
   init() below). Unlike enterViewerMode, this actually takes over the
   normal host-facing UI (courts, stack, scoring) rather than a stripped
   read-only one — see body.cohost-mode in style.css and the
   isCoHostRestricted() guards scattered through the mutating functions
   above for what stays off-limits. */
async function enterCoHostMode(inviteCode, cohostCodeVal, opts){
  opts = opts || {};
  if (cohostModeInitialized){
    console.warn('[Co-host] enterCoHostMode() called again in the same session — ignoring duplicate init');
    return false;
  }
  if (!inviteCode || !INVITE_CODE_RE.test(inviteCode) || !cohostCodeVal || !COHOST_CODE_RE.test(cohostCodeVal)){
    toast('That co-host link looks invalid or incomplete', 'warning');
    saveCohostSession(null);
    return false;
  }
  const fetched = await fetchCohostState(inviteCode, cohostCodeVal);
  if (!fetched){
    // Only surface this as an error for a fresh link click — a silently
    // stale auto-resume (e.g. the host turned access off while this
    // device was closed) should just fall through to the normal local
    // app instead of greeting the person with a warning toast.
    if (!opts.skipConfirm) toast('This co-host link is no longer valid \u2014 ask the host to resend it', 'warning');
    saveCohostSession(null);
    return false;
  }
  // If the host has a PIN set, it rode along inside fetched.state (same
  // state.session blob a co-host will adopt below) — require it before
  // granting access on a FRESH link click. An auto-resume of an
  // already-accepted credential (opts.skipConfirm) was already PIN-checked
  // the first time, so it isn't asked again on every reload.
  //
  // A wrong guess doesn't abort the join outright — the person gets up to
  // COHOST_PIN_MAX_ATTEMPTS tries (re-prompted each time) before giving up,
  // with a toast after every attempt: a warning naming how many tries are
  // left on a miss, or a success notice the moment the PIN checks out.
  const requiredPin = fetched.state && fetched.state.session && fetched.state.session.cohostPin;
  if (requiredPin && !opts.skipConfirm){
    const COHOST_PIN_MAX_ATTEMPTS = 4;
    let pinVerified = false;
    for (let attempt = 1; attempt <= COHOST_PIN_MAX_ATTEMPTS; attempt++){
      const enteredPin = await openCohostPinPrompt(fetched.session_name, attempt, COHOST_PIN_MAX_ATTEMPTS);
      if (enteredPin === null){ saveCohostSession(null); return false; } // cancelled
      if (enteredPin === requiredPin){
        pinVerified = true;
        toast('PIN correct \u2014 joining as co-host', 'success');
        break;
      }
      const remaining = COHOST_PIN_MAX_ATTEMPTS - attempt;
      if (remaining > 0){
        toast('Incorrect PIN \u2014 ' + remaining + (remaining === 1 ? ' attempt' : ' attempts') + ' left', 'warning');
      } else {
        toast('Incorrect PIN \u2014 too many attempts. Ask the host to resend the link', 'warning');
      }
    }
    if (!pinVerified){
      saveCohostSession(null);
      return false;
    }
  }
  if (!opts.skipConfirm){
    const ok = await showConfirm(
      'As a co-host you can start games and keep score on \u201c' + (fetched.session_name || 'this match') + '\u201d, plus swap partners and manage substitutions unless the host turns those off. Settings and the player roster stay with the host.',
      { title: 'Co-host this game?', confirmLabel: 'Start co-hosting' }
    );
    if (!ok) return false;
  }
  cohostModeInitialized = true;
  coHostMode = true;
  document.body.classList.add('cohost-mode');
  saveCohostSession({ id: fetched.id, invite_code: inviteCode, cohost_code: cohostCodeVal, session_name: fetched.session_name });
  lastCohostStateAt = fetched.updated_at_ms || Date.now();
  state = fetched.state;
  normalizeCohostPermissions(state.session);
  const banner = $('#cohostBanner');
  const msgEl = $('#cohostBannerMsg');
  if (banner) banner.hidden = false;
  if (msgEl) msgEl.textContent = fetched.session_name || 'Live match';
  renderAll();
  toast('You\u2019re co-hosting \u2014 changes sync live with the host');
  startCohostPoll();
  return true;
}

/* Access was revoked (host turned it off / regenerated the code) or the
   match itself ended — either way this device can't keep managing it.
   Reload so the normal boot sequence takes over cleanly (same recovery
   shape as forceLocalLogout, just for the co-host credential instead of
   the account login). */
function handleCohostAccessLost(reason){
  stopCohostPoll();
  saveCohostSession(null);
  coHostMode = false;
  cohostModeInitialized = false;
  toast(reason === 'ended' ? 'This match has ended.' : 'Your co-host access was turned off by the host.', 'warning');
  setTimeout(() => location.reload(), 1200); // give the toast a moment to actually be seen
}

function startCohostPoll(){
  if (cohostPollTimer){ clearInterval(cohostPollTimer); cohostPollTimer = null; }
  const poll = async () => {
    if (!cohostSession) return;
    // Don't let an incoming snapshot clobber an edit of ours that's still
    // on its way out (or about to be sent) — same reasoning as the
    // in-flight guard in pushStateNow.
    if (hostPushPending || hostPushInFlight) return;
    const fetched = await fetchCohostState(cohostSession.invite_code, cohostSession.cohost_code);
    if (!fetched){ handleCohostAccessLost('revoked'); return; }
    if (fetched.status !== 'live'){ handleCohostAccessLost('ended'); return; }
    // Only adopt a snapshot that's actually newer than what we already
    // have — a slow poll response landing after we've since pushed a
    // newer edit of our own would otherwise yank the screen backward.
    if (fetched.updated_at_ms && fetched.updated_at_ms <= lastCohostStateAt) return;
    lastCohostStateAt = fetched.updated_at_ms || Date.now();
    state = fetched.state;
    normalizeCohostPermissions(state.session);
    renderAll();
  };
  cohostPollFn = poll;
  cohostPollTimer = setInterval(poll, COHOST_POLL_INTERVAL_MS);
}
function stopCohostPoll(){
  if (cohostPollTimer){ clearInterval(cohostPollTimer); cohostPollTimer = null; }
  cohostPollFn = null;
}

/* Voluntary exit — the co-host taps "Stop co-hosting" themselves, as
   opposed to being kicked by handleCohostAccessLost. Just forgets the
   credential locally; doesn't touch the host's session at all. */
function leaveCohostMode(){
  stopCohostPoll();
  saveCohostSession(null);
  coHostMode = false;
  cohostModeInitialized = false;
  location.href = location.pathname; // drop the ?join=&cohost= params and reload into the normal local app
}
const cohostLeaveBtn = $('#cohostLeaveBtn');
if (cohostLeaveBtn) cohostLeaveBtn.addEventListener('click', async () => {
  if (!(await showConfirm('You can stop co-hosting any time \u2014 the match keeps going for the host and anyone else managing it.', {title: 'Stop co-hosting?', confirmLabel: 'Stop co-hosting'}))) return;
  leaveCohostMode();
});

/* ---- Host panel: enable/disable co-host access for the live session ----
   enable_cohost / disable_cohost (see supabase-cohost.sql) are SECURITY
   DEFINER functions that re-check auth.uid() = host_id server-side before
   touching anything — same pattern as claim_device_session above — so
   these calls only ever succeed for the actual logged-in host. */
async function refreshHostCohostCode(){
  if (!hostSession){ hostCohostCode = null; return; }
  try{
    const res = await sbFetch(`/rest/v1/hosted_sessions?id=eq.${hostSession.id}&select=cohost_code`, { method: 'GET' }, true);
    if (!res.ok) return;
    const rows = await res.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    hostCohostCode = row ? row.cohost_code : null;
  }catch(e){}
}
async function enableCohostAccess(){
  if (!hostSession || hostCohostBusy) return;
  hostCohostBusy = true; renderHostPanel();
  try{
    const res = await sbFetch('/rest/v1/rpc/enable_cohost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session_id: hostSession.id })
    }, true);
    if (!res.ok) throw new Error('enable_cohost failed: HTTP ' + res.status);
    const data = await res.json().catch(() => null);
    const row = Array.isArray(data) ? data[0] : data;
    hostCohostCode = row && row.cohost_code ? row.cohost_code : null;
    if (hostCohostCode){
      // Fresh 4-digit PIN every time co-host access is (re-)enabled — same
      // moment the link/code itself gets regenerated (see cohostRegenBtn),
      // so an old PIN never outlives its matching link. Rides the normal
      // session-state sync (state.session, same as cohostPermissions) so a
      // co-host device fetching cohost_fetch_state sees it before they're
      // ever granted access — see enterCoHostMode below.
      state.session.cohostPin = generateCohostPin();
      persist(true);
      toast('Co-host access is on \u2014 share the link and PIN below');
    } else {
      toast('Could not enable co-host access \u2014 try again', 'warning');
    }
  }catch(e){
    toast('Could not enable co-host access \u2014 has supabase-cohost.sql been applied yet?', 'warning');
  }finally{
    hostCohostBusy = false; renderHostPanel();
  }
}
async function disableCohostAccess(){
  if (!hostSession || hostCohostBusy) return;
  hostCohostBusy = true; renderHostPanel();
  try{
    const res = await sbFetch('/rest/v1/rpc/disable_cohost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session_id: hostSession.id })
    }, true);
    if (res.ok){
      hostCohostCode = null;
      if (state.session.cohostPin){ state.session.cohostPin = null; persist(true); }
      toast('Co-host access turned off \u2014 the old link no longer works');
    }
    else toast('Could not turn off co-host access \u2014 try again', 'warning');
  }catch(e){
    toast('Could not turn off co-host access \u2014 try again', 'warning');
  }finally{
    hostCohostBusy = false; renderHostPanel();
  }
}

/* Host-only: flip Allow Swap / Allow Substitution for the co-host on this
   live session. This is a plain state.session edit — same as any other
   session setting the host changes — so it rides the existing persist()
   plumbing: written to this device's IndexedDB immediately, and pushed
   (immediate=true) to the shared server row that the co-host polls every
   COHOST_POLL_INTERVAL_MS. That's what makes the change apply right away
   on the co-host's screen and survive a refresh/reconnect on both sides,
   without any new sync mechanism. The host device itself is never
   coHostMode, so none of this ever constrains the host's own access. */
function setCohostPermission(key, value, label){
  if (isCoHostRestricted()) return; // belt-and-suspenders: only the real host panel renders these toggles
  normalizeCohostPermissions(state.session);
  state.session.cohostPermissions[key] = !!value;
  toast((value ? 'Co-hosts can now ' : 'Co-hosts can no longer ') + (label === 'swap' ? 'swap partners' : 'substitute players'));
  renderHostPanel();
  renderAll();
  persist(true);
}

/* ---- Reconnection handling ----
   A push or keepalive failing doesn't necessarily mean the match stopped —
   most of the time it's a wifi blip or a spotty venue connection. Instead
   of failing silently (the old behavior) or tearing down the session, we
   flag it as "reconnecting", surface that in the LIVE pill and host panel,
   and keep retrying every few seconds until one succeeds — at which point
   we flip straight back to "Live now" with no action needed from the host. */
function setHostReconnecting(flag){
  if (hostReconnecting === flag) return;
  hostReconnecting = flag;
  updateHostIndicator();
  renderHostPanel();
  if (flag){
    if (!hostReconnectRetryTimer){
      hostReconnectRetryTimer = setInterval(() => {
        if (!hostSession){ stopHostReconnectRetry(); return; }
        if (hostPushPending) pushStateNow();
        else checkHostStillLive();
      }, 4000);
    }
  } else {
    stopHostReconnectRetry();
    toast('Back online \u2014 still live', 'info');
  }
}
function stopHostReconnectRetry(){
  if (hostReconnectRetryTimer){ clearInterval(hostReconnectRetryTimer); hostReconnectRetryTimer = null; }
}

async function pushStateNow(){
  if (!hostSession && !cohostSession) return;
  // Guard against two PATCHes ever being in flight to the same row at once.
  // Without this, a slow earlier request finishing AFTER a later one could
  // silently overwrite a viewer's fresh state with an older snapshot — the
  // live view would then look "stuck" on whatever that stale request sent,
  // no matter how many further edits the host makes, until something else
  // happens to trigger another push. Only one request is ever in the air;
  // anything that changes while it's in flight just waits for it to finish.
  if (hostPushInFlight) return;
  hostPushInFlight = true;
  try{
    if (hostSession){
      await sbFetch(`/rest/v1/hosted_sessions?id=eq.${hostSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ state: state, session_name: state.session.name })
      }, true);
      // We're the ones who just wrote this row, so its updated_at is
      // effectively "now" — mark it as already-applied so startHostPoll's
      // next tick doesn't treat our own push as an incoming remote change
      // (harmless either way since it'd just re-apply identical state, but
      // pointless work, and a slow response landing late could otherwise
      // read as older than a newer edit already in flight behind it).
      lastHostStateAt = Date.now();
    } else {
      // Co-host push: no login, so this goes out under the anon key with
      // the co-host's own scoped code — cohost_push_state (see
      // supabase-cohost.sql) re-validates that code server-side (and that
      // the match is still live) before writing anything.
      const res = await sbFetch('/rest/v1/rpc/cohost_push_state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_invite_code: cohostSession.invite_code,
          p_cohost_code: cohostSession.cohost_code,
          p_state: state,
          p_session_name: state.session.name
        })
      }, false);
      if (!res.ok) throw new Error('cohost_push_state failed: HTTP ' + res.status);
      const data = await res.json().catch(() => null);
      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.ok === false){
        hostPushInFlight = false;
        hostPushPending = false;
        handleCohostAccessLost('revoked');
        return;
      }
    }
    hostPushPending = false;
    setHostReconnecting(false);
    hostPushInFlight = false;
    // Something changed (queueHostPush was called again) while this request
    // was still in flight — send that latest state right away instead of
    // waiting out the next debounce tick or the 4s reconnect-retry loop.
    if (hostPushPending && (hostSession || cohostSession)) pushStateNow();
  }catch(e){
    hostPushInFlight = false;
    // Leave hostPushPending true — the fast retry loop (or the next state
    // change, whichever comes first) will resend this same latest state.
    setHostReconnecting(true);
  }
}

// `immediate`: bypass the debounce entirely and push right now (still
// respecting the in-flight guard in pushStateNow above) — see persist().
function queueHostPush(immediate){
  if ((!hostSession && !cohostSession) || viewerMode) return;
  hostPushPending = true;
  if (immediate){
    if (hostPushTimer){ clearTimeout(hostPushTimer); hostPushTimer = null; }
    pushStateNow();
    return;
  }
  if (hostPushTimer) return;
  // Debounced so a burst of rapid taps (e.g. mashing the score buttons)
  // collapses into one push instead of one per tap, while still keeping
  // spectators close to real time. Shortened from 1500ms — 500ms still
  // coalesces a fast double-tap but no longer sits on a finished state
  // change for a second and a half before anyone watching sees it.
  hostPushTimer = setTimeout(() => {
    hostPushTimer = null;
    if (!hostPushPending || (!hostSession && !cohostSession)) return;
    pushStateNow();
  }, 500);
}

/* ---- Host panel UI (inside the Host Online modal) ---- */
const hostOverlay = $('#hostOverlay');
const hostPanelBody = $('#hostPanelBody');
const liveHostPill = $('#liveHostPill');

function updateHostIndicator(){
  if (!liveHostPill) return;
  liveHostPill.hidden = !hostSession;
  const showReconnecting = !!hostSession && hostReconnecting;
  liveHostPill.textContent = showReconnecting ? '\uD83D\uDFE1 Reconnecting\u2026' : '\uD83D\uDD34 LIVE';
  liveHostPill.classList.toggle('is-reconnecting', showReconnecting);
}

function joinUrlFor(code){
  return location.origin + location.pathname + '?join=' + encodeURIComponent(code);
}
/* The link people actually copy/paste/share — routes through /api/share
   (see /s/:code rewrite in vercel.json) so chat apps like Messenger and
   WhatsApp show a rich preview card with the session name and a generated
   banner image (/api/og). A real click 302s straight into the app; only
   bot user-agents doing link unfurling ever see the intermediate HTML.
   Falls back to the plain app link if this isn't running on the deployed
   domain (e.g. a local file:// preview) where /api routes don't exist. */
function shareUrlFor(code){
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return joinUrlFor(code);
  return location.origin + '/s/' + encodeURIComponent(code);
}
function cohostUrlFor(inviteCode, cohostCodeVal){
  return location.origin + location.pathname + '?join=' + encodeURIComponent(inviteCode) + '&cohost=' + encodeURIComponent(cohostCodeVal);
}
/* The co-host link actually shown/copied in the host panel — routes through
   /api/share-cohost (see /cs/:invite/:secret rewrite in vercel.json) the
   same way shareUrlFor() routes the viewer link through /api/share, so a
   co-host link pasted into a chat app also gets a real preview card (see
   api/og.js's role=cohost banner) instead of showing up bare. A real click
   still 302s straight into the app; only bot user-agents see the
   intermediate HTML. Falls back to the raw join+cohost link if this isn't
   running on the deployed domain (e.g. a local file:// preview). */
function cohostShareUrlFor(inviteCode, cohostCodeVal){
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return cohostUrlFor(inviteCode, cohostCodeVal);
  return location.origin + '/cs/' + encodeURIComponent(inviteCode) + '/' + encodeURIComponent(cohostCodeVal);
}

/* ================= Session name prompt (asked before "Go live") =================
   A themed replacement for window.prompt() — resolves with the trimmed name
   the host typed, or null if they cancelled. Checks this host's own
   hosted_sessions for a name collision (case-insensitive) before resolving,
   so "Go live" never silently creates two sessions with the same name. */
const sessionNameOverlay = $('#sessionNameOverlay');
const sessionNameForm = $('#sessionNameForm');
const sessionNameInput = $('#sessionNameInput');
const sessionClubInput = $('#sessionClubInput');
const sessionDescriptionInput = $('#sessionDescriptionInput');
const sessionNameError = $('#sessionNameError');
const sessionNameSubmitBtn = $('#sessionNameSubmitBtn');
const sessionNameCancelBtn = $('#sessionNameCancelBtn');
let sessionNameResolve = null;

async function isSessionNameTaken(name){
  if (!authSession) return false;
  try{
    const res = await sbFetch(
      `/rest/v1/hosted_sessions?host_id=eq.${authSession.user.id}&session_name=ilike.${encodeURIComponent(name)}&select=id&limit=1`,
      { method: 'GET' },
      true
    );
    if (!res.ok) return false; // fail open — a network hiccup here shouldn't block going live
    const data = await res.json().catch(() => []);
    return Array.isArray(data) && data.length > 0;
  }catch(e){
    return false;
  }
}

function openSessionNamePrompt(defaultName, defaultClub, defaultDescription){
  return new Promise((resolve) => {
    sessionNameResolve = resolve;
    sessionNameError.hidden = true;
    sessionNameInput.value = defaultName || '';
    if (sessionClubInput) sessionClubInput.value = defaultClub || '';
    if (sessionDescriptionInput) sessionDescriptionInput.value = defaultDescription || '';
    sessionNameSubmitBtn.disabled = false;
    sessionNameSubmitBtn.textContent = '\uD83D\uDD34 Go live';
    sessionNameOverlay.hidden = false;
    setTimeout(() => { sessionNameInput.focus(); sessionNameInput.select(); }, 30);
  });
}
function closeSessionNamePrompt(result){
  sessionNameOverlay.hidden = true;
  const resolve = sessionNameResolve;
  sessionNameResolve = null;
  if (resolve) resolve(result);
}
if (sessionNameCancelBtn) sessionNameCancelBtn.addEventListener('click', () => closeSessionNamePrompt(null));
if (sessionNameOverlay) sessionNameOverlay.addEventListener('click', (e) => { if (e.target === sessionNameOverlay) closeSessionNamePrompt(null); });
if (sessionNameForm) sessionNameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = sessionNameInput.value.trim();
  sessionNameError.hidden = true;
  if (!name){
    sessionNameError.textContent = 'Enter a session name.';
    sessionNameError.hidden = false;
    sessionNameInput.focus();
    return;
  }
  sessionNameSubmitBtn.disabled = true;
  sessionNameSubmitBtn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Checking\u2026';
  try{
    const taken = await isSessionNameTaken(name);
    if (taken){
      sessionNameSubmitBtn.disabled = false;
      sessionNameSubmitBtn.textContent = '\uD83D\uDD34 Go live';
      // A recurring club night (e.g. "Tuesday Night Open Play") reuses the
      // same name every week on purpose — isSessionNameTaken() matches
      // against this host's *entire* history, including sessions that
      // ended long ago, so that pattern used to hit a hard "already
      // exists, pick a different name" wall every single time. Ask instead
      // of blocking: if it really is the same recurring event, let it
      // through; if it was an accidental collision, they can still rename.
      const proceedAnyway = await showConfirm(
        `You\u2019ve used the name \u201c${name}\u201d before. If this is the same recurring session (e.g. a weekly night), that\u2019s fine \u2014 go ahead and reuse it.`,
        { title: 'Session name already used', confirmLabel: 'Use this name', cancelLabel: 'Pick a different name' }
      );
      if (!proceedAnyway){
        sessionNameInput.focus();
        sessionNameInput.select();
        return;
      }
    }
    const club = sessionClubInput ? sessionClubInput.value.trim() : '';
    const description = sessionDescriptionInput ? sessionDescriptionInput.value.trim() : '';
    closeSessionNamePrompt({ name, club, description });
  }finally{
    sessionNameSubmitBtn.disabled = false;
    sessionNameSubmitBtn.textContent = '\uD83D\uDD34 Go live';
  }
});

/* ================= Account dashboard (Host Online \u2192 Manage account) =================
   Every hosted_sessions row this account owns, newest first, capped at
   SESSION_HISTORY_LIMIT — older rows are pruned automatically right after a
   new one is created (see enforceSessionHistoryLimit, called from
   startHosting). "Load" pulls a saved session's snapshot onto this device;
   "Delete" removes the row outright. */
const SESSION_HISTORY_LIMIT = 10;
const accountDashOverlay = $('#accountDashOverlay');
const accountDashList = $('#accountDashList');
const accountDashCount = $('#accountDashCount');
let accountSessions = null; // null = not loaded yet (shows skeleton)
let accountDashBusyId = null; // id of the row currently being loaded/deleted

// Deletes whatever's left beyond the SESSION_HISTORY_LIMIT most-recent rows
// for this host. Fire-and-forget from startHosting right after a new
// session is created — never awaited on the "you're live" critical path.
async function enforceSessionHistoryLimit(){
  if (!authSession) return;
  try{
    const res = await sbFetch(
      `/rest/v1/hosted_sessions?host_id=eq.${authSession.user.id}&select=id,created_at&order=created_at.desc`,
      { method: 'GET' },
      true
    );
    const data = await res.json().catch(() => []);
    if (!Array.isArray(data) || data.length <= SESSION_HISTORY_LIMIT) return;
    const excess = data.slice(SESSION_HISTORY_LIMIT); // oldest rows beyond the 10 most recent
    for (const row of excess){
      await sbFetch(`/rest/v1/hosted_sessions?id=eq.${row.id}`, { method: 'DELETE' }, true).catch(() => {});
    }
  }catch(e){}
}

function fmtDashDate(iso){
  if (!iso) return '';
  try{ return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch(e){ return ''; }
}

function accountSessionRowHTML(row){
  const busy = accountDashBusyId === row.id;
  const isLive = row.status === 'live';
  const isCurrent = !!hostSession && hostSession.id === row.id;
  const name = row.session_name ? esc(row.session_name) : 'Untitled session';
  return `
    <div class="account-dash-row${isLive ? ' is-live' : ''}">
      <div class="account-dash-row-main">
        <span class="account-dash-status-dot" aria-hidden="true"></span>
        <div class="account-dash-row-text">
          <span class="account-dash-name">${name}</span>
          <span class="account-dash-meta">${isLive ? '\uD83D\uDD34 Live now' : '\u23F8 Ended'}${isCurrent ? ' &middot; this device' : ''} &middot; code ${esc(row.invite_code)} &middot; ${fmtDashDate(row.created_at)}</span>
        </div>
      </div>
      <div class="account-dash-row-actions">
        ${busy
          ? `<span class="account-dash-busy"><span class="btn-spinner" aria-hidden="true"></span>Working\u2026</span>`
          : `<button type="button" class="btn ghost sm" data-act="dash-load" data-id="${row.id}" ${isCurrent ? 'disabled title="Already live on this device"' : ''}>${isCurrent ? 'Current' : 'Load'}</button>
             <button type="button" class="btn danger sm" data-act="dash-delete" data-id="${row.id}">Delete</button>`}
      </div>
    </div>
  `;
}

function renderAccountDashboard(){
  if (!accountDashList) return;
  if (accountSessions === null){
    accountDashList.innerHTML = `<div class="host-skeleton" style="width:85%"></div><div class="host-skeleton" style="width:60%"></div><div class="host-skeleton" style="width:70%"></div>`;
    if (accountDashCount) accountDashCount.textContent = '';
    return;
  }
  if (accountDashCount) accountDashCount.textContent = `${accountSessions.length} / ${SESSION_HISTORY_LIMIT} saved`;
  accountDashList.innerHTML = accountSessions.length === 0
    ? `<div class="account-dash-empty">No saved sessions yet \u2014 go live once and it\u2019ll show up here.</div>`
    : accountSessions.map(accountSessionRowHTML).join('');
}

async function refreshAccountSessions(){
  if (!authSession){ accountSessions = []; renderAccountDashboard(); return; }
  try{
    const res = await sbFetch(
      `/rest/v1/hosted_sessions?host_id=eq.${authSession.user.id}&select=id,invite_code,session_name,status,created_at,updated_at&order=created_at.desc&limit=${SESSION_HISTORY_LIMIT}`,
      { method: 'GET' },
      true
    );
    const data = await res.json().catch(() => []);
    accountSessions = Array.isArray(data) ? data : [];
  }catch(e){
    accountSessions = [];
  }
  renderAccountDashboard();
}

function openAccountDashboard(){
  if (!authSession) return;
  accountSessions = null;
  accountDashBusyId = null;
  renderAccountDashboard();
  accountDashOverlay.hidden = false;
  refreshAccountSessions();
}

async function loadAccountSession(id){
  if (!accountSessions) return;
  const row = accountSessions.find(r => r.id === id);
  if (!row) return;
  if (hostSession && hostSession.id === row.id) return; // already live on this device — nothing to load
  if (!(await showConfirm(
    `This will replace this device\u2019s current stack, courts and history with the saved session \u201c${row.session_name || 'Untitled session'}\u201d. This cannot be undone.`,
    { title: 'Load this session?', confirmLabel: 'Load' }
  ))) return;
  accountDashBusyId = id; renderAccountDashboard();
  try{
    const res = await sbFetch(`/rest/v1/hosted_sessions?id=eq.${id}&select=id,invite_code,session_name,status,state`, { method: 'GET' }, true);
    const data = await res.json().catch(() => []);
    const full = Array.isArray(data) ? data[0] : null;
    if (!full || !full.state) throw new Error('That saved session could not be found \u2014 it may have just been removed.');
    state = full.state;
    await persist(true); // immediate=true: about to reload the UI straight from this write
    renderRosterList();
    renderAll();
    if (full.status === 'live'){
      saveHostSession({ id: full.id, invite_code: full.invite_code });
      remoteLiveSession = null;
      lastStoppedHost = null;
      updateHostIndicator();
      toast('Loaded \u2014 you\u2019re controlling this live match again');
    } else {
      toast('Session loaded');
    }
    accountDashOverlay.hidden = true;
  }catch(e){
    toast(e.message || 'Could not load that session', 'error');
  }finally{
    accountDashBusyId = null;
    renderAccountDashboard();
    renderHostPanel();
  }
}

async function deleteAccountSession(id){
  if (!accountSessions) return;
  const row = accountSessions.find(r => r.id === id);
  if (!row) return;
  if (!(await showConfirm(
    `Delete the saved session \u201c${row.session_name || 'Untitled session'}\u201d? This cannot be undone.`,
    { title: 'Delete session?', confirmLabel: 'Delete', danger: true }
  ))) return;
  accountDashBusyId = id; renderAccountDashboard();
  try{
    const res = await sbFetch(
      `/rest/v1/hosted_sessions?id=eq.${id}`,
      { method: 'DELETE', headers: { 'Prefer': 'return=representation' } },
      true
    );
    if (!res.ok) throw new Error();
    const deletedRows = await res.json().catch(() => []);
    if (!Array.isArray(deletedRows) || deletedRows.length === 0){
      // Request succeeded but no row was actually removed — almost always
      // an RLS DELETE policy silently blocking it. Surface this instead of
      // lying to the user with a "Deleted" toast.
      throw new Error('Delete was blocked by server permissions (nothing was actually removed)');
    }
    accountSessions = accountSessions.filter(r => r.id !== id);
    toast('Deleted');
  }catch(e){
    toast('Could not delete that session', 'error');
  }finally{
    accountDashBusyId = null;
    renderAccountDashboard();
  }
}

if (accountDashOverlay) accountDashOverlay.addEventListener('click', (e) => {
  if (e.target === accountDashOverlay || e.target.closest('#accountDashDone')){ accountDashOverlay.hidden = true; return; }
  const loadBtn = e.target.closest('[data-act="dash-load"]');
  if (loadBtn){ loadAccountSession(loadBtn.dataset.id); return; }
  const delBtn = e.target.closest('[data-act="dash-delete"]');
  if (delBtn){ deleteAccountSession(delBtn.dataset.id); return; }
});

function renderHostPanel(){
  if (!hostPanelBody) return;

  if (!SUPABASE_CONFIGURED){
    hostPanelBody.innerHTML = `<p class="add-hint" style="padding:0">Online hosting isn't configured yet. Add your Supabase project's anon/public API key to <code>SUPABASE_ANON_KEY</code> at the top of the Host Online section in script.js, then reload.</p>`;
    return;
  }

  if (!authSession){
    if (pendingSignupConfirmation){
      const { email, sent } = pendingSignupConfirmation;
      hostPanelBody.innerHTML = `
        <div class="host-live-card">
          <span class="host-live-badge" style="background:var(--turf-pale);color:var(--turf)">✅ Account created</span>
          <p class="host-live-note" style="margin-top:.5rem">
            ${sent
              ? `We\u2019ve sent a confirmation email to <b>${esc(email)}</b>, sent by Supabase on this app\u2019s behalf. Open it and confirm your address, then log in below.`
              : `Your account was created, but we couldn\u2019t confirm Supabase actually queued a confirmation email to <b>${esc(email)}</b> \u2014 check spam, or this project\u2019s Supabase email sending may not be configured yet. Once confirmed, log in below.`}
          </p>
          <button type="button" class="btn primary" id="signupConfirmDismissBtn" style="width:100%;margin-top:.5rem">Go to log in</button>
        </div>
      `;
      return;
    }
    hostPanelBody.innerHTML = `
      <div class="host-auth-wrap${hostBusy ? ' is-busy' : ''}">
        <div class="host-auth-tabs">
          <button type="button" data-tab="login" class="${hostPanelMode === 'login' ? 'active' : ''}" ${hostBusy ? 'disabled' : ''}>Log in</button>
          <button type="button" data-tab="signup" class="${hostPanelMode === 'signup' ? 'active' : ''}" ${hostBusy ? 'disabled' : ''}>Sign up</button>
        </div>
        ${hostErrorMsg ? `<div class="host-error">${esc(hostErrorMsg)}</div>` : ''}
        <form id="hostAuthForm">
          <fieldset ${hostBusy ? 'disabled' : ''} style="border:0;margin:0;padding:0">
            <div class="field">
              <label for="hostEmailInput">Email</label>
              <input type="email" id="hostEmailInput" required autocomplete="email">
            </div>
            <div class="field">
              <label for="hostPasswordInput">Password</label>
              <input type="password" id="hostPasswordInput" required minlength="6" autocomplete="${hostPanelMode === 'signup' ? 'new-password' : 'current-password'}">
            </div>
            ${hostPanelMode === 'signup' ? `
            <div class="field">
              <label for="hostPasswordConfirmInput">Confirm password</label>
              <input type="password" id="hostPasswordConfirmInput" required minlength="6" autocomplete="new-password">
            </div>` : ''}
            <div id="hcaptchaBox" style="margin:.6rem 0"></div>
            <button type="submit" class="btn primary" style="width:100%">${hostBusy ? '<span class="btn-spinner" aria-hidden="true"></span>Please wait…' : (hostPanelMode === 'signup' ? 'Create account' : 'Log in')}</button>
          </fieldset>
        </form>
        ${hostBusy ? `<div class="host-busy-overlay" aria-hidden="true"><span class="spinner"></span></div>` : ''}
      </div>
    `;
    mountHcaptchaWidget();
    return;
  }

  if (!hostSession){
    if (hostUsageToday === null){
      getHostUsageToday().then(n => { hostUsageToday = n; renderHostPanel(); }).catch(() => { hostUsageToday = 0; renderHostPanel(); });
    }
    if (hostAccountInfo === null){
      getHostAccountInfo().then(info => { hostAccountInfo = info; renderHostPanel(); });
    }
    if (siteSettingsCache === null){
      getSiteSettings().then(s => { siteSettingsCache = s; renderHostPanel(); });
    }
    if (!remoteLiveChecked){
      checkRemoteLiveSession().then(renderHostPanel);
    }
    if (hostPendingCreditRequest === undefined){
      hostPendingCreditRequest = null; // placeholder so this only kicks off once while the real fetch resolves
      getPendingCreditRequest().then(r => { hostPendingCreditRequest = r; renderHostPanel(); });
    }
    const used = hostUsageToday === null ? '…' : hostUsageToday;
    const limit = effectiveHostLimit();
    const credits = hostCreditBalance();
    // The daily free allowance is exhausted AND there's no purchased balance
    // left to fall back on — this is the only state that actually blocks
    // "Go live" (the server draws from credits automatically once the daily
    // count runs out, so having credits left means the button stays enabled).
    const atLimit = typeof used === 'number' && used >= limit && credits <= 0;
    // While the day's usage count is still loading, show a shimmer instead of
    // a bare "… / N" — same treatment as /admin's loading placeholders.
    const usageRowHTML = hostUsageToday === null
      ? `<div class="host-skeleton" style="width:70%"></div>`
      : `<div class="host-usage-row"><span>Live matches used today</span><b>${used} / ${limit}</b></div>`;
    const pendingCreditHTML = hostPendingCreditRequest
      ? `<div class="host-credit-pending">Your \u20b1${esc(hostPendingCreditRequest.amount_php)} request for ${esc(hostPendingCreditRequest.package_credits)} credits is pending admin review.</div>`
      : '';
    const buyCreditsHTML = buyCreditsSectionHTML();

    // A suspended account is blocked outright, regardless of any other
    // state (already-live-elsewhere, a just-stopped session, etc.) — an
    // admin turned hosting off for this account specifically.
    if (hostAccountInfo && hostAccountInfo.suspended){
      hostPanelBody.innerHTML = `
        ${hostAccountRowHTML()}
        <div class="host-error">This account has been suspended from online hosting. Contact the site admin if you think that's a mistake.</div>
      `;
      return;
    }

    if (!remoteLiveChecked){
      hostPanelBody.innerHTML = `
        ${hostAccountRowHTML()}
        <div class="host-skeleton" style="width:85%"></div>
        <div class="host-skeleton" style="width:55%"></div>
      `;
      return;
    }

    if (remoteLiveSession){
      hostPanelBody.innerHTML = `
        ${hostAccountRowHTML()}
        ${hostErrorMsg ? `<div class="host-error">${esc(hostErrorMsg)}</div>` : ''}
        <div class="host-live-card">
          <span class="host-live-badge">🔴 Already live elsewhere</span>
          <p class="host-live-note" style="margin-top:.3rem">
            "${esc(remoteLiveSession.session_name || 'A match')}" (code ${esc(remoteLiveSession.invite_code)}) is still live from another device —
            probably one that lost power or connection before you could stop it there.
          </p>
          <button type="button" class="btn primary" id="hostResumeBtn" style="width:100%;margin-top:.5rem" ${hostBusy ? 'disabled' : ''}>${hostBusy ? 'Working…' : 'Resume it on this device'}</button>
          <button type="button" class="btn ghost" id="hostEndRemoteBtn" style="width:100%;margin-top:.4rem" ${hostBusy ? 'disabled' : ''}>End that live match instead</button>
        </div>
      `;
      return;
    }

    if (lastStoppedHost){
      hostPanelBody.innerHTML = `
        ${hostAccountRowHTML()}
        ${hostErrorMsg ? `<div class="host-error">${esc(hostErrorMsg)}</div>` : ''}
        <div class="host-live-card">
          <span class="host-live-badge host-live-badge--stopped">⏸ Hosting stopped</span>
          <p class="host-live-note" style="margin-top:.3rem">
            You stopped hosting \u201c${esc(lastStoppedHost.session_name || 'your match')}\u201d (code ${esc(lastStoppedHost.invite_code)}). Resume to go live again on that exact same code and link — or start a new session instead.
          </p>
          ${usageRowHTML}
          ${pendingCreditHTML}
          ${siteSettingsCache && siteSettingsCache.maintenanceMode ? `<p class="host-live-note">${esc(siteSettingsCache.maintenanceMessage)}</p>` : ''}
          <button type="button" class="btn primary" id="hostResumeStoppedBtn" style="width:100%;margin-top:.5rem" ${hostBusy ? 'disabled' : ''}>${hostBusy ? 'Working…' : `🔴 Resume on code ${esc(lastStoppedHost.invite_code)}`}</button>
          <button type="button" class="btn ghost" id="hostNewSessionGoLiveBtn" style="width:100%;margin-top:.4rem" ${(hostBusy || atLimit || (siteSettingsCache && siteSettingsCache.maintenanceMode)) ? 'disabled' : ''}>Start a new session & go live</button>
          <button type="button" class="btn ghost sm" id="hostDismissStoppedBtn" style="width:100%;margin-top:.4rem" ${hostBusy ? 'disabled' : ''}>Not now</button>
          ${buyCreditsHTML}
        </div>
      `;
      return;
    }

    hostPanelBody.innerHTML = `
      ${hostAccountRowHTML()}
      ${hostErrorMsg ? `<div class="host-error">${esc(hostErrorMsg)}</div>` : ''}
      ${usageRowHTML}
      ${pendingCreditHTML}
      ${siteSettingsCache && siteSettingsCache.maintenanceMode ? `<p class="host-live-note">${esc(siteSettingsCache.maintenanceMessage)}</p>` : ''}
      <button type="button" class="btn primary" id="hostGoLiveBtn" style="width:100%" ${(hostBusy || atLimit || (siteSettingsCache && siteSettingsCache.maintenanceMode)) ? 'disabled' : ''}>
        ${hostBusy ? 'Going live…' : (atLimit ? 'Daily limit reached' : ((siteSettingsCache && siteSettingsCache.maintenanceMode) ? 'Paused for maintenance' : '🔴 Go live'))}
      </button>
      ${buyCreditsHTML}
      <p class="host-live-note">Going live creates a read-only link anyone can open to see court status and who's next — no account needed on their end.</p>
    `;
    return;
  }

  const url = joinUrlFor(hostSession.invite_code);
  hostPanelBody.innerHTML = `
    ${hostAccountRowHTML()}
    <div class="host-live-card">
      <span class="host-live-badge${hostReconnecting ? ' host-live-badge--reconnecting' : ''}">${hostReconnecting ? '🟡 Reconnecting…' : '🔴 Live now'}</span>
      ${!hostReconnecting ? `<span class="host-synced-ago" id="hostSyncedAgo">${formatSyncedAgo(lastHostStateAt)}</span>` : ''}
      ${hostReconnecting ? `<p class="host-live-note" style="margin-top:.3rem">Lost the connection to the server — retrying automatically. Viewers may see a slightly stale score until this reconnects; no need to stop and restart.</p>` : ''}
      <div class="host-invite-code" id="hostInviteCodeText">${esc(hostSession.invite_code)}</div>
      ${state.session.club ? `<p class="host-live-note" style="margin-top:.2rem">Club: <b>${esc(state.session.club)}</b> \u2014 shown on the link preview banner.</p>` : ''}
      <div class="host-qr-box" id="hostQrBox"></div>
      <div class="host-live-actions">
        <button type="button" class="btn ghost sm" id="hostShareBtn">Share</button>
        <button type="button" class="btn ghost sm" id="hostCopyLinkBtn">Copy link</button>
        <button type="button" class="btn ghost sm" id="hostCopyCodeBtn">Copy code</button>
      </div>
      <button type="button" class="btn danger" id="hostStopBtn" style="width:100%;margin-top:.7rem" ${hostBusy ? 'disabled' : ''}>Stop hosting</button>
      <div class="host-cohost-card">
        <div class="host-cohost-header">
          <span>\u{1F91D} Co-host access</span>
          ${hostCohostCode ? '<span class="cohost-on-badge">On</span>' : ''}
        </div>
        <p class="host-live-note" style="margin-top:.3rem">
          ${hostCohostCode
            ? 'Anyone with this link can start games and keep score \u2014 use the toggles below to allow or block swap and substitution. They can\u2019t touch settings or the roster either way.'
            : 'Give a trusted helper their own link to run the courts \u2014 no account needed on their end, and they can\u2019t change settings or the roster.'}
        </p>
        ${hostCohostCode ? `
          <div class="host-cohost-link" id="cohostLinkText">${esc(cohostShareUrlFor(hostSession.invite_code, hostCohostCode))}</div>
          ${state.session.cohostPin ? `
            <div class="host-cohost-pin">PIN <strong id="cohostPinText">${esc(state.session.cohostPin)}</strong></div>
            <p class="host-live-note" style="margin-top:.2rem">Share this PIN separately from the link (in person or a text) \u2014 whoever opens the link needs it too before they're let in.</p>
          ` : ''}
          <div class="host-live-actions">
            <button type="button" class="btn ghost sm" id="cohostCopyLinkBtn" ${hostCohostBusy ? 'disabled' : ''}>Copy link</button>
            <button type="button" class="btn ghost sm" id="cohostRegenBtn" ${hostCohostBusy ? 'disabled' : ''}>${hostCohostBusy ? 'Working\u2026' : 'Regenerate'}</button>
          </div>
          <div class="host-cohost-permissions">
            <label class="host-cohost-perm-row">
              <input type="checkbox" id="cohostAllowSwapToggle" ${getCohostPermissions().allowSwap ? 'checked' : ''}>
              <span>Allow Swap</span>
            </label>
            <label class="host-cohost-perm-row">
              <input type="checkbox" id="cohostAllowSubToggle" ${getCohostPermissions().allowSubstitution ? 'checked' : ''}>
              <span>Allow Substitution</span>
            </label>
          </div>
          <button type="button" class="btn danger sm" id="cohostDisableBtn" style="width:100%;margin-top:.5rem" ${hostCohostBusy ? 'disabled' : ''}>Turn off co-host access</button>
        ` : `
          <button type="button" class="btn ghost sm" id="cohostEnableBtn" style="width:100%" ${hostCohostBusy ? 'disabled' : ''}>${hostCohostBusy ? 'Working\u2026' : 'Enable co-host access'}</button>
        `}
      </div>
    </div>
  `;
  const qrBox = $('#hostQrBox');
  if (qrBox && window.QRCode){
    qrBox.innerHTML = '';
    try{ new QRCode(qrBox, { text: url, width: 160, height: 160, colorDark: '#0E2748', colorLight: '#ffffff' }); }
    catch(e){ qrBox.textContent = 'QR unavailable — use the code or link above.'; }
  } else if (qrBox){
    qrBox.textContent = 'QR unavailable — use the code or link above.';
  }
}

/* Renders the "Buy credits" flow: collapsed to a single toggle button
   normally, auto-expanded to the package picker once the daily allowance
   is actually exhausted (see the atLimit comment above), then swaps to
   the GCash instructions + receipt upload once a package is picked. */
function buyCreditsSectionHTML(){
  if (!authSession) return '';
  const used = hostUsageToday;
  const limit = effectiveHostLimit();
  const limitReached = typeof used === 'number' && used >= limit && hostCreditBalance() <= 0;
  if (!limitReached && !hostBuyOpen) return '';

  if (!hostBuyOpen){
    return `<button type="button" class="btn ghost host-buy-credits-toggle" id="hostBuyCreditsToggleBtn" style="width:100%;margin-bottom:.8rem"><span>Buy credits</span><span class="host-buy-credits-toggle-arrow">\u2192</span></button>`;
  }

  if (!hostSelectedPackage){
    return `
      <div class="host-live-note" style="margin-top:0;margin-bottom:.4rem">Pick a credit package \u2014 these don\u2019t reset daily, and are only spent once your free daily matches run out.</div>
      <div class="host-credit-pkgs">
        ${CREDIT_PACKAGES.map((p, i) => `
          <button type="button" class="host-credit-pkg-btn${p.isBest ? ' is-best' : ''}" data-package-index="${i}">
            ${p.isBest ? '<span class="host-credit-pkg-badge">Best value</span>' : ''}
            <span class="host-credit-pkg-credits">${p.credits}<small>credits</small></span>
            <span class="host-credit-pkg-price">${p.priceLabel}</span>
            <span class="host-credit-pkg-rate">${p.rateLabel}</span>
          </button>
        `).join('')}
      </div>
      <button type="button" class="btn ghost sm" id="hostBuyCreditsCancelBtn" style="width:100%">Cancel</button>
    `;
  }

  const pkg = hostSelectedPackage;
  return `
    <div class="host-credit-gcash">Send <b>${pkg.priceLabel}</b> via GCash to <b>${GCASH_NUMBER}</b>, then attach a screenshot of the receipt below \u2014 an admin will review it and add your credits.</div>
    <div class="field">
      <label for="hostReceiptInput">Receipt screenshot</label>
      <input type="file" id="hostReceiptInput" accept="image/*" ${hostCreditBusy ? 'disabled' : ''}>
      ${hostReceiptFile ? `<div class="host-receipt-filename">${esc(hostReceiptFile.name)}</div>` : ''}
    </div>
    <button type="button" class="btn primary" id="hostSubmitReceiptBtn" style="width:100%;margin-top:.5rem" ${(hostCreditBusy || !hostReceiptFile) ? 'disabled' : ''}>${hostCreditBusy ? '<span class="btn-spinner" aria-hidden="true"></span>Submitting…' : `Submit \u2014 ${pkg.credits} credits for ${pkg.priceLabel}`}</button>
    <button type="button" class="btn ghost sm" id="hostBuyCreditsBackBtn" style="width:100%;margin-top:.4rem" ${hostCreditBusy ? 'disabled' : ''}>Back</button>
  `;
}
function resetBuyCreditsFlow(){
  hostBuyOpen = false; hostSelectedPackage = null; hostReceiptFile = null; hostCreditBusy = false;
}

/* ---- "Call Out Player" modal (host) ----
   Lets the host call any specific player by name at any time — not tied to
   a court being ready — e.g. paging someone back from a break. Reuses the
   same issuePlayerCall()/reportCallStatus() pipeline as the per-court
   "Call Players" button above. */
const callOutOverlay = $('#callOutOverlay');
const callOutSearch = $('#callOutSearch');
const callOutList = $('#callOutList');
const callOutEmpty = $('#callOutEmpty');
const callOutCourtSelect = $('#callOutCourtSelect');
const callOutCourtTrigger = $('#callOutCourtTrigger');
const callOutCourtTriggerLabel = $('#callOutCourtTriggerLabel');
const callOutCourtPanel = $('#callOutCourtPanel');
const callOutStatusList = $('#callOutStatusList');
let callOutRefreshTimer = null;
let callOutCourtPanelOpen = false;
let callOutCourtOptionsKey = null; // last-rendered court list, so background refreshes
                                    // only touch the DOM (and the open panel) when it
                                    // actually changed instead of every 2s regardless —
                                    // that constant rebuild was what made the dropdown
                                    // flicker/blink while a host had it open.

function courtOptionsList(){
  return [{ value: '', label: 'No specific court' }]
    .concat((state.courts || []).map(c => ({ value: c.name, label: c.name })));
}

function closeCallOutCourtPanel(){
  callOutCourtPanelOpen = false;
  if (callOutCourtPanel) callOutCourtPanel.hidden = true;
  if (callOutCourtTrigger) callOutCourtTrigger.setAttribute('aria-expanded', 'false');
}

function renderCallOutCourtOptions(force){
  if (!callOutCourtSelect) return;
  const opts = courtOptionsList();
  const key = opts.map(o => o.value).join('\u0001');
  // Skip the rebuild entirely if the court list hasn't changed and the panel
  // is currently open — nothing to update, and touching the open panel's
  // markup is exactly what caused the flicker.
  if (!force && key === callOutCourtOptionsKey && callOutCourtPanelOpen) return;
  callOutCourtOptionsKey = key;

  const current = callOutCourtSelect.value;
  callOutCourtSelect.innerHTML = opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  if (opts.some(o => o.value === current)) callOutCourtSelect.value = current;

  if (callOutCourtPanel){
    callOutCourtPanel.innerHTML = opts.map(o => `
      <div class="custom-select-option${o.value === callOutCourtSelect.value ? ' selected' : ''}" role="option" tabindex="-1" data-value="${esc(o.value)}" aria-selected="${o.value === callOutCourtSelect.value}">${esc(o.label)}</div>
    `).join('');
  }
  if (callOutCourtTriggerLabel){
    const match = opts.find(o => o.value === callOutCourtSelect.value);
    callOutCourtTriggerLabel.textContent = match ? match.label : 'No specific court';
  }
}

function openCallOutCourtPanel(){
  callOutCourtPanelOpen = true;
  renderCallOutCourtOptions(true);
  if (callOutCourtPanel) callOutCourtPanel.hidden = false;
  if (callOutCourtTrigger) callOutCourtTrigger.setAttribute('aria-expanded', 'true');
}
function chooseCallOutCourtOption(optEl){
  callOutCourtSelect.value = optEl.dataset.value;
  closeCallOutCourtPanel();
  renderCallOutCourtOptions(true);
  if (callOutCourtTrigger) callOutCourtTrigger.focus();
}
if (callOutCourtTrigger){
  callOutCourtTrigger.addEventListener('click', () => {
    if (callOutCourtPanelOpen) closeCallOutCourtPanel(); else openCallOutCourtPanel();
  });
}
if (callOutCourtPanel){
  callOutCourtPanel.addEventListener('click', (e) => {
    const opt = e.target.closest('.custom-select-option');
    if (!opt) return;
    chooseCallOutCourtOption(opt);
  });
}
document.addEventListener('click', (e) => {
  if (!callOutCourtPanelOpen) return;
  if (e.target.closest('#callOutCourtCustom')) return;
  closeCallOutCourtPanel();
});
if (callOutCourtTrigger && callOutCourtPanel){
  wireCustomSelectKeyboardNav(callOutCourtTrigger, callOutCourtPanel, {
    isOpen: () => callOutCourtPanelOpen, open: openCallOutCourtPanel,
    close: closeCallOutCourtPanel, choose: chooseCallOutCourtOption
  });
}

function renderCallOutList(){
  if (!callOutList) return;
  const q = (callOutSearch && callOutSearch.value || '').trim().toLowerCase();
  const all = collectAllPlayerNames();
  const filtered = q ? all.filter(n => n.toLowerCase().includes(q)) : all;
  if (callOutEmpty) callOutEmpty.hidden = filtered.length > 0;
  callOutList.innerHTML = filtered.map(name => `
    <div class="player-select-row" data-name="${esc(name)}" style="cursor:default">
      <span class="avatar" style="background:${avatarColor(name)}">${initials(name)}</span>
      <span class="ps-name">${esc(name)}</span>
      <button type="button" class="ps-call-btn" data-call-name="${esc(name)}"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg>Call</button>
    </div>
  `).join('');
}

function openCallOutOverlay(){
  if (!callOutOverlay) return;
  if (viewerMode) return; // spectators never get the host-only "call a player" action
  if (isCoHostRestricted()) return; // paging/staff-call stays host-only too
  if (callOutSearch) callOutSearch.value = '';
  if (callOutStatusList) callOutStatusList.innerHTML = '';
  const disabledNote = $('#callOutDisabledNote');
  if (disabledNote) disabledNote.hidden = state.session.notifyCallsEnabled !== false;
  closeCallOutCourtPanel();
  callOutCourtOptionsKey = null;
  renderCallOutCourtOptions(true);
  renderCallOutList();
  callOutOverlay.hidden = false;
  // The stack/roster/courts can keep changing while this modal sits open
  // (players checking in, courts starting), so keep the picker fresh — but
  // renderCallOutCourtOptions() itself now no-ops while the dropdown is open
  // and its options haven't changed, so this no longer flickers it shut.
  if (callOutRefreshTimer) clearInterval(callOutRefreshTimer);
  callOutRefreshTimer = setInterval(() => { renderCallOutCourtOptions(); renderCallOutList(); }, 2000);
}
function closeCallOutOverlay(){
  if (!callOutOverlay) return;
  callOutOverlay.hidden = true;
  closeCallOutCourtPanel();
  if (callOutRefreshTimer){ clearInterval(callOutRefreshTimer); callOutRefreshTimer = null; }
}

function renderCallOutStatusInline(results){
  if (!callOutStatusList) return;
  callOutStatusList.innerHTML = results.map(callStatusLineHtml).join('');
}

if (callOutSearch) callOutSearch.addEventListener('input', renderCallOutList);
if (callOutOverlay){
  callOutOverlay.addEventListener('click', async (e) => {
    if (e.target === callOutOverlay){ closeCallOutOverlay(); return; }
    if (e.target.closest('#callOutDoneBtn')){ closeCallOutOverlay(); return; }
    const callBtn = e.target.closest('button[data-call-name]');
    if (callBtn){
      if (state.session.notifyCallsEnabled === false){
        toast('Turn on "Notify players by phone" in Settings first');
        return;
      }
      const name = callBtn.dataset.callName;
      const courtName = callOutCourtSelect ? callOutCourtSelect.value : '';
      callBtn.disabled = true;
      const calls = issuePlayerCall([name], { courtName: courtName || null });
      const results = await reportCallStatus(calls);
      renderCallOutStatusInline(results);
      callBtn.disabled = false;
    }
  });
}

function openHostOverlay(){
  if (isCoHostRestricted()) return; // account/billing/stop-hosting panel is host-only
  hostErrorMsg = '';
  if (!hostSession) remoteLiveChecked = false; // re-check each time the panel opens, in case
                                                // the other device came back and stopped it, etc.
  hostPendingCreditRequest = undefined; // re-fetch too, in case an admin reviewed it since the overlay was last open
  renderHostPanel();
  hostOverlay.hidden = false;
  if (hostSession){
    checkHostStillLive(); // catch an idle/cron auto-stop that happened while this
                           // device wasn't looking, and re-render if so
    refreshHostCohostCode().then(renderHostPanel);
  }
}

function goWatchCode(){
  const input = $('#watchCodeInput');
  const errEl = $('#watchCodeError');
  const code = (input && input.value || '').trim().toUpperCase();
  if (errEl) errEl.hidden = true;
  if (!code){
    if (errEl){ errEl.textContent = 'Enter the code the host gave you.'; errEl.hidden = false; }
    if (input) input.focus();
    return;
  }
  if (navigator.onLine === false){
    // Navigating offline would just land on a blank/broken spectator view
    // with no obvious explanation — catch it here instead.
    if (errEl){ errEl.textContent = 'You\u2019re offline \u2014 watching a live session needs an internet connection.'; errEl.hidden = false; }
    return;
  }
  const cooldownMs = watchCooldownRemainingMs();
  if (cooldownMs > 0){
    if (errEl){ errEl.textContent = `Too many attempts \u2014 try again in ${Math.ceil(cooldownMs / 1000)}s.`; errEl.hidden = false; }
    return;
  }
  if (!INVITE_CODE_RE.test(code)){
    if (errEl){ errEl.textContent = 'That doesn\u2019t look like a valid code \u2014 double-check it with the host.'; errEl.hidden = false; }
    if (input) input.focus();
    return;
  }
  location.href = location.pathname + '?join=' + encodeURIComponent(code);
}
const watchCodeBtn = $('#watchCodeBtn');
const watchCodeInput = $('#watchCodeInput');
if (watchCodeBtn) watchCodeBtn.addEventListener('click', goWatchCode);
if (watchCodeInput) watchCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter'){ e.preventDefault(); goWatchCode(); } });

/* ================= QR scan (empty-queue "Scan QR Code") =================
   Opens the device camera and watches for a QR carrying a join code — either
   the bare 6-character code or a full join link like the one drawn in the
   host's own QR box (?join=CODE). Uses the native BarcodeDetector API; on
   browsers that don't support it, falls back to pointing the person at the
   manual code field instead of failing silently. */
const qrScanOverlay = $('#qrScanOverlay');
const qrScanVideo = $('#qrScanVideo');
const qrScanStatus = $('#qrScanStatus');
const qrScanCancelBtn = $('#qrScanCancelBtn');
let qrScanStream = null;
let qrScanRAF = null;
let qrScanDetector = null;
let qrScanActive = false;

function resolveJoinCodeFromText(text){
  if (!text) return null;
  const trimmed = String(text).trim();
  const m = trimmed.match(/[?&]join=([^&#]+)/i);
  let candidate = m ? decodeURIComponent(m[1]) : trimmed;
  candidate = candidate.trim().toUpperCase();
  return INVITE_CODE_RE.test(candidate) ? candidate : null;
}

function closeQrScan(){
  qrScanActive = false;
  if (qrScanRAF) cancelAnimationFrame(qrScanRAF);
  qrScanRAF = null;
  if (qrScanStream){ qrScanStream.getTracks().forEach(t => t.stop()); qrScanStream = null; }
  if (qrScanVideo) qrScanVideo.srcObject = null;
  if (qrScanOverlay) qrScanOverlay.hidden = true;
}

async function qrScanTick(){
  if (!qrScanActive) return;
  try{
    if (qrScanVideo.readyState >= 2){
      const codes = await qrScanDetector.detect(qrScanVideo);
      if (codes && codes.length){
        const code = resolveJoinCodeFromText(codes[0].rawValue);
        if (code){
          qrScanStatus.textContent = 'Found it \u2014 joining\u2026';
          closeQrScan();
          location.href = location.pathname + '?join=' + encodeURIComponent(code);
          return;
        }
      }
    }
  }catch(e){}
  qrScanRAF = requestAnimationFrame(qrScanTick);
}

async function openQrScan(){
  if (!qrScanOverlay) return;
  if (!('BarcodeDetector' in window)){
    toast('QR scanning isn\u2019t supported on this browser \u2014 enter the code instead', 'error');
    return;
  }
  if (navigator.onLine === false){
    toast('You\u2019re offline \u2014 watching a live session needs an internet connection.', 'error', {detailed:true});
    return;
  }
  if (qrScanStatus) qrScanStatus.textContent = 'Starting camera\u2026';
  qrScanOverlay.hidden = false;
  qrScanActive = true;
  try{
    qrScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    qrScanVideo.srcObject = qrScanStream;
    await qrScanVideo.play().catch(() => {});
    qrScanDetector = new BarcodeDetector({ formats: ['qr_code'] });
    if (qrScanStatus) qrScanStatus.textContent = 'Point your camera at the QR code';
    qrScanTick();
  }catch(e){
    if (qrScanStatus) qrScanStatus.textContent = '';
    toast('Couldn\u2019t access the camera \u2014 check permissions and try again', 'error');
    closeQrScan();
  }
}

if (qrScanCancelBtn) qrScanCancelBtn.addEventListener('click', closeQrScan);
if (qrScanOverlay) qrScanOverlay.addEventListener('click', (e) => { if (e.target === qrScanOverlay) closeQrScan(); });
if (stackList) stackList.addEventListener('click', (e) => { if (e.target.closest('#stackEmptyScanBtn')) openQrScan(); });

async function copyText(text){
  try{ await navigator.clipboard.writeText(text); toast('Copied'); }
  catch(e){ toast('Could not copy — select and copy manually'); }
}

/* ---- Share text: whenever a live/spectator link is copied or shared,
   fold in the optional session description set in the "Go live" prompt
   (see openSessionNamePrompt) so whoever receives the link sees it, same
   as the native share sheet's "text" field below. `state` here is
   whichever session this device currently has loaded — the host's own,
   or a spectator's polled snapshot — both carry session.description. ---- */
function shareLinkText(url){
  const description = state.session && state.session.description;
  return description ? `${description}\n${url}` : url;
}
async function shareInvite(code){
  const url = shareUrlFor(code);
  const session = state.session || {};
  const title = session.club ? `${session.name || 'PaddleStack'} \u2014 ${session.club}` : (session.name || 'PaddleStack \u2014 Live match');
  const text = session.description || (session.club ? `Hosted by ${session.club} \u2014 watch live on PaddleStack` : 'Watch this live PaddleStack session');
  if (navigator.share){
    try{ await navigator.share({ title, text, url }); }
    catch(e){ /* user dismissed the native share sheet — nothing to do */ }
  } else {
    copyText(`${text}\n${url}`);
  }
}

$('#hostOnlineBtn').addEventListener('click', openHostOverlay);
$('#callOutTopBtn').addEventListener('click', openCallOutOverlay);
$('#hostDone').addEventListener('click', () => { hostOverlay.hidden = true; });
liveHostPill.addEventListener('click', openHostOverlay);

hostOverlay.addEventListener('click', (e) => {
  if (e.target.closest('#signupConfirmDismissBtn')){ pendingSignupConfirmation = null; hostPanelMode = 'login'; renderHostPanel(); return; }
  const tabBtn = e.target.closest('button[data-tab]');
  if (tabBtn){ hostPanelMode = tabBtn.dataset.tab; hostErrorMsg = ''; renderHostPanel(); return; }
  if (e.target.closest('#hostSignOutBtn')){ signOutEverywhere(); return; }
  if (e.target.closest('#hostManageAccountBtn')){ openAccountDashboard(); return; }
  if (e.target.closest('#hostGoLiveBtn')){
    (async () => {
      const result = await openSessionNamePrompt(state.session.name || '', state.session.club || '', state.session.description || '');
      if (result === null) return; // cancelled
      state.session.name = result.name;
      state.session.club = result.club;
      state.session.description = result.description;
      persist();
      startHosting();
    })();
    return;
  }
  if (e.target.closest('#hostResumeStoppedBtn')){ resumeHostingSameLink(); return; }
  if (e.target.closest('#hostNewSessionGoLiveBtn')){
    (async () => {
      if (!(await showConfirm('This clears the stack, courts, blocks, and rankings — but keeps your list of player names so you can re-add them quickly. This cannot be undone.', {title: 'Start a new session?', confirmLabel: 'Start new session', danger: true}))) return;
      const result = await openSessionNamePrompt('', '', '');
      if (result === null) return; // cancelled
      startFreshSessionKeepingRoster();
      state.session.name = result.name;
      state.session.club = result.club;
      state.session.description = result.description;
      persist();
      lastStoppedHost = null;
      startHosting();
    })();
    return;
  }
  if (e.target.closest('#hostDismissStoppedBtn')){ lastStoppedHost = null; renderHostPanel(); return; }
  if (e.target.closest('#hostStopBtn')){
    (async () => {
      if (!(await showConfirm('Stop hosting this live match? The link and code will stop working for anyone watching.', {title: 'Stop hosting?', confirmLabel: 'Stop hosting'}))) return;
      stopHosting();
    })();
    return;
  }
  if (e.target.closest('#hostResumeBtn')){ resumeRemoteSession(); return; }
  if (e.target.closest('#hostEndRemoteBtn')){ endRemoteSession(); return; }
  if (e.target.closest('#hostShareBtn')){ shareInvite(hostSession.invite_code); return; }
  if (e.target.closest('#hostCopyLinkBtn')){ copyText(shareLinkText(shareUrlFor(hostSession.invite_code))); return; }
  if (e.target.closest('#hostCopyCodeBtn')){ copyText(hostSession.invite_code); return; }
  if (e.target.closest('#cohostEnableBtn')){ enableCohostAccess(); return; }
  if (e.target.closest('#cohostCopyLinkBtn')){ if (hostCohostCode) copyText(cohostShareUrlFor(hostSession.invite_code, hostCohostCode)); return; }
  if (e.target.closest('#cohostRegenBtn')){ enableCohostAccess(); return; } // re-running enable_cohost issues a fresh code, invalidating the old link
  if (e.target.closest('#cohostDisableBtn')){
    (async () => {
      if (!(await showConfirm('The current co-host link will stop working right away. You can turn access back on any time.', {title: 'Turn off co-host access?', confirmLabel: 'Turn off', danger: true}))) return;
      disableCohostAccess();
    })();
    return;
  }
  {
    const swapToggle = e.target.closest('#cohostAllowSwapToggle');
    if (swapToggle){ setCohostPermission('allowSwap', swapToggle.checked, 'swap'); return; }
    const subToggle = e.target.closest('#cohostAllowSubToggle');
    if (subToggle){ setCohostPermission('allowSubstitution', subToggle.checked, 'substitution'); return; }
  }
  // "Call a player" now lives in the topbar (see callOutTopBtn below) since
  // it's a general paging action, not something tied to the live-hosting
  // flow — it used to sit inside this panel wedged between the QR/share
  // controls and the "Stop hosting" button, which read as part of the
  // hosting setup steps when it isn't.

  if (e.target.closest('#hostBuyCreditsToggleBtn')){ hostBuyOpen = true; renderHostPanel(); return; }
  if (e.target.closest('#hostBuyCreditsCancelBtn')){ resetBuyCreditsFlow(); renderHostPanel(); return; }
  if (e.target.closest('#hostBuyCreditsBackBtn')){ hostSelectedPackage = null; hostReceiptFile = null; renderHostPanel(); return; }
  const pkgBtn = e.target.closest('button[data-package-index]');
  if (pkgBtn){ hostSelectedPackage = CREDIT_PACKAGES[parseInt(pkgBtn.dataset.packageIndex, 10)] || null; renderHostPanel(); return; }
  if (e.target.closest('#hostSubmitReceiptBtn')){
    (async () => {
      if (!hostReceiptFile || !hostSelectedPackage || hostCreditBusy) return;
      hostCreditBusy = true; renderHostPanel();
      try{
        await submitCreditPurchase(hostSelectedPackage, hostReceiptFile);
        resetBuyCreditsFlow();
        hostPendingCreditRequest = undefined; // re-fetch so the "pending review" banner shows up
        toast('Receipt submitted \u2014 an admin will review it shortly');
      }catch(err){
        toast(err.message || 'Could not submit receipt', 'error');
        hostCreditBusy = false;
      }finally{
        renderHostPanel();
      }
    })();
    return;
  }
});
hostOverlay.addEventListener('change', (e) => {
  if (e.target.id === 'hostReceiptInput'){
    const file = (e.target.files && e.target.files[0]) || null;
    // Client-side sanity checks before we bother uploading anything —
    // faster, friendlier feedback than waiting on a round-trip to Supabase
    // Storage only to have it reject the file. The server/RLS layer is
    // still the real gate; this is just a UX nicety, same spirit as the
    // watch-code throttle above.
    if (file){
      const MAX_RECEIPT_BYTES = 8 * 1024 * 1024; // 8MB — comfortably covers a phone photo/screenshot
      if (!/^image\//.test(file.type)){
        toast('Please attach an image (screenshot or photo) of the receipt', 'warning');
        e.target.value = '';
        hostReceiptFile = null;
        renderHostPanel();
        return;
      }
      if (file.size > MAX_RECEIPT_BYTES){
        toast('That image is too large (max 8MB) — try a screenshot instead of a full-res photo', 'warning');
        e.target.value = '';
        hostReceiptFile = null;
        renderHostPanel();
        return;
      }
    }
    hostReceiptFile = file;
    renderHostPanel();
  }
});

hostOverlay.addEventListener('submit', async (e) => {
  const form = e.target.closest('#hostAuthForm');
  if (!form) return;
  e.preventDefault();
  const email = $('#hostEmailInput').value.trim();
  const password = $('#hostPasswordInput').value;
  if (hostPanelMode === 'signup'){
    const confirmInput = $('#hostPasswordConfirmInput');
    if (confirmInput && confirmInput.value !== password){
      hostErrorMsg = 'Passwords don\u2019t match';
      renderHostPanel();
      return;
    }
  }
  const captchaToken = (window.hcaptcha && hcaptchaWidgetId !== null) ? window.hcaptcha.getResponse(hcaptchaWidgetId) : '';
  if (!captchaToken){
    hostErrorMsg = 'Please complete the captcha';
    renderHostPanel();
    return;
  }
  hostBusy = true; hostErrorMsg = ''; renderHostPanel();
  try{
    if (hostPanelMode === 'signup'){
      const r = await signUpEmail(email, password, captchaToken);
      if (r.needsConfirmation){
        hostBusy = false;
        hostErrorMsg = '';
        pendingSignupConfirmation = { email, sent: !!r.confirmationSent };
        hostPanelMode = 'login';
        renderHostPanel();
        return;
      }
    } else {
      await signInEmail(email, password, captchaToken);
      const claim = await claimDeviceSession(authSession.access_token);
      if (!claim.claimed){
        const otherLabel = claim.active_device_label || 'another device';
        const proceed = await showConfirm(
          `This account was already logged in on ${otherLabel}. Do you want to log out that device and continue here?`,
          { title: 'Already logged in elsewhere', confirmLabel: 'Log out other device', cancelLabel: 'Cancel' }
        );
        if (!proceed){
          // Undo the session we just created on this device — the person
          // chose to leave the other device signed in instead.
          await signOutEverywhere();
          return;
        }
        await forceClaimDeviceSession(authSession.access_token);
        toast('Logged out the other device');
      }
    }
    pendingSignupConfirmation = null;
    hostUsageToday = null; hostAccountInfo = null; siteSettingsCache = null; hostPendingCreditRequest = undefined; resetBuyCreditsFlow();
    toast('Signed in');
  }catch(err){
    hostErrorMsg = normalizeAuthError(err, hostPanelMode);
  }finally{
    hostBusy = false;
    resetHcaptcha();
    renderHostPanel();
  }
});

/* ---- Viewer snapshot cache ----
   A spectator device keeps its own last-known-good copy of whatever the
   host state looked like the last time a poll actually succeeded, entirely
   separate from the host's local IndexedDB/queue state (which a spectator
   must never read/use — see requirement in the viewer-refresh fix). This
   is what lets a page refresh repaint the courts instantly instead of
   sitting on a blank "Connecting…" screen while the first request is
   still in flight. Keyed by invite code so multiple matches watched on the
   same device over time don't clobber each other. */
const VIEWER_SNAPSHOT_KEY = 'paddleStackViewerSnapshots';
const VIEWER_POLL_INTERVAL_MS = 2000;  // unchanged from before — normal live cadence
const VIEWER_POLL_TIMEOUT_MS = 8000;   // a single poll request must not hang indefinitely
function loadViewerSnapshotsAll(){
  try{
    const raw = localStorage.getItem(VIEWER_SNAPSHOT_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return (all && typeof all === 'object') ? all : {};
  }catch(e){ console.error('[Viewer] snapshot read error', e); return {}; }
}
function loadViewerSnapshotFor(code){
  const all = loadViewerSnapshotsAll();
  return (all && all[code]) || null;
}
function saveViewerSnapshotFor(code, snap){
  try{
    const all = loadViewerSnapshotsAll();
    all[code] = snap;
    localStorage.setItem(VIEWER_SNAPSHOT_KEY, JSON.stringify(all));
  }catch(e){ console.error('[Viewer] snapshot write error', e); }
}

/* ---- Viewer (spectator) mode: ?join=CODE in the URL ----
   Reuses the normal renderCourts()/renderUpNext() renderers against a
   read-only snapshot of the host's state, polled every few seconds —
   simpler and more robust than a live socket for a "what's the score /
   who's next" view, at the cost of a few seconds of lag. */
function enterViewerMode(code){
  console.log('[Viewer] code', code);

  // Belt-and-suspenders guard: a normal browser refresh already gets a
  // brand-new script context (so viewerPollTimer/viewerMode etc. can't
  // possibly carry over), but if anything in the boot sequence ever ends
  // up calling this twice in one page load, don't let it stand up a
  // second banner/poll loop on top of the first one.
  if (viewerModeInitialized){
    console.warn('[Viewer] enterViewerMode() called again in the same session — ignoring duplicate init');
    return;
  }
  viewerModeInitialized = true;

  viewerMode = true;
  document.body.classList.add('viewer-mode');
  const banner = $('#viewerBanner');
  const msgEl = $('#viewerBannerMsg');
  if (banner) banner.hidden = false;
  function setMsg(text){ if (msgEl) msgEl.textContent = text; }
  viewerSetMsgFn = setMsg; // let the global 'offline' listener update this banner instantly

  // ---- Session-ended status ----
  // Flips the top banner's pulsing red "Live" badge to a neutral static
  // "Ended" one, and shows a persistent card above the courts grid so the
  // status is still visible even after someone closes the recap popup.
  // Unlike the recap (opened once, dismissible), this stays up for as long
  // as the person keeps this tab open.
  const vbLiveBadge = $('#vbLiveBadge');
  const vbLiveBadgeText = $('#vbLiveBadgeText');
  const endedCard = $('#viewerEndedCard');
  const endedRecapBtn = $('#viewerEndedRecapBtn');
  let sessionHasEnded = false; // distinct from state.session.status — this tracks the
                                // *hosted_sessions row's* status ('live' vs anything else),
                                // which is what actually governs this dashboard
  function showEndedStatus(){
    sessionHasEnded = true;
    if (vbLiveBadge) vbLiveBadge.classList.add('ended');
    if (vbLiveBadgeText) vbLiveBadgeText.textContent = 'Ended';
    if (endedCard) endedCard.hidden = false;
    updateWaitingStatus();
  }
  if (endedRecapBtn){
    endedRecapBtn.addEventListener('click', () => {
      const recap = buildSessionRecap();
      if (recap) openSessionRecap(recap, 'Close');
      else toast('No matches were played this session');
    });
  }

  // ---- "Waiting for host to generate a match" status ----
  // The link can go live the instant the host taps "Go live", well before
  // they've run the Generate Match wizard — courts exist by default
  // (state.courts always seeds a couple), but computeOpenCourtQueue()
  // deliberately returns nothing useful until generationReady flips true,
  // so a spectator arriving early would otherwise just see empty-looking
  // court cards with no explanation. This card fills that gap. Only
  // updated after a render actually reflects real synced data (not the
  // default freshState() placeholder), so it can't flash on for the brief
  // instant before the first snapshot/poll lands.
  const waitingCard = $('#viewerWaitingCard');
  function updateWaitingStatus(){
    if (!waitingCard) return;
    waitingCard.hidden = sessionHasEnded || !!state.session.generationReady;
  }

  /* ---- Connection error / connecting card ----
     Sits above the Courts grid. Only shown when there's nothing useful to
     look at yet (no cached snapshot and no live data) — normal "just
     reconnecting in the background" states stay out of the way and only
     update the small banner message instead. */
  const connCard = $('#viewerConnCard');
  const connCardTitle = $('#viewerConnCardTitle');
  const connCardSub = $('#viewerConnCardSub');
  const connRetryBtn = $('#viewerConnRetryBtn');
  function showConnCard(title, sub, showRetry){
    if (!connCard) return;
    connCard.hidden = false;
    if (connCardTitle) connCardTitle.textContent = title;
    if (connCardSub) connCardSub.textContent = sub || '';
    if (connRetryBtn) connRetryBtn.hidden = !showRetry;
  }
  function hideConnCard(){
    if (connCard) connCard.hidden = true;
  }

  // ---- 1) Validate the join code first, before touching the network ----
  if (!code || !INVITE_CODE_RE.test(code)){
    console.error('[Viewer] invalid code format', code);
    setMsg('Invalid or expired code');
    showConnCard('Invalid or expired match link', 'Double\u2011check the link you were given, or ask the host to resend it.', false);
    return; // no cached snapshot to fall back to, no polling to start
  }

  setMsg('Connecting to live match\u2026');

  // ---- 2) Paint whatever we last saw for this code, instantly ----
  // NEVER the host's own local IndexedDB/queue state (that's a completely
  // separate thing this device may or may not also have) — only ever a
  // previously-saved *viewer* snapshot for this exact invite code.
  //
  // IMPORTANT: this render is wrapped in its own try/catch. If a stale or
  // oddly-shaped cached snapshot ever makes renderAll() throw, that must
  // NOT be allowed to abort the rest of enterViewerMode() — without this
  // guard, an uncaught exception here would silently skip every line
  // after it, including the poll() call at the very bottom, leaving the
  // banner permanently stuck on "Connecting to live match…" with no
  // visible error and no way to recover short of clearing storage. A bad
  // cached snapshot should, at worst, cost you the instant-repaint — it
  // must never be able to prevent the live poll loop from starting.
  let hasRenderableSnapshot = false;
  const cachedSnap = loadViewerSnapshotFor(code);
  if (cachedSnap && cachedSnap.state){
    try{
      console.log('[Viewer] rendering snapshot', cachedSnap.cached_at);
      state = cachedSnap.state;
      hasRenderableSnapshot = true;
      // Title stays the default styled "PaddleStack" brand — same as the
      // host side — instead of being overwritten with the session name
      // and a "· Live" suffix.
      renderAll();
      if (cachedSnap.status && cachedSnap.status !== 'live') showEndedStatus();
      updateWaitingStatus();
    }catch(e){
      console.error('[Viewer] failed to render cached snapshot \u2014 discarding it and continuing to poll', e);
      hasRenderableSnapshot = false;
      showConnCard('Connecting to live match\u2026', 'This usually only takes a second.', false);
    }
  } else {
    showConnCard('Connecting to live match\u2026', 'This usually only takes a second.', false);
  }

  /* ---- Share: let a spectator pass the live link on to someone else.
     Sits next to Rankings/History in the topbar, uses the native share
     sheet where available and falls back to copying the link. ---- */
  const shareBtn = $('#viewerShareBtn');
  if (shareBtn){
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', () => shareInvite(code));
  }

  /* ---- Notifications: player calls only ----
     Spectators used to also get pinged for "match started", "substitution",
     "game ended", and "next up changed" — but with everyone on the floor
     watching the same live match, that turned into a constant stream of
     buzzing for events that don't concern most of them. The only
     notification a spectator device ever receives now is a direct
     "it's your turn" call, and only if they've registered as that specific
     player (see the Visiting Spectator View identity flow below). There's
     no separate opt-in bell anymore — picking your name IS the opt-in. */
  const notifySound = new Audio('./notify.wav');
  notifySound.volume = 0.6;
  notifySound.preload = 'auto';
  // swRegistration itself is set up once, at module scope, near the top of
  // this file — see "Service worker registration" below — so it's ready
  // (or filling in asynchronously) regardless of whether this device is
  // hosting/playing locally or viewing as a spectator. Bug fix: this used
  // to be registered ONLY inside enterViewerMode(), which meant a normal
  // host/player — the primary user of the app — never got the offline app
  // shell or the "Install app" button at all; only someone who opened a
  // ?join= spectator link did.

  // Low-level "actually show it" step used by player-call notifications.
  function fireNotification(title, body, opts){
    opts = opts || {};
    // The "Notify" quick-action in the viewer dashboard is the single
    // on/off switch for this device's call notifications now — chime and
    // system banner together, not just the sound. See notifyPlayerCall()
    // below for the actual "it's your turn" gate; this one-off confirmation
    // call from choosePlayer() still plays the chime here since it fires
    // at the exact moment permission was just granted.
    if (isViewerNotifyEnabled()){
      try{ notifySound.currentTime = 0; notifySound.play().catch(() => {}); }catch(e){}
    }
    const nOpts = {
      body,
      tag: opts.tag || ('renzku-viewer-' + title + '-' + Date.now()),
      icon: './icon-192.png',
      badge: './badge-96.png',
      requireInteraction: !!opts.requireInteraction,
      vibrate: opts.vibrate || undefined
    };
    try{
      if (swRegistration && swRegistration.showNotification){
        swRegistration.showNotification(title, nOpts);
      } else {
        new Notification(title, nOpts);
      }
    }catch(e){ console.error('Notification error:', e); }
  }

  /* ---- Visiting Spectator View: player identity ("Who's watching?") ----
     A device watching this live match is either a Guest (no player-specific
     notifications, ever) or a registered Player (picked their own name from
     the roster). The choice is remembered per match code on this device
     until they explicitly change it via "Change Player" — see
     VIEWER_IDENTITY_KEY below. */
  const VIEWER_IDENTITY_KEY = 'renzkuViewerIdentities'; // { [code]: {role, playerName} }
  function loadViewerIdentity(){
    try{
      const all = JSON.parse(localStorage.getItem(VIEWER_IDENTITY_KEY) || '{}');
      return (all && typeof all === 'object' && all[code]) || null;
    }catch(e){ return null; }
  }
  function saveViewerIdentity(identity){
    try{
      const all = JSON.parse(localStorage.getItem(VIEWER_IDENTITY_KEY) || '{}');
      all[code] = identity;
      localStorage.setItem(VIEWER_IDENTITY_KEY, JSON.stringify(all));
    }catch(e){}
  }
  let viewerIdentity = loadViewerIdentity();     // {role:'guest'|'player', playerName:string|null} | null
  let identityActiveSince = Date.now();          // only calls issued after this count — no backlog spam
                                                  // on (re)connect, see the call-matching block in poll()
  const seenCallIds = new Set();

  const whosWatchingOverlay = $('#whosWatchingOverlay');
  const whosWatchingGuestBtn = $('#whosWatchingGuestBtn');
  const whosWatchingPlayerBtn = $('#whosWatchingPlayerBtn');
  const playerSelectOverlay = $('#playerSelectOverlay');
  const playerSelectSearch = $('#playerSelectSearch');
  const playerSelectList = $('#playerSelectList');
  const playerSelectEmpty = $('#playerSelectEmpty');
  const playerSelectGuestBtn = $('#playerSelectGuestBtn');
  const playerSelectBackBtn = $('#playerSelectBackBtn');
  const viewerIdentityBadge = $('#viewerIdentityBadge');
  const viewerChangePlayerBtn = $('#viewerChangePlayerBtn');
  let playerSelectRefreshTimer = null;

  async function ensureNotifyPermission(){
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try{ return (await Notification.requestPermission()) === 'granted'; }
    catch(e){ return false; }
  }

  function updateViewerIdentityUI(){
    if (!viewerIdentityBadge || !viewerChangePlayerBtn) return;
    if (!viewerIdentity){ viewerIdentityBadge.hidden = true; viewerChangePlayerBtn.hidden = true; return; }
    viewerIdentityBadge.hidden = false;
    viewerChangePlayerBtn.hidden = false;
    viewerIdentityBadge.innerHTML = (viewerIdentity.role === 'player')
      ? `<svg viewBox="0 0 24 24"><use href="#i-user"/></svg><b>${esc(viewerIdentity.playerName)}</b><svg class="vb-id-chevron" viewBox="0 0 24 24"><use href="#i-chev"/></svg>`
      : `<svg viewBox="0 0 24 24"><use href="#i-user"/></svg>Guest<svg class="vb-id-chevron" viewBox="0 0 24 24"><use href="#i-chev"/></svg>`;
  }

  function openWhosWatching(){
    if (whosWatchingOverlay) whosWatchingOverlay.hidden = false;
  }
  function closeWhosWatching(){
    if (whosWatchingOverlay) whosWatchingOverlay.hidden = true;
  }

  function renderPlayerSelectList(){
    if (!playerSelectList) return;
    const q = (playerSelectSearch && playerSelectSearch.value || '').trim().toLowerCase();
    const all = collectAllPlayerNames();
    const filtered = q ? all.filter(n => n.toLowerCase().includes(q)) : all;
    if (playerSelectEmpty) playerSelectEmpty.hidden = filtered.length > 0;
    playerSelectList.innerHTML = filtered.map(name => {
      const isCurrent = viewerIdentity && viewerIdentity.role === 'player' && namesMatch(viewerIdentity.playerName, name);
      return `
        <button type="button" class="player-pick-row" data-name="${esc(name)}">
          ${avatarHtml(name)}
          <span class="pp-name">${esc(name)}</span>
          ${isCurrent ? '<span class="pp-current">You</span>' : ''}
          <svg class="pp-chevron" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
        </button>
      `;
    }).join('');
  }

  function openPlayerSelect(){
    closeWhosWatching();
    if (playerSelectSearch) playerSelectSearch.value = '';
    renderPlayerSelectList();
    if (playerSelectOverlay) playerSelectOverlay.hidden = false;
    // The roster/stack/courts keep changing while this sits open, and the
    // very first poll may not have landed yet the instant someone taps
    // "Player" — keep the list live instead of freezing an empty snapshot.
    if (playerSelectRefreshTimer) clearInterval(playerSelectRefreshTimer);
    playerSelectRefreshTimer = setInterval(renderPlayerSelectList, 1000);
  }
  function closePlayerSelect(){
    if (playerSelectOverlay) playerSelectOverlay.hidden = true;
    if (playerSelectRefreshTimer){ clearInterval(playerSelectRefreshTimer); playerSelectRefreshTimer = null; }
  }

  async function chooseGuest(){
    viewerIdentity = { role: 'guest', playerName: null };
    identityActiveSince = Date.now();
    saveViewerIdentity(viewerIdentity);
    updateViewerIdentityUI();
    stopPresenceHeartbeat();
    closeWhosWatching();
    closePlayerSelect();
  }

  async function choosePlayer(name){
    viewerIdentity = { role: 'player', playerName: name };
    identityActiveSince = Date.now();
    saveViewerIdentity(viewerIdentity);
    updateViewerIdentityUI();
    closeWhosWatching();
    closePlayerSelect();
    // Registering as a player is the clear, in-context moment to ask for
    // notification permission — right when it becomes meaningful, not
    // before. This is the only notification opt-in on the spectator side —
    // there's no separate generic bell to also flip on.
    const granted = await ensureNotifyPermission();
    if (granted){
      fireNotification(`You're set as ${name}`, "We'll notify this phone when it's your turn.");
    } else if (isIOSBrowserTab()){
      // The permission prompt never had a chance to appear on iOS outside
      // an installed PWA — point them at the one path that unlocks it,
      // instead of leaving it looking like nothing happened.
      showIOSAddHomeHint();
    }
    // Reflect the (now possibly just-granted) permission in the "Notify"
    // quick-action button immediately, so the person doesn't have to also
    // find and tap that toggle separately right after this.
    applyViewerNotifyUI(isViewerNotifyEnabled());
    startPresenceHeartbeat();
  }

  if (whosWatchingGuestBtn) whosWatchingGuestBtn.addEventListener('click', chooseGuest);
  if (whosWatchingPlayerBtn) whosWatchingPlayerBtn.addEventListener('click', openPlayerSelect);
  if (playerSelectSearch) playerSelectSearch.addEventListener('input', renderPlayerSelectList);
  if (playerSelectGuestBtn) playerSelectGuestBtn.addEventListener('click', chooseGuest);
  if (playerSelectBackBtn) playerSelectBackBtn.addEventListener('click', () => { closePlayerSelect(); if (!viewerIdentity) openWhosWatching(); });
  if (playerSelectList){
    playerSelectList.addEventListener('click', async (e) => {
      const row = e.target.closest('button[data-name]');
      if (!row) return;
      const name = row.dataset.name;
      // Confirm before locking this phone in as a specific player — picking
      // the wrong name means someone else's court calls end up buzzing a
      // stranger's pocket (and this phone never gets its own).
      const ok = await showConfirm(
        `Make sure it's really you before we start sending court call-ups to this phone.`,
        { title: `Are you sure you're ${name}?`, confirmLabel: "Yes, that's me", cancelLabel: 'Pick again' }
      );
      if (!ok) return;
      choosePlayer(name);
    });
  }
  if (viewerChangePlayerBtn) viewerChangePlayerBtn.addEventListener('click', openWhosWatching);
  // The name pill itself is also tappable (matches the reference dashboard's
  // dropdown-style "Chloe ▾" row) — same destination as the gear button.
  if (viewerIdentityBadge) viewerIdentityBadge.addEventListener('click', openWhosWatching);
  if (whosWatchingOverlay) whosWatchingOverlay.addEventListener('click', (e) => { if (e.target === whosWatchingOverlay && viewerIdentity) closeWhosWatching(); });
  if (playerSelectOverlay) playerSelectOverlay.addEventListener('click', (e) => { if (e.target === playerSelectOverlay && viewerIdentity) closePlayerSelect(); });

  /* ---- Presence heartbeat ----
     Lets the host see this device as "connected" for the player it's
     registered as (so Call Players / Call Out Player can report real
     status instead of guessing). Best-effort: silently does nothing if
     the optional session_viewers table/RPCs aren't installed on the
     Supabase project — see supabase-viewer-presence.sql.
     Declared here, ABOVE the viewerIdentity check below, because that
     check calls startPresenceHeartbeat() synchronously for a returning
     player (someone who already picked their name on a previous visit —
     e.g. reloading after registering as "Karl"). A `let` variable is in
     the temporal dead zone until its own declaration line runs; calling
     a function that touches presenceHeartbeatTimer before that line was
     an uncaught ReferenceError that aborted the rest of enterViewerMode()
     — including the poll()/scheduleNextPoll() calls at the very bottom —
     which is what left the banner stuck on "Connecting to live match…"
     forever on reload while a first-ever visit (no saved identity yet)
     never hit this path at all. */
  let presenceHeartbeatTimer = null;
  async function sendPresenceHeartbeat(){
    if (!SUPABASE_CONFIGURED || !viewerIdentity) return;
    try{
      await sbFetch('/rest/v1/rpc/upsert_viewer_presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_code: code,
          p_device_id: getDeviceId(),
          p_role: viewerIdentity.role,
          p_player_name: viewerIdentity.role === 'player' ? viewerIdentity.playerName : null
        })
      });
    }catch(e){ /* best-effort only — a failed heartbeat just means the host sees "not connected" */ }
  }
  function startPresenceHeartbeat(){
    stopPresenceHeartbeat();
    sendPresenceHeartbeat();
    presenceHeartbeatTimer = setInterval(sendPresenceHeartbeat, 20000);
  }
  function stopPresenceHeartbeat(){
    if (presenceHeartbeatTimer){ clearInterval(presenceHeartbeatTimer); presenceHeartbeatTimer = null; }
  }

  updateViewerIdentityUI();
  if (!viewerIdentity){
    openWhosWatching();
  } else if (viewerIdentity.role === 'player'){
    startPresenceHeartbeat();
  }

  // Fires the actual "it's your turn" phone notification for a matched
  // player call. This is the only notification a spectator device ever
  // receives — picking a player name is itself the opt-in for it, and the
  // "Notify" quick-action toggle is the on/off switch on top of that.
  function notifyPlayerCall(call){
    // The in-app dialog is the guaranteed channel — always show it,
    // regardless of OS Notification permission. Sound/vibrate/native
    // banner on top of that are a bonus when permission happens to be
    // granted, not a requirement for the player to find out.
    showPlayerCalledDialog(call);
    if (!isViewerNotifyEnabled()) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    fireNotification(call.title, call.body, { tag: 'renzku-call-' + call.id, requireInteraction: true, vibrate: [200, 100, 200] });
  }

  let lastStatus = null;      // previous session status, to catch the live -> ended transition
  let firstPoll = true;       // belt-and-suspenders: never notify on the poll that just
                               // establishes the baseline snapshot, no matter what it contains.
  let invalidPolls = 0;       // consecutive "code not found" results — stop repolling a dead code
  let pollInFlight = false;   // true while a request is actually in the air — the next tick skips
                               // itself entirely rather than stacking a second request on top
  let pollStartedAt = 0;      // when the current in-flight request began, so a wedged request can
                               // be detected and recovered from (see VIEWER_POLL_STUCK_MS below)
  let consecutiveFailures = 0; // resets to 0 on any successful poll; drives the "still trying to
                               // reconnect" manual-retry affordance even while showing cached data
  let currentPollDelay = VIEWER_POLL_INTERVAL_MS;

  // The AbortController timeout below is what's *supposed* to guarantee a
  // stuck request settles within VIEWER_POLL_TIMEOUT_MS — but some mobile
  // carriers/proxies are known to silently swallow an abort signal on an
  // in-flight request, leaving the fetch promise neither resolved nor
  // rejected. If that ever happens, pollInFlight would stay true forever
  // and every future tick would just silently skip itself — the whole
  // loop wedges shut with no visible error. This is the backstop: if a
  // request has been "in flight" for way longer than its own timeout
  // could ever legitimately explain, force it back to a clean slate and
  // let a fresh attempt through instead of trusting the abort alone.
  const VIEWER_POLL_STUCK_MS = VIEWER_POLL_TIMEOUT_MS * 3;

  // After this many consecutive failures — even while there's cached
  // content on screen keeping things looking fine — surface a small
  // manual "Retry now" affordance instead of relying purely on silent
  // automatic retries, so a person is never stuck with no way to act.
  const VIEWER_STUCK_RETRY_THRESHOLD = 3;

  // Restarts the interval at a given cadence, always clearing whatever was
  // running first — this is the single choke point every "how often do we
  // poll" decision goes through, so reconnects/backoff/reset can never end
  // up with two intervals ticking at once.
  function scheduleNextPoll(delayMs){
    if (viewerPollTimer){ clearInterval(viewerPollTimer); viewerPollTimer = null; }
    currentPollDelay = delayMs;
    viewerPollTimer = setInterval(poll, currentPollDelay);
  }

  // Shared by every failure path (bad HTTP status, timeout, network error):
  // fall back to whatever's cached, or show the full error card if there's
  // truly nothing to show. Once failures stack up even with cache present,
  // surface a manual retry option too instead of only ever saying
  // "reconnecting…" with no way for the person to act.
  function handleFailure(friendlyMsg){
    consecutiveFailures++;
    const haveSomethingCached = hasRenderableSnapshot || !!loadViewerSnapshotFor(code);
    if (haveSomethingCached){
      hasRenderableSnapshot = true;
      setMsg('Showing the last saved view \u2014 reconnecting\u2026');
      if (consecutiveFailures >= VIEWER_STUCK_RETRY_THRESHOLD){
        showConnCard('Still trying to reconnect\u2026', 'The view above may be a little stale. Tap retry to try again right now.', true);
      } else {
        hideConnCard();
      }
    } else {
      setMsg(friendlyMsg);
      showConnCard('Unable to connect to this live match.', 'We\u2019ll keep trying automatically.', true);
    }
  }

  async function poll(){
    if (!SUPABASE_CONFIGURED){
      setMsg('This app isn\u2019t configured for live viewing yet.');
      showConnCard('Live viewing isn\u2019t set up yet.', 'Ask the app owner to finish the Supabase setup.', false);
      return;
    }
    if (pollInFlight){
      if (Date.now() - pollStartedAt > VIEWER_POLL_STUCK_MS){
        console.warn('[Viewer] previous poll appears wedged \u2014 forcing recovery');
        pollInFlight = false; // fall through and let this tick start a fresh attempt
      } else {
        console.log('[Viewer] poll skipped \u2014 previous request still in flight');
        return; // one request must finish before another starts
      }
    }
    pollInFlight = true;
    pollStartedAt = Date.now();
    console.log('[Viewer] poll started');

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), VIEWER_POLL_TIMEOUT_MS);

    try{
      const res = await sbFetch('/rest/v1/rpc/get_hosted_session_by_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_code: code }),
        signal: controller.signal
      });
      console.log('[Viewer] HTTP status', res.status);

      if (!res.ok){
        const data = await res.json().catch(() => null);
        console.log('[Viewer] response', data);
        console.error('[Viewer] get_hosted_session_by_code failed:', res.status, data);
        const apiMsg = (data && (data.message || data.hint || data.error_description)) || null;
        let friendly;
        if (res.status === 401 || res.status === 403){
          friendly = 'Server authorization problem \u2014 this link may no longer be valid.';
        } else if (res.status === 404){
          friendly = 'The live-viewing endpoint isn\u2019t available right now.';
        } else if (res.status === 409){
          friendly = 'The server hit a conflict updating this match \u2014 retrying.';
        } else if (res.status === 429){
          friendly = 'Too many requests \u2014 slowing down and retrying.';
          scheduleNextPoll(Math.min(currentPollDelay * 2, 30000)); // slower retry, per rate limit
        } else if (res.status >= 500){
          friendly = 'The live-match server is having trouble \u2014 retrying automatically.';
        } else {
          friendly = apiMsg || ('Connection error: HTTP ' + res.status);
        }
        handleFailure(friendly);
        return;
      }

      const data = await res.json().catch(() => null);
      console.log('[Viewer] response', data);
      const row = Array.isArray(data) ? data[0] : null;
      if (!row){
        recordWatchFailure();
        invalidPolls++;
        setMsg('Invalid or expired code');
        showConnCard('Invalid or expired match link', 'Ask the host for a new link, or double\u2011check the code.', false);
        if (invalidPolls >= 2 && viewerPollTimer){
          clearInterval(viewerPollTimer);
          viewerPollTimer = null;
        }
        return;
      }
      invalidPolls = 0;
      consecutiveFailures = 0;
      if (currentPollDelay !== VIEWER_POLL_INTERVAL_MS) scheduleNextPoll(VIEWER_POLL_INTERVAL_MS);

      if (row.status !== 'live'){
        // The final state — full match history and player stats — was
        // already pushed to this row by the host before it flipped out of
        // 'live' (every state change pushes; stopping broadcast only ever
        // patches status/ended_at, not state). Render it once so the
        // recap and the courts view behind it reflect the real finish,
        // not just whatever this device happened to have cached from the
        // last successful poll.
        const justEnded = lastStatus !== row.status;
        lastStatus = row.status;
        firstPoll = false;
        hideConnCard();
        setMsg('Session has ended');
        showEndedStatus();
        if (row.state){
          try{
            state = row.state;
            hasRenderableSnapshot = true;
            renderAll();
            saveViewerSnapshotFor(code, {
              state: row.state,
              session_name: row.session_name || null,
              status: row.status,
              updated_at: row.updated_at,
              cached_at: Date.now()
            });
          }catch(e){ console.error('[Viewer] failed to render final state', e); }
        }
        if (justEnded){
          const recap = buildSessionRecap();
          if (recap) openSessionRecap(recap, 'Close');
        }
        // Nothing further will change once the host has ended the session —
        // stop polling instead of hitting this same branch every interval.
        if (viewerPollTimer){ clearInterval(viewerPollTimer); viewerPollTimer = null; }
        return;
      }

      console.log('[Viewer] poll success');
      state = row.state;
      hasRenderableSnapshot = true;
      hideConnCard();
      // Title stays the default styled "PaddleStack" brand — same as the
      // host side — instead of being overwritten with the session name
      // and a "· Live" suffix.
      setMsg('Updated ' + new Date(row.updated_at).toLocaleTimeString());
      renderAll();
      updateWaitingStatus();
      saveViewerSnapshotFor(code, {
        state: row.state,
        session_name: row.session_name || null,
        status: row.status,
        updated_at: row.updated_at,
        cached_at: Date.now()
      });

      // Player Calling: match any new entries in state.playerCalls against
      // this device's registered player name. Guests never match (their
      // viewerIdentity.role is 'guest', never 'player'). Only calls issued
      // after this device registered as that player are eligible — avoids
      // replaying a backlog of "it's your turn" pings from before this
      // phone was even watching. This is the only notification a
      // spectator device ever receives — no generic match-started /
      // game-ended / next-up pings, so it doesn't turn into a stream of
      // buzzing for events that don't concern most people watching.
      if (Array.isArray(state.playerCalls)){
        state.playerCalls.forEach(call => {
          if (!call || seenCallIds.has(call.id)) return;
          seenCallIds.add(call.id);
          if (firstPoll) return; // baseline snapshot — don't replay history on connect
          if (call.ts < identityActiveSince) return;
          if (!viewerIdentity || viewerIdentity.role !== 'player') return;
          if (!namesMatch(call.name, viewerIdentity.playerName)) return;
          notifyPlayerCall(call);
        });
      }

      lastStatus = row.status;
      firstPoll = false;
    }catch(e){
      // A thrown fetch (as opposed to a non-OK response, handled above) usually
      // means the request never left the device — no internet, DNS failure,
      // an aborted timeout, etc.
      if (e && e.name === 'AbortError'){
        console.warn('[Viewer] timeout');
        handleFailure('Request timed out \u2014 reconnecting\u2026');
      } else {
        console.error('[Viewer] network error', e);
        handleFailure(!navigator.onLine
          ? 'Reconnecting to live\u2026'
          : 'Having trouble connecting: ' + (e.message || e) + ' \u2014 retrying\u2026');
      }
    }finally{
      clearTimeout(timeoutTimer);
      pollInFlight = false;
    }
  }
  if (connRetryBtn){
    connRetryBtn.addEventListener('click', () => {
      console.log('[Viewer] manual retry requested');
      pollInFlight = false; // a person tapping "Retry now" should always get an immediate real
                             // attempt, even if the previous request never technically settled
      setMsg('Connecting to live match\u2026');
      poll();
    });
  }

  poll();
  viewerPollFn = poll; // let the global 'online' listener re-poll immediately instead of
                        // waiting out the rest of the current 2s interval
  scheduleNextPoll(VIEWER_POLL_INTERVAL_MS);
}

/* ---- Network status: shared by the host push loop and the viewer poll loop ----
   The browser fires 'offline'/'online' the moment the OS notices a change,
   which is faster and more reliable than waiting for a scheduled push/poll
   to happen to fail. 'offline' flips the UI to "Reconnecting…" right away;
   'online' immediately retries instead of sitting out the rest of the
   current interval, so things snap back to live within a second or two of
   the network actually coming back. */
window.addEventListener('offline', () => {
  if (hostSession) setHostReconnecting(true);
  if (viewerMode && viewerSetMsgFn) viewerSetMsgFn('Reconnecting to live\u2026');
});
window.addEventListener('online', () => {
  if (hostSession){
    if (hostPushPending) pushStateNow();
    else checkHostStillLive();
    if (hostPollFn) hostPollFn();
  }
  if (cohostSession){
    if (hostPushPending) pushStateNow();
    if (cohostPollFn) cohostPollFn();
  }
  if (authSession) checkDeviceStillActive();
  if (viewerMode && viewerPollFn) viewerPollFn();
});

/* ---- Back/forward cache (bfcache) recovery ----
   Mobile Chrome's "pull to refresh" gesture doesn't always trigger a real
   navigation/reload — if the tab was frozen and can be restored cheaply,
   the browser sometimes just unfreezes the exact DOM/JS state it had at
   freeze time instead of re-running the page's scripts. For a page whose
   whole job is "keep polling and repainting", that's fatal: the polling
   loop that was running before the freeze may have been paused/throttled
   indefinitely, and nothing here would ever have a chance to notice or
   recover — the person is just looking at a stale screenshot of whatever
   was on screen the moment it got frozen (which explains a spectator
   staying stuck on "Connecting to live match…" no matter how long they
   wait, or how many times they pull-to-refresh, if that gesture kept
   landing on a restore instead of a reload).
   The fix used to be: force location.reload() whenever 'pageshow' reports
   event.persisted === true. That backfired on some mobile Chrome builds —
   calling location.reload() synchronously from inside a pageshow handler,
   while the tab is still mid-unfreeze, can itself get folded back into the
   same bfcache restore instead of causing a real network navigation. The
   result is a silent loop: restore -> reload attempt -> restore -> reload
   attempt -> ... with the page never actually changing, which is exactly
   "stuck on Connecting to live match, identical every time I look at it".
   The safer fix: don't reload the page at all. Just resume whichever
   recovery loop is already built for "this tab lost time and needs to
   catch up" — the same one the 'online' and visibilitychange handlers
   below already use — and reset the flags that let it run freely again. */
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  console.log('[Viewer] page restored from bfcache — resuming without a hard reload');
  if (viewerMode){
    if (viewerSetMsgFn) viewerSetMsgFn('Reconnecting to live\u2026');
    if (viewerPollTimer){ clearInterval(viewerPollTimer); viewerPollTimer = null; }
    if (viewerPollFn){
      viewerPollTimer = setInterval(viewerPollFn, VIEWER_POLL_INTERVAL_MS);
      viewerPollFn(); // don't wait out a fresh interval — catch up right now
    }
  }
  if (hostSession){
    if (hostPushPending) pushStateNow();
    else checkHostStillLive();
    if (hostPollTimer){ clearInterval(hostPollTimer); hostPollTimer = null; }
    if (hostPollFn){
      hostPollTimer = setInterval(hostPollFn, HOST_POLL_INTERVAL_MS);
      hostPollFn(); // catch up right now instead of waiting out a fresh interval
    }
  }
  if (cohostSession){
    if (cohostPollTimer){ clearInterval(cohostPollTimer); cohostPollTimer = null; }
    if (cohostPollFn){
      cohostPollTimer = setInterval(cohostPollFn, COHOST_POLL_INTERVAL_MS);
      if (hostPushPending) pushStateNow();
      cohostPollFn(); // catch up right now instead of waiting out a fresh interval
    }
  }
  if (authSession) checkDeviceStillActive();
});

/* ---- Foreground recovery ----
   Mobile browsers aggressively throttle/pause timers (setInterval among
   them) for a backgrounded tab to save battery — so a 2s poll loop can
   silently fall many seconds or minutes behind while the phone is asleep
   or another app is in front. The moment the tab becomes visible again,
   poll right away instead of waiting for the next (possibly very late)
   scheduled tick — this is the same "don't sit out a stale interval"
   reasoning as the 'online' handler above, just for a different cause of
   staleness. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (viewerMode && viewerPollFn) viewerPollFn();
  if (cohostSession && cohostPollFn) cohostPollFn();
  if (hostSession && hostPollFn) hostPollFn();
});

/* ================= Render orchestration ================= */
function renderAll(){
  applyLevelsVisibility();
  applySessionLockUI();
  renderBlocks();
  renderStack();
  renderCourts();
  renderCourtsStatsBar();
  renderUpNext();
  renderArrivals();
  renderQuickAdd();
  renderGenerateNav();
}

// Quick-glance totals shown under "Up next" on the Courts tab — players
// currently active anywhere (queue + on courts + winners/losers blocks),
// court count, how many are waiting in the queue right now, and games
// completed this session. All derived from state already tracked elsewhere
// (the header's "N in stack" pill, Rankings, History), just surfaced together.
function renderCourtsStatsBar(){
  const playersNumEl = $('#statPlayersNum');
  if (!playersNumEl) return; // not on this build/screen
  const onCourtCount = state.courts.reduce((n, c) => n + (c.players ? c.players.length : 0), 0);
  const activePlayers = state.stack.length + onCourtCount + state.winnersBlock.length + state.losersBlock.length;
  playersNumEl.textContent = activePlayers;
  $('#statCourtsNum').textContent = state.courts.length;
  // Spectators get "Matches Completed" + "Session Time" in the 3rd/4th
  // slots instead of a host's "On Deck" + "Games Played" — both numbers a
  // host already sees in full elsewhere (the queue, the Up Next panel),
  // but a session-elapsed clock and a running match tally read better for
  // someone just watching. Same two DOM slots, different label/icon/value.
  const stat3Label = $('#statStat3Label');
  const stat4Label = $('#statStat4Label');
  const stat3Icon = $('#statStat3IconUse');
  const stat4Icon = $('#statStat4IconUse');
  if (viewerMode){
    if (stat3Label) stat3Label.textContent = 'Matches';
    if (stat4Label) stat4Label.textContent = 'Session Time';
    if (stat3Icon) stat3Icon.setAttribute('href', '#i-trophy');
    if (stat4Icon) stat4Icon.setAttribute('href', '#i-clock');
    $('#statOnDeckNum').textContent = state.history.length;
    const startedAt = state.session.createdAt || Date.now();
    // "Session Time" (h:mm:ss) runs noticeably wider than a plain number —
    // the base stat font size was sized for 1-2 digit counts and starts
    // overlapping its own label/border once a session passes an hour. The
    // is-clock class dials it back specifically for this slot.
    const gamesNumEl = $('#statGamesNum');
    if (gamesNumEl) gamesNumEl.classList.add('is-clock');
    $('#statGamesNum').textContent = fmtClock(Math.max(0, Date.now() - startedAt));
  } else {
    if (stat3Label) stat3Label.textContent = 'On Deck';
    if (stat4Label) stat4Label.textContent = 'Games Played';
    if (stat3Icon) stat3Icon.setAttribute('href', '#i-clock');
    if (stat4Icon) stat4Icon.setAttribute('href', '#i-bars');
    $('#statOnDeckNum').textContent = state.stack.length;
    $('#statGamesNum').textContent = state.history.length;
    const gamesNumEl = $('#statGamesNum');
    if (gamesNumEl) gamesNumEl.classList.remove('is-clock');
  }
}

/* ================= Boot ================= */
(async function init(){
  const urlParams = new URLSearchParams(location.search);
  const joinCode = urlParams.get('join');
  const cohostCodeParam = urlParams.get('cohost');
  // If this is the host's own share link (they're already signed in and
  // currently broadcasting that exact code), don't drop them into the
  // read-only spectator view — just take them straight to their normal
  // host dashboard instead.
  const localHostSession = joinCode ? loadHostSession() : null;
  const isOwnHostLink = !!(joinCode && localHostSession && localHostSession.invite_code === joinCode);
  if (joinCode && cohostCodeParam && !isOwnHostLink){
    // Don't re-prompt "Co-host this game?" on every refresh — a browser
    // reload hits this exact same URL (query params and all) every time,
    // so without this check the confirm would fire again and again for as
    // long as the person keeps this link open/bookmarked. Only skip it
    // when this device already accepted THIS SAME code before; a genuinely
    // different link (say, after the host regenerated one) still confirms.
    const alreadyAccepted = (() => {
      const saved = loadCohostSession();
      return !!(saved && saved.invite_code === joinCode && saved.cohost_code === cohostCodeParam);
    })();
    if (await enterCoHostMode(joinCode, cohostCodeParam, { skipConfirm: alreadyAccepted })) return; // co-host mode never touches local IndexedDB/localStorage app state — see persist()
    // Invalid/declined/revoked — fall through to the normal local app rather than leaving the tab blank.
  }
  if (joinCode && !isOwnHostLink){
    enterViewerMode(joinCode);
    return; // spectator view never touches local IndexedDB/localStorage app state
  }
  // No join link this time around — but if this device already accepted a
  // co-host invite earlier (and hasn't tapped "Stop co-hosting" since),
  // pick that same session back up automatically, same as a real host's
  // browser resuming hostSession below.
  const savedCohost = loadCohostSession();
  if (savedCohost && savedCohost.invite_code && savedCohost.cohost_code){
    if (await enterCoHostMode(savedCohost.invite_code, savedCohost.cohost_code, { skipConfirm: true })) return;
    // Access was revoked while this device was closed — fall through to the normal local app.
  }

  idb = await openDB();
  const saved = await loadPersisted();
  if (saved && saved.session && Array.isArray(saved.courts) && Array.isArray(saved.stack)){
    state = saved;
    if (!Array.isArray(state.history)) state.history = [];
    if (!Array.isArray(state.winnersBlock)) state.winnersBlock = [];
    if (!Array.isArray(state.losersBlock)) state.losersBlock = [];
    if (!Array.isArray(state.arrivals)) state.arrivals = [];
    if (!state.playerStats || typeof state.playerStats !== 'object') state.playerStats = {};
    if (!state.teammateHistory || typeof state.teammateHistory !== 'object') state.teammateHistory = {};
    if (!state.opponentHistory || typeof state.opponentHistory !== 'object') state.opponentHistory = {};
    if (!state.upNextSubMap || typeof state.upNextSubMap !== 'object') state.upNextSubMap = {};
    if (!Array.isArray(state.roster)){
      // Backfill roster for older saves from every name we can find, so no one is lost.
      const names = new Set();
      state.stack.forEach(p => names.add(p.name));
      state.winnersBlock.forEach(p => names.add(p.name));
      state.losersBlock.forEach(p => names.add(p.name));
      state.courts.forEach(c => (c.players || []).forEach(n => names.add(n)));
      Object.keys(state.playerStats).forEach(n => names.add(n));
      state.roster = [...names];
    }
    state.courts.forEach(c => { if (!('lastResult' in c)) c.lastResult = null; if (!('swapInfo' in c)) c.swapInfo = null; if (!('requeueOrder' in c)) c.requeueOrder = null; });
    state.stack.forEach(p => { if (!p.tag) p.tag = 'new'; });
    if (!state.session.status) state.session.status = 'active';
    if (typeof state.session.targetGamesEnabled !== 'boolean') state.session.targetGamesEnabled = false;
    if (!state.session.targetGamesPerPlayer || state.session.targetGamesPerPlayer < 1) state.session.targetGamesPerPlayer = 7;
    if (typeof state.session.avoidRepeatTeammates !== 'boolean') state.session.avoidRepeatTeammates = false;
    if (!Array.isArray(state.session.fixedDuos)) state.session.fixedDuos = [];
    if (typeof state.session.scoringEnabled !== 'boolean') state.session.scoringEnabled = false;
    if (!state.session.winningScore || state.session.winningScore < 1) state.session.winningScore = 11;
    if (typeof state.session.autoStartEnabled !== 'boolean') state.session.autoStartEnabled = false;
    if (!Number.isFinite(state.session.autoStartMinutes) || state.session.autoStartMinutes < 1) state.session.autoStartMinutes = 1;
    // 'skillSeparated' was removed as a selectable matching style; a
    // session saved while it still existed migrates to 'winnersLosers',
    // which already behaves identically (see getMatchingStyle/levelsMatch).
    if (state.session.matchingStyle !== 'balanced' && state.session.matchingStyle !== 'winnersLosers') state.session.matchingStyle = 'winnersLosers';
    if (typeof state.session.club !== 'string') state.session.club = '';
    if (typeof state.session.description !== 'string') state.session.description = '';
    normalizeCohostPermissions(state.session);
    if (typeof state.session.skillLevelsEnabled !== 'boolean') state.session.skillLevelsEnabled = false;
    if (typeof state.session.notifyCallsEnabled !== 'boolean') state.session.notifyCallsEnabled = true;
    if (typeof state.session.autoCallPlayersEnabled !== 'boolean') state.session.autoCallPlayersEnabled = false;
    state.courts.forEach(c => { if (!('score' in c)) c.score = null; });
    if (!state.playerLevels || typeof state.playerLevels !== 'object') state.playerLevels = {};
    state.courts.forEach(c => { if (!c.level || !PLAYER_LEVELS.includes(c.level)) c.level = 'Open'; });
    if (!Array.isArray(state.playerCalls)) state.playerCalls = [];
  }
  renderRosterList();
  renderAll();
  if (window.innerWidth > 880){
    appShell.classList.add('show-stack','show-courts');
  } else {
    // Reopen whichever mobile tab (Players/Courts) was showing before the
    // reload instead of always bouncing back to Players.
    let savedTab = null;
    try{ savedTab = localStorage.getItem(MOBILE_TAB_KEY); }catch(e){}
    setMobileTab(savedTab === 'courts' ? 'courts' : 'stack');
  }

  // Backs the manifest.json "shortcuts" entries (long-press the installed
  // app icon) — e.g. ./index.html?action=add-player jumps straight to the
  // Add Player modal instead of just opening to whatever tab was last open.
  const shortcutAction = urlParams.get('action');
  if (shortcutAction === 'add-player'){
    openAddPlayerModal();
  } else if (shortcutAction === 'check-in'){
    openCheckInModal();
  }
  if (shortcutAction){
    // Drop the param from the address bar so a later reload doesn't
    // reopen the same modal every time.
    const cleanUrl = location.pathname + (joinCode ? `?join=${encodeURIComponent(joinCode)}` : '');
    history.replaceState(null, '', cleanUrl);
  }

  authSession = loadAuthSession();
  hostSession = loadHostSession();
  updateHostIndicator();
  if (hostSession && !authSession) saveHostSession(null); // stale local session with no login to back it
  if (hostSession){
    checkHostStillLive(); // catch an idle/cron auto-stop that happened while this device was closed
    lastHostStateAt = Date.now(); // baseline — anything checkHostStillLive/startHostPoll fetches
                                   // from here on only overwrites local state if it's newer than this
    startHostPoll(); // pick up anything a co-host changed while this device was closed, and keep
                      // picking up co-host edits made while this device stays open (see startHostPoll)
  }
  if (authSession) checkDeviceStillActive(); // catch a takeover by another device that happened while this device was closed
})();

})();

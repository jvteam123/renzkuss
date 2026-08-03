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

async function persist(){
  const ok = await idbSet('state', state);
  if (!ok){
    try{ localStorage.setItem('paddleStackQueueState', JSON.stringify(state)); }catch(e){}
  }
  if (typeof queueHostPush === 'function') queueHostPush();
}

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
  const pl = playerLevel || 'Open', cl = courtLevel || 'Open';
  return pl === cl;
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
    id: 'c'+(i+1), name: 'Court '+(i+1), level: 'Open', status:'open', players: [], startTime: null, lastResult: null, swapInfo: null, score: null
  }));
}

function freshState(){
  return {
    session: { name: 'Renzku Smart Stack', gameSize: 4, soundOn: true, status: 'active', targetGamesEnabled: false, targetGamesPerPlayer: 7, avoidRepeatTeammates: false, fixedDuos: [], scoringEnabled: true, winningScore: 11 }, // status: 'active' | 'ended'
    courts: defaultCourts(4),
    arrivals: [],        // {id, name, addedAt} — added but not yet checked in; not part of the live queue
    stack: [],           // {id, name, joinedAt, tag: 'new'|'queued'}
    winnersBlock: [],     // {id, name, joinedAt, tag} — accumulates until gameSize, then flushes to stack as a group (or sooner, if the group's too small to ever fill both blocks — see checkBlockFlush)
    losersBlock: [],      // same shape — accumulates until gameSize, then flushes to stack as a group (or sooner, if the group's too small to ever fill both blocks — see checkBlockFlush)
    history: [],          // {id, courtName, teamA, teamB, winner, startTime, endTime}
    playerStats: {},      // name -> {wins, games}
    teammateHistory: {},   // "nameA||nameB" (sorted) -> number of times paired as teammates this session
    playerLevels: {},      // name -> skill level ('Open'|'Beginner'|'Advanced Beginner'|'Intermediate'|'Advanced')
    roster: []             // known player names, kept across "new session" resets for quick re-adding
  };
}

let state = freshState();

let uid = 1;
function nextId(prefix){ return prefix + (Date.now().toString(36)) + (uid++); }

/* ================= DOM refs ================= */
const $ = (sel) => document.querySelector(sel);

/* ================= Theme (dark mode) =================
   Preference is stored separately from the queue/app state so it can be
   applied the instant script.js runs, without waiting on IndexedDB. */
const THEME_KEY = 'paddleStackTheme';
function getStoredTheme(){
  try{ return localStorage.getItem(THEME_KEY); }catch(e){ return null; }
}
function preferredTheme(){
  const stored = getStoredTheme();
  if (stored === 'dark' || stored === 'light') return stored;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const iconUse = $('#themeToggleIconUse');
  if (iconUse) iconUse.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  const btn = $('#themeToggleBtn');
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
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

function toast(msg, type){
  const kind = type || inferToastType(msg);
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.innerHTML =
    '<span class="toast-icon">' + (TOAST_ICONS[kind] || TOAST_ICONS.info) + '</span>' +
    '<span class="toast-msg"></span>' +
    '<span class="toast-progress"></span>';
  el.querySelector('.toast-msg').textContent = msg;
  toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2200);
}

/* ================= Confirm dialog (replaces native confirm()) ================= */
const confirmOverlay = $('#confirmOverlay');
const confirmTitleEl = $('#confirmTitle');
const confirmMessageEl = $('#confirmMessage');
const confirmOkBtn = $('#confirmOkBtn');
const confirmCancelBtn = $('#confirmCancelBtn');
let confirmResolve = null;
/* Returns a Promise<boolean> — true if the user confirmed, false if they
   cancelled, dismissed via backdrop click, or pressed Escape. Callers use
   `if (!(await showConfirm('...'))) return;` in place of window.confirm(). */
function showConfirm(message, opts){
  opts = opts || {};
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmTitleEl.textContent = opts.title || 'Please confirm';
    confirmMessageEl.textContent = message;
    confirmOkBtn.textContent = opts.confirmLabel || 'Confirm';
    confirmCancelBtn.textContent = opts.cancelLabel || 'Cancel';
    confirmOkBtn.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    confirmOverlay.hidden = false;
    confirmOkBtn.focus();
  });
}
function closeConfirm(result){
  if (confirmOverlay.hidden) return;
  confirmOverlay.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}
confirmOkBtn.addEventListener('click', () => closeConfirm(true));
confirmCancelBtn.addEventListener('click', () => closeConfirm(false));
confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) closeConfirm(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !confirmOverlay.hidden) closeConfirm(false); });

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
/* Fixed Duos affect not just how a chosen foursome gets split into teams
   (see computeTeamPairing) but which foursome gets chosen in the first
   place: if one half of a fixed duo is about to be called up but their
   partner is still waiting further back in the stack, pull the partner into
   this match too (bumping whoever has the least claim to the spot — a
   non-duo player, picked by lowest queue priority) so the duo actually ends
   up playing together instead of in two separate matches. Only meaningful
   for doubles, and only while "Avoid Repeating Teammates" is on, matching
   where Fixed Duos are surfaced in Settings. */
function applyFixedDuoToSelection(base, pool, gameSize){
  if (gameSize !== 4 || !state.session.avoidRepeatTeammates) return base;
  const duos = state.session.fixedDuos || [];
  if (duos.length === 0) return base;
  const idxOf = new Map();
  pool.forEach((e, i) => idxOf.set(e.id, i));
  const duoNames = new Set(duos.flatMap(d => [d.a, d.b]));
  let result = base.slice();
  duos.forEach(duo => {
    const names = result.map(e => e.name);
    const hasA = names.includes(duo.a), hasB = names.includes(duo.b);
    if (hasA === hasB) return; // both already together, or neither queued for this match — nothing to adjust
    const keepName = hasA ? duo.a : duo.b;
    const missingName = hasA ? duo.b : duo.a;
    const resultIds = new Set(result.map(e => e.id));
    const partnerEntry = pool.find(e => e.name === missingName && !resultIds.has(e.id));
    if (!partnerEntry) return; // partner isn't checked in / isn't in this court's slice of the stack at all
    // Pick who to bump: prefer a player not part of any fixed duo themselves,
    // and among candidates, the one with the least seniority (furthest back
    // in this stack slice) so the swap disturbs FIFO order as little as possible.
    let bumpIdx = -1, bumpScore = -1;
    result.forEach((e, i) => {
      if (e.name === keepName) return; // never bump the duo member we're keeping
      const inAnyDuo = duoNames.has(e.name);
      const stackIdx = idxOf.has(e.id) ? idxOf.get(e.id) : 0;
      const score = (inAnyDuo ? 0 : 1e6) + stackIdx;
      if (score > bumpScore){ bumpScore = score; bumpIdx = i; }
    });
    if (bumpIdx === -1) return; // no one safe to bump — leave the match as-is
    result.splice(bumpIdx, 1, partnerEntry);
  });
  // Restore stack (FIFO) order so display and team-splitting stay consistent.
  result.sort((a, b) => (idxOf.get(a.id) ?? 0) - (idxOf.get(b.id) ?? 0));
  return result;
}
function removeEntriesFromStack(entries){
  const ids = new Set(entries.map(e => e.id));
  state.stack = state.stack.filter(e => !ids.has(e.id));
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
function computeTeamPairing(names){
  if (!state.session.avoidRepeatTeammates || names.length !== 4) return { order: names.slice(), forcedDuo: false };
  const duo = findFixedDuo(names);
  if (duo){
    const others = names.filter(n => n !== duo.a && n !== duo.b);
    return { order: [duo.a, duo.b, others[0], others[1]], forcedDuo: true };
  }
  const [p0, p1, p2, p3] = names;
  const options = [
    { order: [p0,p1,p2,p3], cost: teammateCount(p0,p1) + teammateCount(p2,p3) },
    { order: [p0,p2,p1,p3], cost: teammateCount(p0,p2) + teammateCount(p1,p3) },
    { order: [p0,p3,p1,p2], cost: teammateCount(p0,p3) + teammateCount(p1,p2) }
  ];
  const minCost = Math.min(...options.map(o => o.cost));
  // Deterministic tie-break (first minimal-cost option) rather than Math.random():
  // this function is called once to render the "next up" preview and again when
  // "Call next" is actually clicked, so it must return the same answer both times
  // for the same state — a random pick here would let the preview disagree with
  // the match that's actually formed.
  return { order: options.find(o => o.cost === minCost).order, forcedDuo: false };
}
function orderForTeammatePairing(names){
  return computeTeamPairing(names).order;
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
    naturalCost: teammateCount(natA[0], natA[1]) + teammateCount(natB[0], natB[1]),
    chosenCost: teammateCount(chA[0], chA[1]) + teammateCount(chB[0], chB[1]),
    forcedDuo: !!forcedDuo
  };
}

/* ================= Session lock (End session / Resume) ================= */
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
  updateEndSessionBtn();
}

function updateEndSessionBtn(){
  const btn = $('#endSessionBtn');
  if (!btn) return;
  const iconStyle = 'width:13px;height:13px;vertical-align:-2px;margin-right:.35rem';
  if (isSessionEnded()){
    btn.innerHTML = `<svg viewBox="0 0 24 24" style="${iconStyle}"><use href="#i-play"/></svg>Resume session`;
    btn.classList.remove('warn'); btn.classList.add('solid-turf');
  } else {
    btn.innerHTML = `<svg viewBox="0 0 24 24" style="${iconStyle}"><use href="#i-lock"/></svg>End session (keep all records)`;
    btn.classList.remove('solid-turf'); btn.classList.add('warn');
  }
}

async function endSession(){
  if (!(await showConfirm('No new matches can be started and the stack will be locked, but the stack, courts, history and rankings all stay exactly as they are for review. You can resume anytime.', {title: 'End this session?', confirmLabel: 'End session'}))) return;
  state.session.status = 'ended';
  persist();
  applySessionLockUI();
  renderAll();
  settingsOverlay.hidden = true;
  toast('Session ended — all records kept for review');
}
function resumeSession(){
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
    stackList.innerHTML = '<div class="stack-empty">The stack is empty.<br>Tap "Add Player" to get the queue going.</div>';
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
      row.draggable = false;
      row.dataset.id = entry.id;
      const stats = state.playerStats[entry.name];
      const winChip = (stats && stats.wins > 0) ? `<span class="win-chip">🏆${stats.wins}</span>` : '';
      const games = stats ? (stats.games || 0) : 0;
      const gamesChip = gamesChipHtml(games);
      const tag = entry.tag === 'queued' ? '<span class="tag-pill queued">Queued</span>' : '<span class="tag-pill new">New</span>';
      const levelBadge = `<button type="button" class="level-badge ${levelClass(getPlayerLevel(entry.name))}" data-act="cycle-level" title="Tap to change skill level">${esc(levelLabel(getPlayerLevel(entry.name)))}</button>`;
      row.innerHTML = `
        <span class="drag-handle" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-grip"/></svg></span>
        <span class="pos">${idx+1}</span>
        <svg class="glyph" viewBox="0 0 20 28"><use href="#i-paddle"/></svg>
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
      attachDrag(row);
    });
    stackList.appendChild(groupWrap);
  });
}

/* ================= Accumulating blocks (winners vs winners, losers vs losers) =================
   Each level accumulates and flushes independently — a Beginner winner and
   an Advanced winner never end up bundled into the same "group" even though
   they share one underlying block array (level is looked up per entry via
   getPlayerLevel, same as everywhere else). */
function blockItemsHtml(entries){
  return entries.map((entry, idx) => `
    <div class="block-item" data-id="${entry.id}">
      <span class="block-item-pos">${idx+1}</span>
      <span class="block-item-name">${esc(entry.name)}</span>
    </div>
  `).join('');
}
function blockListHtml(block, gameSize, blockKey){
  if (block.length === 0) return '<div class="block-empty">Empty — waiting for a result.</div>';
  const levels = PLAYER_LEVELS.filter(lvl => block.some(e => getPlayerLevel(e.name) === lvl));
  // A single-level block is fully covered by the block header's own count
  // and "Queue now" button, so skip the per-level sub-header here — showing
  // both would just be two identical controls stacked on top of each other.
  if (levels.length <= 1){
    return blockItemsHtml(block);
  }
  return levels.map(level => {
    const entries = block.filter(e => getPlayerLevel(e.name) === level);
    return `
      <div class="block-level-group">
        <div class="block-level-head">
          <span class="level-badge ${levelClass(level)}">${esc(levelLabel(level))}</span>
          <span class="block-level-count">${entries.length}/${gameSize}</span>
          <button type="button" class="block-level-flush-btn" data-block-flush="${blockKey}" data-level-flush="${esc(level)}" aria-label="Move ${esc(levelLabel(level))} group to queue now">Queue now</button>
        </div>
        ${blockItemsHtml(entries)}
      </div>
    `;
  }).join('');
}

function renderBlocks(){
  const gameSize = state.session.gameSize;
  const hasAny = state.winnersBlock.length > 0 || state.losersBlock.length > 0;
  blocksPanel.hidden = !hasAny;
  if (!hasAny) return;

  winnersBlockCount.textContent = state.winnersBlock.length + ' waiting';
  losersBlockCount.textContent = state.losersBlock.length + ' waiting';
  winnersBlockList.innerHTML = blockListHtml(state.winnersBlock, gameSize, 'winnersBlock');
  losersBlockList.innerHTML = blockListHtml(state.losersBlock, gameSize, 'losersBlock');

  blocksPanel.querySelector('[data-block="winners"]').disabled = state.winnersBlock.length === 0 || isSessionEnded();
  blocksPanel.querySelector('[data-block="losers"]').disabled = state.losersBlock.length === 0 || isSessionEnded();
}

// Moves an entire block into the main queue, in order, as an intact group —
// this is what makes callNext() pull "winners vs winners" or "losers vs losers".
function flushBlockToQueue(blockKey){
  const block = state[blockKey];
  if (block.length === 0) return;
  block.forEach(entry => state.stack.push(entry));
  state[blockKey] = [];
}
// Same idea, but only for one level's slice of the block — leaves every
// other level's entries sitting in the block untouched.
function flushBlockLevelToQueue(blockKey, level){
  const block = state[blockKey];
  const matching = block.filter(e => getPlayerLevel(e.name) === level);
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
    const hasBlocked = countOfLevel(state.winnersBlock, level) > 0 || countOfLevel(state.losersBlock, level) > 0;
    const stackLevelCount = countOfLevel(state.stack, level);
    const totalLevelCount = stackLevelCount + countOfLevel(state.winnersBlock, level) + countOfLevel(state.losersBlock, level);
    if (hasBlocked && stackLevelCount < gameSize && totalLevelCount >= gameSize){
      flushBlockLevelToQueue('winnersBlock', level);
      flushBlockLevelToQueue('losersBlock', level);
    }
  });
}

blocksPanel.addEventListener('click', (e) => {
  if (isSessionEnded()) return;
  const levelBtn = e.target.closest('button[data-level-flush]');
  if (levelBtn){
    flushBlockLevelToQueue(levelBtn.dataset.blockFlush, levelBtn.dataset.levelFlush);
    toast(levelBtn.dataset.levelFlush + ' group moved to queue');
    renderAll(); persist();
    return;
  }
  const btn = e.target.closest('button[data-block]');
  if (!btn || btn.disabled) return;
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
  const row = btn.closest('.paddle');
  const id = row.dataset.id;
  const idx = state.stack.findIndex(p => p.id === id);
  if (idx === -1) return;
  const act = btn.dataset.act;
  if (act === 'cycle-level'){
    cyclePlayerLevel(state.stack[idx].name);
    return;
  }
  if (act === 'remove'){
    const entry = state.stack[idx];
    if (!(await showConfirm('Remove ' + entry.name + ' from the stack?', {title: 'Remove player?', confirmLabel: 'Remove', danger: true}))) return;
    const [removed] = state.stack.splice(idx, 1);
    toast(removed.name + ' removed from stack');
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
  renderAll(); persist();
});

/* ---- Pointer-based drag reorder (works for mouse, touch, pen) ----
   Two bugs fixed here for the final release:
   1. Pointer capture was being requested on `row` while the move/up/cancel
      listeners were registered on `handle` (a descendant). Once captured,
      the browser retargets every subsequent event for that pointer at the
      *capture* element — so those listeners, sitting on a non-ancestor,
      never fired again after pointerdown. The drag looked like it started
      (the "dragging" class flashed on) but then did nothing.
   2. Each swap during the drag called the full renderAll(), which wipes
      and rebuilds the whole stack list from scratch. That destroys the
      very row/handle currently holding the pointer capture, silently
      ending the gesture — so even a corrected capture would only survive
      one hop. Reordering now moves the DOM node directly and defers the
      full re-render (which restores position numbers, "next up" tags,
      etc.) until the pointer is released. */
function attachDrag(row){
  let startY = 0, dragging = false;
  const handle = row.querySelector('.drag-handle');
  handle.addEventListener('pointerdown', (e) => {
    if (isSessionEnded()) return;
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    row.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    row.style.position = 'relative';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    row.style.transform = `translateY(${dy}px)`;
    row.style.zIndex = 10;
    const group = row.parentElement; // stay within this player's skill-level group, same as the up/down buttons
    if (!group) return;
    const siblings = [...group.querySelectorAll('.paddle')];
    const myIdx = siblings.indexOf(row);
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const targetRow = target && target.closest ? target.closest('.paddle') : null;
    if (targetRow && targetRow !== row && targetRow.parentElement === group){
      const targetIdx = siblings.indexOf(targetRow);
      if (targetIdx !== -1 && targetIdx !== myIdx){
        const id = row.dataset.id;
        const fromIdx = state.stack.findIndex(p => p.id === id);
        const toIdx = state.stack.findIndex(p => p.id === targetRow.dataset.id);
        if (fromIdx !== -1 && toIdx !== -1){
          const [moved] = state.stack.splice(fromIdx, 1);
          state.stack.splice(toIdx, 0, moved);
          if (myIdx < targetIdx) group.insertBefore(row, targetRow.nextSibling);
          else group.insertBefore(row, targetRow);
          persist();
          startY = e.clientY;
          row.style.transform = 'translateY(0px)';
        }
      }
    }
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    row.classList.remove('dragging');
    row.style.transform = '';
    row.style.zIndex = '';
    renderAll(); persist();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* ================= Add players ================= */
function registerRoster(name){
  const exists = state.roster.some(r => r.toLowerCase() === name.toLowerCase());
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
  const idx = state.roster.findIndex(r => r.toLowerCase() === name.toLowerCase());
  if (idx === -1) return;
  state.roster.splice(idx, 1);
  const lower = name.toLowerCase();
  if (Array.isArray(state.session.fixedDuos)){
    state.session.fixedDuos = state.session.fixedDuos.filter(d => d.a.toLowerCase() !== lower && d.b.toLowerCase() !== lower);
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
    const lower = name.toLowerCase();
    const waiting = state.arrivals.some(a => a.name.toLowerCase() === lower);
    const statusTag = waiting
      ? '<span class="tag-pill queued" title="Added but not checked in yet">Waiting to check in</span>'
      : (isNameActive(name) ? '<span class="tag-pill floor" title="Currently on the floor">On floor</span>' : '');
    return `
    <div class="roster-manage-row">
      <span class="rm-avatar" style="background:${avatarColor(name)}">${initials(name)}</span>
      <span class="rm-name">${esc(name)}</span>
      ${statusTag}
      <button type="button" class="rm-del" data-name="${esc(name)}" aria-label="Remove ${esc(name)} from saved players"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </div>
  `;
  }).join('');
}
const rosterManageListEl = $('#rosterManageList');
if (rosterManageListEl){
  rosterManageListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-name]');
    if (!btn) return;
    const name = btn.dataset.name;
    if (!(await showConfirm('This just clears the suggestion — it won\'t affect history or rankings.', {title: 'Remove "' + name + '" from saved players?', confirmLabel: 'Remove', danger: true}))) return;
    removeFromRoster(name);
    toast(name + ' removed from saved players');
  });
}
const rosterClearAllBtn = $('#rosterClearAllBtn');
if (rosterClearAllBtn){
  rosterClearAllBtn.addEventListener('click', async () => {
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
  const lower = name.toLowerCase();
  if (state.arrivals.some(p => p.name.toLowerCase() === lower)) return true;
  if (state.stack.some(p => p.name.toLowerCase() === lower)) return true;
  if (state.winnersBlock.some(p => p.name.toLowerCase() === lower)) return true;
  if (state.losersBlock.some(p => p.name.toLowerCase() === lower)) return true;
  if (state.courts.some(c => c.players.some(n => n.toLowerCase() === lower))) return true;
  return false;
}
/* Players land here first (added, but not yet on the floor). They only join the
   live stack once someone checks them in as arrived — see checkInArrival(s) below. */
function addNamesToArrivals(names, level){
  const lvl = PLAYER_LEVELS.includes(level) ? level : 'Open';
  const added = [];
  const skipped = [];
  const rejected = [];
  names.forEach(name => {
    if (isUnsafeName(name)){
      rejected.push(name);
      return;
    }
    if (isNameActive(name)){
      skipped.push(name);
      return;
    }
    state.arrivals.push({ id: nextId('a'), name, addedAt: Date.now() });
    setPlayerLevel(name, lvl);
    registerRoster(name);
    added.push(name);
  });
  if (added.length){
    toast((added.length > 1 ? added.length + ' players' : added[0]) + ' added — check in when they arrive');
  }
  if (skipped.length){
    toast(skipped.join(', ') + (skipped.length > 1 ? ' are' : ' is') + ' already waiting, in the stack, a block, or on a court');
  }
  if (rejected.length){
    toast('"' + rejected.join('", "') + '" is not a valid player name');
  }
  renderRosterList();
  renderAll(); persist();
}
addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (isSessionEnded()){ toast('Session has ended — resume it to add players'); return; }
  const raw = addNameInput.value.trim();
  if (!raw) return;
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  addNameInput.value = '';
  addNamesToArrivals(names, addLevelSelect ? addLevelSelect.value : 'Open');
});

/* ---- Bulk add: one name per line ---- */
$('#bulkAddBtn').addEventListener('click', function(){
  if (isSessionEnded()){ toast('Session has ended — resume it to add players'); return; }
  const textarea = $('#bulkNameInput');
  const names = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) return;
  textarea.value = '';
  // Collapse the details panel after adding
  const wrap = $('#bulkAddWrap');
  if (wrap) wrap.removeAttribute('open');
  addNamesToArrivals(names, addLevelSelect ? addLevelSelect.value : 'Open');
  toast(names.length + ' player' + (names.length > 1 ? 's' : '') + ' added');
});

/* ---- Check-in: moves a waiting arrival into the live stack ---- */
async function checkInArrival(id){
  const idx = state.arrivals.findIndex(a => a.id === id);
  if (idx === -1) return;
  const entry = state.arrivals[idx];
  if (!(await showConfirm('Add ' + entry.name + ' to the live stack now?', {title: 'Check in ' + entry.name + '?', confirmLabel: 'Check in'}))) return;
  state.arrivals.splice(idx, 1);
  state.stack.push({ id: nextId('p'), name: entry.name, joinedAt: Date.now(), tag: 'new' });
  checkBlockFlush();
  toast(entry.name + ' checked in and added to the stack');
  renderAll(); persist();
}
async function checkInAllArrivals(){
  if (state.arrivals.length === 0) return;
  const names = state.arrivals.map(a => a.name);
  const label = names.length > 1 ? names.length + ' players' : names[0];
  if (!(await showConfirm('Add ' + label + ' to the live stack now?', {title: 'Check in ' + label + '?', confirmLabel: 'Check in'}))) return;
  state.arrivals.forEach(entry => {
    state.stack.push({ id: nextId('p'), name: entry.name, joinedAt: Date.now(), tag: 'new' });
  });
  state.arrivals = [];
  checkBlockFlush();
  toast(label + ' checked in and added to the stack');
  renderAll(); persist();
}
async function removeArrival(id){
  const idx = state.arrivals.findIndex(a => a.id === id);
  if (idx === -1) return;
  const name = state.arrivals[idx].name;
  if (!(await showConfirm('Remove ' + name + ' from the waiting-to-check-in list?', {title: 'Remove from arrivals?', confirmLabel: 'Remove', danger: true}))) return;
  state.arrivals.splice(idx, 1);
  toast(name + ' removed');
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
  if (checkInTabBtn) checkInTabBtn.classList.toggle('has-waiting', state.arrivals.length > 0 && !isSessionEnded());
  if (allBtn) allBtn.disabled = state.arrivals.length === 0 || isSessionEnded();
  if (emptyNote) emptyNote.hidden = state.arrivals.length > 0;
  listEl.innerHTML = state.arrivals.map(entry => `
    <div class="arrival-row" data-id="${entry.id}">
      <span class="arrival-name">${esc(entry.name)}</span>
      <button type="button" class="level-badge ${levelClass(getPlayerLevel(entry.name))}" data-act="cycle-level" data-name="${esc(entry.name)}" title="Tap to change skill level">${esc(levelLabel(getPlayerLevel(entry.name)))}</button>
      <button type="button" class="arrival-checkin-btn" data-act="checkin" data-id="${entry.id}">Check in</button>
      <button type="button" class="arrival-remove-btn" data-act="remove" data-id="${entry.id}" aria-label="Remove ${esc(entry.name)}"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </div>
  `).join('');
}
const arrivalsListEl = $('#arrivalsList');
if (arrivalsListEl){
  arrivalsListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (isSessionEnded()){ toast('Session has ended — resume it to check players in'); return; }
    const id = btn.dataset.id;
    if (btn.dataset.act === 'checkin') checkInArrival(id);
    else if (btn.dataset.act === 'remove') removeArrival(id);
    else if (btn.dataset.act === 'cycle-level') cyclePlayerLevel(btn.dataset.name);
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
function playerRowHtml(name, swap){
  const stats = state.playerStats[name];
  const winChip = (stats && stats.wins > 0) ? `<span class="win-chip">🏆${stats.wins}</span>` : '';
  const games = stats ? (stats.games || 0) : 0;
  const gamesChip = gamesChipHtml(games);
  const swapBtn = swap
    ? `<button type="button" class="player-swap-btn${swap.selected ? ' selecting' : ''}" data-act="swap-partner" data-idx="${swap.idx}" aria-label="${swap.selected ? 'Cancel swap' : ('Swap partner with ' + esc(name))}" title="Swap partner"><svg viewBox="0 0 24 24"><use href="#i-swap"/></svg></button>`
    : '';
  return `<span class="player-col">
    <span class="player-row">${avatarHtml(name)}<span class="player-name-txt">${esc(courtCardName(name))}</span>${winChip}${swapBtn}</span>
    <span class="player-games-row">${gamesChip}</span>
  </span>`;
}
function teamColHtml(names, side, gameSize, swapCtx){
  const slots = Math.ceil(gameSize / 2);
  const rows = names.map((n, i) => {
    const swap = swapCtx ? { idx: swapCtx.baseIdx + i, selected: swapCtx.selectedIdx === swapCtx.baseIdx + i } : null;
    return playerRowHtml(n, swap);
  });
  while (rows.length < slots) rows.push(`<span class="empty-slot">—</span>`);
  return `<div class="team team-${side}">${rows.join('')}</div>`;
}

/* Sequentially allocates upcoming stack entries to each *open* court, in
   court order, without mutating the real stack. Used both to render each
   open court's "next up" preview and to decide exactly who gets called when
   a specific court's "Call next" is clicked — keeping the two in sync so a
   court never calls a different group of players than what it just showed. */
function computeOpenCourtQueue(gameSize){
  const queue = new Map(); // courtId -> { taken: entries|null, remaining: number available at this point }
  let previewStack = state.stack.slice();
  state.courts.forEach(court => {
    if (court.status !== 'open') return;
    const courtLevel = court.level || 'Open';
    const candidatePool = previewStack.filter(e => levelsMatch(getPlayerLevel(e.name), courtLevel));
    const remaining = candidatePool.length;
    if (remaining >= gameSize){
      const taken = selectMatchEntries(gameSize, candidatePool);
      const takenIds = new Set(taken.map(e => e.id));
      previewStack = previewStack.filter(e => !takenIds.has(e.id));
      queue.set(court.id, { taken, remaining });
    } else {
      queue.set(court.id, { taken: null, remaining });
    }
  });
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

/* ================= Swap partners (mid-match) =================
   Doubles only: lets someone fix a wrong pairing, or just remix the teams,
   without ending the game or losing the score/timer. Tap one player's swap
   icon, then tap another's to trade their court spots; tapping the same
   one again cancels the pick. */
let swapSelection = null; // { courtId, idx } | null — first player picked, awaiting a second

function swapCourtPartner(court, idx){
  if (!swapSelection || swapSelection.courtId !== court.id){
    swapSelection = { courtId: court.id, idx };
    renderCourts();
    return;
  }
  if (swapSelection.idx === idx){
    swapSelection = null;
    renderCourts();
    return;
  }
  const otherIdx = swapSelection.idx;
  const nameA = court.players[otherIdx], nameB = court.players[idx];
  [court.players[otherIdx], court.players[idx]] = [court.players[idx], court.players[otherIdx]];
  swapSelection = null;
  toast(`Swapped ${nameA} ↔ ${nameB}`);
  renderAll(); persist();
}

function renderCourts(){
  courtsGrid.innerHTML = '';
  if (state.courts.length === 0){
    courtsGrid.innerHTML = '<div class="courts-empty">No courts yet. Add some in Settings.</div>';
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
      if (enough){
        const names = orderForTeammatePairing(taken.map(p => p.name));
        const [a, b] = splitTeams(names);
        matchupHtml = `<div class="matchup">${teamColHtml(a,'a',gameSize)}<div class="vs-divider"></div>${teamColHtml(b,'b',gameSize)}</div>`;
      } else {
        const lvlNote = court.level ? ` ${levelLabel(court.level)}` : '';
        matchupHtml = `<div class="matchup" style="align-items:center;justify-content:center"><span class="empty-slot">Needs ${Math.max(0, gameSize - slot.remaining)} more${lvlNote} in the stack</span></div>`;
      }
      card.innerHTML = `
        <div class="court-top">
          <span class="court-name-wrap">${courtIcon}<input class="court-name" value="${esc(court.name)}" data-act="rename" maxlength="24" aria-label="Court name"></span>
          <span class="level-badge court-level-badge ${levelClass(court.level)}" aria-label="Court skill level">${esc(levelLabel(court.level || 'Open'))}</span>
          <span class="status-badge open">Open</span>
        </div>
        ${lastResultHtml}
        ${matchupHtml}
        <button type="button" class="court-cta call" data-act="call" ${(enough && !ended) ? '' : 'disabled'}>${ended ? '🔒 Session ended' : '▶ Start Game'}</button>
      `;
    } else {
      // Lazily attach a live score object if scoring was turned on mid-match.
      if (state.session.scoringEnabled && !court.score) court.score = freshCourtScore();
      const scoringOn = state.session.scoringEnabled;
      const sc = court.score;
      // Once a winner is reached, the clock freezes at the moment it was won
      // instead of continuing to run while the court still shows "on court".
      const clockEndTime = (scoringOn && sc && sc.wonAt) ? sc.wonAt : Date.now();
      const elapsed = clockEndTime - court.startTime;
      const [a, b] = splitTeams(court.players);
      const scoreboard = scoringOn ? scoreboardHtml(court) : '';
      // When scoring is on, the scoreboard already owns the vertical space,
      // so the timer moves into a compact chip up in the header row instead
      // of its own large centered block.
      const timerChip = scoringOn ? `<span class="timer-chip" data-role="timer">${fmtClock(elapsed)}</span>` : '';
      const timerBlock = scoringOn ? '' : `<div class="timer" data-role="timer">${fmtClock(elapsed)}</div>`;
      // Swap-partner icons only make sense in doubles (there's no "partner"
      // to swap in singles) and only once a court actually has its full
      // roster of players on it.
      const canSwapPartners = gameSize > 2 && court.players.length === gameSize;
      const activeSwap = swapSelection && swapSelection.courtId === court.id ? swapSelection.idx : null;
      const swapCtxA = canSwapPartners ? { baseIdx: 0, selectedIdx: activeSwap } : null;
      const swapCtxB = canSwapPartners ? { baseIdx: a.length, selectedIdx: activeSwap } : null;
      const swapHint = (canSwapPartners && activeSwap !== null)
        ? `<div class="swap-hint">Tap another player to swap with <b>${esc(court.players[activeSwap])}</b></div>` : '';
      card.innerHTML = `
        <div class="court-top">
          <span class="court-name-wrap">${courtIcon}<input class="court-name" value="${esc(court.name)}" data-act="rename" maxlength="24" aria-label="Court name"></span>
          <span class="level-badge court-level-badge ${levelClass(court.level)}" aria-label="Court skill level">${esc(levelLabel(court.level || 'Open'))}</span>
          <span class="court-top-right">
            <span class="status-badge playing">On court</span>
            ${timerChip}
          </span>
        </div>
        <div class="matchup">${teamColHtml(a,'a',gameSize,swapCtxA)}<div class="vs-divider"></div>${teamColHtml(b,'b',gameSize,swapCtxB)}</div>
        ${swapHint}
        ${scoreboard}
        ${timerBlock}
        <button type="button" class="court-cta end" data-act="end">End game</button>
      `;
    }
    courtsGrid.appendChild(card);
  });
}

courtsGrid.addEventListener('click', (e) => {
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
  if (btn.dataset.act === 'end') openEndgame(court);
  if (btn.dataset.act === 'undo-result') undoLastResult(court.id);
  if (btn.dataset.act === 'score-plus') adjustCourtScore(court, btn.dataset.team, 1);
  if (btn.dataset.act === 'score-minus') adjustCourtScore(court, btn.dataset.team, -1);
  if (btn.dataset.act === 'side-out') courtSideOut(court);
  if (btn.dataset.act === 'set-first-server') setInitialServer(court, btn.dataset.team);
  if (btn.dataset.act === 'advance-serve') courtAdvanceServe(court);
  if (btn.dataset.act === 'undo-serve') courtUndoServe(court);
  if (btn.dataset.act === 'swap-partner') swapCourtPartner(court, Number(btn.dataset.idx));
});

courtsGrid.addEventListener('change', (e) => {
  if (viewerMode) return;
  const input = e.target.closest('input[data-act="rename"]');
  if (!input) return;
  const card = input.closest('.court-card');
  const court = state.courts.find(c => c.id === card.dataset.id);
  if (!court) return;
  court.name = input.value.trim() || court.name;
  persist();
  renderUpNext();
});

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
  court.status = 'playing';
  const naturalNames = taken.map(p => p.name);
  const pairing = computeTeamPairing(naturalNames);
  const chosenNames = pairing.order;
  court.players = chosenNames;
  court.swapInfo = state.session.avoidRepeatTeammates ? buildSwapInfo(naturalNames, chosenNames, pairing.forcedDuo) : null;
  court.startTime = Date.now();
  court.score = state.session.scoringEnabled ? freshCourtScore() : null;
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
  catch(e){ toast('Could not undo — snapshot was corrupted'); lastUndo = null; return; }
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
    if (!(await showConfirm('This game won\'t count toward rankings, and players won\'t be sorted into the winners/losers blocks.', {title: 'No winner selected — clear the court anyway?', confirmLabel: 'Clear court', danger: true}))) return;
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

  state.history.unshift({
    id: nextId('h'), courtName: court.name,
    teamA: endgameTeams[0].slice(), teamB: endgameTeams[1].slice(),
    winner: endgameWinnerSide, winnerNames: winnerNames ? winnerNames.slice() : null,
    scoreA: finalScoreA, scoreB: finalScoreB,
    startTime: court.startTime, endTime,
    swapInfo: court.swapInfo || null
  });
  state.history = state.history.slice(0, 100);

  Object.entries(endgameChoices).forEach(([name, choice]) => {
    if (choice === 'requeue'){
      const entry = { id: nextId('p'), name, joinedAt: Date.now(), tag: 'queued' };
      if (winnerNames){
        // A winner was recorded — sort into the winners/losers block so the
        // queue later pairs winners vs winners and losers vs losers.
        if (winnerNames.includes(name)) state.winnersBlock.push(entry);
        else state.losersBlock.push(entry);
      } else {
        // No winner recorded (skipped/tie) — nothing to sort by, go straight to the queue.
        state.stack.push(entry);
      }
    }
  });
  checkBlockFlush();

  court.lastResult = { winnerNames: winnerNames ? winnerNames.slice() : null, scoreLine };
  court.status = 'open';
  court.players = [];
  court.startTime = null;
  court.swapInfo = null;
  court.score = null;
  endgameOverlay.hidden = true;
  toast(court.name + ' cleared');
  renderAll(); persist();
});

/* ================= Up Next (queue preview) =================
   The courts-page panel used to repeat the last few finished games, which
   is already covered in full by the Match History modal. Far more useful
   here: who's queued up behind whatever's already previewed on the open
   court cards above — the players who'll get called next once a court
   frees up. */
function renderUpNext(){
  if (state.courts.length === 0){
    historyList.innerHTML = '<div class="ondeck-empty">Add a court to see who plays next.</div>';
    return;
  }
  const gameSize = state.session.gameSize;
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
    return;
  }

  const rows = [];
  let previewStack = onDeck.slice();
  let groupNum = 1;
  while (previewStack.length >= gameSize && groupNum <= 3){
    const chosen = selectMatchEntries(gameSize, previewStack);
    const chosenIds = new Set(chosen.map(e => e.id));
    previewStack = previewStack.filter(e => !chosenIds.has(e.id));
    const names = orderForTeammatePairing(chosen.map(p => p.name));
    let matchup;
    if (gameSize === 2){
      matchup = `<span class="ondeck-team">${esc(names[0])}</span><span class="ondeck-vs">vs</span><span class="ondeck-team">${esc(names[1])}</span>`;
    } else {
      const [a, b] = splitTeams(names);
      matchup = `<span class="ondeck-team">${a.map(esc).join(' &amp; ')}</span><span class="ondeck-vs">vs</span><span class="ondeck-team">${b.map(esc).join(' &amp; ')}</span>`;
    }
    rows.push(`<div class="ondeck-row"><span class="ondeck-num">On deck ${groupNum}</span><span class="ondeck-matchup">${matchup}</span></div>`);
    groupNum++;
  }
  if (previewStack.length > 0){
    rows.push(`<div class="ondeck-more">+${previewStack.length} more waiting</div>`);
  }
  if (rows.length === 0){
    const need = gameSize - onDeck.length;
    rows.push(`<div class="ondeck-empty">Waiting on ${need} more player${need === 1 ? '' : 's'} for the next match.</div>`);
  }
  historyList.innerHTML = rows.join('');
}

/* ================= Match History modal (full detail + swap log) ================= */
const matchHistoryOverlay = $('#matchHistoryOverlay');
const matchHistoryFullList = $('#matchHistoryFullList');

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
      <span class="match-full-court">${esc(h.courtName)}</span>
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

function renderMatchHistory(){
  matchHistoryFullList.innerHTML = state.history.length === 0
    ? '<div class="history-row" style="justify-content:center">No games finished yet.</div>'
    : state.history.map(matchFullRowHtml).join('');
}

function openMatchHistory(){
  renderMatchHistory();
  matchHistoryOverlay.hidden = false;
}
$('#matchHistoryBtn').addEventListener('click', openMatchHistory);
$('#themeToggleBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
});
$('#matchHistoryDone').addEventListener('click', () => { matchHistoryOverlay.hidden = true; });

/* ================= Live timers ================= */
setInterval(() => {
  document.querySelectorAll('.court-card.playing').forEach(card => {
    const court = state.courts.find(c => c.id === card.dataset.id);
    if (!court || !court.startTime) return;
    if (state.session.scoringEnabled && court.score && court.score.wonAt) return; // frozen at the win
    const el = card.querySelector('[data-role="timer"]');
    if (el) el.textContent = fmtClock(Date.now() - court.startTime);
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

function openSettings(){
  settingsSessionName.value = state.session.name;
  courtCountNum.textContent = state.courts.length;
  soundToggle.checked = state.session.soundOn;
  targetGamesToggle.checked = state.session.targetGamesEnabled;
  targetGamesSub.hidden = !state.session.targetGamesEnabled;
  targetGamesInput.value = state.session.targetGamesPerPlayer;
  avoidRepeatToggle.checked = state.session.avoidRepeatTeammates;
  fixedDuoSub.hidden = !state.session.avoidRepeatTeammates;
  scoringToggle.checked = state.session.scoringEnabled;
  scoringSub.hidden = !state.session.scoringEnabled;
  winningScoreInput.value = state.session.winningScore;
  renderFixedDuoNameOptions();
  renderFixedDuoList();
  [...gameSizeSeg.children].forEach(b => b.classList.toggle('active', Number(b.dataset.size) === state.session.gameSize));
  renderCourtNameRows();
  if ($('#rosterSearchInput')) $('#rosterSearchInput').value = '';
  renderRosterManageList('');
  updateEndSessionBtn();
  settingsOverlay.hidden = false;
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
      <select class="${levelClass(c.level)}" data-level-idx="${i}" aria-label="${esc(c.name)} skill level">${levelSelectOptionsHtml(c.level || 'Open')}</select>
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
$('#settingsDone').addEventListener('click', () => { settingsOverlay.hidden = true; renderAll(); persist(); });

$('#endSessionBtn').addEventListener('click', () => {
  if (isSessionEnded()) resumeSession(); else endSession();
});
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
  state.courts.push({ id: nextId('c'), name: 'Court ' + n, level: 'Open', status:'open', players:[], startTime:null, lastResult:null, swapInfo:null, score:null });
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
  state.courts.pop();
  courtCountNum.textContent = state.courts.length;
  renderCourtNameRows(); persist(); renderAll();
});

soundToggle.addEventListener('change', () => {
  state.session.soundOn = soundToggle.checked;
  persist();
});

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

settingsSessionName.addEventListener('change', () => {
  state.session.name = settingsSessionName.value.trim() || 'Renzku Smart Stack';
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
    parsed.courts.forEach(c => { if (!('lastResult' in c)) c.lastResult = null; if (!('swapInfo' in c)) c.swapInfo = null; });
    parsed.stack.forEach(p => { if (!p.tag) p.tag = 'new'; });
    if (!parsed.session.status) parsed.session.status = 'active';
    if (typeof parsed.session.targetGamesEnabled !== 'boolean') parsed.session.targetGamesEnabled = false;
    if (!parsed.session.targetGamesPerPlayer || parsed.session.targetGamesPerPlayer < 1) parsed.session.targetGamesPerPlayer = 7;
    if (typeof parsed.session.avoidRepeatTeammates !== 'boolean') parsed.session.avoidRepeatTeammates = false;
    if (!Array.isArray(parsed.session.fixedDuos)) parsed.session.fixedDuos = [];
    if (typeof parsed.session.scoringEnabled !== 'boolean') parsed.session.scoringEnabled = false;
    if (!parsed.session.winningScore || parsed.session.winningScore < 1) parsed.session.winningScore = 11;
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

$('#newSessionBtn').addEventListener('click', async () => {
  if (!(await showConfirm('This clears the stack, courts, blocks, and rankings — but keeps your list of player names so you can re-add them quickly. This cannot be undone.', {title: 'Start a new session?', confirmLabel: 'Start new session', danger: true}))) return;
  state.arrivals = [];
  state.stack = [];
  state.winnersBlock = [];
  state.losersBlock = [];
  state.history = [];
  state.playerStats = {};
  state.teammateHistory = {};
  state.session.status = 'active';
  state.courts.forEach(c => { c.status = 'open'; c.players = []; c.startTime = null; c.lastResult = null; c.swapInfo = null; });
  persist();
  applySessionLockUI();
  settingsOverlay.hidden = true;
  renderRosterList();
  renderAll();
  toast('New session started — player list kept');
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
$('#tabStack').addEventListener('click', () => {
  appShell.classList.add('show-stack'); appShell.classList.remove('show-courts');
  $('#tabStack').classList.add('active'); $('#tabCourts').classList.remove('active');
});
$('#tabCourts').addEventListener('click', () => {
  appShell.classList.add('show-courts'); appShell.classList.remove('show-stack');
  $('#tabCourts').classList.add('active'); $('#tabStack').classList.remove('active');
});

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
const HOST_DAILY_LIMIT = 5;

const AUTH_STORAGE_KEY = 'renzkuAuthSession';
const HOST_STORAGE_KEY = 'renzkuHostSession';

let authSession = null;   // { access_token, refresh_token, expires_at, user:{id,email} } | null
let hostSession = null;   // { id, invite_code } | null — the currently-live broadcast, if any
let viewerMode = false;
let hostPanelMode = 'login'; // 'login' | 'signup' — which auth tab is showing when logged out
let hostBusy = false;      // true while an auth/go-live/stop request is in flight
let hostErrorMsg = '';
let hostUsageToday = null; // cached count of sessions started today, refreshed on panel open
let hostPushTimer = null;
let hostPushPending = false;
let viewerPollTimer = null;

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

function applyAuthResponse(data){
  const claims = decodeJwt(data.access_token);
  saveAuthSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
    user: { id: claims && claims.sub, email: (claims && claims.email) || (data.user && data.user.email) || '' }
  });
}

async function authRequest(path, body){
  const res = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify(body)
  });
  let data = {};
  try{ data = await res.json(); }catch(e){}
  if (!res.ok){
    throw new Error(data.error_description || data.msg || data.error || 'Something went wrong — try again');
  }
  return data;
}

async function signUpEmail(email, password){
  const data = await authRequest('/auth/v1/signup', { email, password });
  if (data.access_token){ applyAuthResponse(data); return { needsConfirmation: false }; }
  return { needsConfirmation: true };
}
async function signInEmail(email, password){
  const data = await authRequest('/auth/v1/token?grant_type=password', { email, password });
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
  try{
    if (authSession){
      await fetch(SUPABASE_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + authSession.access_token }
      });
    }
  }catch(e){}
  saveAuthSession(null);
  renderHostPanel();
}

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

function genInviteCode(){
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips look-alike chars (0/O, 1/I)
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function getHostUsageToday(){
  if (!authSession) return 0;
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
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
  hostBusy = true; hostErrorMsg = ''; renderHostPanel();
  try{
    const usage = await getHostUsageToday();
    if (usage >= HOST_DAILY_LIMIT){
      hostErrorMsg = `You've used all ${HOST_DAILY_LIMIT} live matches for today — try again tomorrow.`;
      return;
    }
    const row = await createHostedSessionWithRetry();
    if (!row){ hostErrorMsg = 'Could not start hosting — please try again.'; return; }
    saveHostSession({ id: row.id, invite_code: row.invite_code });
    toast('You\u2019re live \u2014 share the code or QR to invite viewers');
  }catch(e){
    hostErrorMsg = e.message || 'Could not start hosting';
  }finally{
    hostBusy = false;
    updateHostIndicator();
    renderHostPanel();
  }
}

async function stopHosting(){
  if (!hostSession) return;
  const dying = hostSession;
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

function queueHostPush(){
  if (!hostSession || viewerMode) return;
  hostPushPending = true;
  if (hostPushTimer) return;
  hostPushTimer = setTimeout(async () => {
    hostPushTimer = null;
    if (!hostPushPending || !hostSession) return;
    hostPushPending = false;
    try{
      await sbFetch(`/rest/v1/hosted_sessions?id=eq.${hostSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ state: state, session_name: state.session.name })
      }, true);
    }catch(e){ /* silent — next state change will retry the push */ }
  }, 1500);
}

/* ---- Host panel UI (inside the Host Online modal) ---- */
const hostOverlay = $('#hostOverlay');
const hostPanelBody = $('#hostPanelBody');
const liveHostPill = $('#liveHostPill');

function updateHostIndicator(){
  if (liveHostPill) liveHostPill.hidden = !hostSession;
}

function joinUrlFor(code){
  return location.origin + location.pathname + '?join=' + encodeURIComponent(code);
}

function renderHostPanel(){
  if (!hostPanelBody) return;

  if (!SUPABASE_CONFIGURED){
    hostPanelBody.innerHTML = `<p class="add-hint" style="padding:0">Online hosting isn't configured yet. Add your Supabase project's anon/public API key to <code>SUPABASE_ANON_KEY</code> at the top of the Host Online section in script.js, then reload.</p>`;
    return;
  }

  if (!authSession){
    hostPanelBody.innerHTML = `
      <div class="host-auth-tabs">
        <button type="button" data-tab="login" class="${hostPanelMode === 'login' ? 'active' : ''}">Log in</button>
        <button type="button" data-tab="signup" class="${hostPanelMode === 'signup' ? 'active' : ''}">Sign up</button>
      </div>
      ${hostErrorMsg ? `<div class="host-error">${esc(hostErrorMsg)}</div>` : ''}
      <form id="hostAuthForm">
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
        <button type="submit" class="btn primary" style="width:100%" ${hostBusy ? 'disabled' : ''}>${hostBusy ? 'Please wait…' : (hostPanelMode === 'signup' ? 'Create account' : 'Log in')}</button>
      </form>
    `;
    return;
  }

  if (!hostSession){
    if (hostUsageToday === null){
      getHostUsageToday().then(n => { hostUsageToday = n; renderHostPanel(); }).catch(() => { hostUsageToday = 0; renderHostPanel(); });
    }
    const used = hostUsageToday === null ? '…' : hostUsageToday;
    const atLimit = typeof used === 'number' && used >= HOST_DAILY_LIMIT;
    hostPanelBody.innerHTML = `
      <div class="host-account-row">
        <span>Signed in as <b>${esc(authSession.user.email)}</b></span>
        <button type="button" class="btn ghost sm" id="hostSignOutBtn">Log out</button>
      </div>
      ${hostErrorMsg ? `<div class="host-error">${esc(hostErrorMsg)}</div>` : ''}
      <div class="host-usage-row"><span>Live matches used today</span><b>${used} / ${HOST_DAILY_LIMIT}</b></div>
      <button type="button" class="btn primary" id="hostGoLiveBtn" style="width:100%" ${(hostBusy || atLimit) ? 'disabled' : ''}>
        ${hostBusy ? 'Going live…' : (atLimit ? 'Daily limit reached' : '🔴 Go live')}
      </button>
      <p class="host-live-note">Going live creates a read-only link anyone can open to see court status and who's next — no account needed on their end.</p>
    `;
    return;
  }

  const url = joinUrlFor(hostSession.invite_code);
  hostPanelBody.innerHTML = `
    <div class="host-account-row">
      <span>Signed in as <b>${esc(authSession.user.email)}</b></span>
      <button type="button" class="btn ghost sm" id="hostSignOutBtn">Log out</button>
    </div>
    <div class="host-live-card">
      <span class="host-live-badge">🔴 Live now</span>
      <div class="host-invite-code" id="hostInviteCodeText">${esc(hostSession.invite_code)}</div>
      <div class="host-qr-box" id="hostQrBox"></div>
      <div class="host-live-actions">
        <button type="button" class="btn ghost sm" id="hostCopyLinkBtn">Copy link</button>
        <button type="button" class="btn ghost sm" id="hostCopyCodeBtn">Copy code</button>
      </div>
      <button type="button" class="btn danger" id="hostStopBtn" style="width:100%;margin-top:.7rem" ${hostBusy ? 'disabled' : ''}>Stop hosting</button>
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

function openHostOverlay(){
  hostErrorMsg = '';
  renderHostPanel();
  hostOverlay.hidden = false;
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
  location.href = location.pathname + '?join=' + encodeURIComponent(code);
}
const watchCodeBtn = $('#watchCodeBtn');
const watchCodeInput = $('#watchCodeInput');
if (watchCodeBtn) watchCodeBtn.addEventListener('click', goWatchCode);
if (watchCodeInput) watchCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter'){ e.preventDefault(); goWatchCode(); } });

async function copyText(text){
  try{ await navigator.clipboard.writeText(text); toast('Copied'); }
  catch(e){ toast('Could not copy — select and copy manually'); }
}

$('#hostOnlineBtn').addEventListener('click', openHostOverlay);
$('#hostDone').addEventListener('click', () => { hostOverlay.hidden = true; });
liveHostPill.addEventListener('click', openHostOverlay);

hostOverlay.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('button[data-tab]');
  if (tabBtn){ hostPanelMode = tabBtn.dataset.tab; hostErrorMsg = ''; renderHostPanel(); return; }
  if (e.target.closest('#hostSignOutBtn')){ signOutEverywhere(); return; }
  if (e.target.closest('#hostGoLiveBtn')){ startHosting(); return; }
  if (e.target.closest('#hostStopBtn')){ stopHosting(); return; }
  if (e.target.closest('#hostCopyLinkBtn')){ copyText(joinUrlFor(hostSession.invite_code)); return; }
  if (e.target.closest('#hostCopyCodeBtn')){ copyText(hostSession.invite_code); return; }
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
  hostBusy = true; hostErrorMsg = ''; renderHostPanel();
  try{
    if (hostPanelMode === 'signup'){
      const r = await signUpEmail(email, password);
      if (r.needsConfirmation){
        hostBusy = false;
        hostErrorMsg = '';
        toast('Check your email to confirm your account, then log in');
        hostPanelMode = 'login';
        renderHostPanel();
        return;
      }
    } else {
      await signInEmail(email, password);
    }
    hostUsageToday = null;
    toast('Signed in');
  }catch(err){
    hostErrorMsg = err.message || 'Something went wrong';
  }finally{
    hostBusy = false;
    renderHostPanel();
  }
});

/* ---- Viewer (spectator) mode: ?join=CODE in the URL ----
   Reuses the normal renderCourts()/renderUpNext() renderers against a
   read-only snapshot of the host's state, polled every few seconds —
   simpler and more robust than a live socket for a "what's the score /
   who's next" view, at the cost of a few seconds of lag. */
function enterViewerMode(code){
  viewerMode = true;
  document.body.classList.add('viewer-mode');
  const banner = $('#viewerBanner');
  const msgEl = $('#viewerBannerMsg');
  if (banner) banner.hidden = false;
  function setMsg(text){ if (msgEl) msgEl.textContent = text; }
  setMsg('Connecting…');

  /* ---- Opt-in browser notifications: "match ended" + "next up changed" ----
     Spectators tap the bell once to grant permission; after that we notify
     them in the background so they don't have to keep the tab in view.

     Reality check on "background": a service worker lets the notification
     display reliably while this tab is open but not focused (and, on
     Android Chrome, often for a while after the screen locks). It does NOT
     mean notifications keep arriving if the browser is fully closed or the
     OS kills the tab — that needs real server-push (VAPID keys + a
     Supabase Edge Function sending Web Push on every state change), which
     is a backend addition, not something this static front end can do on
     its own. This is the best-effort version; ask if you want the full
     server-push version built out. */
  const notifyBtn = $('#viewerNotifyBtn');
  const notifyStatusBtn = $('#viewerNotifyStatus');
  const NOTIFY_STORAGE_KEY = 'renzkuViewerNotify';
  let notifyEnabled = false;
  const notifySound = new Audio('./notify.wav');
  notifySound.volume = 0.6;
  notifySound.preload = 'auto';
  try{
    notifyEnabled = ('Notification' in window) &&
      localStorage.getItem(NOTIFY_STORAGE_KEY) === '1' &&
      Notification.permission === 'granted';
  }catch(e){}

  let swRegistration = null;
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').then(reg => { swRegistration = reg; }).catch(() => {});
  }

  function updateNotifyBtn(){
    if (!notifyBtn || !notifyStatusBtn) return;
    if (!('Notification' in window)){ notifyBtn.hidden = true; notifyStatusBtn.hidden = true; return; }
    // Once it's actually on, the labeled button is gone for good — just a
    // small tappable bell remains, which is also how you turn it back off.
    notifyBtn.hidden = notifyEnabled;
    notifyStatusBtn.hidden = !notifyEnabled;
  }
  updateNotifyBtn();

  if (notifyBtn){
    notifyBtn.addEventListener('click', async () => {
      if (!('Notification' in window)){ toast('Notifications aren\u2019t supported in this browser'); return; }
      if (Notification.permission === 'granted'){
        notifyEnabled = true;
      } else if (Notification.permission === 'denied'){
        toast('Notifications are blocked for this site in your browser settings');
      } else {
        const perm = await Notification.requestPermission();
        notifyEnabled = perm === 'granted';
        if (!notifyEnabled) toast('Notifications weren\u2019t enabled');
      }
      try{ localStorage.setItem(NOTIFY_STORAGE_KEY, notifyEnabled ? '1' : '0'); }catch(e){}
      updateNotifyBtn();
      if (notifyEnabled) toast('Notifications on \u2014 we\u2019ll alert you when a game ends');
    });
  }

  if (notifyStatusBtn){
    notifyStatusBtn.addEventListener('click', async () => {
      const turnOff = await showConfirm('Turn off match notifications on this device?', {
        title: 'Notifications', confirmLabel: 'Turn off', cancelLabel: 'Keep on'
      });
      if (!turnOff) return;
      notifyEnabled = false;
      try{ localStorage.setItem(NOTIFY_STORAGE_KEY, '0'); }catch(e){}
      updateNotifyBtn();
      toast('Notifications turned off');
    });
  }

  function notify(title, body){
    if (!notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    try{ notifySound.currentTime = 0; notifySound.play().catch(() => {}); }catch(e){}
    const opts = {
      body,
      tag: 'renzku-viewer-' + title + '-' + Date.now(),
      icon: './icon-192.png',
      badge: './badge-96.png'
    };
    try{
      if (swRegistration && swRegistration.showNotification){
        swRegistration.showNotification(title, opts);
      } else {
        new Notification(title, opts);
      }
    }catch(e){ console.error('Notification error:', e); }
  }

  let lastStatus = null;      // previous session status, to catch the live -> ended transition
  let lastOnDeck = null;      // text of the first "on deck" matchup, to catch it changing
  let lastHistoryId = undefined; // most recent recorded match id, to catch a game finishing
  let lastCourtStarts = {};   // courtId -> startTime, to catch a new game beginning

  async function poll(){
    if (!SUPABASE_CONFIGURED){ setMsg('This app isn\u2019t configured for live viewing yet.'); return; }
    try{
      const res = await sbFetch('/rest/v1/rpc/get_hosted_session_by_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_code: code })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok){
        const apiMsg = (data && (data.message || data.hint || data.error_description)) || ('HTTP ' + res.status);
        setMsg('Connection error: ' + apiMsg);
        console.error('get_hosted_session_by_code failed:', res.status, data);
        return;
      }
      const row = Array.isArray(data) ? data[0] : null;
      if (!row){ setMsg('This code is invalid or the match has ended.'); return; }
      if (row.status !== 'live'){
        if (lastStatus === 'live') notify('Match ended', 'The host has stopped sharing this match.');
        lastStatus = row.status;
        setMsg('The host has stopped sharing this match.');
        return;
      }
      state = row.state;
      const nameEl = $('.session-name');
      if (nameEl) nameEl.textContent = (row.session_name || 'Live match') + ' \u00b7 Live';
      setMsg('Updated ' + new Date(row.updated_at).toLocaleTimeString());
      renderAll();

      // A new game just started on some court.
      if (Array.isArray(state.courts)){
        state.courts.forEach(c => {
          const prevStart = lastCourtStarts[c.id];
          if (c.startTime && prevStart !== undefined && c.startTime !== prevStart){
            const matchup = (c.players || []).join(', ');
            notify((c.name || 'Court') + ' \u2014 match started', matchup || 'A new match just began.');
          }
          lastCourtStarts[c.id] = c.startTime || null;
        });
      }

      // A game just finished on some court — the host's history array gets
      // a new entry pushed to the front each time a winner is recorded.
      const latestGame = Array.isArray(state.history) && state.history.length ? state.history[0] : null;
      const latestGameId = latestGame ? latestGame.id : null;
      if (lastHistoryId !== undefined && latestGameId !== null && latestGameId !== lastHistoryId){
        const winnerText = latestGame.winnerNames && latestGame.winnerNames.length ? latestGame.winnerNames.join(' & ') : null;
        const scoreText = (latestGame.scoreA !== null && latestGame.scoreB !== null) ? ` ${latestGame.scoreA}-${latestGame.scoreB}` : '';
        const title = (latestGame.courtName || 'Court') + ' \u2014 game ended';
        const body = winnerText ? `${winnerText} won${scoreText}` : `Game finished${scoreText}`;
        notify(title, body);
      }
      lastHistoryId = latestGameId;

      const firstOnDeck = historyList && historyList.querySelector('.ondeck-row .ondeck-matchup');
      const onDeckText = firstOnDeck ? firstOnDeck.textContent.trim() : null;
      if (onDeckText && lastOnDeck !== null && onDeckText !== lastOnDeck){
        notify('Next up', onDeckText.replace(/\s+/g, ' '));
      }
      if (onDeckText) lastOnDeck = onDeckText;
      lastStatus = row.status;
    }catch(e){
      setMsg('Having trouble connecting: ' + (e.message || e) + ' \u2014 retrying…');
      console.error('Viewer poll error:', e);
    }
  }
  poll();
  viewerPollTimer = setInterval(poll, 4000);
}

/* ================= Render orchestration ================= */
function renderAll(){
  applySessionLockUI();
  renderBlocks();
  renderStack();
  renderCourts();
  renderUpNext();
  renderArrivals();
  renderQuickAdd();
}

/* ================= Boot ================= */
(async function init(){
  const joinCode = new URLSearchParams(location.search).get('join');
  // If this is the host's own share link (they're already signed in and
  // currently broadcasting that exact code), don't drop them into the
  // read-only spectator view — just take them straight to their normal
  // host dashboard instead.
  const localHostSession = joinCode ? loadHostSession() : null;
  const isOwnHostLink = !!(joinCode && localHostSession && localHostSession.invite_code === joinCode);
  if (joinCode && !isOwnHostLink){
    enterViewerMode(joinCode);
    return; // spectator view never touches local IndexedDB/localStorage app state
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
    state.courts.forEach(c => { if (!('lastResult' in c)) c.lastResult = null; if (!('swapInfo' in c)) c.swapInfo = null; });
    state.stack.forEach(p => { if (!p.tag) p.tag = 'new'; });
    if (!state.session.status) state.session.status = 'active';
    if (typeof state.session.targetGamesEnabled !== 'boolean') state.session.targetGamesEnabled = false;
    if (!state.session.targetGamesPerPlayer || state.session.targetGamesPerPlayer < 1) state.session.targetGamesPerPlayer = 7;
    if (typeof state.session.avoidRepeatTeammates !== 'boolean') state.session.avoidRepeatTeammates = false;
    if (!Array.isArray(state.session.fixedDuos)) state.session.fixedDuos = [];
    if (typeof state.session.scoringEnabled !== 'boolean') state.session.scoringEnabled = false;
    if (!state.session.winningScore || state.session.winningScore < 1) state.session.winningScore = 11;
    state.courts.forEach(c => { if (!('score' in c)) c.score = null; });
    if (!state.playerLevels || typeof state.playerLevels !== 'object') state.playerLevels = {};
    state.courts.forEach(c => { if (!c.level || !PLAYER_LEVELS.includes(c.level)) c.level = 'Open'; });
  }
  renderRosterList();
  renderAll();
  if (window.innerWidth > 880){
    appShell.classList.add('show-stack','show-courts');
  }

  authSession = loadAuthSession();
  hostSession = loadHostSession();
  updateHostIndicator();
  if (hostSession && !authSession) saveHostSession(null); // stale local session with no login to back it
})();

})();

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
    id: 'c'+(i+1), name: 'Court '+(i+1), level: 'Open', status:'open', players: [], startTime: null, lastResult: null, swapInfo: null, score: null,
    previewOrder: null, previewSubMap: null, openedAt: Date.now()
  }));
}

function freshState(){
  return {
    session: { name: 'Renzku Smart Stack', gameSize: 4, soundOn: true, status: 'active', targetGamesEnabled: false, targetGamesPerPlayer: 7, avoidRepeatTeammates: false, fixedDuos: [], scoringEnabled: true, winningScore: 11, autoStartEnabled: true }, // status: 'active' | 'ended'
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
// True when `name` is half of an active Fixed Duo — used to lock the
// manual swap-partner control so nobody can drag-and-drop split up a pair
// the host explicitly asked to always keep together. Fixed duos only take
// effect while "Avoid Repeating Teammates" is on, so the lock follows suit.
function isInFixedDuo(name){
  if (!state.session.avoidRepeatTeammates) return false;
  const duos = state.session.fixedDuos || [];
  return duos.some(d => d.a === name || d.b === name);
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
      row.dataset.id = entry.id;
      const stats = state.playerStats[entry.name];
      const winChip = (stats && stats.wins > 0) ? `<span class="win-chip">🏆${stats.wins}</span>` : '';
      const games = stats ? (stats.games || 0) : 0;
      const gamesChip = gamesChipHtml(games);
      const tag = entry.tag === 'queued' ? '<span class="tag-pill queued">Queued</span>' : '<span class="tag-pill new">New</span>';
      const levelBadge = `<button type="button" class="level-badge ${levelClass(getPlayerLevel(entry.name))}" data-act="cycle-level" data-name="${esc(entry.name)}" title="Change skill level">${esc(levelLabel(getPlayerLevel(entry.name)))}</button>`;
      row.innerHTML = `
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
function blockListHtml(block, gameSize, blockKey, readOnly){
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
    const flushBtn = readOnly ? '' : `<button type="button" class="block-level-flush-btn" data-block-flush="${blockKey}" data-level-flush="${esc(level)}" aria-label="Move ${esc(levelLabel(level))} group to queue now">Queue now</button>`;
    return `
      <div class="block-level-group">
        <div class="block-level-head">
          <span class="level-badge ${levelClass(level)}">${esc(levelLabel(level))}</span>
          <span class="block-level-count">${entries.length}/${gameSize}</span>
          ${flushBtn}
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
  if (hasAny){
    winnersBlockCount.textContent = state.winnersBlock.length + ' waiting';
    losersBlockCount.textContent = state.losersBlock.length + ' waiting';
    winnersBlockList.innerHTML = blockListHtml(state.winnersBlock, gameSize, 'winnersBlock');
    losersBlockList.innerHTML = blockListHtml(state.losersBlock, gameSize, 'losersBlock');

    blocksPanel.querySelector('[data-block="winners"]').disabled = state.winnersBlock.length === 0 || isSessionEnded();
    blocksPanel.querySelector('[data-block="losers"]').disabled = state.losersBlock.length === 0 || isSessionEnded();
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
        $('#viewerWinnersBlockCount').textContent = state.winnersBlock.length + ' waiting';
        $('#viewerLosersBlockCount').textContent = state.losersBlock.length + ' waiting';
        $('#viewerWinnersBlockList').innerHTML = blockListHtml(state.winnersBlock, gameSize, 'winnersBlock', true);
        $('#viewerLosersBlockList').innerHTML = blockListHtml(state.losersBlock, gameSize, 'losersBlock', true);
      }
    }
  }
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
      <button type="button" class="rm-edit" data-name="${esc(name)}" aria-label="Rename ${esc(name)}"><svg viewBox="0 0 24 24"><use href="#i-pencil"/></svg></button>
      <button type="button" class="rm-del" data-name="${esc(name)}" aria-label="Remove ${esc(name)} from saved players"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </div>
  `;
  }).join('');
}
const rosterManageListEl = $('#rosterManageList');
if (rosterManageListEl){
  rosterManageListEl.addEventListener('click', async (e) => {
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
  const oldLower = oldName.toLowerCase();
  state.arrivals.forEach(p => { if (p.name.toLowerCase() === oldLower) p.name = newName; });
  state.stack.forEach(p => { if (p.name.toLowerCase() === oldLower) p.name = newName; });
  state.winnersBlock.forEach(p => { if (p.name.toLowerCase() === oldLower) p.name = newName; });
  state.losersBlock.forEach(p => { if (p.name.toLowerCase() === oldLower) p.name = newName; });
  state.courts.forEach(c => {
    c.players = c.players.map(n => n.toLowerCase() === oldLower ? newName : n);
  });
  const rIdx = state.roster.findIndex(r => r.toLowerCase() === oldLower);
  if (rIdx !== -1) state.roster[rIdx] = newName; else state.roster.push(newName);
  if (state.playerLevels && Object.prototype.hasOwnProperty.call(state.playerLevels, oldName)){
    state.playerLevels[newName] = state.playerLevels[oldName];
    delete state.playerLevels[oldName];
  }
  if (Array.isArray(state.session.fixedDuos)){
    state.session.fixedDuos.forEach(d => {
      if (d.a.toLowerCase() === oldLower) d.a = newName;
      if (d.b.toLowerCase() === oldLower) d.b = newName;
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
}
if (renamePlayerForm){
  renamePlayerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!renamePlayerOriginal) return closeRenamePlayer();
    const oldName = renamePlayerOriginal;
    const newName = renamePlayerInput.value.trim();
    if (!newName){ toast('Enter a name'); return; }
    if (newName === oldName){ closeRenamePlayer(); return; }
    const newLower = newName.toLowerCase();
    const collision = newLower !== oldName.toLowerCase() && (state.roster.some(n => n.toLowerCase() === newLower) || isNameActive(newName));
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
      <button type="button" class="level-badge ${levelClass(getPlayerLevel(entry.name))}" data-act="cycle-level" data-name="${esc(entry.name)}" title="Change skill level">${esc(levelLabel(getPlayerLevel(entry.name)))}</button>
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
      <button type="button" class="btn ghost sm" id="hostSignOutBtn">Log out</button>
    </div>
  `;
}
function playerRowHtml(name, swap, sub){
  const stats = state.playerStats[name];
  const winChip = (stats && stats.wins > 0) ? `<span class="win-chip">🏆${stats.wins}</span>` : '';
  const games = stats ? (stats.games || 0) : 0;
  const gamesChip = gamesChipHtml(games);
  const duoLocked = !!(swap && isInFixedDuo(name));
  const swapBtn = swap
    ? `<button type="button" class="player-swap-btn${swap.selected ? ' selecting' : ''}${duoLocked ? ' duo-locked' : ''}" data-act="swap-partner" data-idx="${swap.idx}" ${duoLocked ? 'disabled' : ''} aria-label="${duoLocked ? (esc(name) + ' is in a fixed duo \u2014 swap disabled') : (swap.selected ? 'Cancel swap' : ('Swap partner with ' + esc(name)))}" title="${duoLocked ? 'Fixed duo \u2014 can\u2019t split them up' : 'Swap partner'}"><svg viewBox="0 0 24 24"><use href="#i-swap"/></svg></button>`
    : '';
  const subBtn = sub
    ? `<button type="button" class="player-sub-btn" data-act="sub-player" data-idx="${sub.idx}" aria-label="Substitute ${esc(name)}" title="Sub in a replacement for ${esc(name)}"><svg viewBox="0 0 24 24"><use href="#i-sub"/></svg></button>`
    : '';
  const previewBtn = `<button type="button" class="player-preview-btn" data-act="preview-name" data-name="${esc(name)}" aria-label="Show full name for ${esc(name)}" title="Show full name"><svg viewBox="0 0 24 24"><use href="#i-expand"/></svg></button>`;
  return `<span class="player-col">
    <span class="player-row">${avatarHtml(name)}<span class="player-name-txt" title="${esc(name)}">${esc(courtCardName(name))}</span>${winChip}${previewBtn}${swapBtn}${subBtn}</span>
    <span class="player-games-row">${gamesChip}</span>
  </span>`;
}
function teamColHtml(names, side, gameSize, swapCtx, subBaseIdx){
  const slots = Math.ceil(gameSize / 2);
  const rows = names.map((n, i) => {
    const swap = swapCtx ? { idx: swapCtx.baseIdx + i, selected: swapCtx.selectedIdx === swapCtx.baseIdx + i } : null;
    const sub = (subBaseIdx !== undefined) ? { idx: subBaseIdx + i } : null;
    return playerRowHtml(n, swap, sub);
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
      let taken = selectMatchEntries(gameSize, candidatePool);
      // Honor any pending preview substitutions the host made for this court
      // (swapping a specific waiting player in for one of the naturally
      // selected ones) before finalizing who's claimed. A pick that's gone
      // stale — the target already claimed by an earlier court this pass,
      // or no longer in the stack at all — is silently skipped rather than
      // erroring; the natural pick just stands instead.
      if (court.previewSubMap){
        Object.keys(court.previewSubMap).forEach(outgoingId => {
          const incomingId = court.previewSubMap[outgoingId];
          const outIdx = taken.findIndex(e => e.id === outgoingId);
          if (outIdx === -1) return;
          const incomingEntry = previewStack.find(e => e.id === incomingId);
          if (!incomingEntry || !levelsMatch(getPlayerLevel(incomingEntry.name), courtLevel)) return;
          taken = taken.slice();
          taken[outIdx] = incomingEntry;
        });
      }
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

/* ================= Swap partners (mid-match, or in preview) =================
   Doubles only: lets someone fix a wrong pairing, or just remix the teams,
   without ending the game or losing the score/timer. Tap one player's swap
   icon, then tap another's to trade their court spots; tapping the same
   one again cancels the pick.

   The same icon and handler work on a not-yet-started court's preview
   matchup too — there it reorders court.previewOrder instead of
   court.players, letting the host remix teams before hitting "Start Game". */
let swapSelection = null; // { courtId, idx } | null — first player picked, awaiting a second

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
   2 minutes instead of picking up where the real elapsed time left off. ---- */
const AUTO_START_MS = 2 * 60 * 1000; // how long an open court waits before auto-starting once ready

function swapCourtPartner(court, idx){
  const arr0 = court.status === 'open' ? court.previewOrder : court.players;
  if (arr0 && isInFixedDuo(arr0[idx])){
    toast('That pairing is fixed \u2014 can\u2019t swap them apart', 'warning');
    return;
  }
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
  const arr = court.status === 'open' ? court.previewOrder : court.players;
  if (!arr){ swapSelection = null; renderCourts(); return; }
  const nameA = arr[otherIdx], nameB = arr[idx];
  [arr[otherIdx], arr[idx]] = [arr[idx], arr[otherIdx]];
  swapSelection = null;
  toast(`Swapped ${nameA} ↔ ${nameB}`);
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
const subOverlay = $('#subOverlay');
const subList = $('#subList');
const subTitle = $('#subTitle');
const subSubtitle = $('#subSubtitle');
const subEmptyNote = $('#subEmptyNote');

function openSubPicker(court, idx){
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
}
function renderSubPicker(court){
  let candidates;
  if (subTarget && subTarget.preview){
    // Anyone already slotted into any open court's own preview (including
    // this one) is off the table — pulling them in here would double-book
    // them. Only players still further back in the stack, and matching this
    // court's skill level, show up as valid replacements.
    const openQueueNow = computeOpenCourtQueue(state.session.gameSize);
    const claimed = new Set();
    openQueueNow.forEach(slot => { if (slot.taken) slot.taken.forEach(e => claimed.add(e.id)); });
    const courtLevel = court.level || 'Open';
    candidates = state.stack.filter(e => !claimed.has(e.id) && levelsMatch(getPlayerLevel(e.name), courtLevel));
  } else {
    candidates = state.stack.slice();
  }
  subEmptyNote.hidden = candidates.length > 0;
  subList.innerHTML = candidates.map(entry => `
    <div class="sub-row" data-id="${entry.id}">
      <span class="arrival-name">${esc(entry.name)}</span>
      <span class="level-badge ${levelClass(getPlayerLevel(entry.name))}">${esc(levelLabel(getPlayerLevel(entry.name)))}</span>
    </div>
  `).join('');
}
function performSubstitution(entryId){
  if (!subTarget) return;
  const court = state.courts.find(c => c.id === subTarget.courtId);
  const idx = subTarget.idx;
  if (!court){ subOverlay.hidden = true; subTarget = null; return; }
  const incoming = state.stack.find(e => e.id === entryId);
  if (!incoming){ subOverlay.hidden = true; subTarget = null; return; }
  if (subTarget.preview){
    const outgoingName = court.previewOrder && court.previewOrder[idx];
    if (!outgoingName){ subOverlay.hidden = true; subTarget = null; return; }
    // Preview subs don't touch state.stack directly — the outgoing player
    // stays right where they are in the queue. We just record a pick that
    // computeOpenCourtQueue honors on the next render, claiming the incoming
    // player for this court's preview instead of the natural choice.
    const openQueueNow = computeOpenCourtQueue(state.session.gameSize);
    const myTaken = openQueueNow.get(court.id);
    const outgoingEntry = myTaken && myTaken.taken ? myTaken.taken.find(e => e.name === outgoingName) : null;
    if (!outgoingEntry){ subOverlay.hidden = true; subTarget = null; return; }
    court.previewSubMap = court.previewSubMap || {};
    court.previewSubMap[outgoingEntry.id] = incoming.id;
    if (court.previewOrder) court.previewOrder[idx] = incoming.name;
    toast(`${incoming.name} will sub in for ${outgoingName}`);
  } else {
    const stackIdx = state.stack.findIndex(e => e.id === entryId);
    if (stackIdx === -1 || !court.players[idx]) { subOverlay.hidden = true; subTarget = null; return; }
    const outgoingName = court.players[idx];
    state.stack.splice(stackIdx, 1);
    court.players[idx] = incoming.name;
    state.stack.push({ id: nextId('p'), name: outgoingName, joinedAt: Date.now(), tag: 'queued' });
    toast(`${incoming.name} subbed in for ${outgoingName}`);
  }
  subOverlay.hidden = true;
  subTarget = null;
  renderAll(); persist();
}
subList.addEventListener('click', (e) => {
  const row = e.target.closest('.sub-row[data-id]');
  if (!row) return;
  performSubstitution(row.dataset.id);
});
$('#subCancel').addEventListener('click', () => { subOverlay.hidden = true; subTarget = null; });
subOverlay.addEventListener('click', (e) => { if (e.target === subOverlay){ subOverlay.hidden = true; subTarget = null; } });

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
      let swapHint = '';
      let autoStartHtml = '';
      if (court.openedAt == null) court.openedAt = Date.now(); // e.g. an older saved session predating this field
      if (enough && !ended && !viewerMode && state.session.autoStartEnabled){
        const remainingMs = AUTO_START_MS - (Date.now() - court.openedAt);
        autoStartHtml = `<div class="auto-start-hint" data-role="autostart" data-court="${court.id}">Auto-starts in ${fmtClock(Math.max(0, remainingMs))} if nobody taps Start</div>`;
      }
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
        const activeSwap = swapSelection && swapSelection.courtId === court.id ? swapSelection.idx : null;
        const swapCtxA = canSwapPartners ? { baseIdx: 0, selectedIdx: activeSwap } : null;
        const swapCtxB = canSwapPartners ? { baseIdx: a.length, selectedIdx: activeSwap } : null;
        swapHint = (canSwapPartners && activeSwap !== null)
          ? `<div class="swap-hint">Tap another player to swap with <b>${esc(names[activeSwap])}</b></div>` : '';
        matchupHtml = `<div class="matchup">${teamColHtml(a,'a',gameSize,swapCtxA,0)}<div class="vs-divider"></div>${teamColHtml(b,'b',gameSize,swapCtxB,a.length)}</div>`;
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
        ${swapHint}
        <button type="button" class="court-cta call" data-act="call" ${(enough && !ended) ? '' : 'disabled'}>${ended ? '🔒 Session ended' : '▶ Start Game'}</button>
        ${autoStartHtml}
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
        <div class="matchup">${teamColHtml(a,'a',gameSize,swapCtxA,0)}<div class="vs-divider"></div>${teamColHtml(b,'b',gameSize,swapCtxB,a.length)}</div>
        ${swapHint}
        ${scoreboard}
        ${timerBlock}
        <button type="button" class="court-cta end" data-act="end">End game</button>
      `;
    }
    courtsGrid.appendChild(card);
  });
}

/* ---- Preview full name ----
   Card names are uppercased and clamped to two lines to keep the court
   card compact, which is occasionally still not enough room for a very
   long name. This button pops up the original, full, normal-case name
   right above where it was tapped. Works even in viewer mode since it
   doesn't change any state. */
let namePreviewEl = null;
let namePreviewHideTimer = null;
function showNamePreview(btn, name){
  if (!namePreviewEl){
    namePreviewEl = document.createElement('div');
    namePreviewEl.className = 'name-preview-pop';
    document.body.appendChild(namePreviewEl);
  }
  namePreviewEl.textContent = name;
  const r = btn.getBoundingClientRect();
  const x = Math.min(Math.max(60, r.left + r.width / 2), window.innerWidth - 60);
  namePreviewEl.style.left = x + 'px';
  namePreviewEl.style.top = Math.max(8, r.top - 6) + 'px';
  // Restart the show transition even if it's already visible for another name.
  namePreviewEl.classList.remove('show');
  void namePreviewEl.offsetWidth;
  namePreviewEl.classList.add('show');
  clearTimeout(namePreviewHideTimer);
  namePreviewHideTimer = setTimeout(hideNamePreview, 2800);
}
function hideNamePreview(){
  if (namePreviewEl) namePreviewEl.classList.remove('show');
}
document.addEventListener('click', (e) => {
  if (!namePreviewEl || !namePreviewEl.classList.contains('show')) return;
  if (e.target.closest('.player-preview-btn')) return;
  hideNamePreview();
});
document.addEventListener('scroll', hideNamePreview, true);

courtsGrid.addEventListener('click', (e) => {
  const previewBtn = e.target.closest('button[data-act="preview-name"]');
  if (previewBtn){ showNamePreview(previewBtn, previewBtn.dataset.name); return; }
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
  if (btn.dataset.act === 'sub-player') openSubPicker(court, Number(btn.dataset.idx));
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
  court.swapInfo = state.session.avoidRepeatTeammates ? buildSwapInfo(naturalNames, chosenNames, pairing.forcedDuo) : null;
  court.startTime = Date.now();
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
  court.previewOrder = null;
  court.previewSubMap = null;
  court.openedAt = Date.now(); // start the 2-minute auto-start window fresh from right now
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

/* ================= About modal ================= */
const aboutOverlay = $('#aboutOverlay');
function openAbout(){ aboutOverlay.hidden = false; }
function closeAbout(){ aboutOverlay.hidden = true; }
$('#aboutBtn').addEventListener('click', openAbout);
$('#aboutDone').addEventListener('click', closeAbout);
aboutOverlay.addEventListener('click', (e) => { if (e.target === aboutOverlay) closeAbout(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !aboutOverlay.hidden) closeAbout(); });

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

/* ================= Auto-start ready courts ================= */
// Ticks the "auto-starts in…" countdown on any open court, and — if the
// host really did just forget to tap Start Game — starts it for them once 2
// minutes have passed since that court opened AND it currently has enough
// players. Never runs for viewers (read-only) or after the session ends.
setInterval(() => {
  if (viewerMode || isSessionEnded() || !state.session.autoStartEnabled || !Array.isArray(state.courts) || state.courts.length === 0) return;
  const gameSize = state.session.gameSize;
  const openQueue = computeOpenCourtQueue(gameSize);
  let dueCourt = null;
  state.courts.forEach(court => {
    if (court.status !== 'open') return;
    if (court.openedAt == null) court.openedAt = Date.now();
    const remainingMs = AUTO_START_MS - (Date.now() - court.openedAt);
    const slot = openQueue.get(court.id);
    const enough = !!(slot && slot.taken);
    if (remainingMs <= 0){
      if (dueCourt === null && enough) dueCourt = court; // start at most one per tick; keep waiting if not enough yet
      return;
    }
    if (enough){
      const el = document.querySelector(`[data-role="autostart"][data-court="${court.id}"]`);
      if (el) el.textContent = `Auto-starts in ${fmtClock(remainingMs)} if nobody taps Start`;
    }
  });
  if (dueCourt){
    callNext(dueCourt);
    toast(dueCourt.name + ' auto-started — nobody tapped Start Game in time');
  }
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
const autoStartToggle = $('#autoStartToggle');

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
  autoStartToggle.checked = state.session.autoStartEnabled;
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
  const newCourt = { id: nextId('c'), name: 'Court ' + n, level: 'Open', status:'open', players:[], startTime:null, lastResult:null, swapInfo:null, score:null, previewOrder:null, previewSubMap:null, openedAt: Date.now() };
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

autoStartToggle.addEventListener('change', () => {
  state.session.autoStartEnabled = autoStartToggle.checked;
  if (autoStartToggle.checked){
    // Give every open court a fresh full window starting now, rather than
    // picking up wherever an old (pre-toggle-off) clock left off.
    state.courts.forEach(c => { if (c.status === 'open') c.openedAt = Date.now(); });
  }
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
    parsed.courts.forEach(c => { if (!('lastResult' in c)) c.lastResult = null; if (!('swapInfo' in c)) c.swapInfo = null; if (!('previewOrder' in c)) c.previewOrder = null; if (!('previewSubMap' in c)) c.previewSubMap = null; });
    parsed.stack.forEach(p => { if (!p.tag) p.tag = 'new'; });
    if (!parsed.session.status) parsed.session.status = 'active';
    if (typeof parsed.session.targetGamesEnabled !== 'boolean') parsed.session.targetGamesEnabled = false;
    if (!parsed.session.targetGamesPerPlayer || parsed.session.targetGamesPerPlayer < 1) parsed.session.targetGamesPerPlayer = 7;
    if (typeof parsed.session.avoidRepeatTeammates !== 'boolean') parsed.session.avoidRepeatTeammates = false;
    if (!Array.isArray(parsed.session.fixedDuos)) parsed.session.fixedDuos = [];
    if (typeof parsed.session.scoringEnabled !== 'boolean') parsed.session.scoringEnabled = false;
    if (!parsed.session.winningScore || parsed.session.winningScore < 1) parsed.session.winningScore = 11;
    if (typeof parsed.session.autoStartEnabled !== 'boolean') parsed.session.autoStartEnabled = true;
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
  state.session.status = 'active';
  state.courts.forEach(c => { c.status = 'open'; c.players = []; c.startTime = null; c.lastResult = null; c.swapInfo = null; c.previewOrder = null; c.previewSubMap = null; c.openedAt = Date.now(); });
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
let viewerPollTimer = null;
let hostReconnecting = false;       // true once a push/keepalive to Supabase has failed while
                                     // still (as far as we know) live — drives the "Reconnecting…"
                                     // pill/badge until a request succeeds again
let hostReconnectRetryTimer = null; // fast retry loop, only running while hostReconnecting
let viewerPollFn = null;            // set inside enterViewerMode; lets the global 'online'
                                     // listener trigger an immediate re-poll instead of waiting
                                     // out the rest of the current 4s interval
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
setInterval(() => { if (authSession) checkDeviceStillActive(); }, 2 * 60 * 1000);

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
    saveHostSession({ id: row.id, invite_code: row.invite_code });
    lastStoppedHost = null;
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
    await persist(); // hostSession is still unset here, so this just saves locally — no re-broadcast
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
      toast('Your hosted match ended \u2014 it was idle for a while, so it auto-stopped. Go live again to keep sharing.', 'info');
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
  if (!hostSession) return;
  try{
    await sbFetch(`/rest/v1/hosted_sessions?id=eq.${hostSession.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ state: state, session_name: state.session.name })
    }, true);
    hostPushPending = false;
    setHostReconnecting(false);
  }catch(e){
    // Leave hostPushPending true — the fast retry loop (or the next state
    // change, whichever comes first) will resend this same latest state.
    setHostReconnecting(true);
  }
}

function queueHostPush(){
  if (!hostSession || viewerMode) return;
  hostPushPending = true;
  if (hostPushTimer) return;
  hostPushTimer = setTimeout(() => {
    hostPushTimer = null;
    if (!hostPushPending || !hostSession) return;
    pushStateNow();
  }, 1500);
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
      ${hostReconnecting ? `<p class="host-live-note" style="margin-top:.3rem">Lost the connection to the server — retrying automatically. Viewers may see a slightly stale score until this reconnects; no need to stop and restart.</p>` : ''}
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

function openHostOverlay(){
  hostErrorMsg = '';
  if (!hostSession) remoteLiveChecked = false; // re-check each time the panel opens, in case
                                                // the other device came back and stopped it, etc.
  hostPendingCreditRequest = undefined; // re-fetch too, in case an admin reviewed it since the overlay was last open
  renderHostPanel();
  hostOverlay.hidden = false;
  if (hostSession) checkHostStillLive(); // catch an idle/cron auto-stop that happened while this
                                          // device wasn't looking, and re-render if so
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

async function copyText(text){
  try{ await navigator.clipboard.writeText(text); toast('Copied'); }
  catch(e){ toast('Could not copy — select and copy manually'); }
}

$('#hostOnlineBtn').addEventListener('click', openHostOverlay);
$('#hostDone').addEventListener('click', () => { hostOverlay.hidden = true; });
liveHostPill.addEventListener('click', openHostOverlay);

hostOverlay.addEventListener('click', (e) => {
  if (e.target.closest('#signupConfirmDismissBtn')){ pendingSignupConfirmation = null; hostPanelMode = 'login'; renderHostPanel(); return; }
  const tabBtn = e.target.closest('button[data-tab]');
  if (tabBtn){ hostPanelMode = tabBtn.dataset.tab; hostErrorMsg = ''; renderHostPanel(); return; }
  if (e.target.closest('#hostSignOutBtn')){ signOutEverywhere(); return; }
  if (e.target.closest('#hostGoLiveBtn')){ startHosting(); return; }
  if (e.target.closest('#hostResumeStoppedBtn')){ resumeHostingSameLink(); return; }
  if (e.target.closest('#hostNewSessionGoLiveBtn')){
    (async () => {
      if (!(await showConfirm('This clears the stack, courts, blocks, and rankings — but keeps your list of player names so you can re-add them quickly. This cannot be undone.', {title: 'Start a new session?', confirmLabel: 'Start new session', danger: true}))) return;
      startFreshSessionKeepingRoster();
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
  if (e.target.closest('#hostCopyLinkBtn')){ copyText(joinUrlFor(hostSession.invite_code)); return; }
  if (e.target.closest('#hostCopyCodeBtn')){ copyText(hostSession.invite_code); return; }

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
    hostReceiptFile = (e.target.files && e.target.files[0]) || null;
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
  viewerSetMsgFn = setMsg; // let the global 'offline' listener update this banner instantly

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
  let lastCourtRoster = {};   // courtId -> player names on court, to catch a mid-game substitution
  let firstPoll = true;       // belt-and-suspenders: never notify on the poll that just
                               // establishes the baseline snapshot, no matter what it contains.
  let invalidPolls = 0;       // consecutive "code not found" results — stop repolling a dead code

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
      if (!row){
        recordWatchFailure();
        invalidPolls++;
        setMsg('This code is invalid or the match has ended.');
        if (invalidPolls >= 2 && viewerPollTimer){
          clearInterval(viewerPollTimer);
          viewerPollTimer = null;
        }
        return;
      }
      invalidPolls = 0;
      if (row.status !== 'live'){
        if (!firstPoll && lastStatus === 'live') notify('Match ended', 'The host has stopped sharing this match.');
        lastStatus = row.status;
        firstPoll = false;
        setMsg('The host has stopped sharing this match.');
        return;
      }
      state = row.state;
      const nameEl = $('.session-name');
      if (nameEl) nameEl.textContent = (row.session_name || 'Live match') + ' \u00b7 Live';
      setMsg('Updated ' + new Date(row.updated_at).toLocaleTimeString());
      renderAll();

      // A new game just started on some court — or, if the start time didn't
      // move but who's playing did, someone was subbed in mid-game.
      if (Array.isArray(state.courts)){
        state.courts.forEach(c => {
          const prevStart = lastCourtStarts[c.id];
          const prevRoster = lastCourtRoster[c.id];
          const roster = (c.players || []).slice();
          if (!firstPoll && c.startTime && prevStart !== undefined && c.startTime !== prevStart){
            const matchup = roster.join(', ');
            notify((c.name || 'Court') + ' \u2014 match started', matchup || 'A new match just began.');
          } else if (!firstPoll && prevStart !== undefined && c.startTime === prevStart && prevRoster){
            const incoming = roster.filter(n => !prevRoster.includes(n));
            const outgoing = prevRoster.filter(n => !roster.includes(n));
            if (incoming.length && outgoing.length){
              notify((c.name || 'Court') + ' \u2014 substitution', `${incoming.join(' & ')} in for ${outgoing.join(' & ')}`);
            }
          }
          lastCourtStarts[c.id] = c.startTime || null;
          lastCourtRoster[c.id] = roster;
        });
      }

      // A game just finished on some court — the host's history array gets
      // a new entry pushed to the front each time a winner is recorded.
      const latestGame = Array.isArray(state.history) && state.history.length ? state.history[0] : null;
      const latestGameId = latestGame ? latestGame.id : null;
      if (!firstPoll && lastHistoryId !== undefined && latestGameId !== null && latestGameId !== lastHistoryId){
        const winnerText = latestGame.winnerNames && latestGame.winnerNames.length ? latestGame.winnerNames.join(' & ') : null;
        const scoreText = (latestGame.scoreA !== null && latestGame.scoreB !== null) ? ` ${latestGame.scoreA}-${latestGame.scoreB}` : '';
        const title = (latestGame.courtName || 'Court') + ' \u2014 game ended';
        const body = winnerText ? `${winnerText} won${scoreText}` : `Game finished${scoreText}`;
        notify(title, body);
      }
      lastHistoryId = latestGameId;

      const firstOnDeck = historyList && historyList.querySelector('.ondeck-row .ondeck-matchup');
      // Build the text from each child span (team / "vs" / team) rather than
      // raw textContent — the spans are laid out with CSS flex gap, not
      // actual space characters, so a naive textContent read glues them
      // together with no space (e.g. "jun2vsrenzku").
      const onDeckText = firstOnDeck
        ? Array.from(firstOnDeck.children).map(el => el.textContent.trim()).filter(Boolean).join(' ')
        : null;
      if (!firstPoll && onDeckText && lastOnDeck !== null && onDeckText !== lastOnDeck){
        notify('Next up', onDeckText.replace(/\s+/g, ' '));
      }
      if (onDeckText) lastOnDeck = onDeckText;
      lastStatus = row.status;
      firstPoll = false;
    }catch(e){
      // A thrown fetch (as opposed to a non-OK response, handled above) usually
      // means the request never left the device — no internet, DNS failure,
      // etc. Lead with "Reconnecting to live…" in that case since that's the
      // actionable, reassuring read; fall back to the raw error otherwise.
      setMsg(!navigator.onLine
        ? 'Reconnecting to live\u2026'
        : 'Having trouble connecting: ' + (e.message || e) + ' \u2014 retrying…');
      console.error('Viewer poll error:', e);
    }
  }
  poll();
  viewerPollFn = poll; // let the global 'online' listener re-poll immediately instead of
                        // waiting out the rest of the current 4s interval
  viewerPollTimer = setInterval(poll, 4000);
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
  }
  if (authSession) checkDeviceStillActive();
  if (viewerMode && viewerPollFn) viewerPollFn();
});

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
    if (typeof state.session.autoStartEnabled !== 'boolean') state.session.autoStartEnabled = true;
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
  if (hostSession) checkHostStillLive(); // catch an idle/cron auto-stop that happened while this device was closed
  if (authSession) checkDeviceStillActive(); // catch a takeover by another device that happened while this device was closed
})();

})();

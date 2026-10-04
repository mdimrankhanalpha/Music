/*
 * Alpha Music — ultra-lightweight audio player.
 * Vanilla JS. Event-driven: no polling, no timers while idle, no rAF unless the visualizer is on.
 *
 * Playback paths
 *   NORMAL  : <audio> element -> native browser playback
 *   POWER   : <audio> -> AudioContext -> [only the nodes needed] -> (Analyser) -> output
 *             Built only when the Visualizer or a DJ effect is switched on, and fully torn down
 *             (context closed, element replaced) when both are off again.
 *
 * Sections
 *   1 Config & helpers      5 Queue                     9 Visualizer
 *   2 Settings              6 Playback engine           10 Media Session
 *   3 Library & parser      7 Audio graph (DJ)          11 UI wiring, keyboard
 *   4 Virtual track list    8 Playback UI               12 Init
 */
'use strict';
(() => {

/* ============================================================================
 * 1. CONFIG & HELPERS
 * ========================================================================== */

// Source of truth for the music library. Blob URLs are converted to raw URLs by toRawUrl().
const SOURCES = {
  bangla:  { label: 'Bangla',  blob: 'https://github.com/mdimrankhanalpha/Music/blob/main/Music.txt/Music%20Bangla.txt' },
  english: { label: 'English', blob: 'https://github.com/mdimrankhanalpha/Music/blob/main/Music.txt/Music%20English.txt' },
  other:   { label: 'Other',   blob: 'https://github.com/mdimrankhanalpha/Music/blob/main/Music.txt/Music%20Other.txt' }
};
const CACHE_TTL = 6 * 3600 * 1000;      // re-download the text files at most every 6 hours (or on "Refresh library")
const ROW_H = 56;                       // keep in sync with --row in style.css
const OVERSCAN = 4;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const REPEATS = ['off', 'all', 'one'];
const HISTORY_MAX = 50;
const QUEUE_RENDER_MAX = 300;
const APP_NAME = 'Alpha Music';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const noop = () => {};
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '--:--';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
function shorten(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or private mode: ignore */ } }
};

// DOM references, filled once in cacheDom().
const E = {};
const IDS = [
  'btnSearch', 'btnViz', 'btnTools', 'btnSettings', 'searchRow', 'searchInput', 'libCount', 'btnRefresh', 'list', 'spacer',
  'libMsg', 'libMsgText', 'libRetry', 'artBox', 'artSvg', 'artSheen', 'artLetter', 'vizStage', 'vizCanvas', 'vizNote', 'vizModes',
  'npTitle', 'npCat', 'npTrack', 'procChip', 'npStatus', 'seek', 'tCur', 'tDur', 'bShuffle', 'bPrev', 'bPlay', 'bNext', 'bRepeat',
  'bBack', 'bFwd', 'bMute', 'queueList', 'queueCount', 'queueEmpty', 'bClearQueue', 'mini', 'miniTitle', 'miniPlay', 'miniNext',
  'toast', 'toastText', 'toastBtn', 'dlgTools', 'dlgSettings', 'procBox', 'procStatus', 'procNote', 'fxKeepPitch', 'fxReset',
  'setTheme', 'setRepeat', 'setShuffle', 'setAutoplay', 'setAutoskip', 'setViz', 'setReduce', 'setKeys', 'setProc', 'setProcReset', 'player'
];
function cacheDom() { for (const id of IDS) E[id] = $(id); }

/* ============================================================================
 * 2. SETTINGS (tiny, localStorage)
 * ========================================================================== */

const DEFAULTS = {
  vol: 1, muted: false, rate: 1, repeat: 'off', shuffle: false, cat: 'bangla', theme: 'dark',
  reduce: true, viz: 'spectrum', autoplay: true, keys: true, autoskip: false, keepPitch: true
};
const S = Object.assign({}, DEFAULTS, store.get('am:settings', {}));
if (!SOURCES[S.cat]) S.cat = DEFAULTS.cat;
if (!REPEATS.includes(S.repeat)) S.repeat = 'off';
if (!['dark', 'black', 'light'].includes(S.theme)) S.theme = 'dark';
if (!['spectrum', 'bars', 'wave', 'circle'].includes(S.viz)) S.viz = 'spectrum';
S.vol = clamp(Number(S.vol) || 0, 0, 1);
S.rate = SPEEDS.includes(Number(S.rate)) ? Number(S.rate) : 1;

let saveTimer = 0;
function saveSettings() {            // one-shot debounce, only runs after a user change
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('am:settings', S), 400);
}

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = S.theme;
  root.dataset.rm = S.reduce ? '1' : '0';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = S.theme === 'light' ? '#f2f0eb' : S.theme === 'black' ? '#000000' : '#0d0e10';
}

/* ============================================================================
 * 3. LIBRARY: FETCH + PARSER
 * ========================================================================== */

const lib = Object.create(null);     // category -> { tracks }
let curCat = S.cat;
let view = [];                       // tracks currently listed (category, optionally filtered)
let query = '';
let loadToken = 0;

/** github.com/<u>/<r>/blob|raw/<branch>/<path>  ->  raw.githubusercontent.com/<u>/<r>/<branch>/<path> */
function toRawUrl(u) {
  const m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u;
}
/** URL used by the <audio> element. The original text from the file is kept untouched in track.u */
function toPlayable(u) { return toRawUrl(u).replace(/ /g, '%20'); }

async function fetchLibraryText(cat, force) {
  const key = 'am:lib:' + cat;
  const cached = store.get(key, null);
  if (!force && cached && typeof cached.text === 'string' && Date.now() - cached.t < CACHE_TTL) return cached.text;
  try {
    const res = await fetch(toRawUrl(SOURCES[cat].blob), { cache: force ? 'reload' : 'default' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    store.set(key, { t: Date.now(), text });
    return text;
  } catch (err) {
    if (cached && typeof cached.text === 'string') return cached.text;   // offline or GitHub down: use the stale copy
    throw err;
  }
}

/*
 * Parser. A rule takes one trimmed line and returns { name, url } or null.
 * To support a new text format later, add a rule to RULES. Names and URLs are never rewritten;
 * only trailing/leading separator characters between the two ("Name - https://...") are dropped.
 */
const stripTail = (s) => s.replace(/[\s\-–—:|=,>]+$/, '');
const stripHead = (s) => s.replace(/^[\s\-–—:|=,<]+/, '');
const RULES = [
  // [Name](https://...)
  (line) => {
    const m = line.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*$/i);
    return m ? { name: m[1], url: m[2] } : null;
  },
  // Name <separator> https://...   (URL runs to the end of the line, so spaces inside it survive)
  (line) => {
    const i = line.search(/https?:\/\//i);
    return i > 0 ? { name: stripTail(line.slice(0, i).trim()), url: line.slice(i).trim() } : null;
  },
  // https://...  <separator> Name
  (line) => {
    if (!/^https?:\/\//i.test(line)) return null;
    const m = line.match(/^(\S+)\s*(.*)$/);
    return { name: stripHead(m[2]).trim(), url: m[1] };
  }
];
function nameFromUrl(u) {
  try { return decodeURIComponent(u.split(/[?#]/)[0].split('/').pop()) || u; } catch { return u; }
}
function parseMusicFile(text, cat) {
  const tracks = [];
  let pending = '';                  // a name-only line waits for the URL on the next line
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let hit = null;
    for (const rule of RULES) { hit = rule(line); if (hit) break; }
    if (!hit) { pending = line; continue; }
    const src = toPlayable(hit.url);
    try { new URL(src); } catch { pending = ''; continue; }               // not a usable URL: skip the entry
    const name = hit.name || pending || nameFromUrl(hit.url);
    pending = '';
    tracks.push({ n: name, u: hit.url, s: src, c: cat, k: name.toLowerCase(), d: 0, bad: false });
  }
  return tracks;
}

async function loadCategory(cat, force = false) {
  curCat = cat; S.cat = cat; saveSettings();
  paintCats();
  const token = ++loadToken;
  if (!force && lib[cat]) { showCategory(); return; }
  view = []; renderTrackList(); updateCount();
  showMsg('Loading library…');
  let text;
  try { text = await fetchLibraryText(cat, force); }
  catch (err) {
    if (token === loadToken) showMsg('Music library unavailable', true);
    return;
  }
  lib[cat] = { tracks: parseMusicFile(text, cat) };
  paintCats();
  if (token === loadToken) showCategory();
}
function showCategory() {
  const tracks = lib[curCat] ? lib[curCat].tracks : [];
  if (!tracks.length) { view = []; renderTrackList(); updateCount(); showMsg('No playable tracks found in this file.'); return; }
  hideMsg();
  applyFilter();
}
function applyFilter() {
  const all = lib[curCat] ? lib[curCat].tracks : [];
  const q = query.trim().toLowerCase();
  if (!q) view = all;
  else { const toks = q.split(/\s+/); view = all.filter((t) => toks.every((x) => t.k.includes(x))); }
  if (all.length && q && !view.length) showMsg('No tracks match your search.'); else if (all.length) hideMsg();
  E.list.scrollTop = 0;
  renderTrackList();
  updateCount();
}
function updateCount() {
  const all = lib[curCat] ? lib[curCat].tracks.length : 0;
  E.libCount.textContent = !all ? '' : query.trim() ? `${view.length} of ${all} tracks` : `${all} tracks`;
}
function showMsg(text, retry) { E.libMsgText.textContent = text; E.libRetry.hidden = !retry; E.libMsg.hidden = false; }
function hideMsg() { E.libMsg.hidden = true; }
function paintCats() {
  document.querySelectorAll('.cat').forEach((b) => {
    const c = b.dataset.cat;
    b.setAttribute('aria-pressed', String(c === curCat));
    b.querySelector('.n').textContent = lib[c] ? lib[c].tracks.length : '';
  });
}

/* ============================================================================
 * 4. VIRTUAL TRACK LIST (about 20 DOM rows no matter how big the library is)
 * ========================================================================== */

const pool = [];
let paintQueued = false;

function sameTrack(a, b) { return !!a && !!b && (a === b || (a.u === b.u && a.n === b.n)); }

function makeRow() {
  const row = document.createElement('div');
  row.className = 'row'; row.setAttribute('role', 'listitem');
  row.innerHTML =
    '<button class="r-main" type="button"><span class="r-title"></span><span class="r-dur"></span></button>' +
    '<button class="r-act" type="button" data-act="next"><svg class="i"><use href="#i-nextup"/></svg></button>' +
    '<button class="r-act" type="button" data-act="add"><svg class="i"><use href="#i-plus"/></svg></button>';
  row._title = row.querySelector('.r-title');
  row._dur = row.querySelector('.r-dur');
  row._main = row.querySelector('.r-main');
  row._next = row.children[1];
  row._add = row.children[2];
  E.spacer.appendChild(row);
  return row;
}
function renderTrackList() {
  E.spacer.style.height = view.length * ROW_H + 'px';
  paintRows(true);
}
function paintRows(force) {
  const h = E.list.clientHeight || 400;
  const first = Math.max(0, Math.floor(E.list.scrollTop / ROW_H) - OVERSCAN);
  const count = Math.max(0, Math.min(view.length - first, Math.ceil(h / ROW_H) + OVERSCAN * 2));
  while (pool.length < count) pool.push(makeRow());
  for (let k = 0; k < pool.length; k++) {
    const row = pool[k];
    if (k >= count) { if (!row.hidden) row.hidden = true; continue; }
    const i = first + k, t = view[i];
    const isCur = sameTrack(t, cur);
    row.hidden = false;
    row.style.transform = 'translateY(' + i * ROW_H + 'px)';
    row._i = i;
    const dur = t.bad ? 'Unavailable' : t.d ? fmtTime(t.d) : '';
    if (force || row._t !== t || row._cur !== isCur || row._dur_v !== dur) {
      row._t = t; row._cur = isCur; row._dur_v = dur;
      row.className = 'row' + (isCur ? ' cur' : '') + (t.bad ? ' bad' : '');
      row._title.textContent = t.n;
      row._dur.textContent = dur;
      row._main.setAttribute('aria-label', (isCur && isPlaying() ? 'Pause ' : 'Play ') + t.n);
      if (isCur) row._main.setAttribute('aria-current', 'true'); else row._main.removeAttribute('aria-current');
      row._next.setAttribute('aria-label', 'Play next: ' + t.n);
      row._add.setAttribute('aria-label', 'Add to queue: ' + t.n);
    }
  }
}
function onListScroll() {            // one frame per scroll burst; nothing runs when not scrolling
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintRows(false); });
}
function onListClick(e) {
  const row = e.target.closest('.row');
  if (!row) return;
  const t = view[row._i];
  if (!t) return;
  const btn = e.target.closest('button');
  const act = btn && btn.dataset.act;
  if (act === 'add') addToQueue(t);
  else if (act === 'next') playNext(t);
  else playTrack(t, { list: view });
}

/* ============================================================================
 * 5. QUEUE (in memory)
 * ========================================================================== */

const queue = [];

function addToQueue(t) { queue.push(t); renderQueue(); toast('Added to queue'); }
function playNext(t) { queue.unshift(t); renderQueue(); toast('Plays next'); }
function removeFromQueue(i) { queue.splice(i, 1); renderQueue(); }
function clearQueue() { queue.length = 0; renderQueue(); }
function playFromQueue(i) {
  const t = queue.splice(i, 1)[0];
  renderQueue();
  if (t) playTrack(t, { fromQueue: true, force: true });
}
function renderQueue() {
  const frag = document.createDocumentFragment();
  const n = Math.min(queue.length, QUEUE_RENDER_MAX);
  for (let i = 0; i < n; i++) {
    const li = document.createElement('li');
    li.className = 'qi';
    const main = document.createElement('button');
    main.type = 'button'; main.className = 'q-main'; main.dataset.qi = i;
    main.setAttribute('aria-label', 'Play now: ' + queue[i].n);
    const num = document.createElement('span'); num.className = 'q-n'; num.textContent = i + 1;
    const title = document.createElement('span'); title.className = 'q-t'; title.textContent = queue[i].n;
    main.append(num, title);
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'q-x'; rm.dataset.qi = i; rm.dataset.act = 'rm';
    rm.setAttribute('aria-label', 'Remove from queue: ' + queue[i].n);
    rm.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
    li.append(main, rm);
    frag.appendChild(li);
  }
  E.queueList.replaceChildren(frag);
  E.queueCount.textContent = queue.length ? `(${queue.length})` : '';
  E.queueEmpty.hidden = queue.length > 0;
  E.bClearQueue.hidden = queue.length === 0;
}
function onQueueClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const i = Number(b.dataset.qi);
  if (b.dataset.act === 'rm') removeFromQueue(i); else playFromQueue(i);
}

/* ============================================================================
 * 6. PLAYBACK ENGINE (native <audio>)
 * ========================================================================== */

let audio = null;                    // always the active element (replaced when the audio path changes)
let cur = null;                      // current track
let ctxList = [];                    // list the current track came from
let ctxPos = -1;
const history = [];
let seeking = false;
let lastSec = -1;
let failStreak = 0;
let needFadeIn = false;
let volumeSupported = true;

const isPlaying = () => !!audio && !audio.paused && !audio.ended;

const AUDIO_EVENTS = {
  loadstart: onLoadStart, waiting: onWaiting, canplay: onCanPlay, playing: onPlaying, pause: onPause,
  ended: onEnded, timeupdate: onTimeUpdate, loadedmetadata: onMeta, durationchange: onMeta,
  error: onError, seeked: onSeeked, ratechange: onRate, volumechange: onVolume
};
function makeAudio(cors) {
  const el = new Audio();            // detached element: no DOM cost
  el.preload = 'auto';
  if (cors) el.crossOrigin = 'anonymous';   // only needed when Web Audio must read the samples
  el.volume = S.vol; el.muted = S.muted;
  el.defaultPlaybackRate = S.rate; el.playbackRate = S.rate;
  el.loop = S.repeat === 'one';
  applyPitch(el);
  for (const type in AUDIO_EVENTS) {
    const fn = AUDIO_EVENTS[type];
    el.addEventListener(type, (ev) => { if (el === audio) fn(ev); });   // ignore events from retired elements
  }
  return el;
}
function applyPitch(el) {
  el.preservesPitch = S.keepPitch; el.webkitPreservesPitch = S.keepPitch; el.mozPreservesPitch = S.keepPitch;
}
/** Replace the audio element (needed to enter/leave the Web Audio path). Optionally carries position and play state. */
function swapAudio(cors, carry) {
  const old = audio;
  const t = carry && old ? old.currentTime : 0;
  const was = !!carry && !!old && !old.paused && !old.ended;
  const src = carry && old ? old.currentSrc : '';
  const el = makeAudio(cors);
  audio = el;
  if (src) {
    el.src = src;
    if (t > 0) el.addEventListener('loadedmetadata', () => { try { el.currentTime = t; } catch { /* ignore */ } }, { once: true });
    if (was) el.play().catch(noop);
  }
  if (old) { old.pause(); old.removeAttribute('src'); old.load(); }
  return el;
}

function playTrack(t, o = {}) {
  if (!t) return;
  if (sameTrack(t, cur) && !t.bad && !o.force && audio.src) { togglePlay(); return; }   // tapping the current track toggles
  if (cur && !sameTrack(t, cur) && !o.noHistory) { history.push(cur); if (history.length > HISTORY_MAX) history.shift(); }
  cur = t; t.bad = false;
  if (o.list) ctxList = o.list;
  if (!o.fromQueue && !o.keepPos) ctxPos = ctxList.indexOf(t);
  else if (!ctxList.length) { ctxList = lib[curCat] ? lib[curCat].tracks : []; ctxPos = -1; }
  if (o.keepPos && o.pos != null) ctxPos = o.pos;
  setPath(graphWanted(t), false);                     // choose native/Web Audio path before loading
  holdFade();
  needFadeIn = true;
  setStatus('Loading…');
  audio.src = t.s;
  audio.defaultPlaybackRate = S.rate; audio.playbackRate = S.rate;
  const p = audio.play();
  if (p && p.catch) p.catch(onPlayRejected);
  updateNowPlaying();
  updateMediaSession();
  paintRows(false);
}
function pauseTrack() { if (audio) audio.pause(); }
function resumeTrack() {
  if (!cur) return;
  if (audio.error || !audio.src) { cur.bad = false; audio.src = cur.s; setStatus('Loading…'); }
  if (g && g.ctx.state !== 'running') g.ctx.resume().catch(noop);
  const p = audio.play();
  if (p && p.catch) p.catch(onPlayRejected);
}
function togglePlay() {
  if (!cur) { startDefault(); return; }
  if (audio.paused || audio.ended) resumeTrack(); else pauseTrack();
}
function startDefault() {
  const list = queue.length ? null : view;
  if (queue.length) { nextTrack(true); return; }
  if (!list || !list.length) { toast('The library is not loaded yet.'); return; }
  const t = S.shuffle ? list[Math.floor(Math.random() * list.length)] : list[0];
  playTrack(t, { list });
}
function seekBy(sec) {
  if (!cur || !isFinite(audio.duration)) return;
  audio.currentTime = clamp(audio.currentTime + sec, 0, audio.duration);
}

function pickNext(manual) {
  if (queue.length) { const t = queue.shift(); renderQueue(); return { t, q: true }; }
  if (!ctxList.length) ctxList = view.length ? view : (lib[curCat] ? lib[curCat].tracks : []);
  const n = ctxList.length;
  if (!n) return null;
  if (S.shuffle) {
    if (n === 1) return { t: ctxList[0], q: false };
    const recent = history.slice(-Math.min(10, n >> 1));
    let t, tries = 0;
    do { t = ctxList[Math.floor(Math.random() * n)]; tries++; }
    while ((sameTrack(t, cur) || recent.some((r) => sameTrack(r, t))) && tries < 8);
    return { t, q: false };
  }
  let p = ctxPos + 1;
  if (p >= n) { if (S.repeat === 'all' || manual) p = 0; else return null; }
  return { t: ctxList[p], q: false };
}
function nextTrack(manual = true) {
  const n = pickNext(manual);
  if (!n) { pauseTrack(); return; }
  playTrack(n.t, { fromQueue: n.q, force: true });
}
function previousTrack() {
  if (!cur) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const h = history.pop();
  if (h) { playTrack(h, { noHistory: true, force: true, list: ctxList.includes(h) ? ctxList : undefined }); return; }
  const n = ctxList.length;
  if (!n) { audio.currentTime = 0; return; }
  playTrack(ctxList[(ctxPos - 1 + n) % n], { noHistory: true, force: true });
}
function toggleShuffle() { S.shuffle = !S.shuffle; paintToggles(); saveSettings(); }
function toggleRepeat() { setRepeat(REPEATS[(REPEATS.indexOf(S.repeat) + 1) % REPEATS.length]); }
function setRepeat(v) { S.repeat = v; if (audio) audio.loop = v === 'one'; paintToggles(); saveSettings(); }
function setRate(v) {
  S.rate = Number(v);
  audio.defaultPlaybackRate = S.rate; audio.playbackRate = S.rate;
  document.querySelectorAll('.js-speed').forEach((s) => { s.value = String(S.rate); });
  saveSettings();
}
function setVolume(v) {
  S.vol = clamp(v, 0, 1);
  if (S.vol > 0 && S.muted) { S.muted = false; audio.muted = false; }
  audio.volume = S.vol;
  paintVolume(); saveSettings();
}
function toggleMute() { S.muted = !S.muted; audio.muted = S.muted; paintVolume(); saveSettings(); }
function setKeepPitch(v) { S.keepPitch = v; applyPitch(audio); saveSettings(); }

/* ---- audio element events ---- */
function onLoadStart() { if (cur && !cur.bad) setStatus('Loading…'); }
function onWaiting() { setStatus('Buffering…'); }
function onCanPlay() { if (!audio.error) setStatus(''); }
function onPlaying() {
  failStreak = 0;
  corsProbe = '';                                    // playing natively after a CORS failure: the block was real
  setStatus('');
  if (needFadeIn) { needFadeIn = false; fadeIn(); }
  if (g && g.ctx.state === 'suspended') g.ctx.resume().catch(noop);
  updatePlayUI();
  startLoop();
  setPlaybackState('playing');
}
function onPause() {
  fadeReset();
  updatePlayUI();
  stopLoop();
  setPlaybackState('paused');
  paintRows(false);
}
function onEnded() {
  updatePlayUI();
  if (S.repeat === 'one') { audio.currentTime = 0; resumeTrack(); return; }
  if (S.autoplay) nextTrack(false);
}
function onTimeUpdate() {
  if (g) maybeFadeOut();                             // keep working in background tabs
  if (document.hidden || seeking) return;
  const s = Math.floor(audio.currentTime);
  if (s === lastSec) return;                         // UI changes at most once per second
  lastSec = s;
  updateProgress();
}
function onMeta() {
  const d = audio.duration;
  if (isFinite(d) && d > 0) {
    E.seek.max = String(Math.floor(d)); E.seek.disabled = false;
    E.tDur.textContent = fmtTime(d);
    if (cur && !cur.d) { cur.d = d; paintRows(false); }
  } else {
    E.seek.max = '0'; E.seek.disabled = true; E.tDur.textContent = '--:--';
  }
  updatePositionState();
}
function onSeeked() {
  if (g && fx.fade > 0 && audio.duration - audio.currentTime > fx.fade + 0.5) fadeReset();
  lastSec = -1; updateProgress(); updatePositionState();
}
function onRate() { updatePositionState(); }
function onVolume() { /* element volume is driven by setVolume(); nothing to poll */ }
function onPlayRejected(err) {
  if (!err || err.name === 'AbortError') return;
  if (err.name === 'NotAllowedError') { setStatus('Press play to start.'); updatePlayUI(); }
}
function onError() {
  const err = audio.error;
  if (!err || err.code === 1 || !cur || !audio.getAttribute('src')) return;      // aborted / no source
  // First failure on the Web Audio path may be the host refusing CORS: retry natively once.
  if (g && !blockedHosts.has(hostOf(cur.s))) {
    const h = hostOf(cur.s);
    blockedHosts.add(h); corsProbe = h;
    toast('This audio host blocks audio analysis. Playing it without effects or visualizer.');
    setPath(false, false);
    audio.src = cur.s;
    audio.play().catch(noop);
    syncProcessing(false);
    return;
  }
  if (corsProbe && corsProbe === hostOf(cur.s)) { blockedHosts.delete(corsProbe); corsProbe = ''; }   // dead link, not CORS
  cur.bad = true;
  const msg = err.code === 2 ? 'Network error while loading this track.'
    : err.code === 3 ? 'This track could not be decoded.'
    : 'Audio unavailable or format not supported.';
  setStatus(msg, 'error');
  updatePlayUI(); paintRows(false);
  if (S.autoskip && ++failStreak <= 5) { nextTrack(false); return; }
  toast(`Can't play “${shorten(cur.n, 48)}”`, 'Skip', () => nextTrack(true));
}

/* ============================================================================
 * 7. AUDIO GRAPH (DJ tools + visualizer) — built lazily, destroyed when idle
 * ========================================================================== */

const FX_DEFAULT = { bass: 0, mid: 0, treble: 0, gain: 0, hp: 0, lp: 100, echo: 0, echoTime: 0.3, reverb: 0, fade: 0 };
const fx = Object.assign({}, FX_DEFAULT);
const fxActive = () => !!(fx.bass || fx.mid || fx.treble || fx.gain || fx.hp > 0 || fx.lp < 100 || fx.echo > 0 || fx.reverb > 0 || fx.fade > 0);
const sliderHz = (v) => 20 * Math.pow(1000, v / 100);          // 0..100 -> 20 Hz..20 kHz (log)
const FX_FMT = {
  bass: (v) => dB(v), mid: (v) => dB(v), treble: (v) => dB(v), gain: (v) => dB(v),
  hp: (v) => v <= 0 ? 'Off' : fmtHz(sliderHz(v)), lp: (v) => v >= 100 ? 'Off' : fmtHz(sliderHz(v)),
  echo: (v) => v > 0 ? v + '%' : 'Off', echoTime: (v) => Number(v).toFixed(2) + ' s',
  reverb: (v) => v > 0 ? v + '%' : 'Off', fade: (v) => v > 0 ? v + ' s' : 'Off'
};
function dB(v) { return (v > 0 ? '+' : '') + v + ' dB'; }
function fmtHz(f) { return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz'; }

let g = null;                        // { ctx, src, n:{nodes}, analyser, key }
let vizOn = false;
const blockedHosts = new Set();      // hosts whose audio can't be read by Web Audio (no CORS)
let corsProbe = '';

const graphWanted = (t) => (vizOn || fxActive()) && !(t && blockedHosts.has(hostOf(t.s)));
const chainKey = () => [fx.bass || fx.mid || fx.treble ? 1 : 0, fx.hp > 0 ? 1 : 0, fx.lp < 100 ? 1 : 0, fx.gain ? 1 : 0,
  fx.echo > 0 ? 1 : 0, fx.reverb > 0 ? 1 : 0, fx.fade > 0 ? 1 : 0, vizOn ? 1 : 0].join('');

function setPath(want, carry) {
  if (want && !g) {
    try { createGraph(carry); }
    catch (err) { g = null; failProcessing(err); }
  } else if (!want && g) destroyGraph(carry);
}
function failProcessing(err) {
  console.warn('Audio processing unavailable:', err);
  vizOn = false; stopLoop(); releaseCanvas();
  E.vizStage.hidden = true; E.artBox.hidden = false;
  Object.assign(fx, FX_DEFAULT); syncFxControls();
  paintVizButton(); updateProcUI();
  toast('Audio processing is not supported here. Normal playback is unaffected.');
}
function createGraph(carry) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio unsupported');
  swapAudio(true, carry);
  let ctx;
  try {
    ctx = new AC({ latencyHint: 'playback' });
    const src = ctx.createMediaElementSource(audio);
    g = { ctx, src, n: {}, analyser: null, key: '' };
  } catch (err) {
    if (ctx) ctx.close().catch(noop);
    swapAudio(false, carry);
    throw err;
  }
  ctx.resume().catch(noop);
  rebuildChain();
}
function destroyGraph(carry) {
  stopLoop();
  const gg = g; g = null;
  try {
    gg.src.disconnect();
    for (const k in gg.n) gg.n[k].disconnect();
    if (gg.analyser) gg.analyser.disconnect();
  } catch { /* already disconnected */ }
  swapAudio(false, carry);           // back to the plain native element
  gg.ctx.close().catch(noop);
}
function makeIR(ctx) {               // generated impulse response for the reverb (no file download)
  const len = Math.floor(ctx.sampleRate * 1.8);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
  }
  return buf;
}
/** Connect only the nodes the current settings need. */
function rebuildChain() {
  const { ctx, n } = g;
  try { g.src.disconnect(); for (const k in n) n[k].disconnect(); if (g.analyser) g.analyser.disconnect(); } catch { /* ignore */ }
  const used = new Set();
  const use = (k, make) => { used.add(k); return n[k] || (n[k] = make()); };
  const biquad = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
  let tail = g.src;
  const link = (node) => { tail.connect(node); tail = node; };

  if (fx.bass || fx.mid || fx.treble) {
    link(use('bass', () => biquad('lowshelf', 120)));
    link(use('mid', () => biquad('peaking', 1000, 0.9)));
    link(use('treble', () => biquad('highshelf', 4000)));
  }
  if (fx.hp > 0) link(use('hp', () => biquad('highpass', 20, 0.707)));
  if (fx.lp < 100) link(use('lp', () => biquad('lowpass', 20000, 0.707)));
  if (fx.gain) link(use('gain', () => ctx.createGain()));
  if (fx.echo > 0 || fx.reverb > 0) {
    const fin = use('fxIn', () => ctx.createGain());
    const fout = use('fxOut', () => ctx.createGain());
    link(fin); fin.connect(fout);                                    // dry path
    if (fx.echo > 0) {
      const d = use('echoDelay', () => ctx.createDelay(1));
      const fb = use('echoFb', () => ctx.createGain());
      const w = use('echoWet', () => ctx.createGain());
      fin.connect(d); d.connect(w); w.connect(fout); d.connect(fb); fb.connect(d);
    }
    if (fx.reverb > 0) {
      const c = use('conv', () => { const x = ctx.createConvolver(); x.buffer = makeIR(ctx); return x; });
      const w = use('revWet', () => ctx.createGain());
      fin.connect(c); c.connect(w); w.connect(fout);
    }
    tail = fout;
  }
  if (fx.fade > 0) link(use('fade', () => ctx.createGain()));
  if (vizOn) {
    if (!g.analyser) { g.analyser = ctx.createAnalyser(); configureAnalyser(); }
    link(g.analyser);
  } else g.analyser = null;
  tail.connect(ctx.destination);

  for (const k of Object.keys(n)) if (!used.has(k)) delete n[k];     // let unused nodes be collected
  g.key = chainKey();
  applyFxParams();
}
function applyFxParams() {
  if (!g) return;
  const n = g.n, t = g.ctx.currentTime;
  const to = (p, v) => p.setTargetAtTime(v, t, 0.02);                // smooth, no zipper noise
  if (n.bass) { to(n.bass.gain, fx.bass); to(n.mid.gain, fx.mid); to(n.treble.gain, fx.treble); }
  if (n.hp) to(n.hp.frequency, sliderHz(fx.hp));
  if (n.lp) to(n.lp.frequency, sliderHz(fx.lp));
  if (n.gain) to(n.gain.gain, Math.pow(10, fx.gain / 20));
  if (n.echoDelay) { to(n.echoDelay.delayTime, fx.echoTime); to(n.echoFb.gain, 0.38); to(n.echoWet.gain, fx.echo / 100 * 0.8); }
  if (n.revWet) to(n.revWet.gain, fx.reverb / 100 * 0.9);
}
/** Create/destroy/rebuild the graph so it matches exactly what is switched on. */
function syncProcessing(carry = true) {
  const want = graphWanted(cur);
  if (want && !g) setPath(true, carry);
  else if (!want && g) setPath(false, carry);
  else if (g) { if (chainKey() !== g.key) rebuildChain(); else applyFxParams(); }
  updateProcUI();
  if (vizOn) startLoop();
}

/* ---- fade between tracks: scheduled on the audio thread, no timers ---- */
function holdFade() {
  if (!g || !g.n.fade) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(0, t);
}
function fadeIn() {
  if (!g || !g.n.fade) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(0, t); p.linearRampToValueAtTime(1, t + fx.fade);
  fadeOutDone = false;
}
let fadeOutDone = false;
function fadeReset() {
  if (!g || !g.n.fade) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(1, t);
  fadeOutDone = false;
}
function maybeFadeOut() {
  if (fadeOutDone || !g || !g.n.fade || audio.loop) return;
  const rem = audio.duration - audio.currentTime;
  if (!isFinite(rem) || rem > fx.fade + 0.25) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(0, t + Math.max(0.1, rem / (audio.playbackRate || 1)));
  fadeOutDone = true;
}

/* ============================================================================
 * 8. PLAYBACK UI
 * ========================================================================== */

function setStatus(msg, state) {
  if (E.npStatus.textContent !== msg) E.npStatus.textContent = msg;
  E.npStatus.dataset.s = state || '';
}
function paintRange(r) {
  const min = Number(r.min) || 0, max = Number(r.max) || 0;
  r.style.setProperty('--p', (max > min ? ((r.value - min) / (max - min)) * 100 : 0) + '%');
}
function setIcon(btn, id) { btn.querySelector('use').setAttribute('href', '#' + id); }

function updateProgress() {
  if (seeking) return;
  E.tCur.textContent = fmtTime(audio.currentTime);
  if (!E.seek.disabled) { E.seek.value = String(audio.currentTime); paintRange(E.seek); }
}
function updatePlayUI() {
  const playing = isPlaying();
  for (const b of [E.bPlay, E.miniPlay]) {
    setIcon(b, playing ? 'i-pause' : 'i-play');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
}
function updateNowPlaying() {
  E.npTitle.textContent = cur ? cur.n : 'Nothing playing';
  E.miniTitle.textContent = cur ? cur.n : 'Nothing playing';
  document.title = cur ? `${cur.n} — ${APP_NAME}` : APP_NAME;
  E.npCat.hidden = !cur;
  if (cur) {
    E.npCat.textContent = SOURCES[cur.c].label;
    E.npTrack.textContent = ctxPos >= 0 && ctxList.length ? `Track ${ctxPos + 1} of ${ctxList.length}` : 'From queue';
  } else E.npTrack.textContent = 'Choose a track from the library';
  E.seek.value = '0'; E.seek.disabled = true; E.seek.max = '0'; paintRange(E.seek);
  E.tCur.textContent = '0:00'; E.tDur.textContent = cur && cur.d ? fmtTime(cur.d) : '0:00';
  lastSec = -1;
  updateArt();
  updatePlayUI();
  paintMini();
}
function updateArt() {
  const name = cur ? cur.n : '';
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  h = Math.abs(h);
  E.artSvg.style.setProperty('--h', String(h % 360));
  E.artSheen.setAttribute('transform', `rotate(${(h >> 3) % 360} 100 100)`);
  E.artLetter.textContent = name ? Array.from(name)[0] : '';
}
function paintToggles() {
  E.bShuffle.setAttribute('aria-pressed', String(S.shuffle));
  E.bShuffle.setAttribute('aria-label', 'Shuffle: ' + (S.shuffle ? 'on' : 'off'));
  setIcon(E.bRepeat, S.repeat === 'one' ? 'i-repeat1' : 'i-repeat');
  E.bRepeat.setAttribute('aria-pressed', String(S.repeat !== 'off'));
  E.bRepeat.setAttribute('aria-label', 'Repeat: ' + (S.repeat === 'one' ? 'one track' : S.repeat));
  E.setRepeat.value = S.repeat; E.setShuffle.checked = S.shuffle;
}
function paintVolume() {
  const eff = S.muted ? 0 : S.vol;
  document.querySelectorAll('.js-vol').forEach((r) => { r.value = String(Math.round(S.vol * 100)); paintRange(r); });
  E.bMute.setAttribute('aria-pressed', String(S.muted));
  E.bMute.setAttribute('aria-label', S.muted ? 'Unmute' : 'Mute');
  setIcon(E.bMute, eff === 0 ? 'i-mute' : 'i-vol');
}
function paintVizButton() {
  E.btnViz.textContent = vizOn ? 'Visualizer ON' : 'Visualizer';
  E.btnViz.setAttribute('aria-pressed', String(vizOn));
}
function paintVizModes() {
  E.vizModes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === S.viz)));
  E.setViz.value = S.viz;
}
function updateProcUI() {
  const fxOn = fxActive();
  const blocked = !!cur && (fxOn || vizOn) && blockedHosts.has(hostOf(cur.s));
  const on = fxOn && !blocked;
  E.procStatus.textContent = on ? 'Audio Processing ON' : 'Audio Processing OFF';
  E.procBox.dataset.on = on ? '1' : '0';
  E.procNote.textContent = blocked ? 'This audio host does not allow processing (CORS), so this track plays natively.'
    : g ? (vizOn && !fxOn ? 'Visualizer is reading the audio.' : 'Routed through Web Audio.') : 'Native browser playback.';
  E.setProc.textContent = on ? 'ON' : 'OFF';
  E.btnTools.classList.toggle('on', on);
  E.procChip.hidden = !g;
  E.procChip.textContent = fxOn ? 'Processing on' : 'Analyser on';
  E.vizNote.hidden = !(vizOn && blocked);
}
function toast(msg, label, fn) {
  E.toastText.textContent = msg;
  E.toastBtn.hidden = !label;
  if (label) E.toastBtn.textContent = label;
  toastFn = fn || null;
  E.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { E.toast.hidden = true; }, label ? 7000 : 3500);
}
let toastTimer = 0, toastFn = null;

let playerVisible = true;
function paintMini() {
  const show = !!cur && !playerVisible;
  E.mini.hidden = !show;
  document.body.classList.toggle('has-mini', show);
}

/* ============================================================================
 * 9. VISUALIZER (single canvas, rAF only while ON, visible and playing)
 * ========================================================================== */

let raf = 0, lastDraw = 0, buf = null, vctx = null, dpr = 1, accent = '#d9b36c', bands = null, bandVals = null;

function initializeVisualizer() {
  if (vizOn) return;
  if (!(window.AudioContext || window.webkitAudioContext) || !E.vizCanvas.getContext) {
    toast('The visualizer is not supported in this browser. Playback is unaffected.');
    return;
  }
  vizOn = true;
  E.vizStage.hidden = false; E.artBox.hidden = true;
  paintVizButton(); paintVizModes();
  syncProcessing(true);
  if (vizOn) startLoop();
}
function destroyVisualizer() {
  if (!vizOn) return;
  vizOn = false;
  stopLoop();
  E.vizStage.hidden = true; E.artBox.hidden = false;
  releaseCanvas();
  buf = null; bands = null; bandVals = null;
  paintVizButton();
  syncProcessing(true);              // drops the analyser; closes the context if no effect needs it
}
function toggleVisualizer(force) {
  const on = force === undefined ? !vizOn : force;
  if (on) initializeVisualizer(); else destroyVisualizer();
}
function releaseCanvas() {
  E.vizCanvas.width = 0; E.vizCanvas.height = 0; vctx = null;
}
function configureAnalyser() {
  const a = g.analyser;
  a.smoothingTimeConstant = 0.82;
  a.fftSize = S.viz === 'wave' ? 1024 : 2048;
  buf = new Uint8Array(S.viz === 'wave' ? a.fftSize : a.frequencyBinCount);
  const nb = S.viz === 'bars' ? 32 : S.viz === 'circle' ? 48 : 64;
  const bins = a.frequencyBinCount, binHz = g.ctx.sampleRate / a.fftSize;
  const f0 = 45, f1 = Math.min(16000, g.ctx.sampleRate / 2 * 0.95);
  const edges = [];
  for (let i = 0; i <= nb; i++) edges.push(Math.min(bins - 1, Math.round(f0 * Math.pow(f1 / f0, i / nb) / binHz)));
  bands = { nb, edges }; bandVals = new Float32Array(nb);
}
function setVizMode(mode) {
  S.viz = mode; saveSettings(); paintVizModes();
  if (vizOn && g && g.analyser) { configureAnalyser(); if (vctx) vctx.clearRect(0, 0, E.vizCanvas.width, E.vizCanvas.height); }
}
function prepareCanvas() {
  const r = E.vizCanvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (E.vizCanvas.width !== w) E.vizCanvas.width = w;
  if (E.vizCanvas.height !== h) E.vizCanvas.height = h;
  vctx = vctx || E.vizCanvas.getContext('2d');
  accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
}
function startLoop() {
  if (raf || !vizOn || !g || !g.analyser || document.hidden || !isPlaying()) return;
  prepareCanvas();
  if (!vctx) return;
  raf = requestAnimationFrame(draw);
}
function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

function fillBands() {
  const { nb, edges } = bands;
  for (let i = 0; i < nb; i++) {
    const lo = edges[i], hi = Math.max(lo, edges[i + 1] - 1);
    let m = 0;
    for (let k = lo; k <= hi; k++) if (buf[k] > m) m = buf[k];
    bandVals[i] = m / 255;
  }
}
function drawBars(w, h) {
  const nb = bands.nb, gap = Math.max(2, w / nb * 0.22), bw = (w - gap * (nb - 1)) / nb;
  vctx.fillStyle = accent;
  for (let i = 0; i < nb; i++) {
    const bh = Math.max(2 * dpr, Math.pow(bandVals[i], 1.3) * h * 0.96);
    vctx.fillRect(i * (bw + gap), h - bh, bw, bh);
  }
}
function drawSpectrum(w, h) {
  const nb = bands.nb;
  vctx.beginPath(); vctx.moveTo(0, h);
  for (let i = 0; i < nb; i++) vctx.lineTo(i / (nb - 1) * w, h - Math.pow(bandVals[i], 1.2) * h * 0.92);
  vctx.lineTo(w, h); vctx.closePath();
  vctx.globalAlpha = 0.22; vctx.fillStyle = accent; vctx.fill();
  vctx.globalAlpha = 1; vctx.strokeStyle = accent; vctx.lineWidth = 2 * dpr; vctx.lineJoin = 'round'; vctx.stroke();
}
function drawCircle(w, h) {
  const m = Math.min(w, h), cx = w / 2, cy = h / 2, nb = bands.nb, seg = nb * 2;
  let bass = 0;
  for (let i = 0; i < 4; i++) bass += bandVals[i];
  const r0 = m * 0.22 * (1 + bass / 4 * 0.18), maxLen = m * 0.24;
  vctx.beginPath();
  for (let i = 0; i < seg; i++) {
    const v = Math.pow(bandVals[i < nb ? i : seg - 1 - i], 1.2);
    const a = i / seg * Math.PI * 2 - Math.PI / 2, c = Math.cos(a), s = Math.sin(a), len = 2 * dpr + v * maxLen;
    vctx.moveTo(cx + c * r0, cy + s * r0); vctx.lineTo(cx + c * (r0 + len), cy + s * (r0 + len));
  }
  vctx.lineWidth = Math.max(2 * dpr, Math.PI * 2 * r0 / seg * 0.55); vctx.lineCap = 'round';
  vctx.strokeStyle = accent; vctx.stroke();
}
function drawWave(w, h) {
  const n = buf.length, pts = Math.min(n, 256), step = n / pts;
  vctx.beginPath();
  for (let i = 0; i < pts; i++) {
    const y = h / 2 + ((buf[Math.floor(i * step)] - 128) / 128) * h * 0.45;
    if (i === 0) vctx.moveTo(0, y); else vctx.lineTo(i / (pts - 1) * w, y);
  }
  vctx.lineWidth = 2 * dpr; vctx.lineJoin = 'round'; vctx.strokeStyle = accent; vctx.stroke();
}
const DRAW = { spectrum: drawSpectrum, bars: drawBars, circle: drawCircle, wave: drawWave };

function draw(ts) {
  raf = requestAnimationFrame(draw);
  if (ts - lastDraw < (S.reduce ? 50 : 33)) return;     // ~20 fps with Reduce Motion, ~30 fps otherwise
  lastDraw = ts;
  const a = g && g.analyser;
  if (!a || !vctx || !buf || !bands) return;
  const w = E.vizCanvas.width, h = E.vizCanvas.height;
  vctx.clearRect(0, 0, w, h);
  if (S.viz === 'wave') a.getByteTimeDomainData(buf);
  else { a.getByteFrequencyData(buf); fillBands(); }
  DRAW[S.viz](w, h);
}

function handleVisibilityChange() {
  if (document.hidden) { stopLoop(); return; }
  lastSec = -1;
  if (cur) { updateProgress(); updatePlayUI(); }
  if (vizOn) startLoop();
}
function handleResize() { if (vizOn && raf) prepareCanvas(); }

/* ============================================================================
 * 10. MEDIA SESSION
 * ========================================================================== */

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !cur) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: cur.n, artist: SOURCES[cur.c].label, album: APP_NAME });
  } catch { /* unsupported metadata: ignore */ }
}
function setPlaybackState(s) { try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s; } catch { /* ignore */ } }
function updatePositionState() {
  try {
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(audio.duration) && audio.duration > 0) {
      navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) });
    }
  } catch { /* ignore */ }
}
function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* action unsupported */ } };
  set('play', resumeTrack);
  set('pause', pauseTrack);
  set('previoustrack', previousTrack);
  set('nexttrack', () => nextTrack(true));
  set('seekbackward', (d) => seekBy(-((d && d.seekOffset) || 10)));
  set('seekforward', (d) => seekBy((d && d.seekOffset) || 10));
  set('seekto', (d) => { if (d && d.seekTime != null && cur) audio.currentTime = d.seekTime; });
}

/* ============================================================================
 * 11. UI WIRING & KEYBOARD
 * ========================================================================== */

function openDialog(d) { if (d.open) return; if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
function closeDialog(d) { if (!d.open) return; if (d.close) d.close(); else d.removeAttribute('open'); }
function toggleDialog(d) { if (d.open) closeDialog(d); else openDialog(d); }

function toggleSearch(open) {
  const show = open === undefined ? E.searchRow.hidden : open;
  E.searchRow.hidden = !show;
  E.btnSearch.setAttribute('aria-expanded', String(show));
  if (show) E.searchInput.focus();
  else if (query) { E.searchInput.value = ''; query = ''; applyFilter(); }
}

function syncFxControls() {
  document.querySelectorAll('[data-fx]').forEach((inp) => {
    const k = inp.dataset.fx;
    inp.value = String(fx[k]);
    paintRange(inp);
    inp.parentNode.querySelector('output').textContent = FX_FMT[k](fx[k]);
  });
}
function onFxInput(e) {
  const inp = e.target.closest('[data-fx]');
  if (!inp) return;
  const k = inp.dataset.fx;
  fx[k] = Number(inp.value);
  inp.parentNode.querySelector('output').textContent = FX_FMT[k](fx[k]);
  paintRange(inp);
  syncProcessing(true);
}
function resetFx() { Object.assign(fx, FX_DEFAULT); syncFxControls(); syncProcessing(true); }

function onKey(e) {
  if (e.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;          // dialogs close themselves
    if (!E.searchRow.hidden) { toggleSearch(false); return; }
    if (vizOn) toggleVisualizer(false);
    return;
  }
  if (!S.keys || e.ctrlKey || e.metaKey || e.altKey) return;
  const tg = e.target, tag = tg.tagName;
  const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && tg.type !== 'range' && tg.type !== 'checkbox');
  if (typing) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((key === ' ' || key === 'Enter') && tg.closest('button, summary')) return;   // let focused buttons activate natively
  if (tag === 'INPUT' && tg.type === 'range' && key.startsWith('Arrow')) return;    // sliders keep their own arrows
  const letter = key.length === 1 && key !== ' ';
  if (letter && e.repeat) return;
  switch (key) {
    case ' ': togglePlay(); break;
    case 'ArrowLeft': seekBy(-5); break;
    case 'ArrowRight': seekBy(5); break;
    case 'ArrowUp': setVolume(S.vol + 0.05); break;
    case 'ArrowDown': setVolume(S.vol - 0.05); break;
    case 'm': toggleMute(); break;
    case 'n': nextTrack(true); break;
    case 'p': previousTrack(); break;
    case 'r': toggleRepeat(); break;
    case 's': toggleShuffle(); break;
    case 'v': toggleVisualizer(); break;
    case 'd': toggleDialog(E.dlgTools); break;
    case '/': toggleSearch(true); break;
    default: return;
  }
  e.preventDefault();
}

function bindUI() {
  // top bar
  E.btnSearch.addEventListener('click', () => toggleSearch());
  E.btnViz.addEventListener('click', () => toggleVisualizer());
  E.btnTools.addEventListener('click', () => openDialog(E.dlgTools));
  E.btnSettings.addEventListener('click', () => openDialog(E.dlgSettings));

  // dialogs: close buttons and backdrop click
  for (const d of [E.dlgTools, E.dlgSettings]) {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) closeDialog(d); });
  }

  // library
  document.querySelectorAll('.cat').forEach((b) => b.addEventListener('click', () => { if (b.dataset.cat !== curCat) loadCategory(b.dataset.cat); }));
  let searchTimer = 0;
  E.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = E.searchInput.value; applyFilter(); }, 80);
  });
  E.btnRefresh.addEventListener('click', () => { toast('Refreshing library…'); loadCategory(curCat, true); });
  E.libRetry.addEventListener('click', () => loadCategory(curCat, true));
  E.list.addEventListener('scroll', onListScroll, { passive: true });
  E.list.addEventListener('click', onListClick);

  // transport
  E.bPlay.addEventListener('click', togglePlay);
  E.miniPlay.addEventListener('click', togglePlay);
  E.bPrev.addEventListener('click', previousTrack);
  E.bNext.addEventListener('click', () => nextTrack(true));
  E.miniNext.addEventListener('click', () => nextTrack(true));
  E.miniTitle.addEventListener('click', () => E.player.scrollIntoView({ block: 'start' }));
  E.bShuffle.addEventListener('click', toggleShuffle);
  E.bRepeat.addEventListener('click', toggleRepeat);
  E.bBack.addEventListener('click', () => seekBy(-10));
  E.bFwd.addEventListener('click', () => seekBy(10));
  E.bMute.addEventListener('click', toggleMute);

  // seek bar: preview while dragging, commit on release
  const endSeek = () => { seeking = false; };
  E.seek.addEventListener('input', () => { seeking = true; E.tCur.textContent = fmtTime(Number(E.seek.value)); paintRange(E.seek); });
  E.seek.addEventListener('change', () => { if (cur) audio.currentTime = Number(E.seek.value); endSeek(); });
  E.seek.addEventListener('pointerup', endSeek, { passive: true });
  E.seek.addEventListener('blur', endSeek, { passive: true });

  // volume + speed (several controls share one setting)
  document.querySelectorAll('.js-vol').forEach((r) => r.addEventListener('input', () => setVolume(Number(r.value) / 100)));
  document.querySelectorAll('.js-speed').forEach((sel) => {
    for (const v of SPEEDS) sel.add(new Option(v + '×', String(v)));
    sel.value = String(S.rate);
    sel.addEventListener('change', () => setRate(sel.value));
  });

  // queue
  E.queueList.addEventListener('click', onQueueClick);
  E.bClearQueue.addEventListener('click', clearQueue);

  // visualizer styles
  E.vizModes.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setVizMode(b.dataset.mode); });

  // toast action
  E.toastBtn.addEventListener('click', () => { const f = toastFn; E.toast.hidden = true; if (f) f(); });

  // DJ tools
  E.dlgTools.addEventListener('input', onFxInput);
  E.fxReset.addEventListener('click', resetFx);
  E.setProcReset.addEventListener('click', resetFx);
  E.fxKeepPitch.addEventListener('change', () => setKeepPitch(E.fxKeepPitch.checked));

  // settings
  E.setTheme.addEventListener('change', () => { S.theme = E.setTheme.value; applyTheme(); saveSettings(); });
  E.setRepeat.addEventListener('change', () => setRepeat(E.setRepeat.value));
  E.setShuffle.addEventListener('change', () => { S.shuffle = E.setShuffle.checked; paintToggles(); saveSettings(); });
  E.setAutoplay.addEventListener('change', () => { S.autoplay = E.setAutoplay.checked; saveSettings(); });
  E.setAutoskip.addEventListener('change', () => { S.autoskip = E.setAutoskip.checked; saveSettings(); });
  E.setViz.addEventListener('change', () => setVizMode(E.setViz.value));
  E.setReduce.addEventListener('change', () => { S.reduce = E.setReduce.checked; applyTheme(); saveSettings(); });
  E.setKeys.addEventListener('change', () => { S.keys = E.setKeys.checked; saveSettings(); });

  // global
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('resize', handleResize, { passive: true });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { playerVisible = entries[entries.length - 1].isIntersecting; paintMini(); }, { threshold: 0.3 }).observe(E.player);
  }
}

function paintSettingsControls() {
  E.setTheme.value = S.theme;
  E.setAutoplay.checked = S.autoplay; E.setAutoskip.checked = S.autoskip;
  E.setReduce.checked = S.reduce; E.setKeys.checked = S.keys;
  E.fxKeepPitch.checked = S.keepPitch;
}

/* ============================================================================
 * 12. INIT
 * ========================================================================== */

function init() {
  cacheDom();
  applyTheme();
  // iOS ignores element.volume; hide the sliders there rather than show controls that do nothing.
  const probe = new Audio(); probe.volume = 0.5; volumeSupported = probe.volume === 0.5;
  if (!volumeSupported) document.querySelectorAll('.js-volwrap').forEach((n) => { n.hidden = true; });
  audio = makeAudio(false);
  bindUI();
  paintSettingsControls();
  paintToggles(); paintVolume(); paintVizButton(); paintVizModes();
  syncFxControls();
  updateProcUI();
  updateNowPlaying();
  renderQueue();
  initMediaSession();
  paintRange(E.seek);
  loadCategory(S.cat);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

})();

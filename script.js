/*
 * Alpha Music — focused music player. Vanilla JS, no dependencies.
 *
 *  - Library: text files from GitHub (cached in localStorage, shown instantly, refreshed in the background)
 *  - Virtual list: only ~20 DOM rows no matter how many songs there are
 *  - Queue: the "+" button on a song shows its queue number (1, 2, 3 …); tap again to remove
 *  - Next track is always decided in advance, shown under "Up next", and pre-downloaded in a second
 *    audio element so it starts instantly when the current song ends
 *  - Shuffle, repeat all, repeat one, 10 s skips, seek, volume, speed, Media Session (lock screen controls)
 */
'use strict';
(() => {

/* ============================== config & helpers ============================== */

const BASE = 'https://github.com/mdimrankhanalpha/Music/blob/main/Music.txt/';
const SOURCES = {
  bangla:  { label: 'Bangla',        file: 'Music%20Bangla.txt' },
  english: { label: 'English',       file: 'Music%20English.txt' },
  hindi:   { label: 'Hindi',         file: 'Music%20Hindi.txt' },
  other:   { label: 'Other',         file: 'Music%20Other.txt' },
  dj:      { label: 'DJ',            file: 'DJ.txt' },
  party:   { label: 'Party',         file: 'Party.txt' },
  sakrain: { label: 'For Sakrain',   file: 'For%20Sakrain.txt' },
  russian: { label: 'Music Russian', file: 'Music%20Russian.txt' }
};
const ORDER = Object.keys(SOURCES);
const KEY = 'am3:';
const TTL = 6 * 3600 * 1000;           // refresh the text files in the background at most every 6 h
let ROW_H = 52;                        // read from --row in style.css (phones use taller rows)
const OVER = 5;
const HISTORY_MAX = 60;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const REPEATS = ['off', 'all', 'one'];
const APP = 'Alpha Music';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const noop = () => {};
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const byName = (a, b) => collator.compare(a.n, b.n);

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* quota / private mode */ } }
};

const E = {};
['q', 'cats', 'list', 'spacer', 'msg', 'msgText', 'retry', 'art', 'artFb', 'artLetter', 'artImg', 'title', 'sub',
 'seek', 'tCur', 'tDur', 'bShuffle', 'bPrev', 'bBack', 'bPlay', 'bFwd', 'bNext', 'bRepeat', 'bMute', 'vol', 'volwrap',
 'speed', 'upText', 'qClear', 'toast', 'btnViz', 'btnDj', 'popViz', 'popDj', 'viz', 'djState', 'fxReset', 'fxPitch'].forEach((id) => { E[id] = $(id); });

/* ============================== settings ============================== */

const S = Object.assign({ vol: 1, muted: false, rate: 1, repeat: 'off', shuffle: false, cat: 'all', viz: 'spectrum', keepPitch: true }, store.get('s', {}));
if (S.cat !== 'all' && !SOURCES[S.cat]) S.cat = 'all';
if (!REPEATS.includes(S.repeat)) S.repeat = 'off';
S.vol = clamp(Number(S.vol) || 0, 0, 1);
S.rate = SPEEDS.includes(Number(S.rate)) ? Number(S.rate) : 1;
let saveTimer = 0;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('s', S), 300); }

/* ============================== library ============================== */

const lib = Object.create(null);       // category -> tracks[] (A-Z)
let curCat = S.cat;
let view = [];                         // what the list currently shows
let query = '';
let loading = 0;
const failed = new Set();

function toRawUrl(u) {
  const m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u;
}
function toPlayable(u) {
  const raw = toRawUrl(String(u || '').trim());
  try { return new URL(raw).href; } catch { return raw.replace(/ /g, '%20'); }
}

const isDash = (l) => /^[-–—]+$/.test(l);
const isImage = (u) => /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|#|$)/i.test(u);
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|webm|mp4)$/i;

function linksIn(line) {
  const pos = [], re = /https?:\/\//gi;
  let m;
  while ((m = re.exec(line))) pos.push(m.index);
  return pos.map((p, i) => line.slice(p, pos[i + 1] ?? line.length).trim());
}
function nameFromUrl(u) {
  let seg = u.split(/[?#]/)[0].split('/').pop() || u;
  try { seg = decodeURIComponent(seg); } catch { /* keep */ }
  return seg.replace(AUDIO_EXT, '') || seg;
}
function makeTrack(urls, cat) {
  if (!urls.length) return null;
  let a = urls[0], cv = urls[1] || '';
  if (cv && isImage(a) && !isImage(cv)) [a, cv] = [cv, a];
  const s = toPlayable(a);
  try { new URL(s); } catch { return null; }
  const n = nameFromUrl(a);
  return { n, s, cv: cv ? toPlayable(cv) : '', c: cat, k: n.toLowerCase(), bad: false };
}
function parse(text, cat) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).map((l) => l.trim());
  const hasDash = lines.some(isDash);
  const out = [];
  let urls = [];
  const flush = () => { const t = makeTrack(urls, cat); if (t) out.push(t); urls = []; };
  for (const line of lines) {
    if (isDash(line) || (!line && !hasDash)) { flush(); continue; }
    if (line) urls.push(...linksIn(line));
  }
  flush();
  return out.sort(byName);
}

function setCat(cat, text) {
  lib[cat] = parse(text, cat);
  lib.all = mergeAll();
  scheduleRefresh(false);
}
/* "All" shows each song once. A song listed in several playlists (same audio link) becomes one row carrying every tag. */
const dupKey = (u) => { let k = u; try { k = decodeURIComponent(u); } catch { /* keep */ } return k.replace(/ /g, '%20').toLowerCase(); };   // same link written with %28 or ( ) counts as the same song
function mergeAll() {
  const seen = new Map();
  const out = [];
  for (const c of ORDER) {
    for (const t of lib[c] || []) {
      const hit = seen.get(dupKey(t.s));
      if (hit) { if (!hit.cats.includes(c)) hit.cats.push(c); if (!hit.cv && t.cv) hit.cv = t.cv; }
      else { const m = Object.assign({}, t, { cats: [c] }); seen.set(dupKey(t.s), m); out.push(m); }
    }
  }
  return out.sort(byName);
}
const tagsOf = (t) => (t.cats && t.cats.length ? t.cats : [t.c]);
const tagText = (t) => tagsOf(t).map((c) => SOURCES[c].label).join(' · ');
async function loadCat(cat, force) {
  const cached = store.get('lib:' + cat, null);
  if (cached && typeof cached.text === 'string' && !force) {
    setCat(cat, cached.text);                         // instant: show what we already have
    if (Date.now() - cached.t < TTL) return;          // fresh enough: no network at all
  }
  loading++;
  try {
    const res = await fetch(toRawUrl(BASE + SOURCES[cat].file), { cache: force ? 'reload' : 'default' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (!cached || cached.text !== text || force) setCat(cat, text);
    store.set('lib:' + cat, { t: Date.now(), text });
    failed.delete(cat);
  } catch {
    if (!lib[cat]) failed.add(cat);
  } finally {
    loading--;
    scheduleRefresh(false);
  }
}
function loadAll(force) { failed.clear(); ORDER.forEach((c) => loadCat(c, force)); }

let rq = false, rqReset = false;
function scheduleRefresh(reset) {
  rqReset = rqReset || reset;
  if (rq) return;
  rq = true;
  requestAnimationFrame(() => { rq = false; const r = rqReset; rqReset = false; refreshView(r); });
}
function refreshView(reset) {
  const base = lib[curCat] || [];
  const q = query.trim().toLowerCase();
  if (!q) view = base;
  else { const toks = q.split(/\s+/); view = base.filter((t) => toks.every((x) => t.k.includes(x))); }
  E.list.classList.toggle('all', curCat === 'all');
  E.spacer.style.height = view.length * ROW_H + 'px';
  if (reset) E.list.scrollTop = 0;
  paintRows(true);
  paintCats();
  if (!view.length) {
    if (base.length) showMsg('No songs match your search.');
    else if (loading > 0) showMsg('Loading music…');
    else if (failed.size) showMsg('Music library unavailable.', true);
    else showMsg('No songs in this category.');
  } else hideMsg();
}
function showMsg(t, retry) { E.msgText.textContent = t; E.retry.hidden = !retry; E.msg.hidden = false; }
function hideMsg() { E.msg.hidden = true; }
function paintCats() {
  E.cats.querySelectorAll('.cat').forEach((b) => {
    const c = b.dataset.cat;
    b.setAttribute('aria-pressed', String(c === curCat));
    b.querySelector('.n').textContent = lib[c] ? lib[c].length : '';
  });
}
function chooseCat(cat) {
  if (cat === curCat) return;
  curCat = S.cat = cat; save();
  scheduleRefresh(true);
  revealCat();
}
/* phones: the category row scrolls sideways, so bring the chosen one to the middle */
function revealCat() {
  const b = E.cats.querySelector('.cat[data-cat="' + curCat + '"]');   // by name: the pressed highlight is only repainted a frame later
  const max = E.cats.scrollWidth - E.cats.clientWidth;
  if (!b || max <= 0) return;
  E.cats.scrollTo({ left: clamp(b.offsetLeft - (E.cats.clientWidth - b.offsetWidth) / 2, 0, max), behavior: 'smooth' });
}
function syncRowH() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row'));
  if (v > 0 && v !== ROW_H) { ROW_H = v; return true; }
  return false;
}

/* ============================== virtual list ============================== */

const pool = [];
let paintQueued = false;
const sameTrack = (a, b) => !!a && !!b && (a === b || a.s === b.s);

function makeRow() {
  const row = document.createElement('div');
  row.className = 'row'; row.setAttribute('role', 'listitem');
  row.innerHTML =
    '<button class="r-main" type="button"><span class="r-n"></span><span class="r-t"></span><span class="r-tags"></span></button>' +
    '<button class="r-q" type="button"><svg class="i"><use href="#i-plus"/></svg><b></b></button>';
  row._n = row.querySelector('.r-n'); row._t = row.querySelector('.r-t'); row._c = row.querySelector('.r-tags'); row._chips = [];
  row._m = row.firstChild; row._q = row.lastChild; row._b = row._q.querySelector('b');
  E.spacer.appendChild(row);
  return row;
}
function paintRows(force) {
  const h = E.list.clientHeight || 400;
  const first = Math.max(0, Math.floor(E.list.scrollTop / ROW_H) - OVER);
  const count = Math.max(0, Math.min(view.length - first, Math.ceil(h / ROW_H) + OVER * 2));
  while (pool.length < count) pool.push(makeRow());
  for (let k = 0; k < pool.length; k++) {
    const row = pool[k];
    if (k >= count) { if (!row.hidden) row.hidden = true; continue; }
    const i = first + k, t = view[i];
    const isCur = !!cur && t.s === cur.s;
    const qp = qmap.get(t.s) || 0;
    row.hidden = false;
    row.style.transform = 'translateY(' + i * ROW_H + 'px)';
    if (force || row._tr !== t || row._i !== i || row._cur !== isCur || row._qp !== qp || row._bad !== t.bad) {
      row._tr = t; row._i = i; row._cur = isCur; row._qp = qp; row._bad = t.bad;
      row.className = 'row' + (isCur ? ' cur' : '') + (t.bad ? ' bad' : '') + (qp ? ' inq' : '');
      row._n.textContent = i + 1;
      row._t.textContent = t.n;
      const tg = tagsOf(t);
      while (row._chips.length < tg.length) { const ch = document.createElement('span'); ch.className = 'r-c'; row._c.appendChild(ch); row._chips.push(ch); }
      row._chips.forEach((ch, j) => { if (j < tg.length) { ch.hidden = false; ch.textContent = SOURCES[tg[j]].label; } else ch.hidden = true; });
      row._b.textContent = qp || '';
      row._m.setAttribute('aria-label', (isCur && isPlaying() ? 'Pause ' : 'Play ') + t.n);
      row._q.setAttribute('aria-label', qp ? `Remove from queue (position ${qp}): ${t.n}` : 'Add to queue: ' + t.n);
    }
  }
}
E.list.addEventListener('scroll', () => {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintRows(false); });
}, { passive: true });
E.list.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const t = view[row._i];
  if (!t) return;
  if (e.target.closest('.r-q')) toggleQueued(t);
  else playTrack(t, { list: view });
});

/* ============================== queue ============================== */

const queue = [];
let qmap = new Map();                  // track url -> position (1-based)

function toggleQueued(t) {
  const i = queue.findIndex((x) => x.s === t.s);
  if (i >= 0) { queue.splice(i, 1); toast('Removed from queue'); }
  else { queue.push(t); toast('Added to queue · #' + queue.length); }
  queueChanged();
}
function clearQueue() { queue.length = 0; queueChanged(); toast('Queue cleared'); }
function queueChanged() {
  qmap = new Map(queue.map((t, i) => [t.s, i + 1]));
  paintRows(true);
  afterNextChanged();
}

/* ============================== playback engine ============================== */
/* Two audio elements: one plays, the other pre-downloads the next song. */

const A = [makeAudio(), makeAudio()];
let ai = 0;
let audio = A[0];
let pre = { s: '', el: null };
let cur = null;
let ctxList = [];
let ctxPos = -1;
const history = [];
let shufflePick = null;
let seeking = false, lastSec = -1, failStreak = 0, status = '';

const isPlaying = () => !!audio && !audio.paused && !audio.ended;

function makeAudio() {
  const el = new Audio();
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';                       // lets the visualizer / DJ tools read the sound (GitHub allows it)
  el.volume = S.vol; el.muted = S.muted;
  el.defaultPlaybackRate = S.rate; el.playbackRate = S.rate;
  el.preservesPitch = S.keepPitch !== false; el.webkitPreservesPitch = S.keepPitch !== false;
  const on = (type, fn) => el.addEventListener(type, (ev) => { if (el === audio) fn(ev); });
  on('loadstart', () => { if (cur && !cur.bad) setStatus('Loading…'); });
  on('waiting', () => setStatus('Buffering…'));
  on('canplay', () => { if (!el.error) setStatus(''); });
  on('playing', onPlaying);
  on('pause', () => { fadeReset(); stopLoop(); updatePlayUI(); setPlaybackState('paused'); paintRows(false); });
  on('ended', onEnded);
  on('timeupdate', onTimeUpdate);
  on('loadedmetadata', onMeta);
  on('durationchange', onMeta);
  on('seeked', () => { lastSec = -1; updateProgress(); updatePositionState(); });
  on('ratechange', updatePositionState);
  on('error', onError);
  return el;
}
const eachAudio = (fn) => A.forEach(fn);
const ensureCtx = () => { if (!ctxList.length) ctxList = view.length ? view : (lib.all || []); };

/* ---- choosing what plays next (decided in advance) ---- */
function pickShuffle() {
  const n = ctxList.length;
  if (!n) return null;
  if (n === 1) return ctxList[0];
  const recent = new Set(history.slice(-Math.min(8, n >> 1)).map((x) => x.s));
  if (cur) recent.add(cur.s);
  for (let i = 0; i < 12; i++) { const t = ctxList[(Math.random() * n) | 0]; if (!recent.has(t.s)) return t; }
  return ctxList[(Math.random() * n) | 0];
}
function peekNext(manual) {
  if (queue.length) return queue[0];
  ensureCtx();
  const n = ctxList.length;
  if (!n) return null;
  if (S.shuffle) return shufflePick || (shufflePick = pickShuffle());
  let p = ctxPos + 1;
  if (p >= n) { if (S.repeat === 'all' || manual) p = 0; else return null; }
  return ctxList[p];
}
function afterNextChanged() { updateUpNext(); if (cur) preloadNext(); }
function updateUpNext() {
  const n = cur ? peekNext(false) : null;
  E.upText.textContent = !cur ? '—' : n ? (queue.length ? `#1 · ${n.n}` : n.n) : 'End of list';
  E.qClear.hidden = !queue.length;
  E.qClear.textContent = `Clear queue (${queue.length})`;
}

/* ---- pre-download the next song in the idle element ---- */
function preloadNext() {
  const idle = A[1 - ai];
  const n = cur ? peekNext(false) : null;
  if (!n || (cur && n.s === cur.s)) {
    if (pre.s) { idle.removeAttribute('src'); idle.load(); pre = { s: '', el: null }; }
    return;
  }
  if (pre.s === n.s && pre.el === idle) return;
  idle.loop = false; idle.preload = 'auto';
  setCors(idle, n.s);
  idle.src = n.s; idle.load();
  pre = { s: n.s, el: idle };
}

/* ---- play ---- */
function playTrack(t, o = {}) {
  if (!t) return;
  if (sameTrack(t, cur) && !t.bad && !o.force) { togglePlay(); return; }
  if (cur && !sameTrack(t, cur) && !o.noHistory) { history.push(cur); if (history.length > HISTORY_MAX) history.shift(); }
  cur = t; t.bad = false;
  if (o.list) { ctxList = o.list; }
  ensureCtx();
  if (!o.fromQueue) { const idx = ctxList.findIndex((x) => x.s === t.s); if (idx >= 0) ctxPos = idx; }
  shufflePick = null;
  startAudio(t);
  updateNowPlaying();
  updateMediaSession();
  updateUpNext();
  paintRows(false);
}
function startAudio(t) {
  if (g && blocked.has(hostOf(t.s))) {                 // a host that forbids audio analysis cannot play once effects are on
    t.bad = true; audio.pause();
    setStatus('This audio host blocks effects, so it cannot play after DJ Tools or Visualizer were used. Reload the page to play it.', 'err');
    toast('Song unavailable with effects on'); updatePlayUI(); paintRows(false);
    return;
  }
  setStatus('Loading…');
  holdFade(); needFadeIn = true;
  const idle = A[1 - ai];
  if (pre.s === t.s && pre.el === idle && !idle.error) {
    // the next song was already downloaded: swap elements for an instant start
    const old = audio;
    old.pause();
    ai = 1 - ai; audio = idle; pre = { s: '', el: null };
    audio.loop = S.repeat === 'one';
    try { audio.currentTime = 0; } catch { /* not seekable yet */ }
    syncFromAudio();
    const p = audio.play();
    if (p && p.catch) p.catch((err) => {
      if (err && err.name === 'NotAllowedError') {   // some mobile browsers only allow the element that already played
        ai = 1 - ai; audio = old; audio.loop = S.repeat === 'one';
        setCors(audio, t.s); audio.src = t.s; audio.play().catch(onRejected);
      } else onRejected(err);
    });
    return;
  }
  audio.loop = S.repeat === 'one';
  setCors(audio, t.s);
  audio.src = t.s;
  const p = audio.play();
  if (p && p.catch) p.catch(onRejected);
}
function syncFromAudio() {
  lastSec = -1;
  onMeta(); updateProgress(); updatePlayUI();
  setStatus(audio.readyState >= 3 ? '' : 'Loading…');
}
function resume() {
  if (!cur) return;
  if (audio.error || !audio.getAttribute('src')) { cur.bad = false; setCors(audio, cur.s); audio.src = cur.s; setStatus('Loading…'); }
  if (g && g.ctx.state === 'suspended') g.ctx.resume().catch(noop);
  const p = audio.play();
  if (p && p.catch) p.catch(onRejected);
}
function pause() { audio.pause(); }
function togglePlay() {
  if (!cur) { startDefault(); return; }
  if (audio.paused || audio.ended) resume(); else pause();
}
function startDefault() {
  if (queue.length) { next(true); return; }
  if (!view.length) { toast('The library is still loading.'); return; }
  const t = S.shuffle ? view[(Math.random() * view.length) | 0] : view[0];
  playTrack(t, { list: view });
}
function seekBy(sec) {
  if (!cur || !isFinite(audio.duration)) return;
  audio.currentTime = clamp(audio.currentTime + sec, 0, audio.duration);
}
function next(manual = true) {
  const t = peekNext(manual);
  if (!t) { pause(); return; }
  const fromQueue = queue.length > 0 && queue[0] === t;
  if (fromQueue) { queue.shift(); qmap = new Map(queue.map((x, i) => [x.s, i + 1])); }
  playTrack(t, { force: true, fromQueue });
}
function previous() {
  if (!cur) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const h = history.pop();
  if (h) { playTrack(h, { noHistory: true, force: true }); return; }
  ensureCtx();
  const n = ctxList.length;
  if (!n) { audio.currentTime = 0; return; }
  playTrack(ctxList[(ctxPos - 1 + n) % n], { noHistory: true, force: true });
}
function toggleShuffle() { S.shuffle = !S.shuffle; shufflePick = null; paintToggles(); save(); afterNextChanged(); }
function toggleRepeat() {
  S.repeat = REPEATS[(REPEATS.indexOf(S.repeat) + 1) % REPEATS.length];
  audio.loop = S.repeat === 'one';
  paintToggles(); save(); afterNextChanged();
}
function setRate(v) { S.rate = Number(v); eachAudio((a) => { a.defaultPlaybackRate = S.rate; a.playbackRate = S.rate; }); E.speed.value = String(S.rate); save(); }
function setVolume(v) {
  S.vol = clamp(v, 0, 1);
  if (S.vol > 0 && S.muted) S.muted = false;
  eachAudio((a) => { a.volume = S.vol; a.muted = S.muted; });
  paintVolume(); save();
}
function toggleMute() { S.muted = !S.muted; eachAudio((a) => { a.muted = S.muted; }); paintVolume(); save(); }

/* ---- audio events ---- */
function onPlaying() {
  failStreak = 0; corsProbe = ''; setStatus('');
  if (needFadeIn) { needFadeIn = false; fadeIn(); }
  if (g && g.ctx.state === 'suspended') g.ctx.resume().catch(noop);
  updatePlayUI(); setPlaybackState('playing'); paintRows(false);
  startLoop();
  preloadNext();                                      // current song is flowing: now fetch the next one
}
function onEnded() {
  updatePlayUI();
  if (S.repeat === 'one') { audio.currentTime = 0; resume(); return; }
  next(false);
}
function onTimeUpdate() {
  if (g) maybeFadeOut();
  if (document.hidden || seeking) return;
  const s = Math.floor(audio.currentTime);
  if (s === lastSec) return;
  lastSec = s; updateProgress();
}
function onMeta() {
  const d = audio.duration;
  if (isFinite(d) && d > 0) { E.seek.max = String(Math.floor(d)); E.seek.disabled = false; E.tDur.textContent = fmtTime(d); }
  else { E.seek.max = '0'; E.seek.disabled = true; E.tDur.textContent = '0:00'; }
  updatePositionState();
}
function onRejected(err) {
  if (!err || err.name === 'AbortError') return;
  if (err.name === 'NotAllowedError') { setStatus('Press play to start.'); updatePlayUI(); }
}
function onError() {
  const err = audio.error;
  if (!err || err.code === 1 || !cur || !audio.getAttribute('src')) return;
  const h = hostOf(cur.s);
  // A host without CORS can fail on an analysis-ready element: retry once natively (only possible before effects are used)
  if (!g && audio.crossOrigin && !blocked.has(h)) {
    blocked.add(h); corsProbe = h;
    setCors(audio, cur.s); audio.src = cur.s; audio.play().catch(noop);
    return;
  }
  if (corsProbe === h) { blocked.delete(h); corsProbe = ''; }   // failed natively too: a dead link, not CORS
  cur.bad = true;
  setStatus(err.code === 2 ? 'Network error while loading this song.' : err.code === 3 ? 'This song could not be decoded.' : 'This song is unavailable.', 'err');
  updatePlayUI(); paintRows(false);
  if (++failStreak <= 5) { toast('Skipping an unavailable song'); next(false); }
}

/* ============================== audio graph: DJ tools + visualizer ============================== */
/* Built the first time Visualizer or DJ Tools is used. Until then playback is plain native <audio>. */

const FX_DEFAULT = { bass: 0, mid: 0, treble: 0, gain: 0, hp: 0, lp: 100, echo: 0, echoTime: 0.3, reverb: 0, fade: 0 };
const fx = Object.assign({}, FX_DEFAULT);
const fxActive = () => !!(fx.bass || fx.mid || fx.treble || fx.gain || fx.hp > 0 || fx.lp < 100 || fx.echo > 0 || fx.reverb > 0 || fx.fade > 0);
const sliderHz = (v) => 20 * Math.pow(1000, v / 100);          // 0..100 -> 20 Hz..20 kHz (log)
const dB = (v) => (v > 0 ? '+' : '') + v + ' dB';
const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz');
const FX_FMT = {
  bass: dB, mid: dB, treble: dB, gain: dB,
  hp: (v) => (v <= 0 ? 'Off' : fmtHz(sliderHz(v))), lp: (v) => (v >= 100 ? 'Off' : fmtHz(sliderHz(v))),
  echo: (v) => (v > 0 ? v + '%' : 'Off'), echoTime: (v) => Number(v).toFixed(2) + ' s',
  reverb: (v) => (v > 0 ? v + '%' : 'Off'), fade: (v) => (v > 0 ? v + ' s' : 'Off')
};
const VIZ_MODES = ['spectrum', 'bars', 'wave', 'circle'];
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

let g = null;                          // { ctx, n: nodes, srcs }
let vizOn = false;
let vizMode = VIZ_MODES.includes(S.viz) ? S.viz : 'spectrum';
let needFadeIn = false, fadeOutDone = false, corsProbe = '';
const blocked = new Set();             // hosts that do not allow audio analysis (no CORS)

function setCors(el, url) {
  if (blocked.has(hostOf(url))) el.removeAttribute('crossorigin'); else el.crossOrigin = 'anonymous';
}
function applyPitch() {
  eachAudio((a) => { a.preservesPitch = S.keepPitch; a.webkitPreservesPitch = S.keepPitch; a.mozPreservesPitch = S.keepPitch; });
}
function makeIR(ctx) {                 // generated reverb tail: no file download
  const len = Math.floor(ctx.sampleRate * 1.8);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
  }
  return b;
}
function ensureGraph() {
  if (g) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast('This browser does not support effects.'); return false; }
  if (cur && blocked.has(hostOf(cur.s))) { toast('This song’s host does not allow effects.'); return false; }
  let ctx = null;
  try {
    ctx = new AC({ latencyHint: 'playback' });
    const n = {};
    const bq = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
    n.in = ctx.createGain();
    n.bass = bq('lowshelf', 120); n.mid = bq('peaking', 1000, 0.9); n.treble = bq('highshelf', 4000);
    n.hp = bq('highpass', 20, 0.707); n.lp = bq('lowpass', 20000, 0.707);
    n.gain = ctx.createGain();
    n.fxIn = ctx.createGain(); n.fxOut = ctx.createGain();
    n.delay = ctx.createDelay(1); n.fb = ctx.createGain(); n.eWet = ctx.createGain(); n.rWet = ctx.createGain(); n.conv = null;
    n.fade = ctx.createGain(); n.an = ctx.createAnalyser();
    n.fb.gain.value = 0.38; n.eWet.gain.value = 0; n.rWet.gain.value = 0;
    const chain = [n.in, n.bass, n.mid, n.treble, n.hp, n.lp, n.gain, n.fxIn];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    n.fxIn.connect(n.fxOut);                                           // dry
    n.fxIn.connect(n.delay); n.delay.connect(n.eWet); n.eWet.connect(n.fxOut);
    n.delay.connect(n.fb); n.fb.connect(n.delay);                      // echo feedback
    // safety limiter: catches peaks so heavy bass boosts get louder-sounding instead of crackling
    n.lim = ctx.createDynamicsCompressor();
    n.lim.threshold.value = -3; n.lim.knee.value = 0; n.lim.ratio.value = 20; n.lim.attack.value = 0.003; n.lim.release.value = 0.12;
    n.fxOut.connect(n.fade); n.fade.connect(n.lim); n.lim.connect(n.an); n.an.connect(ctx.destination);
    const srcs = A.map((el) => { const s = ctx.createMediaElementSource(el); s.connect(n.in); return s; });
    g = { ctx, n, srcs };
  } catch (err) {
    if (ctx) ctx.close().catch(noop);
    g = null;
    toast('Effects are not supported here. Normal playback is unaffected.');
    return false;
  }
  ctx.resume().catch(noop);
  configureAnalyser(); applyFx();
  return true;
}
function applyFx() {
  if (!g) return;
  const { ctx, n } = g, t = ctx.currentTime;
  const to = (p, v) => p.setTargetAtTime(v, t, 0.02);                  // smooth, no clicks
  to(n.bass.gain, fx.bass); to(n.mid.gain, fx.mid); to(n.treble.gain, fx.treble);
  to(n.hp.frequency, fx.hp > 0 ? sliderHz(fx.hp) : 20);
  to(n.lp.frequency, fx.lp < 100 ? sliderHz(fx.lp) : 20000);
  to(n.gain.gain, Math.pow(10, fx.gain / 20));
  to(n.delay.delayTime, fx.echoTime); to(n.eWet.gain, fx.echo / 100 * 0.8);
  if (fx.reverb > 0 && !n.conv) {
    n.conv = ctx.createConvolver(); n.conv.buffer = makeIR(ctx);
    n.fxIn.connect(n.conv); n.conv.connect(n.rWet); n.rWet.connect(n.fxOut);
  }
  to(n.rWet.gain, fx.reverb / 100 * 0.9);
  if (fx.fade === 0) { n.fade.gain.cancelScheduledValues(t); n.fade.gain.setValueAtTime(1, t); fadeOutDone = false; }
}

/* ---- fade between songs (scheduled on the audio thread) ---- */
function holdFade() {
  if (!g || fx.fade <= 0) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(0, t);
}
function fadeIn() {
  if (!g || fx.fade <= 0) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(0, t); p.linearRampToValueAtTime(1, t + fx.fade);
  fadeOutDone = false;
}
function fadeReset() {
  if (!g) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(1, t);
  fadeOutDone = false;
}
function maybeFadeOut() {
  if (fadeOutDone || !g || fx.fade <= 0 || audio.loop) return;
  const rem = audio.duration - audio.currentTime;
  if (!isFinite(rem) || rem > fx.fade + 0.25) return;
  const p = g.n.fade.gain, t = g.ctx.currentTime;
  p.cancelScheduledValues(t); p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(0, t + Math.max(0.1, rem / (audio.playbackRate || 1)));
  fadeOutDone = true;
}

/* ---- DJ tools panel ---- */
function syncFxControls() {
  E.popDj.querySelectorAll('[data-fx]').forEach((inp) => {
    const k = inp.dataset.fx;
    inp.value = String(fx[k]); paintRange(inp);
    inp.parentNode.querySelector('output').textContent = FX_FMT[k](fx[k]);
  });
  E.fxPitch.checked = S.keepPitch !== false;
}
function updateDjState() {
  const on = fxActive();
  E.djState.textContent = on ? 'ON' : 'OFF';
  E.popDj.dataset.on = on ? '1' : '0';
  E.btnDj.classList.toggle('on', on);
}
function onFxInput(e) {
  const inp = e.target.closest('[data-fx]');
  if (!inp) return;
  const k = inp.dataset.fx;
  fx[k] = Number(inp.value);
  inp.parentNode.querySelector('output').textContent = FX_FMT[k](fx[k]);
  paintRange(inp);
  if (!g) {
    if (!fxActive()) { updateDjState(); return; }
    if (!ensureGraph()) { resetFx(); return; }
  }
  applyFx(); updateDjState();
}
function resetFx() { Object.assign(fx, FX_DEFAULT); syncFxControls(); applyFx(); updateDjState(); }

/* ---- visualizer: drawn only on the cover photo ---- */
let raf = 0, lastDraw = 0, vctx = null, dpr = 1, vgrad = null, ro = null;
let buf = null, bands = null, bandVals = null;

function configureAnalyser() {
  if (!g) return;
  const a = g.n.an;
  a.smoothingTimeConstant = 0.82;
  a.fftSize = vizMode === 'wave' ? 1024 : 2048;
  buf = new Uint8Array(vizMode === 'wave' ? a.fftSize : a.frequencyBinCount);
  const nb = vizMode === 'bars' ? 32 : vizMode === 'circle' ? 48 : 64;
  const bins = a.frequencyBinCount, binHz = g.ctx.sampleRate / a.fftSize;
  const f0 = 45, f1 = Math.min(16000, g.ctx.sampleRate / 2 * 0.95);
  const edges = [];
  for (let i = 0; i <= nb; i++) edges.push(Math.min(bins - 1, Math.round(f0 * Math.pow(f1 / f0, i / nb) / binHz)));
  bands = { nb, edges }; bandVals = new Float32Array(nb);
}
function setViz(mode) {
  if (mode === 'off') {
    vizOn = false; stopLoop();
    E.art.classList.remove('viz');
    if (ro) { ro.disconnect(); ro = null; }
    vctx = null; E.viz.width = 0; E.viz.height = 0;
    paintVizUi();
    return;
  }
  if (!VIZ_MODES.includes(mode) || !ensureGraph()) return;
  vizMode = S.viz = mode; save();
  vizOn = true;
  E.art.classList.add('viz');
  configureAnalyser();
  prepareCanvas();
  if ('ResizeObserver' in window && !ro) { ro = new ResizeObserver(prepareCanvas); ro.observe(E.art); }
  paintVizUi();
  startLoop();
}
function paintVizUi() {
  E.btnViz.classList.toggle('on', vizOn);
  E.btnViz.setAttribute('aria-pressed', String(vizOn));
  E.popViz.querySelectorAll('[data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(vizOn ? b.dataset.mode === vizMode : b.dataset.mode === 'off'));
  });
}
function prepareCanvas() {
  const r = E.art.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (E.viz.width !== w) E.viz.width = w;
  if (E.viz.height !== h) E.viz.height = h;
  vctx = E.viz.getContext('2d');
  vgrad = vctx.createLinearGradient(0, h, 0, 0);
  vgrad.addColorStop(0, '#7d3dff'); vgrad.addColorStop(0.55, '#c13bd0'); vgrad.addColorStop(1, '#ff2e57');
}
function startLoop() {
  if (raf || !vizOn || !g || document.hidden || !isPlaying()) return;
  if (!vctx) prepareCanvas();
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
  vctx.fillStyle = vgrad;
  for (let i = 0; i < nb; i++) {
    const bh = Math.max(3 * dpr, Math.pow(bandVals[i], 1.3) * h * 0.92);
    vctx.fillRect(i * (bw + gap), h - bh, bw, bh);
  }
}
function drawSpectrum(w, h) {
  const nb = bands.nb;
  vctx.beginPath(); vctx.moveTo(0, h);
  for (let i = 0; i < nb; i++) vctx.lineTo(i / (nb - 1) * w, h - Math.pow(bandVals[i], 1.2) * h * 0.9);
  vctx.lineTo(w, h); vctx.closePath();
  vctx.globalAlpha = 0.5; vctx.fillStyle = vgrad; vctx.fill();
  vctx.globalAlpha = 1; vctx.strokeStyle = vgrad; vctx.lineWidth = 2.5 * dpr; vctx.lineJoin = 'round'; vctx.stroke();
}
function drawCircle(w, h) {
  const m = Math.min(w, h), cx = w / 2, cy = h / 2, nb = bands.nb, seg = nb * 2;
  let bass = 0;
  for (let i = 0; i < 4; i++) bass += bandVals[i];
  const r0 = m * 0.2 * (1 + bass / 4 * 0.2), maxLen = m * 0.26;
  vctx.beginPath();
  for (let i = 0; i < seg; i++) {
    const v = Math.pow(bandVals[i < nb ? i : seg - 1 - i], 1.2);
    const a = i / seg * Math.PI * 2 - Math.PI / 2, c = Math.cos(a), s = Math.sin(a), len = 3 * dpr + v * maxLen;
    vctx.moveTo(cx + c * r0, cy + s * r0); vctx.lineTo(cx + c * (r0 + len), cy + s * (r0 + len));
  }
  vctx.lineWidth = Math.max(3 * dpr, Math.PI * 2 * r0 / seg * 0.55); vctx.lineCap = 'round';
  vctx.strokeStyle = vgrad; vctx.stroke();
}
function drawWave(w, h) {
  const n = buf.length, pts = Math.min(n, 256), step = n / pts;
  vctx.beginPath();
  for (let i = 0; i < pts; i++) {
    const y = h / 2 + ((buf[Math.floor(i * step)] - 128) / 128) * h * 0.42;
    if (i === 0) vctx.moveTo(0, y); else vctx.lineTo(i / (pts - 1) * w, y);
  }
  vctx.lineWidth = 3 * dpr; vctx.lineJoin = 'round'; vctx.strokeStyle = vgrad; vctx.stroke();
}
const DRAW = { spectrum: drawSpectrum, bars: drawBars, circle: drawCircle, wave: drawWave };
function draw(ts) {
  raf = requestAnimationFrame(draw);
  if (ts - lastDraw < 33) return;                       // ~30 fps
  lastDraw = ts;
  const a = g && g.n.an;
  if (!a || !vctx || !buf || !bands) return;
  const w = E.viz.width, h = E.viz.height;
  vctx.clearRect(0, 0, w, h);
  if (vizMode === 'wave') a.getByteTimeDomainData(buf);
  else { a.getByteFrequencyData(buf); fillBands(); }
  DRAW[vizMode](w, h);
}

/* ---- floating panels (overlay: they never take layout space) ---- */
let openPop = null;
function placePop(pop, btn) {
  const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.maxHeight = Math.max(160, window.innerHeight - r.bottom - 20) + 'px';
  const w = pop.offsetWidth;
  pop.style.left = Math.max(10, Math.min(r.right - w, window.innerWidth - w - 10)) + 'px';
}
function closePop() {
  if (!openPop) return;
  openPop.pop.hidden = true; openPop.btn.setAttribute('aria-expanded', 'false'); openPop = null;
}
function togglePop(pop, btn) {
  if (openPop && openPop.pop === pop) { closePop(); return; }
  closePop();
  pop.hidden = false; placePop(pop, btn);
  btn.setAttribute('aria-expanded', 'true');
  openPop = { pop, btn };
}
function bindTools() {
  E.btnViz.addEventListener('click', () => togglePop(E.popViz, E.btnViz));
  E.btnDj.addEventListener('click', () => togglePop(E.popDj, E.btnDj));
  E.popViz.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    setViz(b.dataset.mode); closePop();
  });
  E.popDj.addEventListener('input', onFxInput);
  E.fxReset.addEventListener('click', resetFx);
  E.fxPitch.addEventListener('change', () => { S.keepPitch = E.fxPitch.checked; applyPitch(); save(); });
  document.addEventListener('pointerdown', (e) => {
    if (openPop && !e.target.closest('.pop') && !e.target.closest('.tb')) closePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  window.addEventListener('resize', () => { if (openPop) placePop(openPop.pop, openPop.btn); }, { passive: true });
}

/* ============================== UI ============================== */

function setStatus(msg, kind) { status = msg; E.sub.dataset.s = kind || ''; updateSub(); }
function updateSub() {
  E.sub.textContent = status || (cur ? tagText(cur) : 'Tap any track in the list');
}
function paintRange(r) {
  const min = Number(r.min) || 0, max = Number(r.max) || 0;
  r.style.setProperty('--p', (max > min ? ((r.value - min) / (max - min)) * 100 : 0) + '%');
}
const setIcon = (btn, id) => btn.querySelector('use').setAttribute('href', '#' + id);

function updateProgress() {
  if (seeking) return;
  E.tCur.textContent = fmtTime(audio.currentTime);
  if (!E.seek.disabled) { E.seek.value = String(audio.currentTime); paintRange(E.seek); }
}
function updatePlayUI() {
  const p = isPlaying();
  setIcon(E.bPlay, p ? 'i-pause' : 'i-play');
  E.bPlay.setAttribute('aria-label', p ? 'Pause' : 'Play');
}
function updateNowPlaying() {
  E.title.textContent = cur ? cur.n : 'Choose a song';
  document.title = cur ? `${cur.n} — ${APP}` : APP;
  E.seek.value = '0'; E.seek.disabled = true; E.seek.max = '0'; paintRange(E.seek);
  E.tCur.textContent = '0:00'; E.tDur.textContent = '0:00';
  lastSec = -1;
  updateSub();
  updateArt();
  updatePlayUI();
  onMeta(); updateProgress();                         // a pre-downloaded song already knows its length: do not wipe it
}
function updateArt() {
  const name = cur ? cur.n : '';
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  h = Math.abs(h);
  E.artFb.style.setProperty('--h', String((300 + (h % 80)) % 360));   // magenta .. red range keeps the theme
  E.artLetter.textContent = name ? Array.from(name)[0] : '♪';
  const img = E.artImg;
  img.onload = img.onerror = null;
  img.hidden = true;
  if (!cur || !cur.cv) { img.removeAttribute('src'); return; }
  const url = cur.cv;
  img.onload = () => { if (cur && cur.cv === url) img.hidden = false; };
  img.onerror = () => { img.hidden = true; };
  img.src = url;
}
function paintToggles() {
  E.bShuffle.setAttribute('aria-pressed', String(S.shuffle));
  E.bShuffle.setAttribute('aria-label', 'Shuffle: ' + (S.shuffle ? 'on' : 'off'));
  setIcon(E.bRepeat, S.repeat === 'one' ? 'i-repeat1' : 'i-repeat');
  E.bRepeat.setAttribute('aria-pressed', String(S.repeat !== 'off'));
  E.bRepeat.setAttribute('aria-label', 'Repeat: ' + (S.repeat === 'one' ? 'one song' : S.repeat === 'all' ? 'all songs' : 'off'));
}
function paintVolume() {
  E.vol.value = String(Math.round(S.vol * 100)); paintRange(E.vol);
  const eff = S.muted ? 0 : S.vol;
  E.bMute.setAttribute('aria-pressed', String(S.muted));
  E.bMute.setAttribute('aria-label', S.muted ? 'Unmute' : 'Mute');
  setIcon(E.bMute, eff === 0 ? 'i-mute' : 'i-vol');
}
let toastTimer = 0;
function toast(msg) {
  E.toast.textContent = msg; E.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { E.toast.hidden = true; }, 2200);
}

/* ============================== media session ============================== */

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !cur) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.n, artist: tagText(cur), album: APP, artwork: cur.cv ? [{ src: cur.cv }] : []
    });
  } catch { /* ignore */ }
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
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported */ } };
  set('play', resume); set('pause', pause);
  set('previoustrack', previous); set('nexttrack', () => next(true));
  set('seekbackward', (d) => seekBy(-((d && d.seekOffset) || 10)));
  set('seekforward', (d) => seekBy((d && d.seekOffset) || 10));
  set('seekto', (d) => { if (d && d.seekTime != null && cur) audio.currentTime = d.seekTime; });
}

/* ============================== wiring ============================== */

function bind() {
  E.cats.addEventListener('click', (e) => { const b = e.target.closest('.cat'); if (b) chooseCat(b.dataset.cat); });
  let st = 0;
  E.q.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { query = E.q.value; scheduleRefresh(true); }, 80); });
  E.retry.addEventListener('click', () => { showMsg('Loading music…'); loadAll(true); });

  E.bPlay.addEventListener('click', togglePlay);
  E.bPrev.addEventListener('click', previous);
  E.bNext.addEventListener('click', () => next(true));
  E.bBack.addEventListener('click', () => seekBy(-10));
  E.bFwd.addEventListener('click', () => seekBy(10));
  E.bShuffle.addEventListener('click', toggleShuffle);
  E.bRepeat.addEventListener('click', toggleRepeat);
  E.bMute.addEventListener('click', toggleMute);
  E.qClear.addEventListener('click', clearQueue);

  const endSeek = () => { seeking = false; };
  E.seek.addEventListener('input', () => { seeking = true; E.tCur.textContent = fmtTime(Number(E.seek.value)); paintRange(E.seek); });
  E.seek.addEventListener('change', () => { if (cur) audio.currentTime = Number(E.seek.value); endSeek(); });
  E.seek.addEventListener('pointerup', endSeek, { passive: true });
  E.seek.addEventListener('blur', endSeek, { passive: true });

  E.vol.addEventListener('input', () => setVolume(Number(E.vol.value) / 100));
  for (const v of SPEEDS) E.speed.add(new Option(v + '×', String(v)));
  E.speed.value = String(S.rate);
  E.speed.addEventListener('change', () => setRate(E.speed.value));

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target, tag = tg.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && tg.type !== 'range')) return;
    if ((e.key === ' ' || e.key === 'Enter') && tg.closest('button')) return;
    if (tag === 'INPUT' && tg.type === 'range' && e.key.startsWith('Arrow')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (k) {
      case ' ': togglePlay(); break;
      case 'ArrowLeft': seekBy(-5); break;
      case 'ArrowRight': seekBy(5); break;
      case 'ArrowUp': setVolume(S.vol + 0.05); break;
      case 'ArrowDown': setVolume(S.vol - 0.05); break;
      case 'm': toggleMute(); break;
      case 'n': next(true); break;
      case 'p': previous(); break;
      case 'r': toggleRepeat(); break;
      case 's': toggleShuffle(); break;
      case '/': E.q.focus(); break;
      default: return;
    }
    e.preventDefault();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cur) { lastSec = -1; updateProgress(); updatePlayUI(); } });
  window.addEventListener('resize', () => { if (syncRowH()) scheduleRefresh(false); else paintRows(true); }, { passive: true });
}

function init() {
  // iOS ignores element.volume: hide the slider there instead of showing a dead control
  const probe = new Audio(); probe.volume = 0.5;
  if (probe.volume !== 0.5) E.volwrap.remove();
  bind();
  paintToggles(); paintVolume(); updateNowPlaying(); updateUpNext();
  syncFxControls(); updateDjState(); paintVizUi(); bindTools();
  initMediaSession();
  paintRange(E.seek);
  syncRowH();
  paintCats();
  requestAnimationFrame(revealCat);
  showMsg('Loading music…');
  loadAll(false);
  scheduleRefresh(false);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

})();

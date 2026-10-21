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
  sakrain: { label: 'For Sakrain',   file: 'For%20Sakrain.txt' },
  russian: { label: 'Music Russian', file: 'Music%20Russian.txt' }
};
const ORDER = Object.keys(SOURCES);
const KEY = 'am3:';
const TTL = 6 * 3600 * 1000;           // refresh the text files in the background at most every 6 h
const ROW_H = 52;                      // keep equal to --row in style.css
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
 'speed', 'upText', 'qClear', 'toast'].forEach((id) => { E[id] = $(id); });

/* ============================== settings ============================== */

const S = Object.assign({ vol: 1, muted: false, rate: 1, repeat: 'off', shuffle: false, cat: 'all' }, store.get('s', {}));
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
  lib.all = ORDER.flatMap((c) => lib[c] || []).sort(byName);
  scheduleRefresh(false);
}
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
}

/* ============================== virtual list ============================== */

const pool = [];
let paintQueued = false;
const sameTrack = (a, b) => !!a && !!b && (a === b || a.s === b.s);

function makeRow() {
  const row = document.createElement('div');
  row.className = 'row'; row.setAttribute('role', 'listitem');
  row.innerHTML =
    '<button class="r-main" type="button"><span class="r-n"></span><span class="r-t"></span><span class="r-c"></span></button>' +
    '<button class="r-q" type="button"><svg class="i"><use href="#i-plus"/></svg><b></b></button>';
  row._n = row.querySelector('.r-n'); row._t = row.querySelector('.r-t'); row._c = row.querySelector('.r-c');
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
      row._c.textContent = SOURCES[t.c].label;
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
  el.volume = S.vol; el.muted = S.muted;
  el.defaultPlaybackRate = S.rate; el.playbackRate = S.rate;
  el.preservesPitch = true; el.webkitPreservesPitch = true;
  const on = (type, fn) => el.addEventListener(type, (ev) => { if (el === audio) fn(ev); });
  on('loadstart', () => { if (cur && !cur.bad) setStatus('Loading…'); });
  on('waiting', () => setStatus('Buffering…'));
  on('canplay', () => { if (!el.error) setStatus(''); });
  on('playing', onPlaying);
  on('pause', () => { updatePlayUI(); setPlaybackState('paused'); paintRows(false); });
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
  setStatus('Loading…');
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
        audio.src = t.s; audio.play().catch(onRejected);
      } else onRejected(err);
    });
    return;
  }
  audio.loop = S.repeat === 'one';
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
  if (audio.error || !audio.getAttribute('src')) { cur.bad = false; audio.src = cur.s; setStatus('Loading…'); }
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
  failStreak = 0; setStatus('');
  updatePlayUI(); setPlaybackState('playing'); paintRows(false);
  preloadNext();                                      // current song is flowing: now fetch the next one
}
function onEnded() {
  updatePlayUI();
  if (S.repeat === 'one') { audio.currentTime = 0; resume(); return; }
  next(false);
}
function onTimeUpdate() {
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
  cur.bad = true;
  setStatus(err.code === 2 ? 'Network error while loading this song.' : err.code === 3 ? 'This song could not be decoded.' : 'This song is unavailable.', 'err');
  updatePlayUI(); paintRows(false);
  if (++failStreak <= 5) { toast('Skipping an unavailable song'); next(false); }
}

/* ============================== UI ============================== */

function setStatus(msg, kind) { status = msg; E.sub.dataset.s = kind || ''; updateSub(); }
function updateSub() {
  E.sub.textContent = status || (cur ? SOURCES[cur.c].label : 'Tap any track in the list');
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
      title: cur.n, artist: SOURCES[cur.c].label, album: APP, artwork: cur.cv ? [{ src: cur.cv }] : []
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
  window.addEventListener('resize', () => paintRows(true), { passive: true });
}

function init() {
  // iOS ignores element.volume: hide the slider there instead of showing a dead control
  const probe = new Audio(); probe.volume = 0.5;
  if (probe.volume !== 0.5) E.volwrap.remove();
  bind();
  paintToggles(); paintVolume(); updateNowPlaying(); updateUpNext();
  initMediaSession();
  paintRange(E.seek);
  paintCats();
  showMsg('Loading music…');
  loadAll(false);
  scheduleRefresh(false);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

})();

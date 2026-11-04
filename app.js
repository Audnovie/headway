/* Headway: compare commutes from several starting points to one destination at a time.
   Everything runs in your browser. Google Maps Platform (Routes API, Geocoding API and
   the Maps JavaScript API) does the routing, using the key you enter in Settings. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const VERSION = '1.0.0';
  const TZ = 'America/Toronto';
  const PACIFIC = 'America/Los_Angeles'; // Google's free amounts reset on the 1st, Pacific time
  const KEYS = {
    data: 'headway:v1:data',
    apiKey: 'headway:v1:apikey',
    results: 'headway:v1:results',
    usage: 'headway:v1:usage',
  };
  const DAY_MS = 86400000;
  const RESULT_TTL_MS = 30 * DAY_MS; // saved results delete themselves after 30 days
  const COORD_TTL_MS = 30 * DAY_MS; // map coordinates are refreshed from the place ID after 30 days
  const MATRIX_CHUNK = 40; // Google allows up to 100 transit pairs per request; we send at most 40
  const ALL_START_MINUTES = [480, 540, 600, 660, 720, 780]; // 8 AM to 1 PM, on the hour
  const SHIFT_START_OPTIONS = [480, 510, 540, 570, 600, 630, 660, 690, 720, 750, 780]; // 8:00 AM to 1:00 PM
  const MAX_DAYS_AHEAD = 95; // Google plans transit up to about 100 days ahead
  const FREE = { matrixEss: 10000, matrixPro: 5000, routesEss: 10000, geocode: 10000, mapLoads: 10000 };
  const USAGE_LABELS = {
    matrixEss: 'Transit and walking times',
    matrixPro: 'Car times with traffic',
    routesEss: 'Trip details',
    geocode: 'Address lookups',
    mapLoads: 'Map loads',
  };
  const USAGE_NOTES = {
    matrixEss: 'One per starting point per trip. Car times also use one each here for a no-traffic first estimate.',
    matrixPro: 'One per starting point per car trip.',
    routesEss: 'One each time you open a trip you haven’t opened before.',
    geocode: 'One per address you add, plus a refresh every 30 days.',
    mapLoads: 'One each time the app opens with your key.',
  };
  const GTA_BOUNDS = { south: 43.4, west: -80.1, north: 44.1, east: -78.9 };
  const GTA_CENTER = { lat: 43.7, lng: -79.55 };
  const MATRIX_FIELDS = ['condition', 'durationMillis', 'distanceMeters', 'localizedValues', 'error'];
  const MAX_PLACES = 300;
  const ROUTE_FIELDS = ['durationMillis', 'distanceMeters', 'legs', 'path', 'localizedValues', 'travelAdvisory'];
  const DEFAULT_SETTINGS = {
    shiftHours: 8,
    arriveEarlyMin: 10,
    walkLimitKm: 5,
    shiftsPerWeek: 5,
    transitPref: 'FASTEST',
    dayType: 'weekday',
    customDate: '',
    shiftStart: 480,
    sortBy: 'round',
    selectedDestId: null,
    demo: false,
    stopAtFree: true,
  };
  const TRANSIT_PREFS = { FASTEST: 'Fastest', FEWER_TRANSFERS: 'Fewer transfers', LESS_WALKING: 'Less walking' };
  const DAY_TYPES = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday', date: 'Pick a date' };
  const SORTS = { round: 'Round trip', there: 'Trip there', home: 'Trip home', distance: 'Distance' };

  // ---------------------------------------------------------------- state
  const state = {
    data: { places: [], settings: { ...DEFAULT_SETTINGS } },
    results: {},
    usage: { month: '', counts: {} },
    apiKey: '',
    view: 'compare',
    provider: null,
    providerStatus: 'none', // none | loading | ready | error
    providerError: '',
    providerGen: 0, // goes up every time the routing source changes, so old requests can tell they're stale
    sampleResults: {}, // sample mode results live only in memory and never mix with real ones
    busy: false,
    busyText: '',
    activeRuns: new Set(),
    inflight: new Set(),
    compareError: '',
    compareNote: '',
    keyErrors: new Map(), // trip key -> why Google couldn't answer it (shown until it's checked again)
    detail: null, // { startId, dir, opener, scrollY }
    detailInflight: new Set(),
    detailErrors: new Map(),
    lookingUp: false,
    focusStartId: null,
    addDraft: '',
    addKind: 'start',
    addLog: [],
    adding: false,
    storageFull: false,
    toastTimer: 0,
  };

  // ---------------------------------------------------------------- small helpers
  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    setAttrs(el, attrs);
    appendKids(el, kids);
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    setAttrs(el, attrs);
    appendKids(el, kids);
    return el;
  }
  function setAttrs(el, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  function appendKids(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function debounce(fn, ms) {
    let t = 0;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function withTimeout(promise, ms, message) {
    let t = 0;
    return Promise.race([
      promise.finally(() => clearTimeout(t)),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); }),
    ]);
  }
  function hashStr(str) {
    let x = 2166136261;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }
  function haversineKm(a, b) {
    if (!hasCoords(a) || !hasCoords(b)) return null;
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  const hasCoords = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  function fmtDur(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    const m = Math.max(1, Math.round(sec / 60));
    if (m < 60) return `${m} min`;
    const hh = Math.floor(m / 60), mm = m % 60;
    return mm ? `${hh} h ${mm} min` : `${hh} h`;
  }
  function fmtKm(km) {
    if (km == null) return '';
    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  }
  function fmtMeters(m) {
    if (m == null) return '';
    return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  }
  function firstPart(text) {
    const t = String(text || '').trim();
    return (t.split(',')[0] || t).trim();
  }
  const displayName = (p) => (p && (p.name || firstPart(p.address || p.input))) || 'Unnamed place';
  function safeColor(c) {
    if (typeof c !== 'string') return '';
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
    return m ? '#' + m[1] : '';
  }
  function readableOn(hex) {
    const c = safeColor(hex);
    if (!c) return '#ffffff';
    let v = c.slice(1);
    if (v.length === 3) v = v.split('').map((ch) => ch + ch).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
      .map((u) => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 0.45 ? '#111111' : '#ffffff';
  }
  function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  // ---------------------------------------------------------------- storage
  const Store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  function normalizePlace(p) {
    if (!p || typeof p !== 'object') return null;
    const kind = p.kind === 'dest' ? 'dest' : p.kind === 'start' ? 'start' : null;
    if (!kind) return null;
    const lat = Number(p.lat), lng = Number(p.lng);
    const ok = p.lat != null && p.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    return {
      id: String(p.id || uid()).slice(0, 64),
      kind,
      name: String(p.name || '').slice(0, 60),
      input: String(p.input || p.address || '').slice(0, 300),
      address: String(p.address || '').slice(0, 300),
      placeId: p.placeId ? String(p.placeId).slice(0, 300) : '',
      lat: ok ? lat : null,
      lng: ok ? lng : null,
      coordsAt: Number(p.coordsAt) || 0,
      partial: !!p.partial,
      sample: !!p.sample,
    };
  }
  function normalizeSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    s.shiftHours = clamp(Number(s.shiftHours) || DEFAULT_SETTINGS.shiftHours, 1, 14);
    s.arriveEarlyMin = clamp(Math.round(Number(s.arriveEarlyMin)), 0, 90) || 0;
    s.walkLimitKm = clamp(Number(s.walkLimitKm), 0, 20);
    if (!Number.isFinite(s.walkLimitKm)) s.walkLimitKm = DEFAULT_SETTINGS.walkLimitKm;
    s.shiftsPerWeek = clamp(Math.round(Number(s.shiftsPerWeek)), 0, 7);
    if (!Number.isFinite(s.shiftsPerWeek)) s.shiftsPerWeek = DEFAULT_SETTINGS.shiftsPerWeek;
    if (!TRANSIT_PREFS[s.transitPref]) s.transitPref = 'FASTEST';
    if (!DAY_TYPES[s.dayType]) s.dayType = 'weekday';
    s.customDate = /^\d{4}-\d{2}-\d{2}$/.test(String(s.customDate || '')) ? s.customDate : '';
    s.shiftStart = SHIFT_START_OPTIONS.includes(Number(s.shiftStart)) ? Number(s.shiftStart) : DEFAULT_SETTINGS.shiftStart;
    if (!SORTS[s.sortBy]) s.sortBy = 'round';
    s.selectedDestId = s.selectedDestId ? String(s.selectedDestId) : null;
    s.demo = !!s.demo;
    s.stopAtFree = s.stopAtFree !== false;
    return s;
  }
  function normalizeData(raw) {
    const places = Array.isArray(raw && raw.places) ? raw.places.map(normalizePlace).filter(Boolean).slice(0, MAX_PLACES) : [];
    return { places, settings: normalizeSettings(raw && raw.settings) };
  }
  function saveData() {
    if (!Store.set(KEYS.data, state.data)) toast('Couldn’t save on this device. Storage may be full or turned off.');
  }
  // Real results are saved on the device; sample-mode results only live in memory.
  const currentStore = () => (state.data.settings.demo ? state.sampleResults : state.results);
  function pruneStore(store) {
    const now = Date.now();
    let removed = 0;
    for (const [k, e] of Object.entries(store)) {
      if (!e || typeof e !== 'object' || !Number.isFinite(e.at) || now - e.at > RESULT_TTL_MS || now < e.at - DAY_MS) { delete store[k]; removed++; }
    }
    return removed;
  }
  function pruneResults() {
    if (pruneStore(state.results)) persistResults();
    pruneStore(state.sampleResults);
  }
  function persistResults() {
    if (Store.set(KEYS.results, state.results)) { setStorageFull(false); return; }
    // Out of space: save a smaller copy (trip details first, then the oldest quarter at a time).
    // Everything stays usable in the app until it's closed.
    const copy = { ...state.results };
    for (let attempt = 0; attempt < 6; attempt++) {
      const entries = Object.entries(copy).sort((a, b) => {
        const ad = a[0].startsWith('R|') ? 0 : 1, bd = b[0].startsWith('R|') ? 0 : 1;
        return ad - bd || a[1].at - b[1].at;
      });
      if (!entries.length) break;
      const drop = Math.max(1, Math.ceil(entries.length / 4));
      for (const [k] of entries.slice(0, drop)) delete copy[k];
      if (Store.set(KEYS.results, copy)) break;
    }
    setStorageFull(true);
  }
  function setStorageFull(v) {
    if (state.storageFull === v) return;
    state.storageFull = v;
    renderBanner();
  }
  function getResultIn(store, key) {
    const e = store[key];
    if (!e) return null;
    if (Date.now() - e.at > RESULT_TTL_MS) { delete store[key]; return null; }
    return e;
  }
  const getResult = (key) => getResultIn(currentStore(), key);
  function putResult(key, v, dateStr, store) {
    (store || currentStore())[key] = { at: Date.now(), date: dateStr || '', v };
  }
  function saveStore(store) { if (store === state.results) persistResults(); }

  // ---------------------------------------------------------------- time (always Toronto time)
  const partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const stampFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

  function tzParts(date) {
    const o = {};
    for (const p of partsFmt.formatToParts(date)) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, s: +o.second };
  }
  // The instant when Toronto clocks show `minutes` after midnight on the given date.
  function zonedDate(ymd, minutes) {
    const target = Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 0, minutes);
    let guess = target;
    for (let i = 0; i < 4; i++) {
      const p = tzParts(new Date(guess));
      const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
      const next = guess + (target - seen);
      if (next === guess) break;
      guess = next;
    }
    return new Date(guess);
  }
  function todayToronto() { const p = tzParts(new Date()); return { y: p.y, mo: p.mo, d: p.d }; }
  function addDays(ymd, n) {
    const t = new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d + n));
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const dow = (ymd) => new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d)).getUTCDay();
  const ymdStr = (ymd) => `${ymd.y}-${String(ymd.mo).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`;
  const dateLabel = (ymd) => dayFmt.format(new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 12)));
  const daysBetween = (a, b) => Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / DAY_MS);
  // Skip days when transit usually runs a holiday schedule.
  const isHolidayWindow = (ymd) => (ymd.mo === 12 && ymd.d >= 24) || (ymd.mo === 1 && ymd.d <= 2) || (ymd.mo === 7 && ymd.d === 1);

  function resolveTripDay(s) {
    const today = todayToronto();
    if (s.dayType === 'date') {
      if (!s.customDate) return { error: 'Pick a date for the trip.' };
      const [y, mo, d] = s.customDate.split('-').map(Number);
      const ymd = { y, mo, d };
      const diff = daysBetween(today, ymd);
      if (diff < 1) return { error: 'Pick a date after today.' };
      if (diff > MAX_DAYS_AHEAD) return { error: `Pick a date within the next ${MAX_DAYS_AHEAD} days. Google only plans transit about 100 days ahead.` };
      return { ymd, key: 'date:' + s.customDate, label: dateLabel(ymd), typical: false };
    }
    const want = s.dayType === 'saturday' ? [6] : s.dayType === 'sunday' ? [0] : [2, 3, 4];
    for (let i = 1; i <= 21; i++) {
      const c = addDays(today, i);
      if (want.includes(dow(c)) && !isHolidayWindow(c)) return { ymd: c, key: s.dayType, label: dateLabel(c), typical: true };
    }
    return { error: 'Couldn’t find a day to check.' };
  }
  function clockLabel(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    const h24 = Math.floor(m / 60), mm = m % 60;
    const label = `${((h24 + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
    return minutes >= 1440 ? `${label} (next day)` : label;
  }
  const clockOf = (ms) => clockFmt.format(new Date(ms));
  const stampOf = (ms) => stampFmt.format(new Date(ms));
  function shortHour(minutes) {
    const h24 = Math.floor(minutes / 60) % 24, mm = minutes % 60;
    const h12 = ((h24 + 11) % 12) + 1;
    return `${h12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h24 < 12 ? 'AM' : 'PM'}`;
  }

  // ---------------------------------------------------------------- usage meter (this device only)
  function pacificMonth() {
    const o = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, year: 'numeric', month: '2-digit' }).formatToParts(new Date())) o[p.type] = p.value;
    return `${o.year}-${o.month}`;
  }
  function usageCounts() {
    const m = pacificMonth();
    if (!state.usage || state.usage.month !== m || typeof state.usage.counts !== 'object') {
      state.usage = { month: m, counts: {} };
      Store.set(KEYS.usage, state.usage);
    }
    return state.usage.counts;
  }
  function addUsageFor(provider, kind, n) {
    if (!n || !provider || provider.name !== 'google') return;
    const c = usageCounts();
    c[kind] = (c[kind] || 0) + n;
    Store.set(KEYS.usage, state.usage);
    renderUsageChip();
  }
  function usagePeak() {
    const c = usageCounts();
    let peak = 0;
    for (const k of Object.keys(FREE)) peak = Math.max(peak, (c[k] || 0) / FREE[k]);
    return peak;
  }
  // Ask before a request would take this device's count past a free amount.
  function confirmUsage(planned) {
    if (!state.provider || state.provider.name !== 'google' || !state.data.settings.stopAtFree) return true;
    const c = usageCounts();
    const over = Object.entries(planned).filter(([k, n]) => n > 0 && (c[k] || 0) + n > FREE[k]);
    if (!over.length) return true;
    const lines = over.map(([k, n]) => `• ${USAGE_LABELS[k]}: ${(c[k] || 0).toLocaleString()} used, this needs ${n.toLocaleString()} more (free amount ${FREE[k].toLocaleString()} a month)`);
    return window.confirm(`This goes past Google’s free monthly amount, as counted on this device:\n\n${lines.join('\n')}\n\nGoogle charges for anything past the free amount. Continue?`);
  }

  // ---------------------------------------------------------------- providers
  function friendlyError(e) {
    const msg = String((e && (e.message || e.code)) || e || 'Unknown error');
    const short = msg.length > 220 ? msg.slice(0, 220) + '…' : msg;
    if (/REQUEST_DENIED|PERMISSION_DENIED|API key|ApiNotActivated|not activated|not authorized|billing|referer|referrer|403/i.test(msg)) {
      return `Google refused the request. Check that Routes API and Geocoding API are turned on for your key, billing is on, and the key allows this website. (${short})`;
    }
    if (/OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(msg)) {
      return `Google says a usage limit was reached (your daily cap or Google’s per-minute limit). Try again later. (${short})`;
    }
    if (/network|Failed to fetch|offline|timed out|timeout/i.test(msg)) return `Couldn’t reach Google. Check your connection and try again. (${short})`;
    return `Google returned an error: ${short}`;
  }

  // Google's dynamic library import bootstrap loader, unchanged (Apache 2.0):
  // https://developers.google.com/maps/documentation/javascript/load-maps-js-api
  function installMapsBootstrap(params) {
    /* eslint-disable */
    (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})(params);
    /* eslint-enable */
  }

  function normItem(it) {
    if (!it) return { error: 'Google sent no answer for this trip.' };
    if (it.error) return { error: String(it.error.message || it.error) };
    if (it.condition === 'ROUTE_NOT_FOUND') return { noRoute: true };
    const ms = it.durationMillis;
    if (ms == null || !Number.isFinite(ms)) return { error: 'Google sent no travel time for this trip.' };
    const fare = it.localizedValues && it.localizedValues.transitFare;
    return { sec: Math.round(ms / 1000), m: Number.isFinite(it.distanceMeters) ? it.distanceMeters : null, fare: fare ? String(fare) : '' };
  }
  // Works for LatLng (lat() and lng() methods) and LatLngAltitude or plain objects (lat and lng numbers).
  function pointOf(obj) {
    if (!obj) return null;
    const la = typeof obj.lat === 'function' ? obj.lat() : obj.lat;
    const ln = typeof obj.lng === 'function' ? obj.lng() : obj.lng;
    return Number.isFinite(la) && Number.isFinite(ln) ? [Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5] : null;
  }
  function thinPath(path, max) {
    const pts = [];
    for (const p of path || []) { const q = pointOf(p); if (q) pts.push(q); }
    if (pts.length <= max) return pts;
    const stepSize = (pts.length - 1) / (max - 1);
    const out = [];
    for (let i = 0; i < max; i++) out.push(pts[Math.round(i * stepSize)]);
    return out;
  }
  function normRoute(r) {
    if (!r) return { noRoute: true };
    const steps = [];
    for (const leg of r.legs || []) {
      for (const st of leg.steps || []) {
        const td = st.transitDetails || null;
        const line = td && td.transitLine;
        const vehicle = line && line.vehicle;
        steps.push({
          mode: td ? 'TRANSIT' : String(st.travelMode || 'WALKING'),
          sec: st.staticDurationMillis != null ? Math.round(st.staticDurationMillis / 1000) : null,
          m: Number.isFinite(st.distanceMeters) ? st.distanceMeters : null,
          path: thinPath(st.path, 80),
          transit: td ? {
            line: String((line && (line.shortName || line.name)) || ''),
            lineName: String((line && line.name) || ''),
            color: safeColor(line && line.color),
            textColor: safeColor(line && line.textColor),
            vehicle: String((vehicle && vehicle.name) || ''),
            headsign: String(td.headsign || ''),
            from: String((td.departureStop && td.departureStop.name) || ''),
            to: String((td.arrivalStop && td.arrivalStop.name) || ''),
            dep: td.departureTime ? +td.departureTime : null,
            arr: td.arrivalTime ? +td.arrivalTime : null,
            stops: Number.isFinite(td.stopCount) ? td.stopCount : null,
          } : null,
        });
      }
    }
    let fare = (r.localizedValues && r.localizedValues.transitFare) || '';
    if (!fare && r.travelAdvisory && r.travelAdvisory.transitFare) fare = String(r.travelAdvisory.transitFare);
    const sumSec = steps.reduce((a, x) => a + (x.sec || 0), 0);
    return {
      sec: r.durationMillis != null && Number.isFinite(r.durationMillis) ? Math.round(r.durationMillis / 1000) : (sumSec || null),
      m: Number.isFinite(r.distanceMeters) ? r.distanceMeters : null,
      fare: String(fare || ''),
      steps,
      path: steps.length ? [] : thinPath(r.path, 300),
    };
  }

  function makeGoogleProvider(apiKey, gen) {
    let libs = null;
    let matrixFields = MATRIX_FIELDS;
    let routeFields = ROUTE_FIELDS;
    const pt = (p) => ({ lat: p.lat, lng: p.lng });
    const isFieldError = (e) => /field|mask/i.test(String(e && (e.message || e)));
    return {
      name: 'google',
      get libs() { return libs; },
      async init() {
        window.gm_authFailure = () => {
          if (gen !== state.providerGen || state.data.settings.demo) return; // a newer source is in charge
          onProviderError('Google turned down this API key. Check that it’s copied correctly, billing is on, Maps JavaScript API, Routes API and Geocoding API are turned on, and the key allows this website.');
        };
        if (!(window.google && window.google.maps && typeof window.google.maps.importLibrary === 'function')) {
          installMapsBootstrap({ key: apiKey, v: 'weekly', language: 'en', region: 'CA', authReferrerPolicy: 'origin' });
        }
        const names = ['core', 'maps', 'routes', 'geocoding'];
        const loaded = await Promise.all(names.map((n) => window.google.maps.importLibrary(n)));
        libs = Object.fromEntries(names.map((n, i) => [n, loaded[i]]));
      },
      async geocode(text) {
        const geocoder = new libs.geocoding.Geocoder();
        let res;
        try {
          res = await geocoder.geocode({ address: text, region: 'ca', bounds: GTA_BOUNDS, fulfillOnZeroResults: true });
        } catch (e) {
          if (/ZERO_RESULTS/i.test(String((e && (e.code || e.message)) || e))) return null;
          throw e;
        }
        const r = res && res.results && res.results[0];
        if (!r) return null;
        const q = pointOf(r.geometry && r.geometry.location);
        if (!q) return null;
        return { address: r.formatted_address || text, placeId: r.place_id || '', lat: q[0], lng: q[1], partial: !!r.partial_match };
      },
      async geocodePlaceId(placeId) {
        const geocoder = new libs.geocoding.Geocoder();
        const res = await geocoder.geocode({ placeId });
        const r = res && res.results && res.results[0];
        const q = pointOf(r && r.geometry && r.geometry.location);
        return q ? { lat: q[0], lng: q[1] } : null;
      },
      async matrix(origins, destinations, o) {
        const { RouteMatrix } = libs.routes;
        const req = {
          origins: origins.map(pt),
          destinations: destinations.map(pt),
          travelMode: o.mode,
          fields: matrixFields,
          region: 'ca',
          language: 'en-CA',
        };
        if (o.arrivalTime) req.arrivalTime = o.arrivalTime;
        else if (o.departureTime) req.departureTime = o.departureTime;
        if (o.mode === 'DRIVING') req.routingPreference = o.routing || 'TRAFFIC_UNAWARE';
        if (o.mode === 'TRANSIT' && o.transitPref && o.transitPref !== 'FASTEST') req.transitPreference = { routingPreference: o.transitPref };
        let resp;
        try {
          resp = await RouteMatrix.computeRouteMatrix(req);
        } catch (e) {
          if (matrixFields[0] === '*' || !isFieldError(e)) throw e;
          matrixFields = ['*']; // fall back to "all fields" if Google rejects a field name
          resp = await RouteMatrix.computeRouteMatrix({ ...req, fields: matrixFields });
        }
        const rows = (resp && resp.matrix && resp.matrix.rows) || [];
        return origins.map((_, i) => destinations.map((__, j) => normItem(rows[i] && rows[i].items && rows[i].items[j])));
      },
      async route(origin, destination, o) {
        const { Route } = libs.routes;
        const req = {
          origin: pt(origin),
          destination: pt(destination),
          travelMode: 'TRANSIT',
          fields: routeFields,
          region: 'ca',
          language: 'en-CA',
        };
        if (o.arrivalTime) req.arrivalTime = o.arrivalTime;
        else if (o.departureTime) req.departureTime = o.departureTime;
        if (o.transitPref && o.transitPref !== 'FASTEST') req.transitPreference = { routingPreference: o.transitPref };
        let resp;
        try {
          resp = await Route.computeRoutes(req);
        } catch (e) {
          if (routeFields[0] === '*' || !isFieldError(e)) throw e;
          routeFields = ['*'];
          resp = await Route.computeRoutes({ ...req, fields: routeFields });
        }
        const r = resp && resp.routes && resp.routes[0];
        return r ? normRoute(r) : { noRoute: true };
      },
    };
  }

  // Sample mode: made-up but consistent times so you can try every feature without Google.
  function makeDemoProvider() {
    const minuteOfDay = (date) => { const p = tzParts(date); return p.h * 60 + p.mi; };
    const dayOfWeek = (date) => { const p = tzParts(date); return dow({ y: p.y, mo: p.mo, d: p.d }); };
    const jitter = (a, b) => hashStr(`${a.lat},${a.lng}|${b.lat},${b.lng}`) % 9;
    function transitMinutes(a, b, at, dir, pref) {
      const km = haversineKm(a, b) || 0;
      const t = minuteOfDay(at);
      const wd = dayOfWeek(at);
      let m = 9 + km * 3.1 + jitter(a, b);
      if (wd === 0 || wd === 6) m += 7;
      if (t >= 19 * 60) m += 5;
      if (pref === 'FEWER_TRANSFERS') m += 3;
      if (pref === 'LESS_WALKING') m += 2;
      if (dir === 'home' && t >= 20 * 60 + 30 && km > 14) return null; // pretend the last bus has gone
      return Math.round(m);
    }
    return {
      name: 'demo',
      libs: null,
      async init() {},
      async geocode(text) {
        await sleep(40);
        const x = hashStr(text.toLowerCase());
        return {
          address: `${text} (sample location)`,
          placeId: `sample-${x}`,
          lat: Math.round((43.62 + ((x % 1000) / 1000) * 0.28) * 1e5) / 1e5,
          lng: Math.round((-79.85 + (((x >>> 10) % 1000) / 1000) * 0.55) * 1e5) / 1e5,
          partial: false,
        };
      },
      async geocodePlaceId() { return null; },
      async matrix(origins, destinations, o) {
        await sleep(120);
        const at = o.arrivalTime || o.departureTime || new Date();
        return origins.map((a) => destinations.map((b) => {
          const km = haversineKm(a, b) || 0;
          if (o.mode === 'TRANSIT') {
            const mins = transitMinutes(a, b, at, o.arrivalTime ? 'there' : 'home', o.transitPref);
            return mins == null ? { noRoute: true } : { sec: mins * 60, m: Math.round(km * 1300), fare: '$3.00 (sample)' };
          }
          if (o.mode === 'WALKING') return { sec: Math.round(km * 1.3 * 12 * 60), m: Math.round(km * 1300), fare: '' };
          const base = 4 + km * 1.25 * 1.3;
          let f = 1;
          if (o.routing === 'TRAFFIC_AWARE') {
            const t = minuteOfDay(at);
            f = (t >= 420 && t <= 570) || (t >= 930 && t <= 1110) ? 1.45 : 1.05;
          }
          return { sec: Math.round(base * f * 60), m: Math.round(km * 1400), fare: '' };
        }));
      },
      async route(a, b, o) {
        await sleep(120);
        const dir = o.arrivalTime ? 'there' : 'home';
        const at = o.arrivalTime || o.departureTime;
        const mins = transitMinutes(a, b, at, dir, o.transitPref);
        if (mins == null) return { noRoute: true };
        const km = haversineKm(a, b) || 0;
        const walk1 = 5, walk2 = 4, transfer = km > 12 ? 3 : 0;
        const ride = Math.max(4, mins - walk1 - walk2 - transfer);
        const rides = transfer ? [Math.round(ride * 0.55), ride - Math.round(ride * 0.55)] : [ride];
        const lerp = (f) => [Math.round((a.lat + (b.lat - a.lat) * f) * 1e5) / 1e5, Math.round((a.lng + (b.lng - a.lng) * f) * 1e5) / 1e5];
        const seg = (f0, f1, n = 8) => Array.from({ length: n + 1 }, (_, i) => lerp(f0 + ((f1 - f0) * i) / n));
        let t = dir === 'there' ? +at - mins * 60000 - 2 * 60000 : +at + 4 * 60000;
        const steps = [];
        const add = (minutes, f0, f1, transit) => {
          const st = { mode: transit ? 'TRANSIT' : 'WALKING', sec: minutes * 60, m: Math.round(km * 1300 * (f1 - f0)), path: seg(f0, f1), transit: null };
          if (transit) st.transit = { ...transit, dep: t, arr: t + minutes * 60000 };
          steps.push(st);
          t += minutes * 60000;
        };
        add(walk1, 0, 0.04);
        add(rides[0], 0.04, rides.length > 1 ? 0.5 : 0.96, { line: '11', lineName: 'Sample Line', color: '#2F7D32', textColor: '#ffffff', vehicle: 'Bus', headsign: 'Sample Terminal', from: 'Sample Stop A', to: rides.length > 1 ? 'Sample Hub' : 'Sample Stop B', stops: 9 });
        if (rides.length > 1) {
          add(transfer, 0.5, 0.52);
          add(rides[1], 0.52, 0.96, { line: '501', lineName: 'Sample Express', color: '#1565C0', textColor: '#ffffff', vehicle: 'Bus', headsign: 'Sample Centre', from: 'Sample Hub', to: 'Sample Stop B', stops: 7 });
        }
        add(walk2, 0.96, 1);
        return { sec: mins * 60, m: Math.round(km * 1300), fare: '$3.00 (sample)', steps, path: [] };
      },
    };
  }

  const SAMPLE_PLACES = [
    { kind: 'start', name: 'Sample home A', lat: 43.68517, lng: -79.75988 },
    { kind: 'start', name: 'Sample home B', lat: 43.72064, lng: -79.70213 },
    { kind: 'start', name: 'Sample home C', lat: 43.64895, lng: -79.62311 },
    { kind: 'start', name: 'Sample home D', lat: 43.77612, lng: -79.79521 },
    { kind: 'dest', name: 'Sample job 1', lat: 43.65325, lng: -79.38318 },
    { kind: 'dest', name: 'Sample job 2', lat: 43.59312, lng: -79.64412 },
  ];

  // ---------------------------------------------------------------- map
  function makeMarkerClass(OverlayView) {
    return class HtmlMarker extends OverlayView {
      constructor(pos, el) {
        super();
        this.pos = pos;
        this.el = el;
        if (typeof OverlayView.preventMapHitsAndGesturesFrom === 'function') OverlayView.preventMapHitsAndGesturesFrom(el);
      }
      onAdd() { const panes = this.getPanes(); if (panes) panes.overlayMouseTarget.appendChild(this.el); }
      draw() {
        const proj = this.getProjection();
        const p = proj && proj.fromLatLngToDivPixel(this.pos);
        if (!p) return;
        this.el.style.left = p.x + 'px';
        this.el.style.top = p.y + 'px';
      }
      onRemove() { this.el.remove(); }
    };
  }
  function pinElement(p) {
    const label = displayName(p);
    return h('button', {
      type: 'button',
      class: 'pin' + (p.kind === 'dest' ? ' is-dest' : ''),
      'aria-label': (p.kind === 'dest' ? 'Destination: ' : 'Starting point: ') + label,
      title: label,
      onclick: (e) => { e.stopPropagation(); onPinClick(p.id, e.detail === 0); }, // detail 0 means Enter or Space
    }, h('span', { class: 'tag', text: label }));
  }

  const MapView = {
    el: null,
    kind: 'schematic', // schematic | google
    map: null,
    libs: null,
    Marker: null,
    markers: new Map(),
    lines: [],
    fitKey: '',
    overlayKey: '',
    mount(el) { this.el = el; },
    useGoogle(libs, provider) {
      this.libs = libs;
      this.el.replaceChildren();
      this.markers.clear();
      this.lines = [];
      this.fitKey = '';
      this.overlayKey = '';
      this.map = new libs.maps.Map(this.el, {
        center: GTA_CENTER,
        zoom: 10,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false,
        colorScheme: 'FOLLOW_SYSTEM',
        gestureHandling: 'cooperative',
      });
      this.Marker = makeMarkerClass(libs.maps.OverlayView);
      this.kind = 'google';
      addUsageFor(provider, 'mapLoads', 1);
    },
    useSchematic() {
      for (const m of this.markers.values()) m.setMap(null);
      for (const l of this.lines) l.setMap(null);
      this.markers.clear();
      this.lines = [];
      this.map = null;
      this.kind = 'schematic';
      this.fitKey = '';
      this.overlayKey = '';
      if (this.el) this.el.replaceChildren();
    },
    refit() { this.fitKey = ''; },
    update(view) {
      if (!this.el) return;
      if (this.kind === 'google' && this.map) this.updateGoogle(view);
      else this.renderSchematic(view);
    },
    updateGoogle(view) {
      const pts = view.places.filter(hasCoords);
      const seen = new Set();
      for (const p of pts) {
        seen.add(p.id);
        const sig = [p.lat, p.lng, displayName(p), p.kind].join('|');
        let mk = this.markers.get(p.id);
        if (mk && mk.sig !== sig) { mk.setMap(null); this.markers.delete(p.id); mk = null; }
        if (!mk) {
          mk = new this.Marker({ lat: p.lat, lng: p.lng }, pinElement(p));
          mk.sig = sig;
          mk.setMap(this.map);
          this.markers.set(p.id, mk);
        }
        mk.el.classList.toggle('is-selected', p.id === view.selectedDestId);
        mk.el.classList.toggle('is-focus', p.id === view.focusStartId);
      }
      for (const [id, mk] of this.markers) if (!seen.has(id)) { mk.setMap(null); this.markers.delete(id); }
      const okey = view.overlay ? view.overlay.key : '';
      if (okey !== this.overlayKey) {
        for (const l of this.lines) l.setMap(null);
        this.lines = [];
        this.overlayKey = okey;
        if (view.overlay) this.drawGoogleOverlay(view.overlay);
      }
      const fitKey = view.overlay ? 'o:' + okey : 'p:' + pts.map((p) => `${p.id}${p.lat}${p.lng}`).join(',');
      if (fitKey !== this.fitKey) {
        this.fitKey = fitKey;
        const fitPts = view.overlay ? overlayPoints(view.overlay) : pts.map((p) => [p.lat, p.lng]);
        this.fitGoogle(fitPts);
      }
    },
    fitGoogle(points) {
      if (!points.length) return;
      if (points.length === 1) { this.map.setCenter({ lat: points[0][0], lng: points[0][1] }); this.map.setZoom(13); return; }
      const b = new this.libs.core.LatLngBounds();
      for (const [lat, lng] of points) b.extend({ lat, lng });
      this.map.fitBounds(b, 48);
    },
    drawGoogleOverlay(ov) {
      const { Polyline } = this.libs.maps;
      for (const seg of ov.segments) {
        if (!seg.path || seg.path.length < 2) continue;
        const walk = seg.mode !== 'TRANSIT';
        const line = new Polyline({
          map: this.map,
          path: seg.path.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: walk ? '#7C8794' : seg.color || '#0B7A75',
          strokeOpacity: walk ? 0 : 0.95,
          strokeWeight: 6,
          zIndex: walk ? 1 : 2,
          icons: walk ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#7C8794', scale: 3 }, offset: '0', repeat: '12px' }] : [],
        });
        this.lines.push(line);
      }
    },
    renderSchematic(view) {
      const pts = view.places.filter(hasCoords);
      if (!pts.length) {
        this.el.replaceChildren(h('div', { class: 'map-empty', text: 'Your places show up here once their addresses are looked up.' }));
        return;
      }
      const W = Math.max(240, Math.round(this.el.clientWidth || 640));
      const H = Math.max(160, Math.round(this.el.clientHeight || 360));
      const all = pts.map((p) => [p.lat, p.lng]);
      if (view.overlay) for (const sg of view.overlay.segments) for (const q of sg.path || []) all.push(q);
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      for (const [la, ln] of all) { minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLng = Math.min(minLng, ln); maxLng = Math.max(maxLng, ln); }
      const midLat = (minLat + maxLat) / 2;
      const kx = Math.cos((midLat * Math.PI) / 180);
      const spanX = Math.max((maxLng - minLng) * kx, 0.01);
      const spanY = Math.max(maxLat - minLat, 0.01);
      const pad = 36;
      const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
      const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
      const proj = (la, ln) => [W / 2 + (ln - cx) * kx * scale, H / 2 - (la - cy) * scale];
      const svg = s('svg', { class: 'schematic', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Schematic map of your places' });
      for (let x = 60; x < W; x += 60) svg.append(s('line', { class: 'grid', x1: x, y1: 0, x2: x, y2: H }));
      for (let y = 60; y < H; y += 60) svg.append(s('line', { class: 'grid', x1: 0, y1: y, x2: W, y2: y }));
      if (view.overlay) {
        for (const sg of view.overlay.segments) {
          if (!sg.path || sg.path.length < 2) continue;
          const d = sg.path.map(([la, ln], i) => { const [x, y] = proj(la, ln); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
          const walk = sg.mode !== 'TRANSIT';
          svg.append(s('path', { class: 's-route' + (walk ? ' is-walk' : ''), d, style: walk ? null : `stroke:${sg.color || 'var(--transit)'}` }));
        }
      }
      const ordered = pts.slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dest' ? 1 : -1));
      for (const p of ordered) {
        const [x, y] = proj(p.lat, p.lng);
        const sel = p.id === view.selectedDestId;
        const focus = p.id === view.focusStartId;
        if (p.kind === 'dest') {
          const r = sel ? 10 : 7;
          const rect = s('rect', {
            class: 's-dest' + (sel ? ' is-selected' : ''), x: x - r, y: y - r, width: 2 * r, height: 2 * r, rx: 4,
            tabindex: 0, role: 'button', 'aria-label': `Destination: ${displayName(p)}`,
          });
          rect.addEventListener('click', () => onPinClick(p.id));
          rect.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPinClick(p.id, true); } });
          svg.append(rect);
        } else {
          const c = s('circle', { class: 's-start', cx: x, cy: y, r: focus ? 9 : 6, tabindex: 0, role: 'button', 'aria-label': `Starting point: ${displayName(p)}` });
          c.addEventListener('click', () => onPinClick(p.id));
          c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPinClick(p.id, true); } });
          svg.append(c);
        }
        const right = x > W - 130;
        const gap = p.kind === 'dest' ? (sel ? 15 : 12) : 11;
        const t = s('text', { x: right ? x - gap : x + gap, y: y + 4, 'text-anchor': right ? 'end' : 'start' });
        t.textContent = displayName(p).slice(0, 22);
        svg.append(t);
      }
      this.el.replaceChildren(svg);
    },
  };
  function overlayPoints(ov) {
    const out = [];
    for (const sg of ov.segments) for (const q of sg.path || []) out.push(q);
    return out;
  }

  // ---------------------------------------------------------------- places & context
  const placesOf = (kind) => state.data.places.filter((p) => p.kind === kind);
  const findPlace = (id) => state.data.places.find((p) => p.id === id) || null;
  const locKey = (p) => (p.placeId ? p.placeId : hasCoords(p) ? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : `id:${p.id}`);
  const kTransit = (dir, st, dest, dayKey, minute, pref) => `T|${dir}|${locKey(st)}|${locKey(dest)}|${dayKey}|${minute}|${pref}`;
  const kWalk = (st, dest) => `W|there|${locKey(st)}|${locKey(dest)}`;
  const kCarBase = (st, dest) => `B|there|${locKey(st)}|${locKey(dest)}`;
  const kCar = (dir, st, dest, dayKey, minute) => `C|${dir}|${locKey(st)}|${locKey(dest)}|${dayKey}|${minute}`;
  const kDetail = (dir, st, dest, dateStr, minute, pref) => `R|${dir}|${locKey(st)}|${locKey(dest)}|${dateStr}|${minute}|${pref}`;

  function ensureSelectedDest() {
    const s0 = state.data.settings;
    const dests = placesOf('dest');
    if (!dests.some((d) => d.id === s0.selectedDestId)) {
      const first = dests.find(hasCoords) || dests[0] || null;
      s0.selectedDestId = first ? first.id : null;
    }
  }
  function getContext() {
    const s0 = state.data.settings;
    ensureSelectedDest();
    const dest = findPlace(s0.selectedDestId);
    const allStarts = placesOf('start');
    return {
      s: s0,
      dest,
      starts: allStarts.filter(hasCoords),
      pendingStarts: allStarts.filter((p) => !hasCoords(p)),
      day: resolveTripDay(s0),
      pref: s0.transitPref,
    };
  }
  function shiftTimes(ctx, startMin) {
    const arriveMin = startMin - ctx.s.arriveEarlyMin;
    const leaveMin = startMin + Math.round(ctx.s.shiftHours * 60);
    return {
      startMin,
      arriveMin,
      leaveMin,
      arriveAt: ctx.day.ymd ? zonedDate(ctx.day.ymd, arriveMin) : null,
      leaveAt: ctx.day.ymd ? zonedDate(ctx.day.ymd, leaveMin) : null,
    };
  }
  const providerReady = () => !!state.provider && state.providerStatus === 'ready';
  const canCompare = (ctx) => providerReady() && ctx.dest && hasCoords(ctx.dest) && ctx.starts.length > 0 && !ctx.day.error;

  // ---------------------------------------------------------------- compare engine
  // A run is a set of requests started together. Runs for the same destination and trip settings share the
  // work, so nothing is asked twice. When the destination or trip settings change, older runs stop before
  // their next request. A run whose routing source changed (sample mode on or off) never saves its answers.
  const runIsLive = (run) => !run.cancelled && run.gen === state.providerGen;
  function contextSig(ctx) {
    return [ctx.dest && hasCoords(ctx.dest) ? locKey(ctx.dest) : '', ctx.day.key || '', ctx.day.ymd ? ymdStr(ctx.day.ymd) : '',
      ctx.s.shiftStart, ctx.s.arriveEarlyMin, ctx.s.shiftHours, ctx.pref, ctx.s.demo ? 'sample' : 'google'].join('|');
  }
  function updateBusy() {
    const runs = [...state.activeRuns];
    state.busy = runs.length > 0;
    state.busyText = runs.length ? runs[runs.length - 1].text : '';
  }
  function cancelRun(run, note) {
    if (run.cancelled) return;
    run.cancelled = true;
    state.activeRuns.delete(run);
    if (note && run.tapped) state.compareNote = note;
  }
  // Stop runs that no longer match what's on screen (another destination, day, shift or transit option).
  function cancelStaleRuns() {
    const sig = contextSig(getContext());
    for (const run of [...state.activeRuns]) {
      if (run.sig !== sig) cancelRun(run, `Stopped ${run.label} because the destination or trip settings changed. Tap ${run.button} again if you still want it.`);
    }
    updateBusy();
  }
  function cancelAllRuns() {
    for (const run of [...state.activeRuns]) cancelRun(run);
    updateBusy();
  }
  function plannedElsewhere(key) {
    for (const r of state.activeRuns) if (r.keys.has(key)) return true;
    return false;
  }
  // Wait (up to 30 s) until none of these trips are being asked about by another run.
  async function waitForKeys(keys) {
    const until = Date.now() + 30000;
    while (keys.some((k) => state.inflight.has(k)) && Date.now() < until) await sleep(150);
  }
  async function runMatrixJob(job, run) {
    for (let i = 0; i < job.starts.length; i += MATRIX_CHUNK) {
      if (!runIsLive(run)) return;
      let chunk = job.starts.slice(i, i + MATRIX_CHUNK);
      if (!run.force) chunk = chunk.filter((st) => !getResultIn(run.store, job.keyOf(st))); // saved meanwhile by another run
      chunk = chunk.filter((st) => !state.inflight.has(job.keyOf(st)));
      if (!chunk.length) continue;
      const keys = chunk.map(job.keyOf);
      keys.forEach((k) => { state.inflight.add(k); state.keyErrors.delete(k); });
      try {
        const origins = job.dir === 'there' ? chunk : [job.dest];
        const destinations = job.dir === 'there' ? [job.dest] : chunk;
        let grid;
        try {
          grid = await run.provider.matrix(origins, destinations, {
            mode: job.mode,
            routing: job.routing,
            arrivalTime: job.arrivalTime,
            departureTime: job.departureTime,
            transitPref: job.transitPref,
          });
        } catch (e) {
          if (run.gen === state.providerGen) { const why = friendlyError(e); keys.forEach((k) => state.keyErrors.set(k, why)); }
          throw e;
        }
        addUsageFor(run.provider, job.kind, chunk.length);
        if (run.gen !== state.providerGen) return; // the routing source changed while we waited
        let firstError = null;
        chunk.forEach((st, idx) => {
          const item = job.dir === 'there' ? grid[idx] && grid[idx][0] : grid[0] && grid[0][idx];
          if (!item || item.error) { // errors aren't saved as results, so they're asked again next time
            const why = friendlyError(item ? item.error : 'Google sent no answer for this trip.');
            state.keyErrors.set(keys[idx], why);
            firstError = firstError || why;
            return;
          }
          putResult(keys[idx], job.decorate ? job.decorate(st, item) : item, job.dateStr, run.store);
        });
        if (firstError && runIsLive(run)) state.compareError = firstError;
      } finally {
        keys.forEach((k) => state.inflight.delete(k));
      }
      saveStore(run.store);
      if (runIsLive(run)) refreshCompare();
    }
  }

  function planCompare(ctx, opts) {
    const jobs = [];
    const dateStr = ymdStr(ctx.day.ymd);
    const skipped = new Set();
    const missing = (key) => {
      if (!opts.force && getResult(key)) return false;
      if (state.inflight.has(key) || plannedElsewhere(key)) { skipped.add(key); return false; }
      return true;
    };
    const shiftList = opts.allStarts ? ALL_START_MINUTES : [ctx.s.shiftStart];
    if (opts.transit !== false) {
      for (const sm of shiftList) {
        const t = shiftTimes(ctx, sm);
        const thereKey = (st) => kTransit('there', st, ctx.dest, ctx.day.key, t.arriveMin, ctx.pref);
        const homeKey = (st) => kTransit('home', st, ctx.dest, ctx.day.key, t.leaveMin, ctx.pref);
        const there = ctx.starts.filter((st) => missing(thereKey(st)));
        const home = ctx.starts.filter((st) => missing(homeKey(st)));
        if (there.length) jobs.push({ kind: 'matrixEss', mode: 'TRANSIT', dir: 'there', starts: there, dest: ctx.dest, arrivalTime: t.arriveAt, transitPref: ctx.pref, keyOf: thereKey, dateStr });
        if (home.length) jobs.push({ kind: 'matrixEss', mode: 'TRANSIT', dir: 'home', starts: home, dest: ctx.dest, departureTime: t.leaveAt, transitPref: ctx.pref, keyOf: homeKey, dateStr });
      }
      if (ctx.s.walkLimitKm > 0) {
        const walkKey = (st) => kWalk(st, ctx.dest);
        const near = ctx.starts.filter((st) => haversineKm(st, ctx.dest) <= ctx.s.walkLimitKm && missing(walkKey(st)));
        if (near.length) jobs.push({ kind: 'matrixEss', mode: 'WALKING', dir: 'there', starts: near, dest: ctx.dest, keyOf: walkKey, dateStr });
      }
    }
    let car = null;
    if (opts.car) {
      const t = shiftTimes(ctx, ctx.s.shiftStart);
      const needThere = ctx.starts.filter((st) => missing(kCar('there', st, ctx.dest, ctx.day.key, t.arriveMin)));
      const needHome = ctx.starts.filter((st) => missing(kCar('home', st, ctx.dest, ctx.day.key, t.leaveMin)));
      const needBase = needThere.filter((st) => !state.inflight.has(kCarBase(st, ctx.dest)) && !plannedElsewhere(kCarBase(st, ctx.dest)) && (opts.force || !getResult(kCarBase(st, ctx.dest))));
      if (needThere.length || needHome.length) car = { t, needThere, needHome, needBase, dateStr };
    }
    const planned = { matrixEss: 0, matrixPro: 0 };
    for (const j of jobs) planned[j.kind] += j.starts.length;
    if (car) { planned.matrixEss += car.needBase.length; planned.matrixPro += car.needThere.length + car.needHome.length; }
    return { jobs, car, planned, skipped: [...skipped] };
  }

  async function runCar(ctx, car, run) {
    const { t, dateStr } = car;
    if (car.needBase.length) {
      await runMatrixJob({ kind: 'matrixEss', mode: 'DRIVING', routing: 'TRAFFIC_UNAWARE', dir: 'there', starts: car.needBase, dest: ctx.dest, keyOf: (st) => kCarBase(st, ctx.dest), dateStr }, run);
    }
    if (!runIsLive(run)) return;
    await waitForKeys(car.needThere.map((st) => kCarBase(st, ctx.dest)));
    if (!runIsLive(run)) return;
    // Leave early enough for the no-traffic time, then ask Google for traffic at that departure.
    const groups = new Map();
    for (const st of car.needThere) {
      const baseKey = kCarBase(st, ctx.dest);
      const thereKey = kCar('there', st, ctx.dest, ctx.day.key, t.arriveMin);
      const base = getResultIn(run.store, baseKey);
      if (!base) {
        state.keyErrors.set(thereKey, state.keyErrors.get(baseKey) || 'Couldn’t get a driving time for this place. Tap Recheck to try again.');
        continue;
      }
      if (base.v.noRoute || base.v.sec == null) {
        putResult(thereKey, { noRoute: true }, dateStr, run.store);
        continue;
      }
      const depart = Math.floor((+t.arriveAt - base.v.sec * 1000) / 300000) * 300000;
      if (!groups.has(depart)) groups.set(depart, []);
      groups.get(depart).push(st);
    }
    for (const [depart, sts] of groups) {
      await runMatrixJob({
        kind: 'matrixPro', mode: 'DRIVING', routing: 'TRAFFIC_AWARE', dir: 'there', starts: sts, dest: ctx.dest,
        departureTime: new Date(depart), dateStr,
        keyOf: (st) => kCar('there', st, ctx.dest, ctx.day.key, t.arriveMin),
        // Store the leave time as minutes after midnight, so a saved result still reads right on another date.
        decorate: (st, item) => (item.noRoute ? item : { ...item, leaveByMin: t.arriveMin - Math.ceil(item.sec / 60) }),
      }, run);
    }
    if (car.needHome.length && runIsLive(run)) {
      await runMatrixJob({
        kind: 'matrixPro', mode: 'DRIVING', routing: 'TRAFFIC_AWARE', dir: 'home', starts: car.needHome, dest: ctx.dest,
        departureTime: t.leaveAt, dateStr,
        keyOf: (st) => kCar('home', st, ctx.dest, ctx.day.key, t.leaveMin),
      }, run);
    }
  }

  async function runCompare(opts = {}) {
    cancelStaleRuns();
    const ctx = getContext();
    if (!canCompare(ctx)) { refreshCompare(); return; }
    const plan = planCompare(ctx, opts);
    if (!plan.jobs.length && !plan.car) { refreshCompare(); return; } // nothing new to ask, and nothing gets cancelled
    if (!confirmUsage(plan.planned)) { refreshCompare(); return; }
    const n = ctx.starts.length;
    const what = opts.car ? 'car times' : opts.allStarts ? 'every start time' : 'transit';
    const run = {
      sig: contextSig(ctx), gen: state.providerGen, provider: state.provider, store: currentStore(), force: !!opts.force,
      cancelled: false, keys: new Set(), tapped: !!(opts.car || opts.allStarts),
      kind: opts.car ? 'car' : opts.allStarts ? 'all' : 'transit',
      label: `checking ${what}`, button: opts.car ? 'Car times' : 'All start times',
      text: `Checking ${what} for ${plural(n, 'starting point', 'starting points')}…`,
    };
    for (const j of plan.jobs) for (const st of j.starts) run.keys.add(j.keyOf(st));
    if (plan.car) {
      const t = plan.car.t;
      for (const st of plan.car.needThere) run.keys.add(kCar('there', st, ctx.dest, ctx.day.key, t.arriveMin));
      for (const st of plan.car.needHome) run.keys.add(kCar('home', st, ctx.dest, ctx.day.key, t.leaveMin));
      for (const st of plan.car.needBase) run.keys.add(kCarBase(st, ctx.dest));
    }
    state.activeRuns.add(run);
    state.compareError = '';
    if (run.tapped) state.compareNote = '';
    updateBusy();
    refreshCompare();
    try {
      for (const job of plan.jobs) {
        if (!runIsLive(run)) break;
        await runMatrixJob(job, run);
      }
      if (plan.car && runIsLive(run)) await runCar(ctx, plan.car, run);
      if (plan.skipped.length && runIsLive(run)) {
        // Trips another run was asking about: if that run stopped without an answer or an error, ask again.
        await waitForKeys(plan.skipped);
        const orphaned = plan.skipped.filter((k) => !getResultIn(run.store, k) && !state.keyErrors.has(k) && !state.inflight.has(k) && !plannedElsewhere(k));
        if (orphaned.length && runIsLive(run)) setTimeout(() => runCompare({ car: !!opts.car, allStarts: !!opts.allStarts, transit: opts.transit }), 0);
      }
    } catch (e) {
      if (runIsLive(run)) state.compareError = friendlyError(e);
    } finally {
      const wasLive = !run.cancelled;
      state.activeRuns.delete(run);
      saveStore(run.store);
      updateBusy();
      if (wasLive || !state.busy) refreshCompare();
    }
  }
  const scheduleCompare = debounce(() => { runCompare(); }, 450);

  // Everything needed to show or fetch the trip-details panel for its current direction.
  function detailInfo() {
    const d = state.detail;
    if (!d) return null;
    const ctx = getContext();
    const st = findPlace(d.startId);
    if (!st || !hasCoords(st) || !ctx.dest || !hasCoords(ctx.dest) || ctx.day.error) return null;
    const t = shiftTimes(ctx, ctx.s.shiftStart);
    const dateStr = ymdStr(ctx.day.ymd);
    const key = kDetail(d.dir, st, ctx.dest, dateStr, d.dir === 'there' ? t.arriveMin : t.leaveMin, ctx.pref);
    return { d, ctx, st, t, dateStr, key, from: d.dir === 'there' ? st : ctx.dest, to: d.dir === 'there' ? ctx.dest : st };
  }
  async function loadDetail(force) {
    const info = detailInfo();
    if (!info || !providerReady()) { renderSheet(); return; }
    const { key, ctx, t, d } = info;
    if (state.detailInflight.has(key)) { renderSheet(); return; }
    if (!force && getResult(key)) { renderSheet(); updateMap(); return; }
    if (!confirmUsage({ routesEss: 1 })) return;
    const run = { gen: state.providerGen, provider: state.provider, store: currentStore() };
    state.detailInflight.add(key);
    state.detailErrors.delete(key);
    renderSheet();
    try {
      const r = await run.provider.route(info.from, info.to, {
        arrivalTime: d.dir === 'there' ? t.arriveAt : null,
        departureTime: d.dir === 'home' ? t.leaveAt : null,
        transitPref: ctx.pref,
      });
      addUsageFor(run.provider, 'routesEss', 1);
      if (run.gen === state.providerGen) {
        putResult(key, r, info.dateStr, run.store);
        saveStore(run.store);
      }
    } catch (e) {
      state.detailErrors.set(key, friendlyError(e));
    } finally {
      state.detailInflight.delete(key);
    }
    renderSheet();
    updateMap();
  }

  // ---------------------------------------------------------------- rows (shared by the list and the exports)
  function buildRow(ctx, st) {
    const t = shiftTimes(ctx, ctx.s.shiftStart);
    const there = getResult(kTransit('there', st, ctx.dest, ctx.day.key, t.arriveMin, ctx.pref));
    const home = getResult(kTransit('home', st, ctx.dest, ctx.day.key, t.leaveMin, ctx.pref));
    const walk = getResult(kWalk(st, ctx.dest));
    const carThere = getResult(kCar('there', st, ctx.dest, ctx.day.key, t.arriveMin));
    const carHome = getResult(kCar('home', st, ctx.dest, ctx.day.key, t.leaveMin));
    const thereV = there ? there.v : null;
    const homeV = home ? home.v : null;
    const errOf = (key, got) => (got ? '' : state.keyErrors.get(key) || '');
    const errors = {
      there: errOf(kTransit('there', st, ctx.dest, ctx.day.key, t.arriveMin, ctx.pref), there),
      home: errOf(kTransit('home', st, ctx.dest, ctx.day.key, t.leaveMin, ctx.pref), home),
      carThere: errOf(kCar('there', st, ctx.dest, ctx.day.key, t.arriveMin), carThere),
      carHome: errOf(kCar('home', st, ctx.dest, ctx.day.key, t.leaveMin), carHome),
    };
    const round = thereV && homeV && thereV.sec != null && homeV.sec != null ? thereV.sec + homeV.sec : null;
    const km = haversineKm(st, ctx.dest);

    const range = ALL_START_MINUTES.map((m) => {
      const tt = shiftTimes(ctx, m);
      const a = getResult(kTransit('there', st, ctx.dest, ctx.day.key, tt.arriveMin, ctx.pref));
      const b = getResult(kTransit('home', st, ctx.dest, ctx.day.key, tt.leaveMin, ctx.pref));
      return { start: m, arriveMin: tt.arriveMin, leaveMin: tt.leaveMin, there: a ? a.v : null, home: b ? b.v : null };
    });
    let rangeInfo = null;
    if (range.every((r) => r.there && r.home)) {
      let best = null, worst = null;
      const noHome = [], noThere = [];
      for (const r of range) {
        if (r.home.noRoute) noHome.push(r);
        if (r.there.noRoute) noThere.push(r);
        if (r.there.sec != null && r.home.sec != null) {
          const tot = r.there.sec + r.home.sec;
          if (!best || tot < best.tot) best = { start: r.start, tot };
          if (!worst || tot > worst.tot) worst = { start: r.start, tot };
        }
      }
      rangeInfo = { best, worst, noHome, noThere };
    }

    const warnings = [];
    if (thereV && thereV.noRoute) warnings.push({ text: `No transit gets you there by ${clockLabel(t.arriveMin)}.` });
    if (homeV && homeV.noRoute) warnings.push({ text: `No transit home leaving at ${clockLabel(t.leaveMin)}.` });
    if (rangeInfo) {
      for (const r of rangeInfo.noHome) if (r.start !== ctx.s.shiftStart) warnings.push({ caution: true, text: `No transit home after a ${shortHour(r.start)} start (leaving ${clockLabel(r.leaveMin)}).` });
      for (const r of rangeInfo.noThere) if (r.start !== ctx.s.shiftStart) warnings.push({ caution: true, text: `No transit gets you there for a ${shortHour(r.start)} start.` });
    }
    if (carThere && carThere.v.noRoute) warnings.push({ caution: true, text: 'No driving route found.' });
    const ats = [there && there.at, home && home.at].filter(Boolean);
    return {
      start: st, t, km,
      there: thereV, home: homeV, round,
      weekly: round != null ? round * ctx.s.shiftsPerWeek : null,
      walk: walk ? walk.v : null,
      carThere: carThere ? carThere.v : null,
      carHome: carHome ? carHome.v : null,
      range: rangeInfo,
      warnings,
      errors,
      checkedAt: ats.length ? Math.min(...ats) : null,
    };
  }
  function sortRows(rows, by) {
    const val = (r) => (by === 'there' ? r.there && r.there.sec : by === 'home' ? r.home && r.home.sec : by === 'distance' ? r.km : r.round);
    return rows.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      const na = va == null || !Number.isFinite(va), nb = vb == null || !Number.isFinite(vb);
      if (na && nb) return displayName(a.start).localeCompare(displayName(b.start));
      if (na) return 1;
      if (nb) return -1;
      return va - vb;
    });
  }
  function fareText(r) {
    const a = r.there && r.there.fare, b = r.home && r.home.fare;
    if (a && b && a === b) return `${a} each way`;
    if (a && b) return `${a} there, ${b} home`;
    return a || b || '';
  }

  // ---------------------------------------------------------------- exports
  const EXPORT_COLS = ['Starting point', 'Address', 'Destination', 'Day', 'Shift start', 'Arrive by', 'Transit there (min)', 'Leave work', 'Transit home (min)', 'Round trip (min)', 'Week (min)', 'Shifts per week', 'Fare', 'Walk each way (min)', 'Car there (min)', 'Car leave by', 'Car home (min)', 'Best start time', 'Best round trip (min)', 'Worst start time', 'Worst round trip (min)', 'Transit option', 'Notes', 'Checked'];
  function minutesCell(v) {
    if (!v) return '';
    if (v.noRoute) return 'No route';
    return v.sec != null ? Math.round(v.sec / 60) : '';
  }
  function exportTable() {
    const ctx = getContext();
    if (!ctx.dest || !hasCoords(ctx.dest) || ctx.day.error || !ctx.starts.length) return null;
    const rows = sortRows(ctx.starts.map((st) => buildRow(ctx, st)), ctx.s.sortBy);
    if (!rows.some((r) => r.there || r.home)) return null;
    const out = [EXPORT_COLS];
    for (const r of rows) {
      out.push([
        displayName(r.start), r.start.address || r.start.input, displayName(ctx.dest),
        ctx.day.label, clockLabel(ctx.s.shiftStart), clockLabel(r.t.arriveMin),
        minutesCell(r.there), clockLabel(r.t.leaveMin), minutesCell(r.home),
        r.round != null ? Math.round(r.round / 60) : '', r.weekly != null ? Math.round(r.weekly / 60) : '', ctx.s.shiftsPerWeek,
        fareText(r), minutesCell(r.walk), minutesCell(r.carThere),
        r.carThere && r.carThere.leaveByMin != null ? clockLabel(r.carThere.leaveByMin) : '', minutesCell(r.carHome),
        r.range && r.range.best ? shortHour(r.range.best.start) : '', r.range && r.range.best ? Math.round(r.range.best.tot / 60) : '',
        r.range && r.range.worst ? shortHour(r.range.worst.start) : '', r.range && r.range.worst ? Math.round(r.range.worst.tot / 60) : '',
        TRANSIT_PREFS[ctx.pref], r.warnings.map((w) => w.text).join(' '), r.checkedAt ? stampOf(r.checkedAt) : '',
      ]);
    }
    return out;
  }
  function guardCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    const str = String(v);
    return /^[=+\-@\t\r]/.test(str) ? "'" + str : str; // stop spreadsheets reading text as a formula
  }
  const toTSV = (rows) => rows.map((r) => r.map((c) => guardCell(c).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  const toCSV = (rows) => '﻿' + rows.map((r) => r.map((c) => {
    const v = guardCell(c);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\r\n');
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0' }, 'aria-hidden': 'true' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const fileSafe = (txt) => String(txt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'results';
  async function onCopyForSheets() {
    const rows = exportTable();
    if (!rows) { toast('Nothing to copy yet. Check a destination first.'); return; }
    const ok = await copyText(toTSV(rows));
    toast(ok ? `Copied ${plural(rows.length - 1, 'row', 'rows')}. Paste into Google Sheets.` : 'Copying didn’t work here. Use Download CSV instead.');
  }
  function onDownloadCSV() {
    const rows = exportTable();
    if (!rows) { toast('Nothing to download yet. Check a destination first.'); return; }
    const ctx = getContext();
    downloadFile(`headway-${fileSafe(displayName(ctx.dest))}-${ymdStr(ctx.day.ymd)}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
    toast('CSV downloaded. In Google Sheets, use File, then Import.');
  }
  function onDownloadAllCSV() {
    pruneResults();
    if (state.data.settings.demo) { toast('Sample mode results aren’t saved. Turn sample mode off to export real results.'); return; }
    const names = new Map();
    for (const p of state.data.places) if (hasCoords(p) || p.placeId) names.set(locKey(p), displayName(p));
    const nameOf = (k) => names.get(k) || k;
    const rows = [['Type', 'Trip', 'From', 'To', 'Day', 'Time', 'Minutes', 'Distance (km)', 'Fare', 'Transit option', 'Checked']];
    const typeName = { T: 'Transit', W: 'Walk', C: 'Car' };
    const entries = Object.entries(state.results).filter(([k]) => /^[TWC]\|/.test(k)).sort((a, b) => b[1].at - a[1].at);
    for (const [k, e] of entries) {
      const [type, dir, startK, destK, dayKey, minute, pref] = k.split('|');
      const v = e.v || {};
      const fromK = dir === 'home' ? destK : startK;
      const toK = dir === 'home' ? startK : destK;
      const day = dayKey ? (dayKey.startsWith('date:') ? dayKey.slice(5) : DAY_TYPES[dayKey] || dayKey) : '';
      const time = minute ? (dir === 'home' ? `Leave ${clockLabel(Number(minute))}` : `Arrive by ${clockLabel(Number(minute))}`) : '';
      rows.push([
        typeName[type] || type, dir === 'home' ? 'Home' : 'To work', nameOf(fromK), nameOf(toK), day, time,
        v.noRoute ? 'No route' : v.sec != null ? Math.round(v.sec / 60) : '',
        v.m != null ? Math.round(v.m / 100) / 10 : '', v.fare || '', pref ? TRANSIT_PREFS[pref] || pref : '', stampOf(e.at),
      ]);
    }
    if (rows.length === 1) { toast('No saved results yet.'); return; }
    downloadFile(`headway-saved-results-${ymdStr(todayToronto())}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
    toast(`Downloaded ${plural(rows.length - 1, 'saved result', 'saved results')}.`);
  }
  function onExportBackup() {
    const payload = {
      app: 'headway',
      kind: 'backup',
      version: 1,
      savedAt: new Date().toISOString(),
      places: state.data.places,
      settings: state.data.settings,
    };
    downloadFile(`headway-backup-${ymdStr(todayToronto())}.json`, JSON.stringify(payload, null, 2), 'application/json');
    toast('Backup downloaded. It has your places and settings, not your Google key.');
  }
  async function onImportBackup(file) {
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { toast('That file isn’t a Headway backup.'); return; }
    if (!parsed || parsed.app !== 'headway' || !Array.isArray(parsed.places)) { toast('That file isn’t a Headway backup.'); return; }
    const next = normalizeData(parsed);
    if (!window.confirm(`Replace your ${plural(state.data.places.length, 'place', 'places')} and settings with the ${plural(next.places.length, 'place', 'places')} in this backup?`)) return;
    next.settings.demo = state.data.settings.demo;
    state.data = next;
    if (!state.data.settings.demo) clearSamplePlaces(false); // made-up locations from sample mode get looked up for real
    state.detail = null;
    ensureSelectedDest();
    saveData();
    cancelStaleRuns();
    MapView.refit();
    toast(`Restored ${plural(state.data.places.length, 'place', 'places')}.`);
    render();
    lookupPending();
    scheduleCompare();
  }

  // ---------------------------------------------------------------- adding & editing places
  function parseLines(text) {
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
      const bar = line.indexOf('|');
      if (bar >= 0) return { name: line.slice(0, bar).trim().slice(0, 60), addr: line.slice(bar + 1).trim() };
      return { name: '', addr: line };
    }).filter((x) => x.addr);
  }
  async function geocodeInto(place) {
    const prov = state.provider, gen = state.providerGen;
    const r = await prov.geocode(place.input);
    addUsageFor(prov, 'geocode', 1);
    if (gen !== state.providerGen) return 'stale'; // the routing source changed; look it up again later
    if (!r) return false;
    place.address = r.address;
    place.placeId = r.placeId;
    place.lat = r.lat;
    place.lng = r.lng;
    place.coordsAt = Date.now();
    place.partial = r.partial;
    return true;
  }
  async function addPlaces() {
    const items = parseLines(state.addDraft);
    if (!items.length) { toast('Paste at least one address first.'); return; }
    if (items.length > 50) { toast('Add up to 50 places at a time.'); return; }
    if (state.data.places.length + items.length > MAX_PLACES) { toast(`Headway holds up to ${MAX_PLACES} places. Remove some before adding more.`); return; }
    if (providerReady() && !confirmUsage({ geocode: items.length })) return;
    state.adding = true;
    state.addLog = [];
    renderPlaces();
    const kind = state.addKind;
    const lookups = providerReady();
    const gen = state.providerGen;
    let added = 0;
    let leftover = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (lookups && gen !== state.providerGen) { leftover = items.slice(i); break; }
      const place = normalizePlace({ id: uid(), kind, name: it.name, input: it.addr.slice(0, 300) });
      if (lookups) {
        try {
          const found = await geocodeInto(place);
          if (found === 'stale') { leftover = items.slice(i); break; }
          if (!found) { state.addLog.push({ bad: true, text: `Not found: ${it.addr}. Check the spelling or add the city.` }); continue; }
          state.addLog.push({ check: place.partial, text: `${displayName(place)}: ${place.address}${place.partial ? '. Partial match, check it’s right.' : ''}` });
        } catch (e) {
          state.addLog.push({ bad: true, text: `${it.addr}: ${friendlyError(e)}` });
          continue;
        }
      } else {
        state.addLog.push({ check: true, text: `${displayName(place)}: saved. It’ll be looked up once your Google key is set.` });
      }
      state.data.places.push(place);
      added++;
      renderPlaces();
    }
    if (leftover.length) {
      state.addDraft = leftover.map((x) => (x.name ? `${x.name} | ${x.addr}` : x.addr)).join('\n');
      state.addLog.push({ check: true, text: `Stopped because sample mode was switched. ${plural(leftover.length, 'line is', 'lines are')} still in the box; tap Look up and add again.` });
    } else if (added) {
      state.addDraft = '';
    }
    if (added) {
      ensureSelectedDest();
      saveData();
      MapView.refit();
    }
    state.adding = false;
    render();
    if (added) scheduleCompare();
  }
  async function lookupPending() {
    if (!providerReady() || state.lookingUp) return;
    const pending = state.data.places.filter((p) => !hasCoords(p) && p.input);
    if (!pending.length) return;
    if (!confirmUsage({ geocode: pending.length })) return;
    state.lookingUp = true;
    if (state.view === 'places') renderPlaces();
    let failed = 0;
    try {
      for (const p of pending) {
        if (hasCoords(p) || !state.data.places.includes(p)) continue;
        let found;
        try { found = await geocodeInto(p); } catch { found = false; }
        if (found === 'stale') break;
        if (!found) failed++;
      }
    } finally {
      state.lookingUp = false;
    }
    saveData();
    MapView.refit();
    render();
    if (failed) toast(`${plural(failed, 'address', 'addresses')} couldn’t be found. Check them in Places.`);
    scheduleCompare();
  }
  async function refreshStaleCoords() {
    if (!state.provider || state.provider.name !== 'google') return;
    const now = Date.now();
    const stale = state.data.places.filter((p) => p.placeId && !p.placeId.startsWith('sample-') && hasCoords(p) && now - p.coordsAt > COORD_TTL_MS).slice(0, 25);
    if (!stale.length) return;
    const prov = state.provider, gen = state.providerGen;
    for (const p of stale) {
      try {
        const r = await prov.geocodePlaceId(p.placeId);
        addUsageFor(prov, 'geocode', 1);
        if (gen !== state.providerGen) return;
        if (r) { p.lat = r.lat; p.lng = r.lng; p.coordsAt = Date.now(); }
      } catch { /* keep the old coordinates and try again next time */ }
    }
    saveData();
    updateMap();
  }
  function renamePlace(p) {
    const v = window.prompt('Nickname', p.name || displayName(p));
    if (v == null) return;
    p.name = v.trim().slice(0, 60);
    saveData();
    MapView.refit();
    render();
  }
  async function readdressPlace(p) {
    const v = window.prompt('Address', p.input || p.address);
    if (v == null || !v.trim()) return;
    p.input = v.trim().slice(0, 300);
    p.address = '';
    p.placeId = '';
    p.lat = null;
    p.lng = null;
    p.partial = false;
    saveData();
    cancelStaleRuns();
    render();
    if (providerReady()) {
      if (!confirmUsage({ geocode: 1 })) return;
      try {
        const found = await geocodeInto(p);
        if (found !== 'stale') toast(found ? `Found: ${p.address}` : 'That address wasn’t found. Try adding the city.');
      } catch (e) { toast(friendlyError(e)); }
      saveData();
      MapView.refit();
      render();
      scheduleCompare();
    }
  }
  function deletePlace(p) {
    if (!window.confirm(`Remove ${displayName(p)}?`)) return;
    state.data.places = state.data.places.filter((x) => x.id !== p.id);
    if (state.detail && state.detail.startId === p.id) state.detail = null;
    ensureSelectedDest();
    saveData();
    cancelStaleRuns();
    MapView.refit();
    render();
    scheduleCompare();
  }

  // ---------------------------------------------------------------- provider lifecycle
  function onProviderError(message) {
    state.providerStatus = 'error';
    state.providerError = message;
    state.busy = false;
    render();
  }
  async function chooseProvider() {
    const gen = ++state.providerGen;
    cancelAllRuns();
    state.compareError = '';
    state.compareNote = '';
    state.keyErrors.clear();
    if (state.data.settings.demo) {
      state.provider = makeDemoProvider();
      state.providerStatus = 'ready';
      state.providerError = '';
      MapView.useSchematic();
      afterProviderReady();
      return;
    }
    if (!state.apiKey) {
      state.provider = null;
      state.providerStatus = 'none';
      state.providerError = '';
      MapView.useSchematic();
      render();
      return;
    }
    state.provider = null;
    state.providerStatus = 'loading';
    MapView.useSchematic();
    render();
    const p = makeGoogleProvider(state.apiKey, gen);
    try {
      await withTimeout(p.init(), 25000, 'Google Maps took too long to load (timeout).');
      if (gen !== state.providerGen) return; // sample mode was switched while Google loaded
      if (state.providerStatus === 'error') return; // the key was rejected while loading
      state.provider = p;
      MapView.useGoogle(p.libs, p);
      state.providerStatus = 'ready';
      afterProviderReady();
    } catch (e) {
      if (gen !== state.providerGen) return;
      onProviderError(`Google Maps didn’t load. ${friendlyError(e)}`);
    }
  }
  function afterProviderReady() {
    render();
    lookupPending();
    refreshStaleCoords();
    scheduleCompare();
  }

  // ---------------------------------------------------------------- rendering
  // Redraws replace elements, so put keyboard focus back on the element with the same id afterwards.
  function withFocus(fn) {
    const ae = document.activeElement;
    const id = ae && ae !== document.body ? ae.id : '';
    fn();
    if (id) {
      const el = document.getElementById(id);
      if (el && el !== document.activeElement && !el.disabled) el.focus({ preventScroll: true });
    }
  }
  function render() { withFocus(renderAll); }
  function renderAll() {
    renderTabs();
    renderUsageChip();
    renderBanner();
    if (state.view === 'compare') renderCompare();
    else if (state.view === 'places') renderPlaces();
    else renderSettings();
    renderSheet();
  }
  function renderTabs() {
    for (const b of document.querySelectorAll('.tab')) {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    for (const v of ['compare', 'places', 'settings']) $(`#view-${v}`).hidden = v !== state.view;
  }
  function renderUsageChip() {
    const chip = $('#usageChip');
    if (!chip) return;
    if (state.provider && state.provider.name === 'demo') {
      chip.hidden = false;
      chip.className = 'usage-chip';
      chip.textContent = 'Sample mode';
      chip.title = 'Times are made up. Turn sample mode off in Settings.';
      return;
    }
    if (!state.provider || state.provider.name !== 'google') { chip.hidden = true; return; }
    const peak = usagePeak();
    chip.hidden = false;
    chip.className = 'usage-chip' + (peak >= 1 ? ' is-over' : peak >= 0.8 ? ' is-high' : '');
    chip.textContent = `Free use ${Math.min(999, Math.round(peak * 100))}%`;
    chip.title = 'Your highest share of a Google free monthly amount, counted on this device. Tap for details.';
  }
  function renderBanner() {
    const el = $('#banner');
    let msg = null;
    if (state.providerStatus === 'error') msg = { text: state.providerError, action: state.view !== 'settings' ? { label: 'Open settings', fn: () => go('settings') } : null };
    else if (state.storageFull) msg = { text: 'This device ran out of space for saved results, so some older ones won’t be kept after you close the app.', action: null };
    if (!msg) { el.hidden = true; el.replaceChildren(); return; }
    el.hidden = false;
    el.className = 'banner';
    el.replaceChildren(h('p', { text: msg.text }), msg.action ? h('button', { type: 'button', class: 'btn', onclick: msg.action.fn, text: msg.action.label }) : null);
  }
  function go(view) {
    if (view !== 'compare') closeDetail(false);
    state.view = view;
    render();
    window.scrollTo(0, 0);
    if (view === 'compare') { MapView.refit(); updateMap(); }
  }

  function updateMap() {
    if (state.view !== 'compare') return;
    const ctx = getContext();
    MapView.update({
      places: state.data.places,
      selectedDestId: ctx.dest ? ctx.dest.id : null,
      focusStartId: state.detail ? state.detail.startId : state.focusStartId,
      overlay: currentOverlay(),
    });
    const note = $('#mapNote');
    if (MapView.kind === 'schematic' && state.data.places.some(hasCoords)) {
      note.hidden = false;
      note.textContent = state.provider && state.provider.name === 'demo' ? 'Sample mode: schematic view, no street map' : 'Schematic view. The street map appears once your Google key works.';
    } else note.hidden = true;
  }
  function mergedSteps(steps) {
    const out = [];
    for (const x of steps || []) {
      const last = out[out.length - 1];
      if (x.mode !== 'TRANSIT' && last && last.mode !== 'TRANSIT') {
        last.sec = (last.sec || 0) + (x.sec || 0);
        last.m = (last.m || 0) + (x.m || 0);
        last.path = last.path.concat(x.path || []);
      } else out.push({ ...x, path: (x.path || []).slice() });
    }
    return out;
  }
  function currentOverlay() {
    const info = detailInfo();
    if (!info) return null;
    const key = info.key;
    const e = getResult(key);
    if (!e || e.v.noRoute) return null;
    const segs = e.v.steps && e.v.steps.length
      ? mergedSteps(e.v.steps).map((x) => ({ mode: x.mode, color: x.transit && x.transit.color, path: x.path }))
      : [{ mode: 'TRANSIT', color: '', path: e.v.path || [] }];
    return { key, segments: segs };
  }

  // ----- compare view
  function renderCompare() { withFocus(renderCompareInner); }
  function renderCompareInner() {
    if (state.view !== 'compare') return;
    const ctx = getContext();
    const picker = $('#destPicker'), controls = $('#controls'), actions = $('#actions');
    const summary = $('#summary'), results = $('#results'), exportBar = $('#exportBar');
    const clearAll = () => { for (const el of [picker, controls, actions, summary, results, exportBar]) el.replaceChildren(); };

    if (state.providerStatus === 'none') {
      clearAll();
      picker.append(h('div', { class: 'empty' },
        h('h2', { text: 'Add your Google key to start' }),
        h('p', { text: 'Headway uses your own Google Maps key for real transit, car and walking times. You can also look around first with made-up sample places.' }),
        h('div', { class: 'btns' },
          h('button', { type: 'button', id: 'empty-key', class: 'btn btn-primary', onclick: () => go('settings'), text: 'Add Google key' }),
          h('button', { type: 'button', id: 'empty-sample', class: 'btn', onclick: () => setDemo(true), text: 'Try sample mode' }))));
      updateMap();
      return;
    }
    if (state.providerStatus === 'loading') {
      clearAll();
      picker.append(h('p', { class: 'busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading Google Maps…'));
      updateMap();
      return;
    }
    const dests = placesOf('dest');
    if (!dests.length || !placesOf('start').length) {
      clearAll();
      picker.append(h('div', { class: 'empty' },
        h('h2', { text: !dests.length && !placesOf('start').length ? 'Add your places' : !dests.length ? 'Add a destination' : 'Add a starting point' }),
        h('p', { text: 'Starting points are where you might leave from. Destinations are where you work. Add at least one of each.' }),
        h('div', { class: 'btns' }, h('button', { type: 'button', id: 'empty-places', class: 'btn btn-primary', onclick: () => go('places'), text: 'Add places' }))));
      updateMap();
      return;
    }

    // Destination picker: a radio group (arrow keys move between destinations)
    picker.replaceChildren(...dests.map((d) => {
      const on = !!(ctx.dest && d.id === ctx.dest.id);
      return h('button', {
        type: 'button', id: 'dest-' + d.id, class: 'dest-btn', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1',
        title: d.address || d.input, onclick: () => selectDest(d.id),
      }, h('span', { class: 'sq', 'aria-hidden': 'true' }), h('span', { class: 'label', text: displayName(d) }));
    }));
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', 'Destination');
    picker.onkeydown = (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys) && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const i = Math.max(0, dests.findIndex((d) => ctx.dest && d.id === ctx.dest.id));
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? dests.length - 1 : (i + keys[e.key] + dests.length) % dests.length;
      selectDest(dests[j].id);
      const btn = document.getElementById('dest-' + dests[j].id);
      if (btn) btn.focus();
    };

    renderControls(ctx, controls);
    renderActions(ctx, actions);
    renderCompareResults();
    updateMap();
  }
  // Redraw the parts of Compare that change with results, leaving the controls (and any open picker) alone.
  function refreshCompare() {
    if (state.view !== 'compare') return;
    if (!$('#controls').childElementCount) { renderCompare(); return; }
    withFocus(() => {
      renderActions(getContext(), $('#actions'));
      renderCompareResultsInner();
    });
    updateMap();
    renderSheet();
  }
  function selectDest(id) {
    if (state.data.settings.selectedDestId === id) return;
    state.data.settings.selectedDestId = id;
    state.detail = null;
    saveData();
    cancelStaleRuns();
    renderCompare();
    renderSheet();
    scheduleCompare();
  }
  // Changes from the Compare controls: redraw only the Compare view, keeping focus where it was.
  function setSetting(key, value, rerun) {
    state.data.settings[key] = value;
    state.data.settings = normalizeSettings(state.data.settings);
    saveData();
    if (rerun) { state.detail = null; cancelStaleRuns(); }
    if (state.view === 'compare') {
      if (key === 'dayType') renderCompare(); // the date box appears or goes away
      else refreshCompare();
    }
    if (rerun) scheduleCompare();
  }
  // Changes from Settings fields: save without redrawing, so the next field you tap still works.
  function saveSettingQuietly(key, value, rerun) {
    state.data.settings[key] = value;
    state.data.settings = normalizeSettings(state.data.settings);
    saveData();
    if (rerun) { state.detail = null; cancelStaleRuns(); scheduleCompare(); }
    return state.data.settings[key];
  }
  function selectField(label, value, options, onchange, extra) {
    const id = 'f-' + label.toLowerCase().replace(/[^a-z]+/g, '-');
    return h('label', { class: 'field' + (extra ? ' ' + extra : ''), for: id }, label,
      h('select', { id, onchange: (e) => onchange(e.target.value) },
        ...Object.entries(options).map(([v, t]) => h('option', { value: v, selected: String(v) === String(value), text: t }))));
  }
  function renderControls(ctx, el) {
    const s0 = ctx.s;
    const shiftOpts = Object.fromEntries(SHIFT_START_OPTIONS.map((m) => [m, clockLabel(m)]));
    const kids = [
      selectField('Day', s0.dayType, DAY_TYPES, (v) => setSetting('dayType', v, true)),
      selectField('Shift starts', s0.shiftStart, shiftOpts, (v) => setSetting('shiftStart', Number(v), true)),
      selectField('Transit', s0.transitPref, TRANSIT_PREFS, (v) => setSetting('transitPref', v, true)),
      selectField('Sort by', s0.sortBy, SORTS, (v) => setSetting('sortBy', v, false)),
    ];
    if (s0.dayType === 'date') {
      const today = todayToronto();
      kids.splice(1, 0, h('label', { class: 'field', for: 'f-date' }, 'Date',
        h('input', {
          id: 'f-date', type: 'date', value: s0.customDate, min: ymdStr(addDays(today, 1)), max: ymdStr(addDays(today, MAX_DAYS_AHEAD)),
          onchange: (e) => {
            // Typing a date fires partial values like 0002-12-05; only take a whole, plausible date.
            const v = e.target.value;
            const y = Number(v.slice(0, 4));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || y < today.y || y > today.y + 1) return;
            setSetting('customDate', v, true);
          },
        })));
    }
    el.replaceChildren(...kids);
  }
  function carCheckedForShift(ctx) {
    const t = shiftTimes(ctx, ctx.s.shiftStart);
    return ctx.starts.length > 0 && ctx.starts.every((st) => getResult(kCar('there', st, ctx.dest, ctx.day.key, t.arriveMin)) && getResult(kCar('home', st, ctx.dest, ctx.day.key, t.leaveMin)));
  }
  function allStartsChecked(ctx) {
    return ctx.starts.length > 0 && ctx.starts.every((st) => ALL_START_MINUTES.every((m) => {
      const tt = shiftTimes(ctx, m);
      return getResult(kTransit('there', st, ctx.dest, ctx.day.key, tt.arriveMin, ctx.pref)) && getResult(kTransit('home', st, ctx.dest, ctx.day.key, tt.leaveMin, ctx.pref));
    }));
  }
  function renderActions(ctx, el) {
    if (!canCompare(ctx)) { el.replaceChildren(); return; }
    const n = ctx.starts.length;
    const carDone = carCheckedForShift(ctx);
    const allDone = allStartsChecked(ctx);
    const running = (kind) => [...state.activeRuns].some((r) => r.kind === kind && runIsLive(r));
    const carRunning = running('car'), allRunning = running('all');
    const carPlan = planCompare(ctx, { car: true, transit: false });
    const allPlan = planCompare(ctx, { allStarts: true, transit: true });
    el.replaceChildren(
      h('button', {
        type: 'button', id: 'act-car', class: 'btn', 'aria-disabled': String(carRunning || carDone),
        title: carDone ? 'Car times are already checked for this shift.' : 'Uses Google’s car-with-traffic allowance',
        onclick: () => { if (!carRunning && !carDone) runCompare({ car: true, transit: false }); },
      }, iconCar(), carDone ? 'Car times checked' : carRunning ? 'Checking car times…' : 'Car times', !carDone && !carRunning && state.provider.name === 'google' ? h('span', { class: 'count', text: `uses ${carPlan.planned.matrixPro}` }) : null),
      h('button', {
        type: 'button', id: 'act-all', class: 'btn', 'aria-disabled': String(allRunning || allDone),
        title: 'Checks transit for every start time from 8 AM to 1 PM',
        onclick: () => { if (!allRunning && !allDone) runCompare({ allStarts: true }); },
      }, iconClock(), allDone ? 'All start times checked' : allRunning ? 'Checking start times…' : 'All start times', !allDone && !allRunning && state.provider.name === 'google' ? h('span', { class: 'count', text: `uses ${allPlan.planned.matrixEss}` }) : null),
      h('button', {
        type: 'button', id: 'act-recheck', class: 'btn btn-quiet', 'aria-disabled': String(state.busy),
        title: `Asks Google again for all ${n} starting points for this shift`,
        onclick: () => { if (!state.busy) runCompare({ force: true, car: carDone }); },
      }, iconRefresh(), 'Recheck'),
    );
  }
  function renderCompareResults() { withFocus(renderCompareResultsInner); }
  function renderCompareResultsInner() {
    if (state.view !== 'compare') return;
    const ctx = getContext();
    const summary = $('#summary'), list = $('#results'), exportBar = $('#exportBar');
    if (!ctx.dest || state.providerStatus === 'none' || state.providerStatus === 'loading') return;
    const sum = [];
    if (ctx.day.error) sum.push(h('p', { class: 'busy', text: ctx.day.error }));
    else {
      const t = shiftTimes(ctx, ctx.s.shiftStart);
      sum.push(h('p', {},
        h('strong', { text: ctx.day.label }), ctx.day.typical ? (ctx.s.dayType === 'weekday' ? ' as a typical weekday (the next Tuesday to Thursday). ' : ` as a typical ${DAY_TYPES[ctx.s.dayType]}. `) : '. ',
        `Arrive by ${clockLabel(t.arriveMin)} for a ${clockLabel(ctx.s.shiftStart)} start, leave work at ${clockLabel(t.leaveMin)}.`));
    }
    if (!hasCoords(ctx.dest)) sum.push(h('p', { text: 'This destination hasn’t been looked up yet. Check it in Places.' }));
    if (ctx.pendingStarts.length) sum.push(h('p', { text: `${plural(ctx.pendingStarts.length, 'starting point still needs', 'starting points still need')} an address lookup (see Places).` }));
    if (state.busy) sum.push(h('p', { class: 'busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), state.busyText));
    if (state.compareError) sum.push(h('p', { class: 'busy', style: { color: 'var(--warn)' }, text: state.compareError }));
    if (state.compareNote) sum.push(h('p', { class: 'busy', style: { color: 'var(--caution)' }, text: state.compareNote }));

    if (ctx.day.error || !hasCoords(ctx.dest)) { summary.replaceChildren(...sum); list.replaceChildren(); exportBar.replaceChildren(); return; }

    const rows = sortRows(ctx.starts.map((st) => buildRow(ctx, st)), ctx.s.sortBy);
    if (!state.busy) {
      const failed = rows.filter((r) => r.errors.there || r.errors.home || r.errors.carThere || r.errors.carHome);
      if (failed.length && !state.compareError) {
        const why = failed[0].errors.there || failed[0].errors.home || failed[0].errors.carThere || failed[0].errors.carHome;
        sum.push(h('p', { class: 'busy', style: { color: 'var(--warn)' }, text: `${plural(failed.length, 'starting point', 'starting points')} couldn’t be checked. ${why} Tap Recheck to try again.` }));
      }
    }
    const checked = rows.map((r) => r.checkedAt).filter(Boolean);
    if (checked.length && !state.busy) {
      sum.push(h('p', { text: `Checked ${stampOf(Math.min(...checked))}. Saved results delete themselves after 30 days.` }));
    }
    summary.replaceChildren(...sum);

    const values = [];
    for (const r of rows) for (const v of [r.there, r.home, r.carThere, r.carHome]) if (v && v.sec != null) values.push(v.sec);
    const scale = values.length ? Math.max(...values) : 1;
    let bestShown = false;
    list.replaceChildren(...rows.map((r, i) => {
      const isBest = !bestShown && ctx.s.sortBy === 'round' && r.round != null && rows.filter((x) => x.round != null).length > 1;
      if (isBest) bestShown = true;
      return renderRow(ctx, r, i + 1, scale, isBest);
    }));
    const any = rows.some((r) => r.there || r.home);
    exportBar.replaceChildren(...(any ? [
      h('p', { text: 'Export these results:' }),
      h('button', { type: 'button', id: 'exp-copy', class: 'btn', onclick: onCopyForSheets, text: 'Copy for Sheets' }),
      h('button', { type: 'button', id: 'exp-csv', class: 'btn', onclick: onDownloadCSV, text: 'Download CSV' }),
    ] : []));
  }
  function barLine(label, v, scale, kind, thin, err) {
    let fill;
    let val;
    if (!v && err) { fill = h('span', { class: 'fill', style: { width: '0%' } }); val = h('span', { class: 'bar-val', title: err }, h('small', { text: 'failed' })); }
    else if (!v) { fill = h('span', { class: 'fill', style: { width: '0%' } }); val = h('span', { class: 'bar-val' }, h('small', { text: state.busy ? 'checking' : 'not checked' })); }
    else if (v.noRoute) { fill = h('span', { class: 'fill is-none', style: { width: '100%' } }); val = h('span', { class: 'bar-val', text: 'No route' }); }
    else {
      const pct = clamp((v.sec / scale) * 100, 3, 100);
      fill = h('span', { class: 'fill' + (kind === 'car' ? ' is-car' : kind === 'walk' ? ' is-walk' : ''), style: { width: pct.toFixed(1) + '%' } });
      val = h('span', { class: 'bar-val', text: fmtDur(v.sec) });
    }
    return h('div', { class: 'bar-line' + (thin ? ' is-thin' : '') }, h('span', { class: 'bar-label', text: label }), h('span', { class: 'bar', 'aria-hidden': 'true' }, fill), val);
  }
  function renderRow(ctx, r, rank, scale, isBest) {
    const st = r.start;
    const head = h('div', { class: 'row-head' },
      h('span', { class: 'row-rank', 'aria-label': `Rank ${rank}`, text: rank }),
      h('span', { class: 'row-name' }, displayName(st), isBest ? h('span', { class: 'tag-best', text: 'Shortest' }) : null),
      h('span', { class: 'row-total' }, r.round != null ? fmtDur(r.round) : '—', h('small', { text: 'round trip' })));
    const sub = h('div', { class: 'row-sub', text: [st.address || st.input, r.km != null ? `${fmtKm(r.km)} away in a straight line` : ''].filter(Boolean).join(', ') });
    const bars = [
      barLine('There', r.there, scale, 'transit', false, r.errors.there),
      barLine('Home', r.home, scale, 'transit', false, r.errors.home),
    ];
    if (r.carThere || r.carHome || r.errors.carThere || r.errors.carHome) {
      bars.push(barLine('Car there', r.carThere, scale, 'car', true, r.errors.carThere));
      bars.push(barLine('Car home', r.carHome, scale, 'car', true, r.errors.carHome));
    }
    if (r.walk) bars.push(barLine('Walk', r.walk, scale, 'walk', true));
    const meta = [];
    if (r.carThere && r.carThere.leaveByMin != null) meta.push(h('p', { text: `By car, leave by ${clockLabel(r.carThere.leaveByMin)} to arrive by ${clockLabel(r.t.arriveMin)}.` }));
    if (r.walk && r.walk.sec != null) meta.push(h('p', { text: `Walking takes about ${fmtDur(r.walk.sec)} each way.` }));
    if (r.weekly != null && ctx.s.shiftsPerWeek > 0) meta.push(h('p', { text: `About ${fmtDur(r.weekly)} a week over ${plural(ctx.s.shiftsPerWeek, 'shift', 'shifts')}.` }));
    const fare = fareText(r);
    if (fare) meta.push(h('p', { text: `Fare: ${fare}.` }));
    if (r.range && r.range.best && r.range.worst) {
      meta.push(h('p', { text: r.range.best.start === r.range.worst.start
        ? `Every start time from 8 AM to 1 PM: about ${fmtDur(r.range.best.tot)} round trip.`
        : `Start times 8 AM to 1 PM: ${fmtDur(r.range.best.tot)} at best (${shortHour(r.range.best.start)} start), ${fmtDur(r.range.worst.tot)} at worst (${shortHour(r.range.worst.start)} start).` }));
    }
    const warns = r.warnings.length ? h('ul', { class: 'warnings' }, ...r.warnings.map((w) => h('li', { class: w.caution ? 'is-caution' : '', text: w.text }))) : null;
    const canDetail = (r.there && !r.there.noRoute) || (r.home && !r.home.noRoute);
    const acts = h('div', { class: 'row-actions' },
      h('button', {
        type: 'button', id: 'det-' + st.id, class: 'btn', disabled: !canDetail,
        onclick: () => openDetail(st.id, r.there && !r.there.noRoute ? 'there' : 'home', 'det-' + st.id),
      }, iconRoute(), 'Trip details'));
    return h('li', { class: 'row', id: 'row-' + st.id }, head, sub, h('div', { class: 'bars' }, ...bars), meta.length ? h('div', { class: 'row-meta' }, ...meta) : null, warns, acts);
  }

  // ----- details sheet
  const isPhoneLayout = () => window.matchMedia('(max-width: 899px)').matches;
  function openDetail(startId, dir, openerId) {
    state.detail = { startId, dir, opener: openerId || '', scrollY: window.scrollY };
    state.focusStartId = startId;
    if (isPhoneLayout()) window.scrollTo(0, 0); // so the route on the map shows above the panel
    renderSheet();
    loadDetail(false);
    updateMap();
    const title = $('#sheetTitle');
    if (title) title.focus({ preventScroll: true });
  }
  function closeDetail(doRender = true) {
    if (!state.detail) return;
    const { opener, scrollY } = state.detail;
    state.detail = null;
    if (doRender) {
      renderSheet();
      MapView.refit();
      updateMap();
      if (isPhoneLayout()) window.scrollTo(0, scrollY || 0);
      const el = opener && document.getElementById(opener);
      if (el) el.focus({ preventScroll: true });
    }
  }
  function tripClock(d, dir, targetMs) {
    const steps = d.steps || [];
    const firstT = steps.findIndex((x) => x.transit && x.transit.dep);
    let lastT = -1;
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].transit && steps[i].transit.arr) { lastT = i; break; }
    if (firstT < 0 || lastT < 0 || d.sec == null) {
      return dir === 'there' ? { leave: targetMs - (d.sec || 0) * 1000, arrive: targetMs } : { leave: targetMs, arrive: targetMs + (d.sec || 0) * 1000 };
    }
    const before = steps.slice(0, firstT).reduce((a, x) => a + (x.sec || 0), 0);
    const after = steps.slice(lastT + 1).reduce((a, x) => a + (x.sec || 0), 0);
    return { leave: steps[firstT].transit.dep - before * 1000, arrive: steps[lastT].transit.arr + after * 1000 };
  }
  function renderSheet() { withFocus(renderSheetInner); }
  function renderSheetInner() {
    const sh = $('#sheet');
    if (!state.detail || state.view !== 'compare') { sh.hidden = true; sh.replaceChildren(); return; }
    const info = detailInfo();
    if (!info) { state.detail = null; sh.hidden = true; sh.replaceChildren(); return; }
    const { d, ctx, t, key, from, to } = info;
    const entry = getResult(key);
    const loading = state.detailInflight.has(key);
    const error = state.detailErrors.get(key);
    const kids = [
      h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      h('div', { class: 'sheet-head' },
        h('h2', { id: 'sheetTitle', tabindex: '-1', text: `${displayName(from)} to ${displayName(to)}` }),
        h('button', { type: 'button', id: 'sheet-close', class: 'btn btn-quiet', 'aria-label': 'Close trip details', onclick: () => closeDetail(), text: 'Close' })),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Which trip' },
        h('button', { type: 'button', id: 'seg-there', 'aria-pressed': String(d.dir === 'there'), onclick: () => switchDir('there'), text: 'Trip there' }),
        h('button', { type: 'button', id: 'seg-home', 'aria-pressed': String(d.dir === 'home'), onclick: () => switchDir('home'), text: 'Trip home' })),
    ];
    if (loading) kids.push(h('p', { class: 'busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Getting the trip from Google…'));
    else if (error && !entry) kids.push(h('p', { style: { color: 'var(--warn)' }, text: error }), h('button', { type: 'button', id: 'sheet-retry', class: 'btn', onclick: () => loadDetail(true), text: 'Try again' }));
    else if (!entry) kids.push(h('p', { text: 'Trip details aren’t loaded.' }), h('button', { type: 'button', id: 'sheet-get', class: 'btn', onclick: () => loadDetail(true), text: 'Get trip details' }));
    else if (entry.v.noRoute) kids.push(h('p', { text: d.dir === 'there' ? `Google found no transit trip arriving by ${clockLabel(t.arriveMin)}.` : `Google found no transit trip leaving at ${clockLabel(t.leaveMin)}.` }));
    else kids.push(...tripBody(entry, d.dir, t, ctx, from, to));
    kids.push(h('div', { class: 'sheet-links' },
      h('a', { id: 'sheet-maps', class: 'btn btn-primary', href: mapsUrl(from, to, 'transit'), target: '_blank', rel: 'noopener', text: 'Open in Google Maps' }),
      h('a', { id: 'sheet-drive', class: 'btn', href: mapsUrl(from, to, 'driving'), target: '_blank', rel: 'noopener', text: 'Driving' }),
      h('a', { id: 'sheet-walk', class: 'btn', href: mapsUrl(from, to, 'walking'), target: '_blank', rel: 'noopener', text: 'Walking' })),
      h('p', { class: 'hint', text: `Google Maps opens with "leave now". Set ${d.dir === 'there' ? `"Arrive by ${clockLabel(t.arriveMin)}"` : `"Depart at ${clockLabel(t.leaveMin)}"`} there to see this trip.` }));
    if (entry && !loading) {
      kids.push(h('p', { class: 'hint', style: { marginTop: '12px' } }, `Checked ${stampOf(entry.at)}. `,
        h('button', { type: 'button', id: 'sheet-recheck', class: 'btn btn-quiet', onclick: () => loadDetail(true), text: 'Recheck this trip' })));
    }
    sh.replaceChildren(...kids);
    sh.hidden = false;
  }
  function switchDir(dir) {
    if (!state.detail || state.detail.dir === dir) return;
    state.detail.dir = dir;
    renderSheet();
    loadDetail(false);
    updateMap();
  }
  function tripBody(entry, dir, t, ctx, from, to) {
    const d = entry.v;
    const target = dir === 'there' ? +t.arriveAt : +t.leaveAt;
    const clock = tripClock(d, dir, target);
    const steps = mergedSteps(d.steps);
    const rides = steps.filter((x) => x.mode === 'TRANSIT').length;
    const walkSec = steps.filter((x) => x.mode !== 'TRANSIT').reduce((a, x) => a + (x.sec || 0), 0);
    const facts = [];
    if (dir === 'there') {
      const early = Math.round((zonedDate(ctx.day.ymd, ctx.s.shiftStart) - clock.arrive) / 60000);
      facts.push(`Leave ${clockOf(clock.leave)}, arrive ${clockOf(clock.arrive)}.`);
      if (early >= 0) facts.push(`That’s ${early} min before your ${clockLabel(ctx.s.shiftStart)} shift.`);
    } else {
      const wait = Math.round((clock.leave - target) / 60000);
      facts.push(`Your shift ends ${clockLabel(t.leaveMin)}. Leave ${clockOf(clock.leave)}, get home ${clockOf(clock.arrive)}.`);
      if (wait >= 2) facts.push(`About ${wait} min after your shift ends before you need to leave.`);
    }
    const parts = [];
    if (rides) parts.push(rides === 1 ? '1 ride' : `${rides} rides, ${plural(rides - 1, 'transfer', 'transfers')}`);
    if (walkSec) parts.push(`${fmtDur(walkSec)} walking`);
    if (d.fare) parts.push(`fare ${d.fare}`);
    const body = [
      h('div', { class: 'trip-summary' },
        h('p', { class: 'big', text: fmtDur(d.sec) }),
        ...facts.map((f) => h('p', { text: f })),
        parts.length ? h('p', { text: parts.join(', ') + '.' }) : null),
    ];
    const strip = h('ol', { class: 'route-strip', 'aria-label': 'Trip steps' });
    strip.append(h('li', { class: 'leg-end' + (from.kind === 'start' ? ' is-start' : '') + ' leg-start-node', text: displayName(from) }));
    for (const x of steps) {
      if (x.mode === 'TRANSIT' && x.transit) {
        const tr = x.transit;
        const color = tr.color || '';
        const li = h('li', { class: 'leg' });
        if (color) { li.style.setProperty('--leg-color', color); li.style.setProperty('--leg-text', tr.textColor || readableOn(color)); }
        li.append(
          h('span', { class: 'node', 'aria-hidden': 'true' }),
          h('div', { class: 'leg-title' },
            tr.line ? h('span', { class: 'line-chip', text: tr.line }) : null,
            h('span', { text: [tr.vehicle || 'Transit', tr.lineName && tr.lineName !== tr.line ? tr.lineName : '', tr.headsign ? `toward ${tr.headsign}` : ''].filter(Boolean).join(' ') })),
          h('p', { text: `Board at ${tr.from || 'the stop'}${tr.dep ? ' at ' + clockOf(tr.dep) : ''}.` }),
          h('p', { text: `Get off at ${tr.to || 'your stop'}${tr.arr ? ' at ' + clockOf(tr.arr) : ''}${tr.stops != null ? `, ${plural(tr.stops, 'stop', 'stops')}` : ''}.` }));
        strip.append(li);
      } else {
        strip.append(h('li', { class: 'leg is-walk' },
          h('span', { class: 'node', 'aria-hidden': 'true' }),
          h('div', { class: 'leg-title', text: `Walk ${fmtDur(x.sec)}` }),
          x.m ? h('p', { text: fmtMeters(x.m) }) : null));
      }
    }
    strip.append(h('li', { class: 'leg-end' + (to.kind === 'start' ? ' is-start' : ''), text: displayName(to) }));
    body.push(strip);
    return body;
  }
  function mapsUrl(from, to, mode) {
    const q = new URLSearchParams({ api: '1' });
    q.set('origin', from.address || from.input || `${from.lat},${from.lng}`);
    if (from.placeId && !from.placeId.startsWith('sample-')) q.set('origin_place_id', from.placeId);
    q.set('destination', to.address || to.input || `${to.lat},${to.lng}`);
    if (to.placeId && !to.placeId.startsWith('sample-')) q.set('destination_place_id', to.placeId);
    q.set('travelmode', mode);
    return 'https://www.google.com/maps/dir/?' + q.toString();
  }
  function onPinClick(id, viaKeyboard) {
    const p = findPlace(id);
    if (!p) return;
    if (p.kind === 'dest') {
      selectDest(id);
      const btn = viaKeyboard && document.getElementById('dest-' + id);
      if (btn) btn.focus();
      return;
    }
    state.focusStartId = id;
    updateMap();
    const row = document.getElementById('row-' + id);
    if (row) {
      row.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      row.classList.remove('is-flash');
      void row.offsetWidth;
      row.classList.add('is-flash');
      const btn = viaKeyboard && document.getElementById('det-' + id);
      if (btn && !btn.disabled) btn.focus({ preventScroll: true });
    }
  }

  // ----- places view
  function renderPlaces() { withFocus(renderPlacesInner); }
  function renderPlacesInner() {
    if (state.view !== 'places') return;
    const root = $('#view-places');
    const ta = h('textarea', {
      id: 'addText', rows: 5, spellcheck: 'false', autocomplete: 'off',
      placeholder: 'Home | 10 Peel Centre Dr, Brampton\nMom’s | 123 Main St N, Brampton\n1 Yonge St, Toronto',
      oninput: (e) => { state.addDraft = e.target.value; },
    });
    ta.value = state.addDraft;
    const kindSel = h('select', { id: 'addKind', onchange: (e) => { state.addKind = e.target.value; } },
      h('option', { value: 'start', selected: state.addKind === 'start', text: 'Starting points' }),
      h('option', { value: 'dest', selected: state.addKind === 'dest', text: 'Destinations' }));
    const pendingCount = state.data.places.filter((p) => !hasCoords(p)).length;
    const addPanel = h('div', { class: 'panel' },
      h('h3', { text: 'Add places' }),
      h('div', { class: 'add-grid' },
        h('label', { class: 'field', for: 'addText' }, 'One address per line. Add a nickname before a bar if you like.', ta),
        h('div', { class: 'add-row' },
          h('label', { class: 'field', for: 'addKind' }, 'Add them as', kindSel),
          h('button', { type: 'button', id: 'add-btn', class: 'btn btn-primary', disabled: state.adding, onclick: addPlaces, text: state.adding ? 'Looking up…' : 'Look up and add' })),
        h('p', { class: 'hint', text: providerReady() ? 'Each address uses one Google address lookup. Results are biased toward the Toronto area.' : 'Your Google key isn’t working yet, so addresses are saved now and looked up later.' })),
      state.addLog.length ? h('ul', { class: 'log' }, ...state.addLog.map((l) => h('li', { class: l.bad ? 'is-bad' : l.check ? 'is-check' : '', text: l.text }))) : null);
    const col = (kind, title, blurb) => {
      const list = placesOf(kind);
      return h('div', { class: 'panel' },
        h('h3', { text: `${title} (${list.length})` }),
        h('p', { class: 'hint', text: blurb }),
        list.length ? h('ul', { class: 'place-list' }, ...list.map(placeItem)) : h('p', { class: 'hint', text: 'None yet.' }));
    };
    root.replaceChildren(h('div', { class: 'page' },
      h('h2', { text: 'Places' }),
      h('p', { class: 'lede', text: 'Starting points are where you might leave from. Destinations are where you work. On Compare, tap a destination to rank every starting point against it.' }),
      addPanel,
      pendingCount && providerReady() ? h('div', { class: 'panel' }, h('p', { text: `${plural(pendingCount, 'place needs', 'places need')} an address lookup.` }), h('button', { type: 'button', id: 'lookup-btn', class: 'btn', disabled: state.lookingUp, onclick: lookupPending, text: state.lookingUp ? 'Looking up…' : 'Look them up now' })) : null,
      h('div', { class: 'place-cols' },
        col('start', 'Starting points', 'Where you’d leave from: home, or places you’re thinking of moving to.'),
        col('dest', 'Destinations', 'Where you work. Each one gets its own ranking.'))));
  }
  function placeItem(p) {
    const flags = [];
    if (!hasCoords(p)) flags.push(h('span', { class: 'flag is-bad', text: providerReady() ? 'Not found yet. Change the address or look it up again.' : 'Waiting for a lookup.' }));
    else if (p.partial) flags.push(h('span', { class: 'flag', text: 'Partial match. Check this is the right place.' }));
    if (p.sample) flags.push(h('span', { class: 'flag', text: 'Sample place' }));
    return h('li', { class: 'place' + (p.kind === 'dest' ? ' is-dest' : '') },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('span', { class: 'name', text: displayName(p) }),
      h('span', { class: 'addr', text: p.address || p.input }),
      ...flags,
      h('span', { class: 'ops' },
        h('button', { type: 'button', id: 'rename-' + p.id, class: 'btn', onclick: () => renamePlace(p), text: 'Rename' }),
        h('button', { type: 'button', id: 'addr-' + p.id, class: 'btn', onclick: () => readdressPlace(p), text: 'Change address' }),
        h('button', { type: 'button', id: 'del-' + p.id, class: 'btn btn-danger', onclick: () => deletePlace(p), text: 'Remove' })));
  }

  // ----- settings view
  function numberField(label, key, min, max, stepVal, suffix) {
    const id = 'set-' + key;
    return h('label', { class: 'field', for: id }, label,
      h('input', {
        id, type: 'number', inputmode: 'decimal', min, max, step: stepVal, value: state.data.settings[key],
        onchange: (e) => {
          const v = Number(e.target.value);
          if (e.target.value === '' || !Number.isFinite(v)) { e.target.value = state.data.settings[key]; return; }
          e.target.value = saveSettingQuietly(key, v, key !== 'shiftsPerWeek');
        },
      }), suffix ? h('span', { class: 'hint', text: suffix }) : null);
  }
  function renderSettings() { withFocus(renderSettingsInner); }
  function renderSettingsInner() {
    if (state.view !== 'settings') return;
    const root = $('#view-settings');
    const s0 = state.data.settings;
    const status = state.data.settings.demo ? { cls: 'is-wait', text: 'Sample mode is on, so your key isn’t being used.' }
      : state.providerStatus === 'ready' ? { cls: 'is-ok', text: 'Google is connected.' }
        : state.providerStatus === 'loading' ? { cls: 'is-wait', text: 'Connecting to Google…' }
          : state.providerStatus === 'error' ? { cls: 'is-bad', text: 'There’s a problem with the key. See the message at the top.' }
            : { cls: '', text: 'No key yet.' };
    const keyInput = h('input', { id: 'apiKeyInput', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: state.apiKey ? 'Key saved. Paste a new one to replace it.' : 'Paste your Google Maps API key' });
    const keyPanel = h('div', { class: 'panel' },
      h('h3', { text: 'Google key' }),
      h('p', { class: 'status-line' }, h('span', { class: 'status-dot ' + status.cls, 'aria-hidden': 'true' }), status.text),
      h('div', { class: 'key-row' },
        h('label', { class: 'field', for: 'apiKeyInput' }, 'API key', keyInput),
        h('button', { type: 'button', id: 'key-toggle', class: 'btn', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; }, text: 'Show or hide' }),
        h('button', { type: 'button', id: 'key-save', class: 'btn btn-primary', onclick: () => saveKey(keyInput.value), text: 'Save key' })),
      h('p', { class: 'hint', text: 'Saved only in this browser on this device, and left out of backups. Saving reloads the app.' }),
      state.apiKey ? h('p', {}, h('button', { type: 'button', id: 'key-remove', class: 'btn btn-danger', onclick: removeKey, text: 'Remove key from this device' })) : null);
    const demoPanel = h('div', { class: 'panel' },
      h('h3', { text: 'Sample mode' }),
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', id: 'demo-toggle', checked: s0.demo, onchange: (e) => setDemo(e.target.checked) }),
        h('span', {}, 'Use sample places and made-up times', h('small', { text: 'Nothing is sent to Google and nothing counts toward your free use. Handy for trying things out.' }))));
    const shiftPanel = h('div', { class: 'panel' },
      h('h3', { text: 'Your shifts' }),
      h('div', { class: 'set-grid' },
        numberField('Shift length (hours)', 'shiftHours', 1, 14, 0.5),
        numberField('Arrive early (minutes)', 'arriveEarlyMin', 0, 90, 5),
        numberField('Shifts per week', 'shiftsPerWeek', 0, 7, 1),
        numberField('Show walking within (km)', 'walkLimitKm', 0, 20, 0.5)));
    const c = usageCounts();
    const meter = h('div', { class: 'meter' }, ...Object.keys(FREE).map((k) => {
      const used = c[k] || 0;
      const frac = used / FREE[k];
      return h('div', { class: 'meter-row' + (frac >= 1 ? ' is-over' : frac >= 0.8 ? ' is-high' : ''), title: USAGE_NOTES[k] },
        h('span', { text: USAGE_LABELS[k] }),
        h('span', { class: 'num', text: `${used.toLocaleString()} of ${FREE[k].toLocaleString()}` }),
        h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { style: { width: Math.min(100, frac * 100).toFixed(1) + '%' } })));
    }));
    const usagePanel = h('div', { class: 'panel', id: 'usagePanel' },
      h('h3', { text: 'Free monthly use on this device' }),
      h('p', { class: 'hint', text: 'Google gives these amounts free each month, and resets them on the 1st (Pacific time). This only counts what this device sent, so Google’s billing page has the real total.' }),
      meter,
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', id: 'free-ask', checked: s0.stopAtFree, onchange: (e) => saveSettingQuietly('stopAtFree', e.target.checked, false) }),
        h('span', {}, 'Ask before going past a free amount')),
      h('p', {}, h('button', { type: 'button', id: 'usage-reset', class: 'btn btn-quiet', onclick: resetUsage, text: 'Reset this device’s count' })));
    pruneResults();
    const resultEntries = Object.values(state.results);
    const oldest = resultEntries.length ? Math.min(...resultEntries.map((e) => e.at)) : null;
    const savedPanel = h('div', { class: 'panel' },
      h('h3', { text: 'Saved results' }),
      h('p', { text: resultEntries.length ? `${plural(resultEntries.length, 'saved result', 'saved results')}, oldest from ${stampOf(oldest)}. Each one deletes itself 30 days after it was checked.` : 'No saved results yet.' }),
      s0.demo ? h('p', { class: 'hint', text: 'Sample mode results aren’t saved and aren’t counted here.' }) : null,
      h('div', { class: 'add-row' },
        h('button', { type: 'button', id: 'res-csv', class: 'btn', onclick: onDownloadAllCSV, disabled: !resultEntries.length || s0.demo, text: 'Download all as CSV' }),
        h('button', { type: 'button', id: 'res-clear', class: 'btn btn-danger', onclick: clearResults, disabled: !resultEntries.length, text: 'Delete all now' })));
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', id: 'importFile', onchange: (e) => { onImportBackup(e.target.files && e.target.files[0]); e.target.value = ''; } });
    const backupPanel = h('div', { class: 'panel' },
      h('h3', { text: 'Backup' }),
      h('p', { class: 'hint', text: 'Moves your places and settings between devices. Your Google key and saved results aren’t included.' }),
      h('div', { class: 'add-row' },
        h('button', { type: 'button', id: 'backup-down', class: 'btn', onclick: onExportBackup, text: 'Download backup' }),
        h('button', { type: 'button', id: 'backup-restore', class: 'btn', onclick: () => fileInput.click(), text: 'Restore from backup' }),
        fileInput));
    root.replaceChildren(h('div', { class: 'page' },
      h('h2', { text: 'Settings' }),
      keyPanel, demoPanel, shiftPanel, usagePanel, savedPanel, backupPanel,
      h('p', { class: 'hint', text: `Headway ${VERSION}. Times come from Google and are estimates, so check the trip in Google Maps before you rely on it.` })));
  }
  function saveKey(raw) {
    const v = String(raw || '').trim();
    if (!v) { toast('Paste your key first.'); return; }
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(v)) { toast('That doesn’t look like a Google API key. They’re about 39 letters, numbers, dashes or underscores.'); return; }
    if (!Store.set(KEYS.apiKey, v)) { toast('Couldn’t save the key on this device.'); return; }
    if (state.data.settings.demo) { state.data.settings.demo = false; clearSamplePlaces(false); purgeSampleResults(); saveData(); }
    state.sampleResults = {};
    location.reload();
  }
  function removeKey() {
    if (!window.confirm('Remove your Google key from this device?')) return;
    Store.del(KEYS.apiKey);
    location.reload();
  }
  function resetUsage() {
    if (!window.confirm('Reset this device’s count to zero? This doesn’t change anything at Google.')) return;
    state.usage = { month: pacificMonth(), counts: {} };
    Store.set(KEYS.usage, state.usage);
    render();
  }
  function clearResults() {
    if (!window.confirm('Delete all saved results now?')) return;
    cancelAllRuns(); // stop anything still asking Google
    state.inflight.clear();
    state.keyErrors.clear();
    state.results = {};
    state.sampleResults = {};
    persistResults();
    state.detail = null;
    render();
    toast('Saved results deleted.');
  }
  function purgeSampleResults() {
    for (const k of Object.keys(state.results)) if (k.includes('|sample-')) delete state.results[k];
    persistResults();
  }
  function clearSamplePlaces(ask) {
    const samples = state.data.places.filter((p) => p.sample);
    if (samples.length && (!ask || window.confirm(`Remove the ${plural(samples.length, 'sample place', 'sample places')} too?`))) {
      state.data.places = state.data.places.filter((p) => !p.sample);
    }
    // Places you added during sample mode got made-up locations, so look them up again for real.
    for (const p of state.data.places) {
      if (p.placeId && p.placeId.startsWith('sample-') && !p.sample) {
        p.placeId = ''; p.address = ''; p.lat = null; p.lng = null; p.coordsAt = 0;
      }
    }
  }
  function setDemo(on) {
    const s0 = state.data.settings;
    if (on === s0.demo) return;
    s0.demo = on;
    state.detail = null;
    if (on) {
      if (!state.data.places.length) {
        state.data.places = SAMPLE_PLACES.map((p) => normalizePlace({ ...p, id: uid(), input: 'Sample location', address: 'Sample location', placeId: `sample-${hashStr(p.name)}`, coordsAt: Date.now(), sample: true }));
        s0.selectedDestId = null;
      }
    } else {
      clearSamplePlaces(true);
      purgeSampleResults();
      state.sampleResults = {};
    }
    ensureSelectedDest();
    saveData();
    MapView.refit();
    if (on && state.view === 'settings') state.view = 'compare';
    chooseProvider();
  }

  // ----- toast
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
  }

  // ----- icons
  function icon(d) {
    return s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  const iconCar = () => icon('M5 16h14M6 16v2.5M18 16v2.5M4.5 16l1.6-5.2A2 2 0 0 1 8 9.4h8a2 2 0 0 1 1.9 1.4L19.5 16M8 13h.01M16 13h.01');
  const iconClock = () => icon('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2');
  const iconRefresh = () => icon('M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6');
  const iconRoute = () => icon('M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7');

  // ---------------------------------------------------------------- start
  function init() {
    state.data = normalizeData(Store.get(KEYS.data, null));
    const res = Store.get(KEYS.results, {});
    state.results = res && typeof res === 'object' && !Array.isArray(res) ? res : {};
    if (pruneStore(state.results)) Store.set(KEYS.results, state.results); // expired results leave the device right away
    const u = Store.get(KEYS.usage, null);
    state.usage = u && typeof u === 'object' ? u : { month: '', counts: {} };
    const k = Store.get(KEYS.apiKey, '');
    state.apiKey = typeof k === 'string' ? k : '';
    ensureSelectedDest();
    MapView.mount($('#map'));
    for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => go(b.dataset.view));
    $('#usageChip').addEventListener('click', () => {
      go('settings');
      const panel = document.getElementById('usagePanel');
      if (panel) panel.scrollIntoView({ block: 'start' });
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.detail) closeDetail(); });
    window.addEventListener('resize', debounce(() => { if (MapView.kind === 'schematic') updateMap(); }, 200));
    window.addEventListener('storage', (e) => { if (e.key === KEYS.apiKey) location.reload(); });
    render();
    chooseProvider();
  }

  window.__headway = { state, version: VERSION, getContext, buildRow, exportTable, zonedDate, resolveTripDay };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

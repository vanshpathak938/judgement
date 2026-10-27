'use strict';
/*
 * Judgement — single-table card game server. Zero dependencies (Node 18+).
 *  - Accounts: name + passcode (scrypt-hashed), saved in DATA_DIR/data.json
 *  - One always-open table; spectators can watch, seated players play
 *  - Live updates over Server-Sent Events, actions over plain POSTs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();
const SESSION_MS = 90 * 24 * 3600 * 1000;
const LOBBY_IDLE_MS = 10 * 60 * 1000;
const ABANDON_MS = 60 * 1000;
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

// ---------------------------------------------------------------- storage
let db = { users: {}, sessions: {}, table: null };

function load() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read data file:', e.message);
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    db = Object.assign(db, parsed);
  } catch (e) {
    const bak = `${DATA_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(DATA_FILE, bak);
    console.error(`Data file was unreadable; moved to ${bak} and starting fresh.`);
  }
  db.users = db.users || {};
  db.sessions = db.sessions || {};
}
load();

let table = db.table && Array.isArray(db.table.seats) ? db.table : G.newTable(1);
{
  // After a restart nobody is connected yet: give everyone a fresh clock.
  const now = Date.now();
  table.turnStart = now;
  if (table.until && table.until < now + 3000) table.until = now + 3000;
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 500);
}
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db.table = table;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Save failed:', e.message);
  }
}

// ---------------------------------------------------------------- helpers
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,15}$/u;
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return NAME_RE.test(n) ? n : null;
}
const keyOf = (name) => name.toLowerCase();

function hashPass(pass, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pass, salt, 32, (err, k) => (err ? reject(err) : resolve(k.toString('hex'))))
  );
}
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// crude in-memory throttles
const fails = new Map(); // id -> {n, first}
const FAIL_WINDOW = 10 * 60 * 1000;
function locked(id, limit) {
  const a = fails.get(id);
  if (!a) return false;
  if (Date.now() - a.first > FAIL_WINDOW) {
    fails.delete(id);
    return false;
  }
  return a.n >= limit;
}
function noteFail(id) {
  const a = fails.get(id);
  if (!a || Date.now() - a.first > FAIL_WINDOW) fails.set(id, { n: 1, first: Date.now() });
  else a.n += 1;
}
const signups = new Map(); // ip -> [timestamps]
function signupAllowed(ip) {
  const hour = Date.now() - 3600 * 1000;
  const list = (signups.get(ip) || []).filter((t) => t > hour);
  signups.set(ip, list);
  if (list.length >= 8) return false;
  list.push(Date.now());
  return true;
}

function newSession(key) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { key, at: Date.now() };
  // keep at most 10 sessions per user
  const mine = Object.entries(db.sessions)
    .filter(([, s]) => s.key === key)
    .sort((a, b) => a[1].at - b[1].at);
  while (mine.length > 10) delete db.sessions[mine.shift()[0]];
  return token;
}
function userFromToken(token) {
  const s = token && db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.at > SESSION_MS) {
    delete db.sessions[token];
    return null;
  }
  const u = db.users[s.key];
  return u ? { key: s.key, name: u.name, token } : null;
}
function tokenOf(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('token') || '';
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(Object.assign(new Error('Bad JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- live clients
const clients = new Set(); // {res, key, token}
const connCount = new Map(); // key -> n
const lastOnline = new Map(); // key -> ts
let lbCache = null;
let broadcastTimer = null;

function refreshOnline() {
  let changed = false;
  const now = Date.now();
  for (const s of table.seats) {
    const on = (connCount.get(s.key) || 0) > 0;
    if (on) lastOnline.set(s.key, now);
    else if (!lastOnline.has(s.key)) lastOnline.set(s.key, now);
    if (s.online !== on) {
      s.online = on;
      changed = true;
    }
  }
  return changed;
}

function leaderboard() {
  if (lbCache) return lbCache;
  lbCache = Object.values(db.users)
    .filter((u) => u.games > 0)
    .sort((a, b) => b.wins - a.wins || a.games - b.games || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((u) => ({ name: u.name, wins: u.wins, games: u.games }));
  return lbCache;
}

function onlineNames() {
  const names = [];
  for (const [key, n] of connCount) if (n > 0 && db.users[key]) names.push(db.users[key].name);
  return names.sort((a, b) => a.localeCompare(b)).slice(0, 40);
}

function payloadFor(key) {
  return JSON.stringify({
    now: Date.now(),
    you: db.users[key] ? db.users[key].name : '',
    game: G.viewFor(table, key),
    leaderboard: leaderboard(),
    online: onlineNames(),
  });
}

function queueBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    for (const c of clients) {
      try {
        c.res.write(`data: ${payloadFor(c.key)}\n\n`);
      } catch {
        /* closed; cleanup happens in 'close' */
      }
    }
  }, 25);
}

function recordStatsIfDone() {
  if (table.phase !== 'finished' || table.statsRecorded) return;
  table.statsRecorded = true;
  for (const s of table.seats) {
    const u = db.users[s.key];
    if (!u) continue;
    u.games = (u.games || 0) + 1;
    u.points = (u.points || 0) + s.score;
    if (table.winners.includes(s.key)) u.wins = (u.wins || 0) + 1;
  }
  lbCache = null;
}

function afterChange() {
  recordStatsIfDone();
  saveSoon();
  queueBroadcast();
}

// ---------------------------------------------------------------- actions
function doAction(user, body) {
  const t = table;
  const idx = t.seats.findIndex((s) => s.key === user.key);
  const needSeat = () => (idx < 0 ? { ok: false, error: 'Take a seat first.' } : null);
  let r;
  switch (String(body.type || '')) {
    case 'join':
      r = G.join(t, user.key, user.name);
      break;
    case 'leave':
      r = G.leave(t, user.key);
      break;
    case 'start':
      r = G.start(t, user.key);
      break;
    case 'settings':
      r = G.setSettings(t, user.key, body.settings && typeof body.settings === 'object' ? body.settings : {});
      break;
    case 'bid':
      r = needSeat() || G.bid(t, idx, body.n);
      break;
    case 'play':
      r = needSeat() || G.play(t, idx, body.card);
      break;
    case 'ready':
      r = needSeat() || G.ready(t, idx);
      break;
    case 'again':
      r = G.again(t, user.key);
      break;
    case 'back':
      r = needSeat() || G.back(t, idx);
      break;
    default:
      r = { ok: false, error: 'Unknown action.' };
  }
  if (r.ok) {
    refreshOnline();
    afterChange();
  }
  return r;
}

// ---------------------------------------------------------------- housekeeping
let emptySince = 0;
function tick() {
  const now = Date.now();
  let changed = refreshOnline();

  if (table.phase === 'lobby') {
    const before = table.seats.length;
    table.seats = table.seats.filter((s) => s.online || now - (lastOnline.get(s.key) || now) < LOBBY_IDLE_MS);
    if (table.seats.length !== before) changed = true;
    emptySince = 0;
  } else {
    const someonePresent = table.seats.some((s) => s.online && !s.away);
    if (someonePresent) emptySince = 0;
    else {
      emptySince = emptySince || now;
      if (now - emptySince > ABANDON_MS) {
        G.resetTable(table);
        emptySince = 0;
        changed = true;
      }
    }
  }

  if (G.tick(table, now)) changed = true;
  if (changed) afterChange();
}
setInterval(tick, 500);
setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }
}, 20000);
setInterval(() => {
  const now = Date.now();
  for (const [id, a] of fails) if (now - a.first > FAIL_WINDOW) fails.delete(id);
  for (const [tok, s] of Object.entries(db.sessions)) if (now - s.at > SESSION_MS) delete db.sessions[tok];
}, 10 * 60 * 1000);

// ---------------------------------------------------------------- http
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

async function handleAuth(req, res, kind) {
  const ip = clientIp(req);
  const body = await readJson(req);
  const name = cleanName(body.name);
  const pass = typeof body.pass === 'string' ? body.pass : '';

  if (!name) {
    return send(res, 400, { error: 'Names are 2–16 characters: letters, numbers, spaces, _ . or -' });
  }
  if (pass.length < 4 || pass.length > 64) {
    return send(res, 400, { error: 'Your passcode needs 4 to 64 characters.' });
  }
  const key = keyOf(name);

  if (kind === 'register') {
    if (INVITE_CODE && !safeEq(String(body.invite || '').trim(), INVITE_CODE)) {
      return send(res, 403, { error: 'That invite code is not right. Ask whoever runs this table.' });
    }
    if (db.users[key]) return send(res, 409, { error: 'That name is taken. Sign in, or pick another name.' });
    if (!signupAllowed(ip)) return send(res, 429, { error: 'Too many new accounts from your network. Try again later.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPass(pass, salt);
    if (db.users[key]) return send(res, 409, { error: 'That name is taken. Sign in, or pick another name.' });
    db.users[key] = { name, salt, hash, created: Date.now(), games: 0, wins: 0, points: 0 };
    const token = newSession(key);
    saveSoon();
    return send(res, 200, { token, name });
  }

  // login
  const ipId = `ip|${ip}`;
  const userId = `user|${ip}|${key}`;
  if (locked(ipId, 30) || locked(userId, 6)) {
    return send(res, 429, { error: 'Too many wrong tries. Wait a few minutes and try again.' });
  }
  const u = db.users[key];
  const salt = u ? u.salt : 'ffffffffffffffffffffffffffffffff';
  const hash = await hashPass(pass, salt);
  if (!u || !safeEq(hash, u.hash)) {
    noteFail(ipId);
    noteFail(userId);
    return send(res, 401, { error: 'Wrong name or passcode.' });
  }
  const token = newSession(key);
  saveSoon();
  return send(res, 200, { token, name: u.name });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    if (req.method === 'GET' && p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method === 'GET' && p === '/api/config') {
      return send(res, 200, { inviteRequired: Boolean(INVITE_CODE) });
    }
    if (req.method === 'POST' && p === '/api/register') return await handleAuth(req, res, 'register');
    if (req.method === 'POST' && p === '/api/login') return await handleAuth(req, res, 'login');

    if (p.startsWith('/api/')) {
      const user = userFromToken(tokenOf(req, url));
      if (!user) return send(res, 401, { error: 'Please sign in again.' });

      if (req.method === 'GET' && p === '/api/me') return send(res, 200, { name: user.name });

      if (req.method === 'POST' && p === '/api/logout') {
        delete db.sessions[user.token];
        for (const c of clients) if (c.token === user.token) c.res.end();
        saveSoon();
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/action') {
        const body = await readJson(req);
        const r = doAction(user, body);
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
      }

      if (req.method === 'GET' && p === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        const client = { res, key: user.key, token: user.token };
        clients.add(client);
        connCount.set(user.key, (connCount.get(user.key) || 0) + 1);
        lastOnline.set(user.key, Date.now());
        refreshOnline();
        res.write(`data: ${payloadFor(user.key)}\n\n`);
        queueBroadcast(); // tell everyone else this person is here
        req.on('close', () => {
          clients.delete(client);
          connCount.set(user.key, Math.max(0, (connCount.get(user.key) || 1) - 1));
          refreshOnline();
          queueBroadcast();
        });
        return;
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : e.message });
    else res.end();
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`Judgement is running on port ${PORT}`));

function shutdown() {
  saveNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

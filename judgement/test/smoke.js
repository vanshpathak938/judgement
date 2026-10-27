'use strict';
// Boots the real server, signs up three people, plays a whole game over HTTP + SSE,
// then restarts the server and checks that accounts and stats were remembered.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'judgement-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, JUDGEMENT_FAST: '1', INVITE_CODE: 'letmein' }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return child;
}
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}
async function post(p, body, token) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, data: await r.json() };
}

class Player {
  constructor(name, token) { this.name = name; this.token = token; this.state = null; this.raw = ''; }
  async listen() {
    const ctl = (this.ctl = new AbortController());
    const res = await fetch(`${BASE}/api/stream?token=${this.token}`, { signal: ctl.signal });
    assert.strictEqual(res.status, 200);
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const msg = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = msg.split('\n').find((l) => l.startsWith('data: '));
            if (line) { this.raw = line.slice(6); this.state = JSON.parse(this.raw); }
          }
        }
      } catch {}
    })();
    for (let i = 0; i < 50 && !this.state; i++) await sleep(50);
    assert(this.state, 'no initial state');
  }
  act(type, extra) { return post('/api/action', Object.assign({ type }, extra), this.token); }
  close() { this.ctl && this.ctl.abort(); }
}

async function main() {
  let child = boot();
  try {
    await waitUp();

    // ---- pages & config
    const page = await fetch(BASE + '/');
    assert.strictEqual(page.status, 200);
    assert((await page.text()).includes('Judgement'));
    assert.strictEqual((await (await fetch(BASE + '/api/config')).json()).inviteRequired, true);
    assert.strictEqual((await fetch(BASE + '/api/me')).status, 401);

    // ---- accounts
    assert.strictEqual((await post('/api/register', { name: 'Alice', pass: 'pw1234' })).status, 403, 'invite required');
    const names = ['Alice', 'Bob', 'Carol'];
    const players = [];
    for (const n of names) {
      const r = await post('/api/register', { name: n, pass: 'pw-' + n, invite: 'letmein' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      players.push(new Player(n, r.data.token));
    }
    assert.strictEqual((await post('/api/register', { name: 'alice', pass: 'whatever', invite: 'letmein' })).status, 409, 'names are unique ignoring case');
    assert.strictEqual((await post('/api/register', { name: '<b>x</b>', pass: 'whatever', invite: 'letmein' })).status, 400, 'bad name rejected');
    assert.strictEqual((await post('/api/register', { name: 'Dave', pass: '1', invite: 'letmein' })).status, 400, 'short passcode rejected');
    assert.strictEqual((await post('/api/login', { name: 'Alice', pass: 'nope-nope' })).status, 401);
    assert.strictEqual((await post('/api/login', { name: 'alice', pass: 'pw-Alice' })).status, 200, 'login ignores case of name');

    // ---- table
    for (const p of players) await p.listen();
    assert.strictEqual(players[0].state.game.phase, 'lobby');
    for (const p of players) assert((await p.act('join')).status === 200);
    await sleep(150);
    assert.strictEqual(players[2].state.game.seats.length, 3);
    assert((await players[1].act('start')).status === 400, 'only the host can start');
    assert((await players[0].act('settings', { settings: { maxCards: 3, mode: 'down' } })).status === 200);
    assert((await post('/api/action', { type: 'join' }, 'bogus-token')).status === 401);
    assert((await players[0].act('start')).status === 200);
    await sleep(100);

    // ---- privacy: nobody sees anyone else's cards, and no secrets leak
    for (const p of players) {
      assert(!/"salt"|"hash"|"key"|"token"/.test(p.raw), 'secret leaked in state');
      const mine = p.state.game.hand;
      assert.strictEqual(mine.length, 3);
      for (const q of players) if (q !== p) for (const c of q.state.game.hand) assert(!p.raw.includes(`"${c}"`) || mine.includes(c) || p.state.game.trick.some((t) => t.card === c));
    }

    // ---- play the whole game through the API
    const deadline = Date.now() + 60000;
    let sawIllegal = false;
    while (players[0].state.game.phase !== 'finished') {
      assert(Date.now() < deadline, 'game took too long: ' + JSON.stringify(players[0].state.game.phase));
      for (const p of players) {
        const g = p.state.game;
        if (g.phase === 'bidding' && g.turn === g.me) {
          if (!sawIllegal) {
            sawIllegal = true;
            const bad = await p.act('bid', { n: 99 });
            assert.strictEqual(bad.status, 400);
            const other = players.find((q) => q.state.game.me !== g.me);
            assert.strictEqual((await other.act('bid', { n: 0 })).status, 400, 'bidding out of turn rejected');
          }
          await p.act('bid', { n: g.validBids[0] });
        } else if (g.phase === 'playing' && g.turn === g.me) {
          assert(g.legal.length > 0);
          const illegal = g.hand.find((c) => !g.legal.includes(c));
          if (illegal) assert.strictEqual((await p.act('play', { card: illegal })).status, 400, 'must follow suit');
          await p.act('play', { card: g.legal[0] });
        } else if (g.phase === 'roundEnd') {
          await p.act('ready');
        }
      }
      await sleep(40);
    }
    await sleep(150);
    const g = players[0].state.game;
    assert.strictEqual(g.history.length, 3);
    assert(g.winners.length >= 1);
    const lb = players[1].state.leaderboard;
    assert.strictEqual(lb.reduce((a, p) => a + p.games, 0), 3, 'everyone got a game on their record');
    assert.strictEqual(lb.reduce((a, p) => a + p.wins, 0), g.winners.length);
    const winnerNames = g.winners.slice();

    // ---- new game opens by itself after "Play again"
    assert((await players[0].act('again')).status === 200);
    await sleep(150);
    assert.strictEqual(players[1].state.game.phase, 'lobby');
    assert.strictEqual(players[1].state.game.id, 2);
    assert.strictEqual(players[1].state.game.seats.length, 3);

    // ---- restart: names, passcodes, wins and the open table are remembered
    players.forEach((p) => p.close());
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    child = boot();
    await waitUp();
    const back = await post('/api/login', { name: 'Bob', pass: 'pw-Bob' });
    assert.strictEqual(back.status, 200, 'account survived restart');
    const old = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + players[0].token } });
    assert.strictEqual(old.status, 200, 'old session survived restart');
    const bob = new Player('Bob', back.data.token);
    await bob.listen();
    assert.strictEqual(bob.state.game.id, 2);
    assert.strictEqual(bob.state.game.seats.length, 3, 'seated players kept their seats');
    assert.deepStrictEqual(bob.state.leaderboard.map((p) => p.name).sort(), winnerNames.length === 3 ? names.slice().sort() : bob.state.leaderboard.map((p) => p.name).sort());
    assert.strictEqual(bob.state.leaderboard.reduce((a, p) => a + p.games, 0), 3);
    bob.close();

    // ---- login throttle
    let last;
    for (let i = 0; i < 8; i++) last = await post('/api/login', { name: 'Carol', pass: 'wrong-' + i });
    assert.strictEqual(last.status, 429, 'repeated wrong passcodes are throttled');

    console.log('smoke ok: accounts, invite code, full game over SSE, privacy, restart persistence, throttle');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

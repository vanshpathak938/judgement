'use strict';
/*
 * Judgement (a.k.a. Estimation / Oh Hell / Kachufool) — rules engine.
 * Pure game logic, no networking. The server owns one table and calls these.
 *
 * Rules implemented
 *  - 3–6 players, one 52-card deck, ace high.
 *  - Each round every player gets N cards. Trump rotates ♠ ♦ ♣ ♥ then no-trump.
 *  - Starting left of the dealer, everyone bids how many tricks they will win.
 *    The dealer bids last and may NOT make the total bids equal the cards dealt
 *    (so somebody is always wrong).
 *  - Follow suit if you can. Highest trump wins, else highest card of the led suit.
 *  - Exact bid scores 10 + bid. Otherwise 0 ("classic") or minus the miss ("penalty").
 *  - Round sizes go max..1 and (optionally) back up again to max.
 */
const crypto = require('crypto');

const FAST = process.env.JUDGEMENT_FAST === '1'; // tests only

const SUIT_ORDER = ['S', 'H', 'C', 'D']; // hand display order (alternating colours)
const TRUMP_CYCLE = ['S', 'D', 'C', 'H', 'N'];
const TRUMP_NAME = { S: 'Spades', D: 'Diamonds', C: 'Clubs', H: 'Hearts', N: 'No trump' };
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;

const TURN_MS = FAST ? 60_000 : 75_000;
const OFFLINE_TURN_MS = 15_000;
const AWAY_TURN_MS = FAST ? 5 : 1_200;
const TRICK_PAUSE_MS = FAST ? 20 : 1_900;
const ROUND_PAUSE_MS = FAST ? 200 : 25_000;
const FINISH_PAUSE_MS = FAST ? 60_000 : 180_000;

const ok = (extra) => Object.assign({ ok: true }, extra);
const fail = (error) => ({ ok: false, error });

// ---------- cards ----------
const suitOf = (c) => c[0];
const rankOf = (c) => Number(c.slice(1));
function makeDeck() {
  const d = [];
  for (const s of SUIT_ORDER) for (let r = 2; r <= 14; r++) d.push(s + r);
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sortHand(h) {
  return h.sort(
    (a, b) => SUIT_ORDER.indexOf(suitOf(a)) - SUIT_ORDER.indexOf(suitOf(b)) || rankOf(b) - rankOf(a)
  );
}

// ---------- table ----------
function newSeat(key, name) {
  return { key, name, score: 0, bid: null, won: 0, hand: [], away: false, online: true, ready: false };
}

function newTable(id = 1) {
  return {
    id,
    phase: 'lobby', // lobby | bidding | playing | trickEnd | roundEnd | finished
    seats: [],
    settings: { maxCards: 7, mode: 'updown', scoring: 'classic' },
    plan: [],
    roundIdx: -1,
    dealer: 0,
    turn: null,
    turnStart: 0,
    trick: [],
    trickWinner: null,
    lastTrick: null,
    until: 0,
    history: [],
    log: [],
    winners: [],
    statsRecorded: false,
  };
}

function say(t, text) {
  t.log.push({ t: Date.now(), text });
  if (t.log.length > 40) t.log.shift();
}
function setTurn(t, i) {
  t.turn = i;
  t.turnStart = Date.now();
}
const seatIndex = (t, key) => t.seats.findIndex((s) => s.key === key);
const isHost = (t, key) => t.seats.length > 0 && t.seats[0].key === key;
const effectiveMax = (t) => Math.min(t.settings.maxCards, Math.floor(51 / Math.max(t.seats.length, 1)));
const turnLimit = (s) => (s.away ? AWAY_TURN_MS : s.online === false ? OFFLINE_TURN_MS : TURN_MS);

// ---------- lobby ----------
function join(t, key, name) {
  if (t.phase !== 'lobby') return fail('A game is in progress. You can watch, and sit down when it ends.');
  if (seatIndex(t, key) >= 0) return ok();
  if (t.seats.length >= MAX_PLAYERS) return fail('The table is full (6 players).');
  t.seats.push(newSeat(key, name));
  say(t, `${name} sat down`);
  return ok();
}

function leave(t, key) {
  const i = seatIndex(t, key);
  if (i < 0) return fail('You are not seated.');
  const s = t.seats[i];
  if (t.phase === 'lobby') {
    t.seats.splice(i, 1);
    say(t, `${s.name} left the table`);
  } else {
    s.away = true;
    say(t, `${s.name} stepped away. A bot is playing for them`);
  }
  return ok();
}

function back(t, i) {
  if (i < 0) return fail('You are not seated.');
  const s = t.seats[i];
  if (s.away) {
    s.away = false;
    say(t, `${s.name} is back`);
    if (t.turn === i) t.turnStart = Date.now();
  }
  return ok();
}

function setSettings(t, key, patch) {
  if (t.phase !== 'lobby') return fail('Settings can only change in the lobby.');
  if (!isHost(t, key)) return fail('Only the host (first player seated) can change settings.');
  const s = t.settings;
  if (patch.maxCards !== undefined) {
    const n = Number(patch.maxCards);
    if (!Number.isInteger(n) || n < 3 || n > 10) return fail('Max cards must be between 3 and 10.');
    s.maxCards = n;
  }
  if (patch.mode !== undefined) {
    if (!['updown', 'down'].includes(patch.mode)) return fail('Unknown round order.');
    s.mode = patch.mode;
  }
  if (patch.scoring !== undefined) {
    if (!['classic', 'penalty'].includes(patch.scoring)) return fail('Unknown scoring.');
    s.scoring = patch.scoring;
  }
  return ok();
}

function start(t, key) {
  if (t.phase !== 'lobby') return fail('A game is already running.');
  if (!isHost(t, key)) return fail('Only the host (first player seated) can start the game.');
  if (t.seats.length < MIN_PLAYERS) return fail(`You need at least ${MIN_PLAYERS} players.`);
  const max = effectiveMax(t);
  const down = [];
  for (let c = max; c >= 1; c--) down.push(c);
  const up = [];
  for (let c = 2; c <= max; c++) up.push(c);
  const sizes = t.settings.mode === 'updown' ? down.concat(up) : down;
  t.plan = sizes.map((cards, i) => ({ cards, trump: TRUMP_CYCLE[i % TRUMP_CYCLE.length] }));
  for (const s of t.seats) Object.assign(s, { score: 0, bid: null, won: 0, hand: [], away: false, ready: false });
  t.history = [];
  t.winners = [];
  t.statsRecorded = false;
  t.log = [];
  t.roundIdx = -1;
  say(t, 'The game has started');
  startRound(t);
  return ok();
}

// ---------- round flow ----------
function startRound(t) {
  const n = t.seats.length;
  t.roundIdx += 1;
  t.dealer = t.roundIdx === 0 ? crypto.randomInt(n) : (t.dealer + 1) % n;
  const { cards, trump } = t.plan[t.roundIdx];
  const deck = shuffle(makeDeck());
  for (const s of t.seats) {
    s.hand = sortHand(deck.splice(0, cards));
    s.bid = null;
    s.won = 0;
    s.ready = false;
  }
  t.trick = [];
  t.trickWinner = null;
  t.lastTrick = null;
  t.phase = 'bidding';
  setTurn(t, (t.dealer + 1) % n);
  say(t, `Round ${t.roundIdx + 1}: ${cards} card${cards > 1 ? 's' : ''}, ${TRUMP_NAME[trump]}`);
}

function validBids(t, i) {
  const { cards } = t.plan[t.roundIdx];
  const all = [];
  for (let n = 0; n <= cards; n++) all.push(n);
  const waiting = t.seats.filter((s) => s.bid === null);
  if (waiting.length === 1 && t.seats[i].bid === null) {
    const sum = t.seats.reduce((a, s) => a + (s.bid || 0), 0);
    const banned = cards - sum;
    return all.filter((n) => n !== banned);
  }
  return all;
}

function bid(t, i, n, opts = {}) {
  if (t.phase !== 'bidding') return fail('It is not the bidding stage.');
  if (t.turn !== i) return fail('It is not your turn to bid.');
  const { cards } = t.plan[t.roundIdx];
  if (!Number.isInteger(n) || n < 0 || n > cards) return fail(`Bid a whole number from 0 to ${cards}.`);
  if (!validBids(t, i).includes(n)) {
    return fail(`As dealer you can't make the bids add up to exactly ${cards}. Pick a different number.`);
  }
  const s = t.seats[i];
  s.bid = n;
  if (!opts.auto) s.away = false;
  say(t, `${s.name} bid ${n}`);
  if (t.seats.every((x) => x.bid !== null)) {
    t.phase = 'playing';
    setTurn(t, (t.dealer + 1) % t.seats.length);
  } else {
    setTurn(t, (i + 1) % t.seats.length);
  }
  return ok();
}

function legalCards(t, i) {
  const hand = t.seats[i].hand;
  if (!t.trick.length) return hand.slice();
  const led = suitOf(t.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

function winnerOf(trick, trump) {
  let best = trick[0];
  for (const p of trick.slice(1)) {
    const ps = suitOf(p.card);
    const bs = suitOf(best.card);
    if (ps === bs) {
      if (rankOf(p.card) > rankOf(best.card)) best = p;
    } else if (trump !== 'N' && ps === trump) {
      best = p; // best is not trump (suits differ)
    }
  }
  return best.seat;
}

function play(t, i, card, opts = {}) {
  if (t.phase !== 'playing') return fail('It is not the playing stage.');
  if (t.turn !== i) return fail('It is not your turn.');
  const s = t.seats[i];
  if (typeof card !== 'string' || !s.hand.includes(card)) return fail('You do not hold that card.');
  if (!legalCards(t, i).includes(card)) {
    return fail(`You must follow suit (${TRUMP_NAME[suitOf(t.trick[0].card)]}).`);
  }
  s.hand.splice(s.hand.indexOf(card), 1);
  if (!opts.auto) s.away = false;
  t.trick.push({ seat: i, card });
  if (t.trick.length === t.seats.length) {
    const w = winnerOf(t.trick, t.plan[t.roundIdx].trump);
    t.seats[w].won += 1;
    t.trickWinner = w;
    t.phase = 'trickEnd';
    t.turn = null;
    t.until = Date.now() + TRICK_PAUSE_MS;
    say(t, `${t.seats[w].name} takes the trick`);
  } else {
    setTurn(t, (i + 1) % t.seats.length);
  }
  return ok();
}

function afterTrick(t) {
  t.lastTrick = { plays: t.trick, winner: t.trickWinner };
  const w = t.trickWinner;
  t.trick = [];
  t.trickWinner = null;
  if (t.seats.every((s) => s.hand.length === 0)) endRound(t);
  else {
    t.phase = 'playing';
    setTurn(t, w);
  }
}

function endRound(t) {
  const { cards, trump } = t.plan[t.roundIdx];
  const rows = t.seats.map((s) => {
    const made = s.bid === s.won;
    const delta = made ? 10 + s.bid : t.settings.scoring === 'penalty' ? -Math.abs(s.bid - s.won) : 0;
    s.score += delta;
    return { bid: s.bid, won: s.won, delta, total: s.score };
  });
  t.history.push({ n: t.roundIdx + 1, cards, trump, dealer: t.dealer, rows });
  t.phase = 'roundEnd';
  t.turn = null;
  t.until = Date.now() + ROUND_PAUSE_MS;
  for (const s of t.seats) s.ready = false;
  say(t, `Round ${t.roundIdx + 1} scored`);
}

function ready(t, i) {
  if (i < 0) return fail('You are not seated.');
  if (t.phase !== 'roundEnd') return fail('Nothing to confirm right now.');
  t.seats[i].ready = true;
  if (t.seats.every((s) => s.ready || s.away || s.online === false)) nextAfterRound(t);
  return ok();
}

function nextAfterRound(t) {
  if (t.roundIdx + 1 < t.plan.length) {
    startRound(t);
  } else {
    const top = Math.max(...t.seats.map((s) => s.score));
    t.winners = t.seats.filter((s) => s.score === top).map((s) => s.key);
    t.phase = 'finished';
    t.turn = null;
    t.until = Date.now() + FINISH_PAUSE_MS;
    say(t, 'The game is over');
  }
}

function resetToLobby(t) {
  t.seats = t.seats.filter((s) => !s.away && s.online !== false);
  for (const s of t.seats) Object.assign(s, { score: 0, bid: null, won: 0, hand: [], ready: false });
  Object.assign(t, {
    id: t.id + 1,
    phase: 'lobby',
    plan: [],
    roundIdx: -1,
    turn: null,
    trick: [],
    trickWinner: null,
    lastTrick: null,
    history: [],
    winners: [],
    statsRecorded: false,
    log: [],
  });
  say(t, 'New game open. Sit down to play');
}

function again(t, key) {
  if (seatIndex(t, key) < 0) return fail('Only seated players can start another game.');
  if (t.phase !== 'finished') return fail('The game is not over yet.');
  resetToLobby(t);
  return ok();
}

/** Throw everyone out and open a fresh game (used when the table has been abandoned). */
function resetTable(t) {
  t.seats = [];
  resetToLobby(t);
}

// ---------- bots (used for away / timed-out players) ----------
function botBid(t, i) {
  const { cards, trump } = t.plan[t.roundIdx];
  let est = 0;
  for (const c of t.seats[i].hand) {
    const r = rankOf(c);
    if (trump !== 'N' && suitOf(c) === trump) est += r >= 14 ? 0.95 : r >= 13 ? 0.85 : r >= 12 ? 0.7 : r >= 10 ? 0.5 : 0.3;
    else est += r === 14 ? 0.8 : r === 13 ? 0.4 : r === 12 ? 0.15 : 0;
  }
  const valid = validBids(t, i);
  const target = Math.max(0, Math.min(cards, Math.round(est)));
  // closest legal bid to the estimate (ties go to the lower bid)
  return valid.reduce((best, n) => (Math.abs(n - target) < Math.abs(best - target) ? n : best), valid[0]);
}

function botPlay(t, i) {
  const legal = legalCards(t, i);
  const s = t.seats[i];
  const trump = t.plan[t.roundIdx].trump;
  const strength = (c) => (trump !== 'N' && suitOf(c) === trump ? 100 : 0) + rankOf(c);
  const asc = legal.slice().sort((a, b) => strength(a) - strength(b));
  const wins = (c) => winnerOf(t.trick.concat([{ seat: i, card: c }]), trump) === i;
  const winners = asc.filter(wins);
  const losers = asc.filter((c) => !wins(c));
  const need = s.bid - s.won;
  if (need > 0) {
    if (!t.trick.length) return asc[asc.length - 1];
    return winners.length ? winners[0] : asc[0];
  }
  return losers.length ? losers[losers.length - 1] : asc[0];
}

function autoAct(t, i) {
  if (t.phase === 'bidding') return bid(t, i, botBid(t, i), { auto: true });
  if (t.phase === 'playing') return play(t, i, botPlay(t, i), { auto: true });
  return fail('Nothing to do.');
}

function timeoutAct(t) {
  const i = t.turn;
  const s = t.seats[i];
  if (!s.away) {
    s.away = true;
    say(t, `${s.name} ran out of time. A bot is playing for them`);
  }
  autoAct(t, i);
}

/** Advance any timers. Returns true when something changed. */
function tick(t, now = Date.now()) {
  if (t.phase === 'bidding' || t.phase === 'playing') {
    const s = t.seats[t.turn];
    if (s && now - t.turnStart >= turnLimit(s)) {
      timeoutAct(t);
      return true;
    }
  } else if (t.phase === 'trickEnd') {
    if (now >= t.until) {
      afterTrick(t);
      return true;
    }
  } else if (t.phase === 'roundEnd') {
    const all = t.seats.every((s) => s.ready || s.away || s.online === false);
    if (all || now >= t.until) {
      nextAfterRound(t);
      return true;
    }
  } else if (t.phase === 'finished') {
    if (now >= t.until) {
      resetToLobby(t);
      return true;
    }
  }
  return false;
}

// ---------- what each viewer is allowed to see ----------
function viewFor(t, key) {
  const me = seatIndex(t, key);
  const round = t.roundIdx >= 0 && t.plan[t.roundIdx] ? Object.assign({ n: t.roundIdx + 1, total: t.plan.length }, t.plan[t.roundIdx]) : null;
  const g = {
    id: t.id,
    phase: t.phase,
    settings: t.settings,
    effectiveMax: effectiveMax(t),
    me,
    host: t.phase === 'lobby' && me === 0,
    dealer: t.dealer,
    turn: t.turn,
    turnDeadline: t.turn != null && t.seats[t.turn] ? t.turnStart + turnLimit(t.seats[t.turn]) : 0,
    until: t.until,
    round,
    seats: t.seats.map((s) => ({
      name: s.name,
      score: s.score,
      bid: s.bid,
      won: s.won,
      away: s.away,
      online: s.online !== false,
      cards: s.hand.length,
      ready: s.ready,
    })),
    trick: t.trick,
    trickWinner: t.trickWinner,
    lastTrick: t.lastTrick,
    hand: me >= 0 ? t.seats[me].hand.slice() : [],
    legal: [],
    validBids: [],
    history: t.history,
    log: t.log.slice(-12),
    winners: t.winners.map((k) => t.seats[seatIndex(t, k)].name),
  };
  if (me >= 0 && t.turn === me) {
    if (t.phase === 'bidding') g.validBids = validBids(t, me);
    if (t.phase === 'playing') g.legal = legalCards(t, me);
  }
  return g;
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  TRUMP_NAME,
  newTable,
  join,
  leave,
  back,
  setSettings,
  start,
  bid,
  play,
  ready,
  again,
  resetTable,
  resetToLobby,
  tick,
  viewFor,
  validBids,
  legalCards,
  winnerOf,
  botBid,
  botPlay,
  suitOf,
  rankOf,
};

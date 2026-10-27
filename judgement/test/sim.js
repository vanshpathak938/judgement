'use strict';
// Plays many full games with bots through the real engine and checks the rules hold.
process.env.JUDGEMENT_FAST = '1';
const assert = require('assert');
const G = require('../game');

const FAR = Date.now() + 1e12;
let games = 0, rounds = 0, hookChecks = 0, followChecks = 0;

function playGame(n, settings) {
  const t = G.newTable(1);
  for (let i = 0; i < n; i++) assert(G.join(t, 'p' + i, 'P' + i).ok);
  assert(G.setSettings(t, 'p0', settings).ok);
  assert(G.start(t, 'p0').ok);
  const plan = t.plan.slice();
  let guard = 0;

  while (t.phase !== 'finished') {
    assert(guard++ < 20000, 'game did not terminate');
    if (t.phase === 'bidding') {
      const i = t.turn;
      const cards = t.plan[t.roundIdx].cards;
      const valid = G.validBids(t, i);
      // the dealer (last bidder) can never make the total equal the cards dealt
      if (t.seats.filter((s) => s.bid === null).length === 1) {
        const sum = t.seats.reduce((a, s) => a + (s.bid || 0), 0);
        assert(!valid.includes(cards - sum), 'hook rule broken');
        const r = G.bid(t, i, cards - sum);
        if (cards - sum >= 0 && cards - sum <= cards) { assert(!r.ok, 'banned bid accepted'); hookChecks++; }
      }
      // wrong turn is rejected
      assert(!G.bid(t, (i + 1) % n, 0).ok);
      assert(G.bid(t, i, G.botBid(t, i)).ok);
    } else if (t.phase === 'playing') {
      const i = t.turn;
      const legal = G.legalCards(t, i);
      const hand = t.seats[i].hand;
      if (t.trick.length) {
        const led = G.suitOf(t.trick[0].card);
        const hasLed = hand.some((c) => G.suitOf(c) === led);
        for (const c of hand) {
          if (hasLed && G.suitOf(c) !== led) {
            const copy = JSON.stringify(t);
            assert(!G.play(t, i, c).ok, 'illegal off-suit play accepted');
            assert.strictEqual(JSON.stringify(t), copy, 'rejected play changed state');
            followChecks++;
          }
        }
      }
      assert(!G.play(t, (i + 1) % n, hand[0] || 'S2').ok);
      assert(!G.play(t, i, 'S99').ok);
      assert(G.play(t, i, G.botPlay(t, i)).ok);
      assert(legal.length > 0);
    } else if (t.phase === 'trickEnd') {
      assert(G.tick(t, FAR));
    } else if (t.phase === 'roundEnd') {
      const h = t.history[t.history.length - 1];
      // every trick of the round was won by someone
      assert.strictEqual(h.rows.reduce((a, r) => a + r.won, 0), h.cards, 'tricks do not add up');
      assert.notStrictEqual(h.rows.reduce((a, r) => a + r.bid, 0), h.cards, 'bids added up to cards');
      for (const r of h.rows) {
        const want = r.bid === r.won ? 10 + r.bid : settings.scoring === 'penalty' ? -Math.abs(r.bid - r.won) : 0;
        assert.strictEqual(r.delta, want, 'scoring wrong');
      }
      rounds++;
      if (rounds % 2) { for (let i = 0; i < n; i++) G.ready(t, i); } else assert(G.tick(t, FAR));
    } else {
      assert.fail('unexpected phase ' + t.phase);
    }
  }

  assert.strictEqual(t.history.length, plan.length, 'wrong number of rounds');
  assert.deepStrictEqual(t.plan.map((p) => p.cards), plan.map((p) => p.cards));
  const top = Math.max(...t.seats.map((s) => s.score));
  assert(t.winners.length >= 1);
  for (const k of t.winners) assert.strictEqual(t.seats.find((s) => s.key === k).score, top);
  for (const s of t.seats) assert.strictEqual(s.score, t.history.reduce((a, h) => a + h.rows[t.seats.indexOf(s)].delta, 0));
  // finished -> lobby, same people still seated
  assert(G.tick(t, FAR));
  assert.strictEqual(t.phase, 'lobby');
  assert.strictEqual(t.seats.length, n);
  games++;
  return plan.map((p) => p.cards);
}

for (let n = 3; n <= 6; n++) {
  for (const mode of ['updown', 'down']) {
    for (const scoring of ['classic', 'penalty']) {
      for (let rep = 0; rep < 12; rep++) playGame(n, { maxCards: 3 + (rep % 8), mode, scoring });
    }
  }
}

// plan shapes
{
  const t = G.newTable(1);
  for (let i = 0; i < 4; i++) G.join(t, 'p' + i, 'P' + i);
  G.start(t, 'p0');
  assert.deepStrictEqual(t.plan.map((p) => p.cards), [7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(t.plan.slice(0, 6).map((p) => p.trump), ['S', 'D', 'C', 'H', 'N', 'S']);
}
// 6 players can't be dealt more than 8
{
  const t = G.newTable(1);
  for (let i = 0; i < 6; i++) G.join(t, 'p' + i, 'P' + i);
  G.setSettings(t, 'p0', { maxCards: 10 });
  G.start(t, 'p0');
  assert.strictEqual(t.plan[0].cards, 8);
}
// trick resolution
{
  const w = (trick, trump) => G.winnerOf(trick.map(([seat, card]) => ({ seat, card })), trump);
  assert.strictEqual(w([[0, 'H5'], [1, 'H9'], [2, 'S2']], 'N'), 1, 'no trump: highest of led suit');
  assert.strictEqual(w([[0, 'H5'], [1, 'H9'], [2, 'S2']], 'S'), 2, 'trump beats led suit');
  assert.strictEqual(w([[0, 'H5'], [1, 'S3'], [2, 'S2']], 'S'), 1, 'higher trump wins');
  assert.strictEqual(w([[0, 'H5'], [1, 'C14'], [2, 'D13']], 'S'), 0, 'off-suit never wins');
}
// lobby rules
{
  const t = G.newTable(1);
  G.join(t, 'a', 'A'); G.join(t, 'b', 'B');
  assert(!G.start(t, 'a').ok, 'cannot start with 2');
  G.join(t, 'c', 'C');
  assert(!G.start(t, 'b').ok, 'only host starts');
  assert(!G.setSettings(t, 'b', { maxCards: 5 }).ok, 'only host sets');
  assert(G.start(t, 'a').ok);
  assert(!G.join(t, 'd', 'D').ok, 'cannot join mid-game');
  // a timeout marks the player away and a bot acts; acting again clears away
  const i = t.turn;
  assert(G.tick(t, Date.now() + 1e9));
  assert(t.seats[i].away && t.seats[i].bid !== null);
  assert(G.back(t, i).ok && !t.seats[i].away);
}

console.log(`sim ok: ${games} full games, ${rounds} rounds, ${hookChecks} dealer-rule checks, ${followChecks} follow-suit checks`);

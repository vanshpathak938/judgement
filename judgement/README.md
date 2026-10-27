# Judgement (Estimation / Oh Hell)

A multiplayer card game for friends. One table is always open. Players sign in with a name and passcode, and the server remembers them (accounts, wins, games played).

No dependencies. Needs Node 18 or newer.

## Run it on your computer

```
node server.js
```

Open http://localhost:3000. Open it in a second browser window with a different name to try it alone (you need 3 players to start).

## Put it online for free

Any host that runs a Node web service will do. The start command is `node server.js`, and the server reads the `PORT` environment variable.

On Render, for example: push this folder to a GitHub repo, create a new **Web Service** from it, set the build command to `npm install` (or leave it blank), the start command to `npm start`, and pick the free instance type. Share the URL it gives you.

Two things to know about free hosts (Render's own 2026 comparison describes both for its free tier, and other hosts are similar, so check the current terms of whichever you pick):

- **They go to sleep.** A free service stops after about 15 minutes with nobody connected and takes around a minute to wake up on the next visit. A game in progress stays alive while players are connected. A free uptime pinger hitting `/healthz` every 10 minutes keeps it awake, if the host's terms allow that.
- **The disk is usually wiped on redeploy or restart.** Accounts and win counts are saved to `data/data.json`. Without a persistent disk, players may have to create their account again after a restart. If your host offers a free or cheap persistent disk or volume, mount it and set `DATA_DIR` to its path (for example `DATA_DIR=/data`).

## Settings (environment variables)

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on. Hosts set this for you. Default 3000. |
| `INVITE_CODE` | If set, creating a new account requires this code. Recommended for a public site, so strangers can't join. Signing in never needs it. |
| `DATA_DIR` | Where `data.json` is stored. Default `./data`. |

## How the game works

- 3 to 6 players. The first person seated is the host and picks the settings and starts the game.
- Everyone bids how many tricks they will win. You score only if you win exactly that many: 10 plus your bid. A miss scores 0 (or loses a point per trick missed, if the host picks that).
- The dealer bids last and can't make the bids add up to the number of cards dealt.
- Trump goes spades, diamonds, clubs, hearts, then no trump. Hand sizes count down to 1 and back up (or just down).
- If a player runs out of time (75 seconds, or 15 if they're offline), a bot plays for them until they press "I'm back". A game nobody is present for is closed after a minute.
- When a game ends, a new one opens at the same table. People watching can sit down in the lobby.

## Accounts and security

Passcodes are stored hashed (scrypt), never in plain text. Wrong passcodes are throttled, and sign-ups are rate limited per network. It's meant for a friendly group, so use a passcode you don't use anywhere else.

## Tests

```
npm test
```

Plays 192 full bot games to check the rules, then runs a real server and plays a game over the network, including a restart.

## Files

- `game.js`: the rules (bidding, follow suit, scoring, bots).
- `server.js`: logins, saved data, the always-open table, live updates.
- `public/index.html`: the whole browser app.

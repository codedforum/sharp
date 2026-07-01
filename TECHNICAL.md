# Sharp · Technical Documentation

TxODDS × Solana World Cup Hackathon · Trading Tools and Agents track.
Live app: https://sharp.smartcodedbot.com · Network: Solana devnet.

## Core idea
Sharp is an autonomous sharp-money trading agent. It reads TxLINE consensus odds for World Cup and International Friendlies fixtures, strips the bookmaker margin to recover honest probabilities, and detects the moment professional money reprices an outcome (steam). On a confirmed steam it commits its decision to Solana before the match resolves, opens a conviction-sized paper position, then grades itself on closing-line value and the real full-time result. Critically, it does not ask you to trust it: it calls TxLINE's own on-chain program to prove the odds it acted on are the canonical, tamper-evident record.

This is the sponsor's own first "ideas to get started" (a Sharp Movement Detector that monitors odds every 60 seconds and tracks whether it predicted the outcome), taken to a full autonomous, self-grading, on-chain-verifiable agent.

## Technical highlights
- **Deterministic signal engine** (`signal.js`, pure and unit-testable): de-vigs each 1X2 market and scores outcome movement on five factors: direction (0.34), velocity (0.22), steam / directional purity (0.20), magnitude vs its own noise (0.14), signal-to-noise (0.10). STEAM opens a call at conviction >= 66 with purity >= 0.5.
- **Paper trading book**: a 100-unit bankroll, conviction-sized stakes (0.5u to 3u), P&L / ROI / win-loss, and a bankroll curve. It trades, it does not merely signal.
- **Commit-reveal**: every call SHA-256-hashes its full decision and anchors that commitment to Solana (SPL Memo) before kickoff. Reveal = re-hash the settled call; it must match. The agent cannot rewrite its own history.
- **Exact closing-line value**: at settlement it pulls the odds as of kickoff via `asOf` (the true closing line) and grades CLV exactly, not by proxy.
- **Cross-market confirmation**: a 1X2 steam is cross-checked against the Asian-handicap line for agreement.
- **Trustless on-chain verification**: `verify.js` calls TxLINE's `txoracle.validate_odds` read instruction against the daily odds Merkle-root PDA. If it does not throw (InvalidSubTreeProof / InvalidMainTreeProof / RootNotAvailable), the odds are proven canonical. A public endpoint (`/api/verify`) lets anyone run this from the browser.
- **Fully autonomous**: a 60-second loop ingests, scores, positions, anchors, settles, grades and verifies with no human in the loop. State is published as JSON that the static UI reads.

## TxLINE endpoints used
- `POST /auth/guest/start` · guest JWT
- on-chain `subscribe(serviceLevelId=1, durationWeeks=4)` · free World Cup tier (0 tokens)
- `POST /api/token/activate` · API token (ed25519 wallet signature over `txSig:leagues:jwt`)
- `GET /api/fixtures/snapshot` · World Cup and friendlies fixtures
- `GET /api/odds/snapshot/{fixtureId}` · consensus 1X2, de-vigged via the demargined `Pct`
- `GET /api/odds/snapshot/{fixtureId}?asOf={kickoffMs}` · exact closing line for true CLV
- `GET /api/odds/updates/{fixtureId}` · message IDs for validation, and the Asian-handicap market
- `GET /api/scores/snapshot/{fixtureId}` · match state and result for settlement
- `GET /api/odds/validation?messageId={id}&ts={ms}` · Merkle proof for an odds message
- on-chain `txoracle.validate_odds(ts, odds, summary, subTreeProof, mainTreeProof)` against the `daily_batch_roots` PDA · trustless verification

Markets consumed: `1X2_PARTICIPANT_RESULT` (primary signal) and `ASIANHANDICAP_PARTICIPANT_GOALS` (cross-confirmation).

## Architecture
- `signal.js` · pure de-vig and steam scoring engine
- `txline.js` · TxLINE client (guest JWT, on-chain subscribe, activate, then fixtures / odds / scores / validation / handicap)
- `verify.js` · trustless on-chain verification via `txoracle.validate_odds`
- `anchor.js` · Solana memo anchoring for the decision commitment and the graded result
- `agent.js` · the autonomous loop; writes `data/board.json`, `data/calls.json`, `data/events.json`
- `server.js` · tiny read-only API exposing `/api/verify` (live on-chain verification for judges)
- `web/` · static mobile-first terminal UI (Board / Calls / Track / How)

## Run it
```
npm install
node signal.js        # unit self-test, no network
node agent.js --mock  # full pipeline on synthetic steam, no keys required
node verify.js        # trustless on-chain odds verification demo (devnet)
node agent.js         # live TxLINE devnet (needs a funded devnet wallet in .devkey.json)
node server.js        # the /api/verify endpoint
```
Devnet txoracle program: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`.

## Security notes
- No secrets are committed. The devnet wallet keypair (`.devkey.json`), the TxLINE session (`.session.json`), any `.env`, and runtime `data/` are gitignored. The wallet is a throwaway devnet key holding only devnet SOL.
- `server.js` is read-only: it exposes only `/api/health` and `/api/verify`. The `fixture` query parameter is used solely to filter an already-fetched, trusted fixture list, so it cannot inject into upstream calls. Results are cached briefly to prevent hammering. There are no write, auth, or key-bearing endpoints.

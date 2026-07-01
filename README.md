# Sharp · an autonomous sharp-money trading agent on Solana

**Live:** https://sharp.smartcodedbot.com · **Track:** TxODDS × Solana World Cup Hackathon — Trading Tools & Agents · **Data:** TxLINE (Solana devnet)

> Sharp money moves the line first. Sharp is an autonomous agent that reads the professional betting market through TxLINE, strips the bookmaker margin, and detects the moment sharp money reprices an outcome. It commits its decision on-chain before the match resolves, takes a position, then grades itself on closing-line value and the real result, and verifies its own source data against the oracles on-chain Merkle root so nothing can be faked after the fact.

## The thesis
In sports betting the most predictive signal is not a pundit or a model, it is how the consensus line moves. When sharp (professional) money hits a market, the no-vig probability of an outcome drifts in a sustained, low-noise, high-velocity way. Beating the closing line (positive CLV) is the industry-proven proxy for long-run edge. Sharp turns that thesis into a fully autonomous, verifiable agent.

## What it does, every 60 seconds, unattended
1. **Ingests TxLINE** consensus odds for live World Cup + International Friendlies fixtures (the free devnet World Cup tier).
2. **De-vigs** each 1X2 market to honest probabilities using TxLINEs demargined `Pct` (overround stripped, three outcomes sum to 1).
3. **Scores the move** on direction, velocity, steam (directional purity), magnitude and signal-to-noise, separating sharp money from chop.
4. **Commits + positions:** on a confirmed steam it SHA-256-hashes the full decision and anchors that commitment on Solana (a memo) BEFORE the match resolves, then opens a paper position sized by conviction against a 100-unit bankroll.
5. **Grades itself:** reprices each open call against the live line every cycle, and at full-time settles on the real TxLINE result, computing exact CLV against the closing line pulled via `asOf=kickoff`.
6. **Anchors the result** on Solana too, so the whole track record (call + outcome) is tamper-evident.
7. **Proves its data on-chain:** calls the sponsors own `txoracle.validate_odds` program against the daily Merkle-root PDA, proving the odds it acted on are the canonical, on-chain record. Trustless, not the APIs word.

The public track record (bankroll curve, ROI, win-loss, hit rate, beat-the-close rate) is the agent keeping honest score of itself.

## Why this wins the Agents track
- **Autonomous:** no human in the loop. It scans, decides, commits, positions, settles and grades on its own.
- **It trades, not just signals:** a real self-traded book with conviction-sized stakes, bankroll, P&L and ROI.
- **Verifiable, not claimed:** the decision is committed on-chain before resolution (commit-reveal), the result is anchored, and the source odds are proven canonical by the oracles own on-chain validator.
- **Honest metric:** graded on closing-line value + real result, the only edge metrics that survive contact with reality.

## TxLINE usage (primary input, end-to-end)
- `fixtures/snapshot` — the World Cup + friendlies board
- `odds/snapshot/{id}` — consensus 1X2, de-vigged via `Pct`
- `odds/snapshot/{id}?asOf=kickoff` — the exact closing line for true CLV
- `scores/snapshot/{id}` — match state + result for settlement
- `odds/validation` + on-chain `txoracle.validate_odds` — trustless proof the odds are canonical vs the on-chain daily root

## Architecture
- `signal.js` — pure, deterministic de-vig + steam scoring engine (unit-testable)
- `txline.js` — TxLINE client: guest JWT to on-chain subscribe to activate, then fixtures/odds/scores/validation
- `agent.js` — the autonomous loop: ingest, score, commit, position, anchor, settle, grade, verify, publish JSON
- `anchor.js` — Solana memo anchoring for calls (commit-reveal) and graded results
- `verify.js` — trustless on-chain verification via `txoracle.validate_odds`
- Front-end — a static, mobile-first terminal UI (Board / Calls / Track / How) fed by the agents JSON

## Run it
```
npm install
node signal.js          # self-test the engine (no network)
node agent.js --mock    # full pipeline on synthetic steam (no keys needed)
node verify.js          # trustless on-chain odds verification demo (devnet)
node agent.js           # live TxLINE devnet (funded devnet wallet)
```

Devnet txoracle program: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`. Built by @smartcoded (SmartCodedBot).

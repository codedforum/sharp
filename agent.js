// Sharp · autonomous agent loop. Every cycle: pull match-odds for live World Cup
// fixtures from TxLINE, append to each fixture's rolling series, run the signal engine,
// and when it detects sharp money (STEAM) it records a public, self-grading "call".
// Calls + state are written to data/*.json for the UI and (TODO) anchored on-chain.
//   node agent.js --mock   -> synthetic odds, no TxLINE/SOL needed (build + demo)
//   node agent.js          -> live TxLINE devnet (needs a funded session)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { computeSignal, probSeries, devig } = require('./signal');
const r3 = (x) => Math.round(x * 1000) / 1000;

const DATA = process.env.SHARP_DATA || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const MOCK = process.argv.includes('--mock');
const ONCE = process.argv.includes('--once');
const ANCHOR = !MOCK && process.env.SHARP_ANCHOR !== '0';   // anchor real calls on-chain (skip for mock)
let anchorer = null;
function getAnchorer() { if (!anchorer) { const { Anchor } = require('./anchor'); anchorer = new Anchor({ cluster: 'devnet' }); } return anchorer; }
const POLL_MS = +process.env.POLL_MS || 60_000;   // 60s live; override low to seed a demo
const STEAM_AT = 66;                    // conviction threshold to open a call
const SETTLE_CYCLES = 24;               // (mock) cycles after which a call's edge is graded + closed
const BANKROLL0 = 100;                  // starting paper bankroll (units) · the agent trades its own book
const STARTED = new Date().toISOString();  // agent boot time (for the live autonomy heartbeat)
const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// stake sizing: scale with conviction (Kelly-lite). 66 conv -> 1.0u, 82 -> 2.0u, 98 -> 3.0u, capped 0.5..3
const stakeFor = (score) => Math.round(clampN((score - 50) / 16, 0.5, 3) * 100) / 100;
const SERIES = {};                      // fixtureId -> [{ts,home,draw,away}]
// atomic write (temp + rename) so a concurrent HTTP read never catches a half-written file
const writeJson = (f, o) => { const p = path.join(DATA, f), t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, p); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f))); } catch { return d; } };

// ---- data source (live TxLINE devnet) ----
let tx = null;
async function liveFixtures() {
  if (!tx) { const { Txline } = require('./txline'); tx = new Txline({ net: 'devnet' }); await tx.session(); }
  return tx.matchFixtures();   // -> [{id,name,home,away,competition,startTime}]
}
async function liveOdds(id) {
  const o = await tx.matchOdds(id);   // consensus 1X2 decimal snapshot, or null if no scorable market
  return o;                           // {ts,home,draw,away,books,source} | null
}

// ---- mock source (synthetic steam, lets us build the whole pipeline now) ----
const MOCK_FX = [
  { id: 'WC-ARG-FRA', name: 'Argentina v France' },
  { id: 'WC-ENG-BRA', name: 'England v Brazil' },
  { id: 'WC-ESP-GER', name: 'Spain v Germany' },
];
const mockState = {};
function mockOdds(id) {
  // realistic synthetic steam: small persistent drift (a few bp/cycle) + light noise,
  // decaying so a call settles at a believable low-single-digit CLV, not a runaway move.
  const m = (mockState[id] = mockState[id] || { home: 2.4 + Math.random(), draw: 3.2 + Math.random() * 0.4, away: 2.6 + Math.random(), bias: (Math.random() < 0.5 ? 1 : -1) * (0.006 + Math.random() * 0.006), n: 0, reversal: Math.random() < 0.33 });
  m.n++;
  if (m.n > 50) { m.n = 0; m.bias = (Math.random() < 0.5 ? 1 : -1) * (0.006 + Math.random() * 0.006); m.reversal = Math.random() < 0.33; } // fresh episode
  if (m.reversal && m.n === 13) m.bias *= -2.2;        // ~1/3 of steam reads reverse after the call (the agent is sometimes wrong)
  const decay = Math.exp(-m.n / 30);                  // steam fades as the line settles
  const step = m.bias * decay + (Math.random() - 0.5) * 0.004;
  m.home = Math.max(1.2, m.home - step);              // steam one side
  m.away = Math.max(1.2, m.away + step);
  m.draw = Math.max(2.5, m.draw + (Math.random() - 0.5) * 0.01);
  return { ts: Math.floor(Date.now() / 1000), home: +m.home.toFixed(3), draw: +m.draw.toFixed(3), away: +m.away.toFixed(3) };
}

// ---- live scores -> match state + result settlement ----
const asArray = (x) => (Array.isArray(x) ? x : x && (x.data || x.payload) ? (x.data || x.payload) : x ? [x] : []);
const numOf = (x) => { const n = Number(x); return isFinite(n) ? n : null; };
const grabNum = (o, keys) => { for (const k of keys) if (o && o[k] != null) { const n = numOf(o[k]); if (n != null) return n; } return null; };
function isFinished(gs) { return /finish|ended|full.?time|^ft$|complete|after.?extra|\baet\b|penalt|\bresult\b/i.test(String(gs || '')); }
function matchState(gs) { const s = String(gs || '').toLowerCase();
  if (isFinished(s)) return 'final';
  if (/play|live|1st|2nd|half|running|progress|kick|inplay|break|added/.test(s)) return 'live';
  return 'scheduled'; }
// pull Participant1/Participant2 goals out of whatever shape TxLINE puts them in
function readScore(snap) {
  const d = (snap && (snap.Data || snap.data)) || {};
  for (const c of [d, d.Score, d.ScoreSoccer, d.FullTime, d.Result, d.Current, snap]) {
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c.Score) && c.Score.length >= 2) { const p1 = numOf(c.Score[0]), p2 = numOf(c.Score[1]); if (p1 != null && p2 != null) return { p1, p2 }; }
    const p1 = grabNum(c, ['Participant1', 'Participant1Score', 'P1', 'Home', 'HomeScore', 'home', 'Goals1', 'Score1']);
    const p2 = grabNum(c, ['Participant2', 'Participant2Score', 'P2', 'Away', 'AwayScore', 'away', 'Goals2', 'Score2']);
    if (p1 != null && p2 != null) return { p1, p2 };
  }
  return null;
}
// resolve the match result into home/draw/away terms, honoring which side is home; score shown home-away
function resultOutcome(snap) {
  const sc = readScore(snap); if (!sc) return null;
  const p1Home = snap.Participant1IsHome !== false;
  const score = `${p1Home ? sc.p1 : sc.p2}-${p1Home ? sc.p2 : sc.p1}`;
  if (sc.p1 === sc.p2) return { winner: 'draw', score };
  const p1Win = sc.p1 > sc.p2;
  return { winner: p1Win ? (p1Home ? 'home' : 'away') : (p1Home ? 'away' : 'home'), score };
}

// realise a settled call's paper P&L: a win pays stake*(price-1), a loss forfeits the stake.
function bookPnl(c) {
  const stake = c.bet && c.bet.stake ? c.bet.stake : 1;
  const price = c.bet && c.bet.price ? c.bet.price : null;
  c.stake = stake;
  c.pnl = (c.win && price) ? Math.round(stake * (price - 1) * 100) / 100 : -stake;
  // edge vs the closing line: EV of our price given where the market closed (>0 = we beat the close)
  if (price && c.implied_now != null) c.edge_pp = Math.round((c.implied_now * price - 1) * 1000) / 10;
}

// on-chain data provenance: prove the odds our agent acts on are the canonical, tamper-evident
// TxLINE record by pulling a real Merkle proof (subTree + mainTree) against the daily on-chain root.
let provenance = null, cyc = 0;
async function verifyProvenance(fixtures) {
  try {
    const { verifyOdds } = require('./verify');
    for (const f of fixtures) {
      let ups = []; try { ups = asArray(await tx.oddsUpdates(f.id)); } catch (e) {}
      const msg = ups.find((m) => m.MessageId && /stable|demarg/i.test(String(m.Bookmaker || ''))) || ups.find((m) => m.MessageId);
      if (!msg) continue;
      // TRUSTLESS: run the sponsor's own txoracle.validate_odds against the on-chain daily Merkle root
      const r = await verifyOdds(tx, msg.MessageId, msg.Ts);
      if (r && r.verified) {
        provenance = { verified: true, onchain: true, method: r.method, program: r.program, pda: r.pda,
          fixture: f.name, market: msg.SuperOddsType, message_id: msg.MessageId, ts: msg.Ts, proof_depth: r.proof_nodes, epoch_day: r.epochDay, at: new Date().toISOString() };
        console.log(`[PROOF] ${f.name} odds verified ON-CHAIN via txoracle.validate_odds (${r.method}) · ${r.proof_nodes}-node proof · root pda ${r.pda}`);
        return;
      }
    }
  } catch (e) {}
}

async function cycle() {
  const calls = readJson('calls.json', []);
  const events = readJson('events.json', []);
  const ev = (type, msg) => events.unshift({ ts: new Date().toISOString(), type, msg });
  const scoresCache = {};
  const getScores = async (id) => { if (id in scoresCache) return scoresCache[id]; let r = null; try { r = asArray(await tx.scores(id)); } catch (e) { r = null; } return (scoresCache[id] = r); };
  const open = new Set(calls.filter((c) => c.status === 'open').map((c) => c.fixtureId)); // one open call per fixture
  const fixtures = MOCK ? MOCK_FX : await liveFixtures();
  const startMap = MOCK ? {} : Object.fromEntries(fixtures.map((f) => [f.id, f.startTime]));  // fixtureId -> kickoff ms
  const board = [];

  for (const f of fixtures) {
    let snap;
    try { snap = MOCK ? mockOdds(f.id) : await liveOdds(f.id); } catch (e) { continue; }
    if (!snap || snap.home == null || snap.away == null) continue;
    const ser = (SERIES[f.id] = (SERIES[f.id] || []).concat(snap)).slice(-60);
    const sig = computeSignal(ser);
    let spark = [];
    try { const ps = probSeries(ser); const k = (sig.side || 'home').toLowerCase(); spark = (ps[k] || []).slice(-24).map((x) => (x == null ? null : Math.round(x * 1000) / 1000)); } catch (e) {}
    // always surface the current de-vig odds, even before there's enough history to score
    let mk = sig.market;
    if (!mk) { try { const d = devig(snap); if (d) mk = { overround_pct: d.overround, implied: { home: d.p.home != null ? r3(d.p.home) : null, draw: d.p.draw != null ? r3(d.p.draw) : null, away: d.p.away != null ? r3(d.p.away) : null } }; } catch (e) {} }
    board.push({ fixtureId: f.id, name: f.name, ...sig, market: mk, odds: snap, spark });

    // open a call when sharp money is detected and we don't already have one
    if (sig.verdict === 'STEAM' && sig.score >= STEAM_AT && !open.has(f.id)) {
      const sideKey = sig.side.toLowerCase();
      const impliedAt = sig.market && sig.market.implied ? sig.market.implied[sideKey] : null;
      const betPrice = r3(snap[sideKey] || 0);   // decimal odds the agent takes its position at
      const openedAt = new Date().toISOString();
      // commit-reveal: hash the full decision so the on-chain anchor is a verifiable commitment
      // the agent made BEFORE the match resolved (reveal = re-hash the settled call, must match).
      const commit = crypto.createHash('sha256')
        .update(JSON.stringify({ fx: f.id, side: sig.side, sc: sig.score, px: betPrice, p: impliedAt, t: openedAt }))
        .digest('hex');
      const call = {
        id: f.id + '-' + Date.now(), fixtureId: f.id, name: f.name, side: sig.side,
        score: sig.score, opened_at: openedAt, commit,
        bet: { price: betPrice, prob: impliedAt, stake: stakeFor(sig.score) },   // paper position
        implied_at_call: impliedAt, implied_now: impliedAt, clv_pp: 0, cycles: 1,
        rationale:
          `Sharp move: ${sig.side} de-vig prob ${sig.stats.prob_open}→${sig.stats.prob_now} ` +
          `(${sig.stats.move_pct > 0 ? '+' : ''}${sig.stats.move_pct}pp, steam ${sig.stats.steam}, ${sig.stats.velocity_bp}bp/cycle).`,
        status: 'open', graded: null,
      };
      // cross-market confirmation: does the Asian-handicap line agree with the 1X2 steam?
      if (MOCK) { call.cross_confirmed = Math.random() < 0.6; }
      else {
        try {
          const hc = await tx.matchHandicap(f.id);
          if (hc) { call.handicap = hc; const sk = sig.side.toLowerCase();
            call.cross_confirmed = (sk === 'home' && hc.home >= 0.5) || (sk === 'away' && hc.away >= 0.5); }
        } catch (e) {}
      }
      calls.unshift(call);
      open.add(f.id);
      ev('call', `STEAM ${sig.side} · ${f.name} @ conv ${Math.round(sig.score)}${call.cross_confirmed ? ' · handicap-confirmed' : ''}`);
      console.log(`[CALL] ${f.name} → STEAM ${sig.side} @ ${sig.score} · ${call.rationale}`);
      // anchor the decision on-chain (Solana memo) for a verifiable, tamper-evident record
      if (ANCHOR) {
        try { const a = await getAnchorer().anchorCall(call); if (a) { call.anchor = a; ev('anchor', `${f.name} decision committed on-chain · ${a.sig.slice(0, 8)}…`); console.log(`[ANCHOR] ${f.id} → ${a.sig}`); } } catch (e) {}
      }
    }
  }

  // periodically prove the data pipeline is anchored on-chain (best-effort, live only)
  if (!MOCK && cyc % 30 === 0) { await verifyProvenance(fixtures); if (provenance && provenance.verified) ev('verify', `source odds verified on-chain · txoracle.validate_odds · ${provenance.proof_depth}-node proof`); }
  cyc++;

  // live: tag each board match with its state (scheduled/live/final) + live score from TxLINE scores
  if (!MOCK) {
    for (const bo of board) {
      const snaps = await getScores(bo.fixtureId); const last = snaps && snaps[snaps.length - 1];
      if (!last) continue;
      bo.state = matchState(last.GameState);
      if (bo.state === 'live' || bo.state === 'final') { const oc = resultOutcome(last); if (oc) bo.matchScore = oc.score; }
    }
  }

  // live self-grading: re-price every open call against the current de-vig line (CLV proxy).
  // Positive CLV = the market kept moving our way after we called it = the read was sharp.
  const byId = Object.fromEntries(board.map((b) => [b.fixtureId, b]));
  for (const c of calls) {
    if (c.status !== 'open') continue;
    const b = byId[c.fixtureId];
    const impNow = b && b.market && b.market.implied ? b.market.implied[c.side.toLowerCase()] : null;
    if (impNow != null && c.implied_at_call != null) {
      c.implied_now = impNow;
      c.clv_pp = Math.round((impNow - c.implied_at_call) * 1000) / 10; // percentage points
      c.cycles = (c.cycles || 1) + 1;
      c.grade = c.clv_pp >= 0.3 ? 'confirming' : c.clv_pp <= -0.3 ? 'fading' : 'flat';
    }
    // settle a call once the outcome is known.
    if (MOCK) {
      // MOCK: settle after the move matures (no real result to grade against).
      if ((c.cycles || 0) >= SETTLE_CYCLES) {
        c.status = 'settled'; c.settled_at = new Date().toISOString();
        c.result_clv_pp = c.clv_pp; c.win = c.clv_pp > 0;
        bookPnl(c);
        ev('settle', `${c.name} · ${c.win ? 'WON' : 'lost'} ${c.pnl >= 0 ? '+' : ''}${c.pnl}u · CLV ${c.result_clv_pp}pp`);
      }
    } else {
      // LIVE: settle at full-time against the real TxLINE result.
      const snaps = await getScores(c.fixtureId); const last = snaps && snaps[snaps.length - 1];
      if (last && matchState(last.GameState) === 'final') {
        const oc = resultOutcome(last);
        if (oc) {
          c.status = 'settled'; c.settled_at = new Date().toISOString();
          c.final_score = oc.score; c.winner = oc.winner;
          c.win = c.side.toLowerCase() === oc.winner;   // did the side we called actually win
          c.result_clv_pp = c.clv_pp;                   // proxy CLV (rolling), upgraded to exact below
          // EXACT closing-line value: pull the odds as of kickoff (the true close) and grade against it
          try {
            const kickoff = startMap[c.fixtureId];
            if (kickoff) {
              const close = await tx.matchOdds(c.fixtureId, kickoff);
              const cd = close && devig(close);
              const cp = cd && cd.p ? cd.p[c.side.toLowerCase()] : null;
              if (cp != null && c.implied_at_call != null) {
                c.close_implied = r3(cp);
                c.result_clv_pp = Math.round((cp - c.implied_at_call) * 1000) / 10;
                c.clv_exact = true;
              }
            }
          } catch (e) {}
          bookPnl(c);
          ev('settle', `${c.name} ${c.final_score} · ${c.win ? 'WON' : 'lost'} ${c.pnl >= 0 ? '+' : ''}${c.pnl}u · CLV ${c.result_clv_pp}pp`);
          console.log(`[SETTLE] ${c.name} → ${oc.score} · called ${c.side} · ${c.win ? 'WON' : 'lost'} · P&L ${c.pnl >= 0 ? '+' : ''}${c.pnl}u (CLV ${c.result_clv_pp}pp)`);
          // anchor the graded result on-chain too: the whole track record is tamper-evident
          if (ANCHOR && c.anchor) { try { const a = await getAnchorer().anchorSettle(c); if (a) c.settle_anchor = a; } catch (e) {} }
        }
      }
    }
  }

  board.sort((a, b) => (b.score || 0) - (a.score || 0));
  const openCalls = calls.filter((c) => c.status === 'open');
  const settled = calls.filter((c) => c.status === 'settled');
  const wins = settled.filter((c) => c.win).length;
  const withClv = openCalls.filter((c) => typeof c.clv_pp === 'number');
  const avgClv = withClv.length ? Math.round((withClv.reduce((s, c) => s + c.clv_pp, 0) / withClv.length) * 10) / 10 : 0;
  // paper P&L / bankroll curve (chronological): the agent's self-traded book
  const settledChrono = settled.slice().sort((a, b) => new Date(a.settled_at || 0) - new Date(b.settled_at || 0));
  let bank = BANKROLL0, staked = 0; const curve = [BANKROLL0];
  for (const c of settledChrono) { staked += (c.stake || (c.bet && c.bet.stake) || 1); bank += (c.pnl || 0); curve.push(Math.round(bank * 100) / 100); }
  const pnlU = Math.round((bank - BANKROLL0) * 100) / 100;
  const summary = {
    matches: board.length,
    open_calls: openCalls.length,
    steam_now: board.filter((b) => b.verdict === 'STEAM').length,
    avg_clv_pp: avgClv,
    confirming: openCalls.filter((c) => c.grade === 'confirming').length,
    settled: settled.length,
    clv_hit_rate: settled.length ? Math.round((wins / settled.length) * 100) : null,   // result hit rate
    beat_close_pct: settled.length ? Math.round((settled.filter((c) => (c.result_clv_pp ?? 0) > 0).length / settled.length) * 100) : null,
    bankroll: Math.round(bank * 100) / 100,     // paper bankroll, started at 100u
    pnl_u: pnlU,                                // net units won/lost
    roi_pct: staked ? Math.round((pnlU / staked) * 1000) / 10 : 0,
    staked_u: Math.round(staked * 100) / 100,
    record: `${wins}-${settled.length - wins}`,  // W-L on real results
    bankroll_curve: curve.slice(-40),
    provenance,                                   // on-chain Merkle-proof that the source odds are canonical
    agent: { cycles: cyc, poll_s: Math.round(POLL_MS / 1000), started_at: STARTED, mode: MOCK ? 'demo' : 'live' },
  };
  if (cyc % 10 === 1 || (!events.length)) ev('scan', `scan · ${board.length} fixtures · ${summary.steam_now} steam · ${openCalls.length} open`);
  writeJson('board.json', { updated_at: new Date().toISOString(), mock: MOCK, summary, fixtures: board });
  writeJson('calls.json', calls.slice(0, 200));
  writeJson('events.json', events.slice(0, 60));
  console.log(`[cycle] ${board.length} scored · ${openCalls.length} open · ${summary.steam_now} steam · CLV ${avgClv}pp${MOCK ? ' · MOCK' : ''}`);
}

(async () => {
  console.log(`Sharp agent starting (${MOCK ? 'MOCK' : 'LIVE devnet'})`);
  await cycle();
  if (ONCE) return;
  setInterval(() => cycle().catch((e) => console.error('[cycle] err', e.message)), POLL_MS);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });

// Sharp · tiny read-only API so the page can trigger a LIVE, trustless on-chain verification.
// GET /api/verify           -> re-verify the current provenance odds message against the on-chain
//                              txoracle daily Merkle root (fast: the message_id+ts are in board.json)
// GET /api/verify?fixture=ID -> pull that fixture's latest stable odds update and verify it live
// GET /api/health           -> liveness
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Txline } = require('./txline');
const { verifyOdds } = require('./verify');

const DATA = process.env.SHARP_DATA || path.join(__dirname, 'data');
const PORT = +process.env.SHARP_API_PORT || 3211;
const CACHE_MS = 20_000;                 // brief cache so the endpoint cannot be hammered
let tx = null, cache = { at: 0, body: null };
async function getTx() { if (!tx) { tx = new Txline({ net: 'devnet' }); await tx.session(); } return tx; }
const readBoard = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'board.json'))); } catch { return null; } };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/health') return send(res, 200, { ok: true });
    if (u.pathname !== '/api/verify') return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    const fixtureId = u.searchParams.get('fixture');
    // serve a brief cache for the default (no-fixture) verify to prevent hammering
    if (!fixtureId && cache.body && Date.now() - cache.at < CACHE_MS) return send(res, 200, { ...cache.body, cached: true });
    const t = await getTx();

    // fast path: re-verify the message already surfaced in board.json provenance
    if (!fixtureId) {
      const pv = readBoard()?.summary?.provenance;
      if (pv && pv.message_id && pv.ts) {
        const r = await verifyOdds(t, pv.message_id, pv.ts);
        const body = { fixture: pv.fixture, market: pv.market, message_id: pv.message_id, took_ms: Date.now() - started, ...r };
        cache = { at: Date.now(), body };
        return send(res, 200, body);
      }
    }
    // targeted path: pull a fixture's latest stable odds update, then verify it
    const fx = await t.matchFixtures();
    const list = fixtureId ? fx.filter((f) => String(f.id) === String(fixtureId)) : fx;
    for (const f of list) {
      let ups = []; try { ups = await t.oddsUpdates(f.id); } catch (e) {}
      const arr = Array.isArray(ups) ? ups : [];
      const m = arr.find((x) => x.MessageId && /stable|demarg/i.test(String(x.Bookmaker || ''))) || arr.find((x) => x.MessageId);
      if (!m) continue;
      const r = await verifyOdds(t, m.MessageId, m.Ts);
      return send(res, 200, { fixture: f.name, market: m.SuperOddsType, message_id: m.MessageId, took_ms: Date.now() - started, ...r });
    }
    send(res, 200, { verified: false, error: 'no verifiable odds message available right now' });
  } catch (e) { send(res, 500, { error: (e.message || String(e)).slice(0, 160) }); }
});
server.listen(PORT, '127.0.0.1', () => console.log('sharp-api listening on 127.0.0.1:' + PORT));

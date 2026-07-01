// Sharp · TRUSTLESS on-chain data verification. Instead of trusting the TxLINE API's
// word, the agent calls the sponsor's own `txoracle` program (validate_odds) to prove the
// odds it acted on validate against the daily Merkle root posted on Solana. If the program
// does not throw InvalidSubTreeProof / InvalidMainTreeProof / RootNotAvailable, the data is
// canonical, tamper-evident, on-chain-verified. (Mapping from IDL via tx-on-chain repo.)
'use strict';
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey } = require('@solana/web3.js');
const BN = anchor.BN;

const toB32 = (v) => {
  let b;
  if (Array.isArray(v)) b = Buffer.from(v.map((x) => (x < 0 ? x + 256 : x)));
  else if (typeof v === 'string') b = v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex') : Buffer.from(v, 'base64');
  else throw new Error('bad 32-byte value');
  if (b.length !== 32) throw new Error('not 32 bytes: ' + b.length);
  return Array.from(b);
};
const toProof = (a) => (a || []).map((n) => ({ hash: toB32(n.hash), isRightSibling: !!n.isRightSibling }));

let _program = null;
function program(tx) {
  if (_program) return _program;
  const conn = new Connection(tx.cfg.rpc, 'confirmed');
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(tx.loadKeypair()), { commitment: 'confirmed' });
  const idl = JSON.parse(JSON.stringify(tx.idl));
  idl.address = tx.cfg.program;
  // shipped IDL omits the bool return on validate_* → add it so .view() can decode
  for (const ix of idl.instructions) if (/^validate/i.test(ix.name)) ix.returns = 'bool';
  _program = new anchor.Program(idl, provider);
  return _program;
}

// Verify one odds message against the on-chain daily odds Merkle root.
// Returns {verified:true, method, epochDay, pda, program, message_id, proof_nodes} on success.
async function verifyOdds(tx, messageId, ts) {
  const v = await tx.oddsValidation(messageId, ts);   // {odds, summary, subTreeProof, mainTreeProof}
  const o = v.odds, sm = v.summary;
  const p = program(tx);
  const epochDay = Math.floor(Number(o.Ts) / 86_400_000);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('daily_batch_roots'), new BN(epochDay).toArrayLike(Buffer, 'le', 2)], p.programId);
  const odds = {
    fixtureId: new BN(o.FixtureId), messageId: o.MessageId, ts: new BN(o.Ts),
    bookmaker: o.Bookmaker, bookmakerId: o.BookmakerId, superOddsType: o.SuperOddsType,
    gameState: o.GameState ?? null, inRunning: !!o.InRunning,
    marketParameters: o.MarketParameters ?? null, marketPeriod: o.MarketPeriod ?? null,
    priceNames: o.PriceNames, prices: o.Prices,
  };
  const summary = {
    fixtureId: new BN(sm.fixtureId),
    updateStats: { updateCount: sm.updateStats.updateCount, minTimestamp: new BN(sm.updateStats.minTimestamp), maxTimestamp: new BN(sm.updateStats.maxTimestamp) },
    oddsSubTreeRoot: toB32(sm.oddsSubTreeRoot),
  };
  const proofNodes = (v.subTreeProof || []).length + (v.mainTreeProof || []).length;
  const base = { epochDay, pda: pda.toBase58(), program: p.programId.toBase58(), message_id: messageId, proof_nodes: proofNodes };
  const call = p.methods.validateOdds(new BN(o.Ts), odds, summary, toProof(v.subTreeProof), toProof(v.mainTreeProof)).accounts({ dailyOddsMerkleRoots: pda });
  try {
    const predicate = await call.view();
    return { verified: true, method: 'view', predicate, ...base };
  } catch (e) {
    try {
      await call.simulate();   // no program error => proof is authentic against the on-chain root
      return { verified: true, method: 'simulate', ...base };
    } catch (e2) {
      return { verified: false, ...base, error: (e2.message || String(e2)).slice(0, 160) };
    }
  }
}

module.exports = { verifyOdds };

if (require.main === module) {
  const { Txline } = require('./txline');
  (async () => {
    const tx = new Txline({ net: 'devnet' }); await tx.session();
    const fx = await tx.matchFixtures();
    for (const f of fx) {
      const ups = await tx.oddsUpdates(f.id).catch(() => []);
      const m = (Array.isArray(ups) ? ups : []).find((x) => x.MessageId);
      if (!m) continue;
      const r = await verifyOdds(tx, m.MessageId, m.Ts);
      console.log(f.name, '→', JSON.stringify(r));
      return;
    }
  })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}

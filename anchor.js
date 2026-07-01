// Sharp · on-chain decision anchoring. Each STEAM call is written to Solana as a
// compact, timestamped memo (SPL Memo program) so the agent's read is a verifiable,
// tamper-evident public record · not a claim in a database we could edit after the fact.
// Reuses the agent's devnet keypair + connection (funded via the retry cron).
'use strict';
const { Connection, PublicKey, Transaction, TransactionInstruction, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const NET = { devnet: 'https://api.devnet.solana.com', mainnet: 'https://api.mainnet-beta.solana.com' };

class Anchor {
  constructor(opts = {}) {
    this.cluster = opts.cluster || 'devnet';
    this.conn = new Connection(opts.rpc || NET[this.cluster], 'confirmed');
    this.keyFile = opts.keyFile || path.join(opts.dir || __dirname, '.devkey.json');
    this.kp = null; this.disabled = false; this._warned = false;
  }
  load() {
    if (this.kp) return this.kp;
    if (!fs.existsSync(this.keyFile)) { this.disabled = true; return null; }
    this.kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(this.keyFile))));
    return this.kp;
  }

  // Best-effort memo write: returns {sig, cluster, slot} on success, or null (never throws into the loop).
  async _send(memoObj) {
    if (this.disabled) return null;
    const kp = this.load();
    if (!kp) return null;
    const memo = JSON.stringify(memoObj);   // Memo caps ~566 bytes; keep it compact + parseable
    try {
      const ix = new TransactionInstruction({ keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }], programId: MEMO_PROGRAM, data: Buffer.from(memo, 'utf8') });
      const sig = await sendAndConfirmTransaction(this.conn, new Transaction().add(ix), [kp], { commitment: 'confirmed', maxRetries: 3 });
      let slot = null; try { slot = (await this.conn.getSignatureStatus(sig)).context.slot; } catch {}
      return { sig, cluster: this.cluster, slot };
    } catch (e) {
      if (!this._warned) { console.error('[anchor] disabled (unfunded/unreachable):', e.message.slice(0, 80)); this._warned = true; }
      return null;
    }
  }

  // anchor a NEW call (the agent's decision to take a position)
  anchorCall(call) {
    return this._send({
      t: 'sharp.call', v: 1, fx: call.fixtureId, m: call.name, side: call.side,
      sc: Math.round(call.score || 0), p: call.implied_at_call,
      stk: call.bet && call.bet.stake, px: call.bet && call.bet.price,
      h: call.commit,   // SHA-256 commitment to the full decision (reveal = re-hash the settled call)
      ts: Math.floor(Date.now() / 1000),
    });
  }

  // anchor the GRADED RESULT so the whole track record is tamper-evident, not just the open
  anchorSettle(call) {
    return this._send({
      t: 'sharp.settle', v: 1, fx: call.fixtureId, m: call.name, side: call.side,
      res: call.final_score, win: !!call.win, pnl: call.pnl, clv: call.result_clv_pp, ts: Math.floor(Date.now() / 1000),
    });
  }
}

module.exports = { Anchor };

if (require.main === module) {
  (async () => {
    const a = new Anchor({ cluster: 'devnet' });
    const r = await a.anchorCall({ fixtureId: 'TEST-1', name: 'Argentina v France', side: 'HOME', score: 78, implied_at_call: 0.52 });
    console.log(r ? `anchored ${r.sig} (slot ${r.slot}) → https://explorer.solana.com/tx/${r.sig}?cluster=devnet` : 'anchor returned null (wallet unfunded — expected until faucet clears)');
  })();
}

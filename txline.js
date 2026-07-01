// Sharp · TxLINE data client (devnet free World Cup tier). Promoted from the verified
// spike: guest JWT -> on-chain subscribe (free, 0 tokens) -> activate -> read fixtures/odds/scores.
// The activated apiToken + jwt are cached to disk so the agent loop reuses one session.
'use strict';
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const axios = require('axios');
const nacl = require('tweetnacl');
const fs = require('fs');
const path = require('path');

const NETS = {
  devnet: { rpc: 'https://api.devnet.solana.com', origin: 'https://txline-dev.txodds.com', program: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J', mint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG' },
  mainnet: { rpc: 'https://api.mainnet-beta.solana.com', origin: 'https://txline.txodds.com', program: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA', mint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL' },
};
const SERVICE_LEVEL_ID = 1;       // free World Cup + Int Friendlies (60s delay)
const DURATION_WEEKS = 4;
const LEAGUES = [];               // standard bundle

class Txline {
  constructor(opts = {}) {
    this.net = opts.net || 'devnet';
    this.cfg = NETS[this.net];
    this.dir = opts.dir || __dirname;
    this.keyFile = opts.keyFile || path.join(this.dir, '.devkey.json');
    this.sessFile = path.join(this.dir, '.session.json');
    this.idl = require(opts.idlPath || path.join(this.dir, 'txoracle.json'));
    this.idl.address = this.cfg.program;          // reuse mainnet IDL on devnet
    this.mint = new PublicKey(this.cfg.mint);
    this.api = `${this.cfg.origin}/api`;
    this.kp = null; this.jwt = null; this.apiToken = null;
  }

  loadKeypair() {
    if (this.kp) return this.kp;
    if (fs.existsSync(this.keyFile)) this.kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(this.keyFile))));
    else { this.kp = Keypair.generate(); fs.writeFileSync(this.keyFile, JSON.stringify(Array.from(this.kp.secretKey)), { mode: 0o600 }); }
    return this.kp;
  }
  pubkey() { return this.loadKeypair().publicKey.toBase58(); }

  async guestJwt() {
    for (const o of [this.cfg.origin, this.cfg.origin.replace('txline', 'oracle')]) {
      try { const r = await axios.post(`${o}/auth/guest/start`); if (r.data && r.data.token) { this.jwt = r.data.token; return this.jwt; } } catch (e) {}
    }
    throw new Error('guest JWT failed');
  }

  async subscribe() {
    const kp = this.loadKeypair();
    const conn = new Connection(this.cfg.rpc, 'confirmed');
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' });
    anchor.setProvider(provider);
    const program = new anchor.Program(this.idl, provider);
    const userAta = await getOrCreateAssociatedTokenAccount(conn, kp, this.mint, kp.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID);
    const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from('pricing_matrix')], program.programId);
    const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from('token_treasury_v2')], program.programId);
    const tokenTreasuryVault = getAssociatedTokenAddressSync(this.mint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);
    const txSig = await program.methods.subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS).accounts({
      user: kp.publicKey, pricingMatrix: pricingMatrixPda, tokenMint: this.mint, userTokenAccount: userAta.address,
      tokenTreasuryVault, tokenTreasuryPda, tokenProgram: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
    return txSig;
  }

  async activate(txSig) {
    if (!this.jwt) await this.guestJwt();
    const kp = this.loadKeypair();
    const msg = `${txSig}:${LEAGUES.join(',')}:${this.jwt}`;
    const walletSignature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)).toString('base64');
    const r = await axios.post(`${this.api}/token/activate`, { txSig, walletSignature, leagues: LEAGUES }, { headers: { Authorization: `Bearer ${this.jwt}` } });
    this.apiToken = (r.data && (r.data.token || r.data.apiToken)) || r.data;
    if (typeof this.apiToken !== 'string') this.apiToken = (this.apiToken && this.apiToken.token) || '';
    fs.writeFileSync(this.sessFile, JSON.stringify({ jwt: this.jwt, apiToken: this.apiToken, txSig, at: Date.now() }), { mode: 0o600 });
    return this.apiToken;
  }

  // bootstrap a usable session: reuse cached, else fresh guest+activate (subscribe if needed)
  async session({ forceSubscribe = false } = {}) {
    if (fs.existsSync(this.sessFile) && !forceSubscribe) {
      try { const s = JSON.parse(fs.readFileSync(this.sessFile)); this.jwt = s.jwt; this.apiToken = s.apiToken;
        await this.fixtures(); return { reused: true }; } catch (e) { /* fall through to refresh */ }
    }
    await this.guestJwt();
    const txSig = await this.subscribe();
    await this.activate(txSig);
    return { reused: false, txSig };
  }

  headers() { return { Authorization: `Bearer ${this.jwt}`, 'X-Api-Token': this.apiToken }; }
  async _get(p) { return (await axios.get(`${this.api}${p}`, { headers: this.headers(), timeout: 20000 })).data; }

  async fixtures() { return this._get('/fixtures/snapshot'); }
  async odds(fixtureId, asOf) { return this._get(`/odds/snapshot/${fixtureId}${asOf ? `?asOf=${asOf}` : ''}`); }  // asOf(ms) = point-in-time snapshot (e.g. kickoff = closing line)
  async scores(fixtureId) { return this._get(`/scores/snapshot/${fixtureId}`); }
  async oddsUpdates(fixtureId) { return this._get(`/odds/updates/${fixtureId}`); }
  // Merkle-proof that a given odds message is the canonical, tamper-evident on-chain record
  async oddsValidation(messageId, ts) { return this._get(`/odds/validation?messageId=${encodeURIComponent(messageId)}&ts=${ts}`); }

  // --- normalised views (map TxLINE's raw schema to what the agent consumes) ---
  // Fixture{FixtureId, Participant1, Participant2, Participant1IsHome, Competition, StartTime}
  async matchFixtures() {
    const raw = await this.fixtures();
    return asArray(raw).map((f) => {
      const p1Home = f.Participant1IsHome !== false;      // default true
      const home = p1Home ? f.Participant1 : f.Participant2;
      const away = p1Home ? f.Participant2 : f.Participant1;
      return { id: f.FixtureId, name: `${home || '?'} v ${away || '?'}`, home, away,
        competition: f.Competition, startTime: f.StartTime, raw: f };
    }).filter((f) => f.id != null);
  }

  // Reduce the per-bookmaker OddsPayload[] for a fixture to a single consensus
  // 1X2 (home/draw/away) decimal-odds snapshot the signal engine can de-vig.
  async matchOdds(fixtureId, asOf) {
    const raw = await this.odds(fixtureId, asOf);
    return mapMatchOdds(asArray(raw), fixtureId);
  }

  // The main Asian-handicap line (closest to level) from the stable book, as a second market
  // to cross-confirm 1X2 steam. Returns {line, home, away} demargined probs, or null.
  async matchHandicap(fixtureId, asOf) {
    return mapHandicap(asArray(await this.odds(fixtureId, asOf)));
  }
}

function mapHandicap(payloads) {
  let best = null;
  for (const o of payloads) {
    if (!/asianhandicap/i.test(String(o.SuperOddsType || ''))) continue;
    if (/half=[12]/i.test(String(o.MarketPeriod || ''))) continue;       // full match only
    if (!/stable|demarg/i.test(String(o.Bookmaker || ''))) continue;     // consensus book
    const names = o.PriceNames || [], pct = o.Pct || [];
    const iH = names.findIndex((n) => /part1|home|^1$/i.test(n)), iA = names.findIndex((n) => /part2|away|^2$/i.test(n));
    const ph = iH >= 0 && /^\d/.test(String(pct[iH])) ? Number(pct[iH]) / 100 : null;
    const pa = iA >= 0 && /^\d/.test(String(pct[iA])) ? Number(pct[iA]) / 100 : null;
    if (ph == null || pa == null) continue;                               // skip NA quarter lines
    const lm = String(o.MarketParameters || '').match(/-?\d+(\.\d+)?/);
    const line = lm ? parseFloat(lm[0]) : 0;
    if (!best || Math.abs(line) < Math.abs(best.line)) best = { line, home: r3(ph), away: r3(pa) };
  }
  return best;
}

const asArray = (x) => (Array.isArray(x) ? x : x && (x.data || x.payload) ? (x.data || x.payload) : x ? [x] : []);
const SEL = (name) => {
  const s = String(name || '').trim().toLowerCase();
  if (/^(1|h|home|host|w1|part1|p1)$/.test(s)) return 'home';    // TxLINE uses part1/draw/part2
  if (/^(x|d|draw|tie|dr)$/.test(s)) return 'draw';
  if (/^(2|a|away|visitor|guest|w2|part2|p2)$/.test(s)) return 'away';
  return null;
};
// Prices are int32 decimal odds; scale so the value lands in a sane decimal-odds band.
const priceToDecimal = (p) => {
  const n = Number(p); if (!isFinite(n) || n <= 0) return null;
  for (const s of [1000, 100, 10, 1]) { const v = n / s; if (v >= 1.01 && v <= 1000) return v; }
  return null;
};
const median = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); if (!v.length) return null;
  const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

function mapMatchOdds(payloads, fixtureId) {
  // keep only full-match 1X2 payloads: exactly home/draw/away selections, no handicap params
  const cand = [];
  for (const o of payloads) {
    const names = o.PriceNames || o.priceNames || [];
    const prices = o.Prices || o.prices || [];
    const pct = o.Pct || o.pct || [];
    const sot = String(o.SuperOddsType || '');
    if (!/1x2|participant_result/i.test(sot)) continue;  // ONLY the match-winner (1X2) market
    if (/half=[12]/i.test(String(o.MarketPeriod || ''))) continue; // full match, not halves
    if (o.MarketParameters) continue;                    // handicap / totals carry a line param
    const sel = {};
    let mapped = 0;
    for (let i = 0; i < names.length; i++) {
      const k = SEL(names[i]); if (!k || sel[k]) continue;
      const prob = pct[i] != null && /^\d/.test(String(pct[i])) ? Number(pct[i]) / 100 : null; // demargined %
      const dec = prob && prob > 0 ? 1 / prob : priceToDecimal(prices[i]);
      if (dec) { sel[k] = { dec, prob }; mapped++; }
    }
    if (mapped >= 2 && sel.home && sel.away) {
      const stable = /super|stable|consensus|txodds|demarg/i.test(`${o.Bookmaker || ''} ${sot}`);
      cand.push({ sel, ts: o.Ts, stable, inRunning: !!o.InRunning });
    }
  }
  if (!cand.length) return null;
  // prefer an explicit consensus/stable book, else the median across all books
  const stable = cand.find((c) => c.stable && !c.inRunning) || cand.find((c) => c.stable);
  const pick = (k) => stable ? (stable.sel[k] ? stable.sel[k].dec : null)
    : median(cand.map((c) => c.sel[k] && c.sel[k].dec));
  const home = pick('home'), draw = pick('draw'), away = pick('away');
  if (!home || !away) return null;
  const ts = (stable && stable.ts) || Math.max(...cand.map((c) => c.ts || 0)) || Math.floor(Date.now() / 1000);
  return { ts: Math.floor(ts > 1e12 ? ts / 1000 : ts), home: r3(home), draw: draw ? r3(draw) : null, away: r3(away),
    books: cand.length, source: stable ? 'stable' : 'consensus-median' };
}
const r3 = (x) => Math.round(x * 1000) / 1000;

module.exports = { Txline, NETS, mapMatchOdds, mapHandicap };

if (require.main === module) {
  // smoke test: needs devnet SOL in .devkey.json wallet (see retry cron)
  (async () => {
    const tx = new Txline({ net: 'devnet' });
    console.log('wallet:', tx.pubkey());
    const s = await tx.session();
    console.log('session:', s);
    const fx = await tx.fixtures();
    const arr = Array.isArray(fx) ? fx : (fx.fixtures || fx.data || []);
    console.log('fixtures:', Array.isArray(arr) ? arr.length : '?', JSON.stringify(arr[0] || fx).slice(0, 240));
  })().catch((e) => { console.error('FAIL', e.message, e.response ? JSON.stringify(e.response.data).slice(0, 160) : ''); process.exit(1); });
}

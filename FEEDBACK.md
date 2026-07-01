# TxLINE API · builder feedback

Our experience integrating TxLINE as the primary input for Sharp.

## What we liked most
- **One normalised JSON schema across everything.** Fixtures, odds and scores share the same shape and the same fixture IDs, so scaling from a single friendly to all 104 World Cup matches was genuinely trivial. This is the single best thing about the feed.
- **The demargined `Pct` field.** Getting honest, no-vig outcome probabilities directly from the feed (3 decimal places) meant our edge signal could reason about true probability without us having to trust our own de-vig. We still de-vig the decimal prices as a cross-check, and the two agree.
- **On-chain Merkle validation is a real differentiator.** Being able to call `validate_odds` and prove the exact odds our agent acted on against the daily on-chain root turned "trust our dashboard" into "verify it yourself on Solana." Nothing else in this space offers that, and it became the centrepiece of our submission.
- **The free World Cup tier via on-chain subscribe (0 tokens).** Once the handshake is understood, activation is clean and the 60-second sampled feed is plenty for an odds-movement agent.

## Where we hit friction
- **The validate instructions ship without a `returns` field in the IDL.** Anchor's `.view()` cannot decode a boolean unless the instruction declares a return type, so `validate_odds` / `validate_stat` throw until you patch the IDL in memory (add `"returns": "bool"`). Publishing `returns` on those instructions would save every builder a debugging session.
- **`SuperOddsType` is a bare string with no published enum.** We had to enumerate the market families empirically from live payloads (we found `1X2_PARTICIPANT_RESULT` and `ASIANHANDICAP_PARTICIPANT_GOALS`). A published list of market types plus their `PriceNames` conventions would remove guesswork.
- **`odds/updates/{fixtureId}` returns the full 5-minute cache.** That can be thousands of messages when all we needed was the latest `MessageId` for a validation call. A "latest per market" or "latest N" parameter would cut a lot of bandwidth.
- **Mixed field casing.** The odds payload is PascalCase (`FixtureId`, `PriceNames`) while the validation `summary` is camelCase (`fixtureId`, `oddsSubTreeRoot`). Minor, but it caught us when mapping to the Anchor structs.
- **The activation handshake could use one copy-paste Node snippet.** The guest JWT, on-chain `subscribe`, then the wallet signature over `txSig:leagues:jwt` into `token/activate` is a few well-documented steps, but a single runnable example (beyond the quickstart) would smooth first contact. (Devnet SOL faucet availability was our only real bootstrapping hurdle, and that is not on TxLINE.)

Overall: a genuinely strong data layer. The normalised schema and the on-chain verifiability are the standouts, and they are exactly what made an autonomous, self-proving agent possible.

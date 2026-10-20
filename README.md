# Ageback — cashback rail for agent purchases on NEAR

**An agent buys something. In the same receipt, the merchant is paid and the agent's human gets the cashback.**

Merchants publish a commission on-chain. When an agent pays, the contract splits the payment *at settlement*: merchant share to the merchant, rebate to the human the agent is linked to, protocol fee to the rail. No escrow, no release step, no server deciding later whether cashback is owed. Every sale leaves a receipt anyone can verify.

```
merchant ── register_merchant(commission_bps) ──────────► Ageback
human    ── link(agent, payout_account, identity) ───────► Ageback
agent    ── pay(merchant, source) + 10 NEAR ─────────────► Ageback
                                                 ├─ 9.50 NEAR → merchant   ┐
                                                 ├─ 0.45 NEAR → human      ├ same receipt
                                                 └─ 0.05 NEAR → protocol   ┘
anyone   ── get_receipt(42) ─────────────────────────────► the proof
```

## Why a rail and not a discount

For a human buyer, cashback works on psychology. For an agent buyer it doesn't — an agent just takes the lowest price. What *does* work is the thing cashback sites have always been underneath: an **affiliate network**. Merchants already budget 2–10% for referred volume. Ageback makes that commission a verifiable on-chain primitive for agent commerce, with per-channel rates so the frameworks that bring the buyers get paid for it.

Three things fall out of doing the split inside the payment:

- **Verifiable.** The receipt *is* the proof. Merchant, agent, identity, source, rate, split — stored on-chain, `get_receipt` returns it forever.
- **Zero integration for agents.** Anything that can send a NEAR transaction gets cashback for its human. The human never signs anything; the rebate just arrives.
- **Attribution built in.** `pay()` carries a `source` (framework, channel, referral code) and merchants set rates per source. That's what makes integrating Ageback worth a framework's while, and it's the dataset nobody else has.

## Repo layout

```
contract/        near-sdk-js contract (TypeScript → wasm) + sandbox tests
  src/contract.ts     the rail
  test/rail.ava.js    near-workspaces tests
docs/index.html  Ledger — accounting view of every receipt, read from the contract (GitHub Pages)
agent/           off-chain scripts (near-api-js)
  agent.js            an agent paying a merchant
  setup.js            register a merchant, set per-source rates, link an agent to a human
```

## Contract API

| Method | Who | What |
| --- | --- | --- |
| `init({owner, protocol_fee_bps})` | deployer | one-time; fee is a share of the *commission* |
| `register_merchant({name, commission_bps, payout_account?})` (0.01 Ⓝ) | merchant | publish your default commission |
| `update_merchant({commission_bps?, active?, payout_account?})` | merchant | |
| `set_source_rate({source, commission_bps \| null})` | merchant | pay a different rate per acquisition channel |
| `link({agent, payout_account, identity?})` (0.005 Ⓝ) | human / agent | where this agent's rebates go + a portable identity (e.g. ERC-8004). First caller is controller; the agent itself can also update it |
| `pay({merchant, memo?, source?})` + deposit | agent | **the split.** Merchant and human paid in this receipt. Returns and stores a `Receipt`, emits NEP-297 `sale` |
| `get_receipt({sale_id})`, `get_receipts({from, limit})` | view | verify any sale; page through all of them |
| `quote({merchant, price, source?})`, `get_rate({merchant, source?})` | view | what the split would be |
| `get_merchant`, `list_merchants`, `get_link`, `get_config` | view | |
| `withdraw_fees({amount})` | owner | protocol fees only; the storage reserve is protected |

Unlinked agents get the rebate back to their own account, so nothing is ever stranded.

### Ledger (for the humans doing the books)

`docs/index.html` is a single-file page that reads every receipt from the contract over RPC and shows it the way an accounting team expects: gross sales → paid to merchants + cashback paid + fee income, per-merchant and per-source breakdowns, cashback by human, a filterable ledger, a double-entry journal view, CSV export, and a one-click `near view … get_receipt` command to verify any line against the chain. Serve it from GitHub Pages; `?contract=ageback.testnet&network=testnet` loads a deployment, no query loads demo data.

## Run it

### 1. Build and test the contract (Node 20+)

```bash
cd contract
npm install          # near-sdk-js downloads its toolchain on postinstall
npm run build        # → build/ageback.wasm
npm test             # near-workspaces sandbox (downloads near-sandbox on first run)
```

### 2. Deploy (testnet)

```bash
near create-account ageback.<you>.testnet --useFaucet
near deploy ageback.<you>.testnet contract/build/ageback.wasm
near call ageback.<you>.testnet init '{"owner":"<you>.testnet","protocol_fee_bps":1000}' --accountId <you>.testnet
```

### 3. Demo

```bash
cd agent && npm install && cp .env.example .env   # fill in accounts/keys

npm run setup -- merchant "Pizzeria Da Michele" 500          # 5% commission
npm run setup -- rate claude-code 800                          # 8% for purchases via that channel
npm run setup -- link agent.testnet erc8004:eip155:8453:1234   # rebates → PAYOUT_ACCOUNT
AGEBACK_SOURCE=claude-code npm run agent -- pizzeria.testnet 10 "two margherita"
```

Then open `docs/index.html?contract=ageback.<you>.testnet` and the sale is on the ledger.

## Honest limitations (and what's next)

- **Merchant side is the adoption problem.** The demo merchant is a NEAR account. Real merchants need to accept crypto *and* agent purchases *and* opt in. First real targets: x402/MPP-style API sellers and agent marketplaces, where the merchant is already on-chain.
- **Native NEAR only.** Accepting NEP-141 (USDC on NEAR) via `ft_on_transfer` is the obvious next step and keeps the same split logic.
- **Receipts cost storage** (~0.004 Ⓝ each from the contract balance). On tiny sales that exceeds the protocol fee; a production version prunes to events + an indexer, or charges storage to the sale.
- **Sybil-resistant loyalty is deliberately out.** Tiers and referrals are farmable; this is a plain split with attribution. Reputation can plug in later via the `identity` on the link.
- **Cross-chain payout** (human wants USDC on Base) was in a previous version via NEAR Intents and was removed to keep settlement atomic. It can come back as an optional hop on top of the same receipt.

## License

MIT

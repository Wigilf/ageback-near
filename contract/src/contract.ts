// Ageback — a commission rail for agent purchases on NEAR.
//
// The one rule: the split happens inside the payment. In the same receipt as
// the sale, the merchant gets their share and the agent's human gets the rebate.
// No escrow, no release step, no server that decides later.
//
//   merchant  ──register_merchant(commission_bps)──────►  Ageback
//   human     ──link(agent, payout account, identity)──►  Ageback
//   agent     ──pay(merchant, source) + NEAR───────────►  Ageback
//                ├─ merchant_share → merchant payout account
//                ├─ rebate         → human's NEAR account      (same receipt)
//                └─ protocol_fee   → stays on contract for the owner
//   anyone    ──get_receipt(sale_id)───────────────────►  verifiable record

import {
  NearBindgen,
  near,
  call,
  view,
  initialize,
  LookupMap,
  UnorderedMap,
  NearPromise,
  assert,
} from "near-sdk-js";

const BPS = 10_000n;
const MERCHANT_STORAGE = 10n ** 22n; // 0.01 NEAR
const LINK_STORAGE = 5n * 10n ** 21n; // 0.005 NEAR
const RECEIPT_STORAGE = 4n * 10n ** 21n; // 0.004 NEAR reserve per receipt

export type Merchant = {
  name: string;
  commission_bps: number; // default rate
  source_rates: Record<string, number>; // per-channel overrides, e.g. { "claude-code": 700 }
  payout_account: string;
  active: boolean;
  sales: number;
  volume: string; // yoctoNEAR as string
  rebates: string;
};

export type Link = {
  controller: string; // account allowed to change this link (the human, or the agent itself)
  payout_account: string; // NEAR account that receives the agent's rebates
  identity: string; // portable agent identity, e.g. "erc8004:eip155:8453:1234", "" if none
};

export type Receipt = {
  sale_id: number;
  block_timestamp: string; // ns
  agent: string;
  identity: string;
  source: string; // channel / framework / referral code
  commission_bps: number; // rate applied
  merchant: string;
  price: string;
  merchant_share: string;
  protocol_fee: string;
  rebate: string;
  rebate_to: string; // NEAR account the rebate was sent to
  memo: string;
};

function emit(event: string, data: unknown) {
  near.log(`EVENT_JSON:${JSON.stringify({ standard: "ageback", version: "2.0.0", event, data: [data] })}`);
}

function rateFor(m: Merchant, source: string): number {
  return source !== "" && m.source_rates[source] !== undefined ? m.source_rates[source] : m.commission_bps;
}

@NearBindgen({ requireInit: true })
export class Ageback {
  owner: string = "";
  protocol_fee_bps: number = 0; // share of the *commission* kept by the protocol
  sale_count: number = 0;
  merchants: UnorderedMap<Merchant> = new UnorderedMap<Merchant>("m");
  links: LookupMap<Link> = new LookupMap<Link>("l");
  receipts: LookupMap<Receipt> = new LookupMap<Receipt>("r");
  total_volume: string = "0";
  total_rebates: string = "0";
  total_fees: string = "0";

  @initialize({})
  init({ owner, protocol_fee_bps }: { owner: string; protocol_fee_bps: number }) {
    assert(protocol_fee_bps >= 0 && protocol_fee_bps <= 10_000, "bad fee");
    this.owner = owner;
    this.protocol_fee_bps = protocol_fee_bps;
  }

  // ---------------------------------------------------------------- merchants

  @call({ payableFunction: true })
  register_merchant({
    name,
    commission_bps,
    payout_account,
  }: {
    name: string;
    commission_bps: number;
    payout_account?: string;
  }) {
    assert(near.attachedDeposit() >= MERCHANT_STORAGE, "attach ≥ 0.01 NEAR for storage");
    assert(commission_bps >= 0 && commission_bps <= 10_000, "commission_bps must be 0..10000");
    const id = near.predecessorAccountId();
    assert(this.merchants.get(id) === null, "already registered");
    const m: Merchant = {
      name,
      commission_bps,
      source_rates: {},
      payout_account: payout_account ?? id,
      active: true,
      sales: 0,
      volume: "0",
      rebates: "0",
    };
    this.merchants.set(id, m);
    emit("merchant_registered", { merchant: id, ...m });
  }

  @call({})
  update_merchant({
    commission_bps,
    active,
    payout_account,
  }: {
    commission_bps?: number;
    active?: boolean;
    payout_account?: string;
  }) {
    const id = near.predecessorAccountId();
    const m = this.merchants.get(id);
    assert(m !== null, "not a merchant");
    if (commission_bps !== undefined) {
      assert(commission_bps >= 0 && commission_bps <= 10_000, "bad bps");
      m.commission_bps = commission_bps;
    }
    if (active !== undefined) m.active = active;
    if (payout_account !== undefined) m.payout_account = payout_account;
    this.merchants.set(id, m);
    emit("merchant_updated", { merchant: id, ...m });
  }

  /** Set (or clear with null) a commission override for one acquisition channel.
   *  This is how a merchant pays more to the framework that converts best. */
  @call({})
  set_source_rate({ source, commission_bps }: { source: string; commission_bps: number | null }) {
    const id = near.predecessorAccountId();
    const m = this.merchants.get(id);
    assert(m !== null, "not a merchant");
    assert(source.length > 0 && source.length <= 64, "bad source");
    if (commission_bps === null) {
      delete m.source_rates[source];
    } else {
      assert(commission_bps >= 0 && commission_bps <= 10_000, "bad bps");
      m.source_rates[source] = commission_bps;
    }
    this.merchants.set(id, m);
    emit("source_rate_set", { merchant: id, source, commission_bps });
  }

  // -------------------------------------------------------------------- links

  /** Link an agent to the NEAR account that should receive its rebates.
   *  The first caller becomes the controller; afterwards only the controller
   *  (or the agent itself) can change it. */
  @call({ payableFunction: true })
  link({ agent, payout_account, identity }: { agent: string; payout_account: string; identity?: string }) {
    const caller = near.predecessorAccountId();
    const existing = this.links.get(agent);
    if (existing === null) {
      assert(near.attachedDeposit() >= LINK_STORAGE, "attach ≥ 0.005 NEAR for storage");
    } else {
      assert(existing.controller === caller || agent === caller, "only the controller or the agent can relink");
    }
    const l: Link = {
      controller: existing ? existing.controller : caller,
      payout_account,
      identity: identity ?? (existing ? existing.identity : ""),
    };
    this.links.set(agent, l);
    emit("agent_linked", { agent, ...l });
  }

  // ---------------------------------------------------------------------- pay

  /** The agent pays a merchant. Attached deposit is the price.
   *  Merchant share and rebate are transferred in this same receipt. */
  @call({ payableFunction: true })
  pay({ merchant, memo, source }: { merchant: string; memo?: string; source?: string }): Receipt {
    const price = near.attachedDeposit();
    assert(price > 0n, "attach the price");
    const m = this.merchants.get(merchant);
    assert(m !== null && m.active, "unknown or inactive merchant");
    const src = source ?? "";
    assert(src.length <= 64, "source too long");
    const memoText = memo ?? "";
    assert(memoText.length <= 140, "memo too long");

    const rateBps = rateFor(m, src);
    const commission = (price * BigInt(rateBps)) / BPS;
    const protocolFee = (commission * BigInt(this.protocol_fee_bps)) / BPS;
    const rebate = commission - protocolFee;
    const merchantShare = price - commission;

    const agent = near.predecessorAccountId();
    const link = this.links.get(agent);
    const rebateTo = link ? link.payout_account : agent; // unlinked agents get it back themselves

    m.sales += 1;
    m.volume = (BigInt(m.volume) + price).toString();
    m.rebates = (BigInt(m.rebates) + rebate).toString();
    this.merchants.set(merchant, m);
    this.total_volume = (BigInt(this.total_volume) + price).toString();
    this.total_rebates = (BigInt(this.total_rebates) + rebate).toString();
    this.total_fees = (BigInt(this.total_fees) + protocolFee).toString();

    this.sale_count += 1;
    const receipt: Receipt = {
      sale_id: this.sale_count,
      block_timestamp: near.blockTimestamp().toString(),
      agent,
      identity: link ? link.identity : "",
      source: src,
      commission_bps: rateBps,
      merchant,
      price: price.toString(),
      merchant_share: merchantShare.toString(),
      protocol_fee: protocolFee.toString(),
      rebate: rebate.toString(),
      rebate_to: rebateTo,
      memo: memoText,
    };
    this.receipts.set(this.sale_count.toString(), receipt);
    emit("sale", receipt);

    if (merchantShare > 0n) NearPromise.new(m.payout_account).transfer(merchantShare).build();
    if (rebate > 0n) NearPromise.new(rebateTo).transfer(rebate).build();
    return receipt;
  }

  // -------------------------------------------------------------------- admin

  /** Owner withdraws protocol fees, never the storage reserve. */
  @call({})
  withdraw_fees({ amount }: { amount: string }): NearPromise {
    assert(near.predecessorAccountId() === this.owner, "owner only");
    const storageCost = near.storageUsage() * 10n ** 19n;
    const free = near.accountBalance() - storageCost - BigInt(this.sale_count) * RECEIPT_STORAGE;
    assert(BigInt(amount) <= free, "would dip into storage reserve");
    return NearPromise.new(this.owner).transfer(BigInt(amount));
  }

  // -------------------------------------------------------------------- views

  @view({})
  get_merchant({ merchant }: { merchant: string }): Merchant | null {
    return this.merchants.get(merchant);
  }

  @view({})
  list_merchants({ from = 0, limit = 50 }: { from?: number; limit?: number }): [string, Merchant][] {
    return this.merchants.toArray().slice(from, from + limit);
  }

  @view({})
  get_link({ agent }: { agent: string }): Link | null {
    return this.links.get(agent);
  }

  /** Verifiable receipt: anyone can check a sale without trusting a server. */
  @view({})
  get_receipt({ sale_id }: { sale_id: number }): Receipt | null {
    return this.receipts.get(sale_id.toString());
  }

  /** Page through receipts for indexers and the ledger page. */
  @view({})
  get_receipts({ from = 1, limit = 50 }: { from?: number; limit?: number }): Receipt[] {
    const out: Receipt[] = [];
    for (let i = from; i < from + limit && i <= this.sale_count; i++) {
      const r = this.receipts.get(i.toString());
      if (r) out.push(r);
    }
    return out;
  }

  @view({})
  get_rate({ merchant, source }: { merchant: string; source?: string }): number {
    const m = this.merchants.get(merchant);
    assert(m !== null, "unknown merchant");
    return rateFor(m, source ?? "");
  }

  @view({})
  quote({ merchant, price, source }: { merchant: string; price: string; source?: string }) {
    const m = this.merchants.get(merchant);
    assert(m !== null, "unknown merchant");
    const p = BigInt(price);
    const rate = rateFor(m, source ?? "");
    const commission = (p * BigInt(rate)) / BPS;
    const protocolFee = (commission * BigInt(this.protocol_fee_bps)) / BPS;
    return {
      price,
      merchant_share: (p - commission).toString(),
      protocol_fee: protocolFee.toString(),
      rebate: (commission - protocolFee).toString(),
      commission_bps: rate,
      source: source ?? "",
    };
  }

  @view({})
  get_config() {
    return {
      owner: this.owner,
      protocol_fee_bps: this.protocol_fee_bps,
      sale_count: this.sale_count,
      total_volume: this.total_volume,
      total_rebates: this.total_rebates,
      total_fees: this.total_fees,
    };
  }
}

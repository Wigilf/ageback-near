// The agent: buys something from a merchant on the rail. Cashback for its human
// is a side effect of the payment itself — the agent does nothing extra.
//
//   AGEBACK_SOURCE=claude-code node agent.js <merchant.near> <price_in_NEAR> ["memo"]
import { account, RAIL, toYocto, fromYocto, events } from "./lib/near.js";

const [merchant, price, memo = "agent purchase"] = process.argv.slice(2);
const source = process.env.AGEBACK_SOURCE ?? "ageback-demo-agent"; // which framework/channel this agent runs in
if (!merchant || !price) {
  console.error("usage: node agent.js <merchant_account> <price_NEAR> [memo]");
  process.exit(1);
}

const agent = await account(process.env.AGENT_ACCOUNT, process.env.AGENT_PRIVATE_KEY);

const q = await agent.viewFunction({ contractId: RAIL, methodName: "quote", args: { merchant, price: toYocto(price), source } });
console.log(`quote: merchant gets ${fromYocto(q.merchant_share)} NEAR, human gets ${fromYocto(q.rebate)} NEAR (${q.commission_bps} bps via "${source}")`);

const outcome = await agent.functionCall({
  contractId: RAIL,
  methodName: "pay",
  args: { merchant, memo, source },
  attachedDeposit: toYocto(price),
  gas: "50000000000000",
});

const sale = events(outcome).find((e) => e.event === "sale")?.data[0];
console.log("paid. receipt:", sale);
console.log(`rebate of ${fromYocto(sale.rebate)} NEAR sent to ${sale.rebate_to} in the same receipt`);
console.log(`verify any time: near view ${RAIL} get_receipt '{"sale_id":${sale.sale_id}}'`);
console.log(`tx: https://${process.env.NEAR_NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${outcome.transaction.hash}`);

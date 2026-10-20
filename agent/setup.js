// One-time setup for a demo.
//
//   node setup.js merchant <name> <commission_bps>            # run as MERCHANT_ACCOUNT
//   node setup.js rate <source> <commission_bps|clear>        # run as MERCHANT_ACCOUNT
//   node setup.js link <agent.near> [identity]                # run as HUMAN (PAYOUT_ACCOUNT); rebates go to the human
import { account, RAIL, toYocto } from "./lib/near.js";

const [cmd, ...rest] = process.argv.slice(2);
const merchantAcct = () => account(process.env.MERCHANT_ACCOUNT, process.env.MERCHANT_PRIVATE_KEY);

if (cmd === "merchant") {
  const [name, bps] = rest;
  const m = await merchantAcct();
  await m.functionCall({ contractId: RAIL, methodName: "register_merchant", args: { name, commission_bps: Number(bps) }, attachedDeposit: toYocto("0.01"), gas: "30000000000000" });
  console.log(`registered ${m.accountId} as "${name}" paying ${bps} bps`);
} else if (cmd === "rate") {
  const [source, bps] = rest;
  const m = await merchantAcct();
  await m.functionCall({ contractId: RAIL, methodName: "set_source_rate", args: { source, commission_bps: bps === "clear" ? null : Number(bps) }, gas: "30000000000000" });
  console.log(`${m.accountId}: source "${source}" → ${bps} bps`);
} else if (cmd === "link") {
  const [agent, identity = ""] = rest;
  const h = await account(process.env.PAYOUT_ACCOUNT, process.env.PAYOUT_PRIVATE_KEY);
  await h.functionCall({ contractId: RAIL, methodName: "link", args: { agent, payout_account: h.accountId, identity }, attachedDeposit: toYocto("0.005"), gas: "30000000000000" });
  console.log(`linked ${agent} → rebates to ${h.accountId}${identity ? ` (${identity})` : ""}`);
} else {
  console.error("usage: node setup.js merchant <name> <bps> | rate <source> <bps|clear> | link <agent> [identity]");
  process.exit(1);
}

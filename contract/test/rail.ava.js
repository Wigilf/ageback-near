import anyTest from "ava";
import { Worker, parseNEAR } from "near-workspaces";

const test = anyTest;
const N = (s) => BigInt(parseNEAR(s));

test.beforeEach(async (t) => {
  const worker = await Worker.init();
  const root = worker.rootAccount;

  const owner = await root.createSubAccount("owner");
  const rail = await root.createSubAccount("rail");
  await rail.deploy("build/ageback.wasm");
  await owner.call(rail, "init", { owner: owner.accountId, protocol_fee_bps: 1000 }); // protocol keeps 10% of commission

  const merchant = await root.createSubAccount("pizzeria");
  const agent = await root.createSubAccount("agent");
  const human = await root.createSubAccount("human");

  await merchant.call(
    rail,
    "register_merchant",
    { name: "Pizzeria Da Michele", commission_bps: 500 },
    { attachedDeposit: N("0.01") }
  );

  t.context = { worker, root, owner, rail, merchant, agent, human };
});

test.afterEach.always(async (t) => {
  await t.context.worker?.tearDown().catch(() => {});
});

test("pay splits at settlement: merchant and human both paid in the same receipt", async (t) => {
  const { rail, merchant, agent, human } = t.context;
  await human.call(
    rail,
    "link",
    { agent: agent.accountId, payout_account: human.accountId, identity: "erc8004:eip155:8453:1234" },
    { attachedDeposit: N("0.005") }
  );

  const mBefore = await merchant.availableBalance();
  const hBefore = await human.availableBalance();
  const price = N("10");
  const receipt = await agent.call(rail, "pay", { merchant: merchant.accountId, memo: "margherita x2" }, { attachedDeposit: price });

  // 5% of 10 = 0.5 commission; protocol keeps 10% of that = 0.05; rebate 0.45
  t.is(receipt.merchant_share, N("9.5").toString());
  t.is(receipt.protocol_fee, N("0.05").toString());
  t.is(receipt.rebate, N("0.45").toString());
  t.is(receipt.rebate_to, human.accountId);
  t.is(receipt.identity, "erc8004:eip155:8453:1234");
  t.is(receipt.memo, "margherita x2");

  t.is((await merchant.availableBalance()) - mBefore, N("9.5"));
  t.is((await human.availableBalance()) - hBefore, N("0.45")); // human didn't sign anything, no gas spent

  const m = await rail.view("get_merchant", { merchant: merchant.accountId });
  t.is(m.sales, 1);
  t.is(m.volume, price.toString());
  const cfg = await rail.view("get_config");
  t.is(cfg.total_rebates, N("0.45").toString());
  t.is(cfg.total_fees, N("0.05").toString());
});

test("unlinked agent gets the rebate back itself", async (t) => {
  const { rail, merchant, agent } = t.context;
  const r = await agent.call(rail, "pay", { merchant: merchant.accountId }, { attachedDeposit: N("2") });
  t.is(r.rebate_to, agent.accountId);
  t.is(r.rebate, N("0.09").toString());
  t.is(r.identity, "");
});

test("attribution: per-source rates and verifiable receipts", async (t) => {
  const { rail, merchant, agent, human } = t.context;
  await human.call(rail, "link", { agent: agent.accountId, payout_account: human.accountId }, { attachedDeposit: N("0.005") });

  await merchant.call(rail, "set_source_rate", { source: "claude-code", commission_bps: 800 });
  t.is(await rail.view("get_rate", { merchant: merchant.accountId, source: "claude-code" }), 800);
  t.is(await rail.view("get_rate", { merchant: merchant.accountId, source: "unknown" }), 500);

  const r1 = await agent.call(rail, "pay", { merchant: merchant.accountId, source: "claude-code" }, { attachedDeposit: N("10") });
  t.is(r1.commission_bps, 800);
  t.is(r1.rebate, N("0.72").toString());
  t.is(r1.source, "claude-code");

  const r2 = await agent.call(rail, "pay", { merchant: merchant.accountId }, { attachedDeposit: N("10") });
  t.is(r2.commission_bps, 500);

  const stored = await rail.view("get_receipt", { sale_id: r1.sale_id });
  t.deepEqual(stored, r1);
  t.true(BigInt(stored.block_timestamp) > 0n);
  t.is(await rail.view("get_receipt", { sale_id: 999 }), null);
  t.is((await rail.view("get_receipts", { from: 1, limit: 10 })).length, 2);

  await merchant.call(rail, "set_source_rate", { source: "claude-code", commission_bps: null });
  t.is(await rail.view("get_rate", { merchant: merchant.accountId, source: "claude-code" }), 500);
  await t.throwsAsync(agent.call(rail, "set_source_rate", { source: "x", commission_bps: 9999 }));
});

test("only the controller or the agent can relink; strangers cannot", async (t) => {
  const { rail, agent, human, root } = t.context;
  await human.call(rail, "link", { agent: agent.accountId, payout_account: human.accountId }, { attachedDeposit: N("0.005") });

  const stranger = await root.createSubAccount("stranger");
  await t.throwsAsync(stranger.call(rail, "link", { agent: agent.accountId, payout_account: stranger.accountId }));

  await human.call(rail, "link", { agent: agent.accountId, payout_account: "treasury.test.near" });
  t.deepEqual(await rail.view("get_link", { agent: agent.accountId }), {
    controller: human.accountId,
    payout_account: "treasury.test.near",
    identity: "",
  });
  // the agent itself may also update its payout, controller is preserved
  await agent.call(rail, "link", { agent: agent.accountId, payout_account: human.accountId, identity: "near:agent" });
  const l = await rail.view("get_link", { agent: agent.accountId });
  t.is(l.controller, human.accountId);
  t.is(l.identity, "near:agent");
});

test("quote matches pay math; inactive merchant rejects; fee withdrawal is owner-only", async (t) => {
  const { rail, merchant, agent, owner } = t.context;
  const q = await rail.view("quote", { merchant: merchant.accountId, price: N("3").toString() });
  t.is(q.rebate, N("0.135").toString());
  await agent.call(rail, "pay", { merchant: merchant.accountId }, { attachedDeposit: N("3") });
  await t.throwsAsync(agent.call(rail, "withdraw_fees", { amount: "1" }));
  await owner.call(rail, "withdraw_fees", { amount: N("0.01").toString() });
  await merchant.call(rail, "update_merchant", { active: false });
  await t.throwsAsync(agent.call(rail, "pay", { merchant: merchant.accountId }, { attachedDeposit: 1n }));
});

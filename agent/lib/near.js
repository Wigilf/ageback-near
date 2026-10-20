import { connect, keyStores, KeyPair, utils } from "near-api-js";
import "dotenv/config";

const NETWORKS = {
  testnet: { networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org" },
  mainnet: { networkId: "mainnet", nodeUrl: "https://rpc.mainnet.near.org" },
};

export const network = NETWORKS[process.env.NEAR_NETWORK ?? "testnet"];
export const RAIL = process.env.RAIL_CONTRACT;
if (!RAIL) throw new Error("RAIL_CONTRACT missing in .env");

/** Connect as `accountId` using a private key from the env (ed25519:... format). */
export async function account(accountId, privateKey) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(network.networkId, accountId, KeyPair.fromString(privateKey));
  const near = await connect({ ...network, keyStore });
  return near.account(accountId);
}

export const toYocto = (near) => utils.format.parseNearAmount(String(near));
export const fromYocto = (y) => utils.format.formatNearAmount(String(y), 4);

/** Pull EVENT_JSON logs out of a transaction outcome. */
export function events(outcome) {
  const logs = [outcome.transaction_outcome, ...outcome.receipts_outcome].flatMap((o) => o.outcome.logs);
  return logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
}

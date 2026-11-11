// One-time testnet setup: fills .env from .env.example, then creates (or completes)
// the server wallet and the agent wallet. Safe to re-run: never overwrites a value
// already in .env and never prints secret keys.
import fs from "node:fs/promises";
import { parse } from "dotenv";
import { Keypair, Horizon, rpc, TransactionBuilder, Operation, Asset, BASE_FEE, StrKey } from "@stellar/stellar-sdk";

const ENV_FILE = ".env";
const TEMPLATE = ".env.example";
const short = (g) => `${g.slice(0, 6)}…${g.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (v) => (/\s|;|#/.test(v) ? `"${v}"` : v);

// ── .env helpers ───────────────────────────────────────────
// Fill KEY only if it is empty. Keeps comments and order intact.
function setIfEmpty(text, env, key, value) {
  if (env[key]) return text;
  env[key] = value;
  const line = new RegExp(`^${key}=.*$`, "m");
  return line.test(text)
    ? text.replace(line, () => `${key}=${quote(value)}`)
    : `${text.trimEnd()}\n${key}=${quote(value)}\n`;
}
const saveEnv = (text) => fs.writeFile(ENV_FILE, text, { mode: 0o600 }); // owner-only

// 1. Bring .env up to date with every setting in .env.example (empty values only).
const templateText = await fs.readFile(TEMPLATE, "utf8");
let text = await fs.readFile(ENV_FILE, "utf8").catch(() => templateText);
const env = parse(text);
for (const [key, value] of Object.entries(parse(templateText))) {
  if (value) text = setIfEmpty(text, env, key, value);
}

// Friendbot only exists on testnet.
if (env.STELLAR_NETWORK !== "stellar:testnet") {
  console.error("This setup script is testnet-only. Set STELLAR_NETWORK=stellar:testnet in .env.");
  process.exit(1);
}

// 2. Create any missing keys and save BEFORE touching the network,
//    so a network hiccup can never lose a freshly generated key.
let serverKp = env.STELLAR_RECIPIENT_SECRET ? Keypair.fromSecret(env.STELLAR_RECIPIENT_SECRET) : null;
if (!env.STELLAR_RECIPIENT) {
  serverKp = Keypair.random();
  text = setIfEmpty(text, env, "STELLAR_RECIPIENT", serverKp.publicKey());
  text = setIfEmpty(text, env, "STELLAR_RECIPIENT_SECRET", serverKp.secret());
}
if (!StrKey.isValidEd25519PublicKey(env.STELLAR_RECIPIENT)) {
  console.error("STELLAR_RECIPIENT in .env is not a valid public key (G...). Fix or clear it, then re-run.");
  process.exit(1);
}
if (!env.STELLAR_SECRET_KEY) text = setIfEmpty(text, env, "STELLAR_SECRET_KEY", Keypair.random().secret());
let agentKp;
try { agentKp = Keypair.fromSecret(env.STELLAR_SECRET_KEY); }
catch {
  console.error("STELLAR_SECRET_KEY in .env is not a valid secret key (S...). Fix or clear it, then re-run.");
  process.exit(1);
}
await saveEnv(text);

// ── Stellar helpers (all endpoints/assets from .env) ───────
const horizon = new Horizon.Server(env.STELLAR_HORIZON_URL);
const rpcServer = new rpc.Server(env.STELLAR_RPC_URL);
const USDC = new Asset(env.USDC_ASSET_CODE, env.USDC_ISSUER);

async function loadAccount(pub) {
  try { return await horizon.loadAccount(pub); }
  catch (e) { if (e?.response?.status === 404) return null; throw e; }
}
async function ensureFunded(pub) {
  if (await loadAccount(pub)) return "already funded";
  await rpcServer.fundAddress(pub); // Friendbot, discovered via the RPC
  for (let i = 0; i < 10; i++) {
    if (await loadAccount(pub)) return "funded by Friendbot";
    await sleep(1000);
  }
  throw new Error(`Friendbot funded ${short(pub)} but Horizon can't see it yet. Run npm run setup again.`);
}
const usdcBalance = (acc) => acc.balances.find((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer);
async function ensureTrustline(kp) {
  const acc = await loadAccount(kp.publicKey());
  if (usdcBalance(acc)) return `${USDC.code} trustline already there`;
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
  return `${USDC.code} trustline added`;
}

// 3. Fund + trustlines
console.log("\nSetting up testnet wallets…\n");
const serverPub = env.STELLAR_RECIPIENT;
const agentPub = agentKp.publicKey();

console.log(`Server wallet  ${short(serverPub)}  (receives payments)`);
console.log(`  ✓ ${await ensureFunded(serverPub)}`);
if (serverKp) {
  console.log(`  ✓ ${await ensureTrustline(serverKp)}`);
} else if (usdcBalance(await loadAccount(serverPub))) {
  console.log(`  ✓ ${USDC.code} trustline already there`);
} else {
  console.log(`  ✗ no ${USDC.code} trustline, and no STELLAR_RECIPIENT_SECRET in .env to add one.`);
  console.log("    → add it in Stellar Lab, or clear STELLAR_RECIPIENT and re-run to create a fresh wallet.");
}

console.log(`\nAgent wallet   ${short(agentPub)}  (pays)`);
console.log(`  ✓ ${await ensureFunded(agentPub)}`);
console.log(`  ✓ ${await ensureTrustline(agentKp)}`);
const usdc = usdcBalance(await loadAccount(agentPub));
console.log(`  ${USDC.code} balance: ${usdc?.balance ?? "0"}  ← the agent's hard spending limit`);

// 4. What's left for the human
const F = (env.FACILITATOR || "").toUpperCase();
console.log("\nNext steps:");
let n = 1;
if (!Number(usdc?.balance)) {
  console.log(`  ${n++}. Give the agent testnet ${USDC.code}: ${env.USDC_FAUCET_URL} → Stellar Testnet → paste:`);
  console.log(`       ${agentPub}`);
}
if (env[`FACILITATOR_${F}_KEY_URL`] && !env[`FACILITATOR_${F}_API_KEY`]) {
  console.log(`  ${n++}. Get a free facilitator key: ${env[`FACILITATOR_${F}_KEY_URL`]}`);
  console.log(`       Paste it into FACILITATOR_${F}_API_KEY in .env (nowhere else).`);
}
console.log(`  ${n++}. Run: npm run check`);
console.log(`\nExplorer: ${env.STELLAR_EXPLORER_URL}/account/${agentPub}\n`);

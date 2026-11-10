// Preflight before a demo: are both wallets and the facilitator ready?
// Prints no secrets. Exits with code 1 if anything needs fixing.
import { Keypair, Horizon, StrKey } from "@stellar/stellar-sdk";
import { config, explorer } from "../src/config.mjs";

const horizon = new Horizon.Server(config.horizonUrl);
const { usdc, facilitator: fac } = config;

let failures = 0;
const short = (g) => `${g.slice(0, 6)}…${g.slice(-4)}`;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m, fix) => { failures++; console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ""}`); };

async function checkWallet(label, pub, { isAgent }) {
  console.log(`\n${label} ${short(pub)}`);
  let acc;
  try { acc = await horizon.loadAccount(pub); ok("exists on the network"); }
  catch (e) {
    return e?.response?.status === 404 ? fail("not found", "run: npm run setup") : fail(`Horizon error: ${e.message}`);
  }
  const bal = acc.balances.find((b) => b.asset_code === usdc.code && b.asset_issuer === usdc.issuer);
  if (!bal) return fail(`no ${usdc.code} trustline`, "run: npm run setup");
  ok(`${usdc.code} trustline`);
  if (!isAgent) return ok(`${usdc.code} received so far: ${bal.balance}`);
  Number(bal.balance) > 0
    ? ok(`${usdc.code} ${bal.balance}  ← hard spending limit`)
    : fail(`${usdc.code} balance is 0`, `${usdc.faucetUrl} → paste ${pub}`);
  console.log(`    ${explorer.account(pub)}`);
}

async function checkFacilitator() {
  console.log(`\nFacilitator (${fac.name}) ${fac.url}`);
  if (fac.keyUrl && !fac.apiKey)
    return fail(`FACILITATOR_${fac.name.toUpperCase()}_API_KEY is empty`, `free key: ${fac.keyUrl}`);
  // The key belongs to this facilitator's own settings, so it only ever goes to its own URL.
  const headers = fac.apiKey ? { Authorization: `Bearer ${fac.apiKey}` } : {};

  let res;
  try { res = await fetch(`${fac.url}/supported`, { headers, signal: AbortSignal.timeout(10_000) }); }
  catch (e) { return fail(`unreachable (${e.message})`, "switch FACILITATOR in .env"); }
  if (res.status === 401 || res.status === 403)
    return fail(`rejected the API key (HTTP ${res.status})`, fac.keyUrl ? `new key: ${fac.keyUrl}` : "check the key");
  if (!res.ok) return fail(`HTTP ${res.status}`, "switch FACILITATOR in .env");

  const { kinds = [] } = await res.json();
  const match = kinds.find((k) => k.network === config.network && k.scheme === "exact" && k.x402Version === 2);
  match
    ? ok(`supports exact on ${config.network}${match.extra?.areFeesSponsored ? " (fees sponsored)" : ""}`)
    : fail(`does not list ${config.network}`, "switch FACILITATOR in .env");
}

// ── Main ───────────────────────────────────────────────────
console.log(`x402 preflight · ${config.network}`);

if (!StrKey.isValidEd25519PublicKey(config.recipient)) {
  fail("STELLAR_RECIPIENT missing or not a public key (G...)", "run: npm run setup");
} else {
  await checkWallet("Server wallet", config.recipient, { isAgent: false });
}

let agentPub;
try { agentPub = Keypair.fromSecret(config.agentSecret).publicKey(); }
catch { fail("STELLAR_SECRET_KEY missing or not a secret key (S...)", "run: npm run setup"); }
if (agentPub) await checkWallet("Agent wallet", agentPub, { isAgent: true });

await checkFacilitator();

console.log(failures ? `\n✗ ${failures} thing(s) to fix before going live.\n` : "\n✓ Ready to demo.\n");
process.exit(failures ? 1 : 0);

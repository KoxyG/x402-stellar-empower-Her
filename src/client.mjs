// The paying client: a stand-in for an agent. It asks for a paid route, gets a 402,
// signs the USDC payment, retries, and prints the data plus the on-chain proof.
// Usage: npm run client              (defaults to /paid/sun-forecast)
//        npm run client /paid/installers
import { Keypair } from "@stellar/stellar-sdk";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { config, explorer } from "./config.mjs";

const url = `${config.apiBaseUrl}${process.argv[2] || "/paid/sun-forecast"}`;

let agentPub;
try { agentPub = Keypair.fromSecret(config.agentSecret).publicKey(); }
catch { console.error("STELLAR_SECRET_KEY missing or invalid. Run: npm run setup"); process.exit(1); }

// The signer takes the raw S... secret and the network id (it derives everything else).
// The RPC URL comes from .env, so x402 never falls back to its built-in default.
const signer = createEd25519Signer(config.agentSecret, config.network);
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: config.network, client: new ExactStellarScheme(signer, { url: config.rpcUrl }) }],
});

console.log(`Agent ${agentPub.slice(0, 6)}… requesting ${url}`);
const started = Date.now();
const res = await paidFetch(url); // 402 → sign → retry happens inside
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (!res.ok) {
  console.error(`\n✗ HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(`\n✓ Paid and received in ${seconds}s:`);
console.log(await res.json());

// Proof of payment: the server passes back the facilitator's settlement result.
const header = res.headers.get("PAYMENT-RESPONSE");
if (header) {
  const settlement = decodePaymentResponseHeader(header);
  console.log(`\nSettlement: ${settlement.success ? "✓ success" : "✗ failed"} on ${settlement.network}`);
  console.log(`Transaction: ${explorer.tx(settlement.transaction)}`);
}

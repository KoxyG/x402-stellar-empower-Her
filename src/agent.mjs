// The agent: runs a task, meets paid APIs along the way, and decides for itself whether to pay.
//   Layer 1: RULES below, checked in code before every payment.
//   Layer 2: the x402 client refuses anything above the amount the agent approved.
//   Layer 3: the wallet itself. It can never spend more USDC than it holds.
// Terminal: npm run agent ["your task"]   ·   The console (step 7) imports runAgent().
import { pathToFileURL } from "node:url";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { config, explorer } from "./config.mjs";

// ── Spending rules ─────────────────────────────────────────
// Set in .env (AGENT_*), so a user can change the agent's limits without touching code.
export const RULES = config.agent;

// ── Setup ──────────────────────────────────────────────────
const { usdc } = config;
const unitsPerUsd = 10n ** BigInt(usdc.decimals);
const toUnits = (usd) => BigInt(Math.round(usd * 10 ** usdc.decimals));   // money math in whole units
const toUsd = (units) => Number(units) / Number(unitsPerUsd);

let agentPub;
try { agentPub = Keypair.fromSecret(config.agentSecret).publicKey(); }
catch { console.error("STELLAR_SECRET_KEY missing or invalid. Run: npm run setup"); process.exit(1); }

const signer = createEd25519Signer(config.agentSecret, config.network);
const horizon = new Horizon.Server(config.horizonUrl);

async function walletUsdc() {
  const acc = await horizon.loadAccount(agentPub);
  const bal = acc.balances.find((b) => b.asset_code === usdc.code && b.asset_issuer === usdc.issuer);
  return Number(bal?.balance ?? 0);
}

// Read the price out of a 402 WITHOUT paying.
function readQuote(res) {
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return null;
  const { resource, accepts } = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const offer = accepts.find((o) => o.network === config.network && o.asset === usdc.contractId);
  return offer && { units: BigInt(offer.amount), priceUsd: toUsd(offer.amount), description: resource.description };
}

// The decision. Returns which rule allowed or blocked the payment, in plain English.
function decide(url, quote, spentUnits) {
  const host = new URL(url).host;
  if (!RULES.allowedHosts.includes(host))
    return { ok: false, rule: "allowlist", reason: `${host} is not on the allowlist` };
  if (quote.units > toUnits(RULES.maxPerRequestUsd))
    return { ok: false, rule: "price cap", reason: `$${quote.priceUsd} is over the $${RULES.maxPerRequestUsd} per-request cap` };
  if (spentUnits + quote.units > toUnits(RULES.taskBudgetUsd))
    return { ok: false, rule: "budget", reason: `would go over the $${RULES.taskBudgetUsd} task budget ($${toUsd(spentUnits)} spent)` };
  return { ok: true, rule: "within limits", reason: `$${quote.priceUsd} is within the cap and the budget` };
}

// A fetch that pays at most the approved amount (Layer 2).
function payingFetch(approvedUnits) {
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: config.network, client: new ExactStellarScheme(signer, { url: config.rpcUrl }) }],
    policies: [(_version, offers) => offers.filter((o) => BigInt(o.amount) <= approvedUnits)],
    spendControls: { maxAmountPerPayment: RULES.maxPerRequestUsd },
  });
}

// ── The agent ──────────────────────────────────────────────
// emit(event) reports every step, so the terminal and the console can show it live.
export async function runAgent(task, emit = () => {}) {
  const payments = [];
  let spentUnits = 0n;
  emit({ type: "start", task, rules: RULES, wallet: agentPub, walletUsdc: await walletUsdc() });

  // Call a service. Free: use it. Paid: read the price, decide, then pay or refuse.
  async function call(why, path) {
    const url = `${config.apiBaseUrl}${path}`;
    emit({ type: "step", why, url });
    const first = await fetch(url);
    if (first.status !== 402) {
      emit({ type: "free", url });
      return first.json();
    }

    const quote = readQuote(first);
    if (!quote) {
      emit({ type: "refused", url, rule: "asset", reason: "no offer in our network and asset" });
      return null;
    }
    emit({ type: "quote", url, priceUsd: quote.priceUsd, description: quote.description });

    const decision = decide(url, quote, spentUnits);
    if (!decision.ok) {
      payments.push({ why, url, priceUsd: quote.priceUsd, paid: false, reason: decision.reason });
      emit({ type: "refused", url, ...decision });
      return null;
    }

    emit({ type: "paying", url, priceUsd: quote.priceUsd, reason: decision.reason });
    try {
      const res = await payingFetch(quote.units)(url);
      const header = res.headers.get("PAYMENT-RESPONSE");
      const settlement = header ? decodePaymentResponseHeader(header) : null;
      if (!res.ok || !settlement?.success) throw new Error(`payment not confirmed (HTTP ${res.status})`);

      spentUnits += quote.units;
      const entry = { why, url, priceUsd: quote.priceUsd, paid: true, tx: settlement.transaction, link: explorer.tx(settlement.transaction) };
      payments.push(entry);
      emit({ type: "paid", ...entry, spentUsd: toUsd(spentUnits) });
      return res.json();
    } catch (e) {
      // The x402 client's own safeguards (Layer 2) blocked it before signing: a refusal, not a failure.
      if (/filtered out by policies|rejected by spendControls/.test(e.message)) {
        payments.push({ why, url, priceUsd: quote.priceUsd, paid: false, reason: "blocked by the x402 client's safeguard" });
        emit({ type: "refused", url, rule: "client safeguard", reason: "price changed or exceeded the client cap; nothing was signed" });
        return null;
      }
      payments.push({ why, url, priceUsd: quote.priceUsd, paid: false, reason: e.message });
      emit({ type: "error", url, message: e.message, hint: "Check the explorer: a settlement can land even when the server reports a failure." });
      return null;
    }
  }

  // The plan. Swap this for an LLM planner later; the pay-or-refuse layer above stays the same.
  await call("Find suppliers (free search)", `/search?q=${encodeURIComponent(task)}`);
  const prices = await call("Get live supplier prices", "/paid/supplier-prices");
  await call("Check Lagos weather for solar conditions", "/paid/weather?city=Lagos");
  await call("Get the full market report (nice to have)", "/paid/premium-report");

  const best = prices?.suppliers.filter((s) => s.inStock).sort((a, b) => a.price - b.price)[0];
  const summary = best
    ? `Cheapest in stock: ${best.name} at ₦${best.price.toLocaleString()} for a ${prices.product}.`
    : "Could not get supplier prices.";
  const translated = await call("Translate the summary into Yoruba", `/paid/translate?to=yo&text=${encodeURIComponent(summary)}`);

  const result = {
    summary,
    translation: translated?.translation ?? null,
    spentUsd: toUsd(spentUnits),
    budgetUsd: RULES.taskBudgetUsd,
    payments,
    walletUsdc: await walletUsdc(),
  };
  emit({ type: "done", ...result });
  return result;
}

// ── Terminal output ────────────────────────────────────────
function print(e) {
  const line = {
    start:   () => `\nTask: ${e.task}\nRules: budget $${e.rules.taskBudgetUsd} · max $${e.rules.maxPerRequestUsd}/request · allowed: ${e.rules.allowedHosts.join(", ")}\nWallet: ${e.wallet.slice(0, 6)}… holds ${e.walletUsdc} ${usdc.code} (hard limit)\n`,
    step:    () => `→ ${e.why}`,
    free:    () => `   free, no payment needed`,
    quote:   () => `   402: costs $${e.priceUsd}`,
    paying:  () => `   ✓ decision: pay (${e.reason}) … settling on Stellar`,
    paid:    () => `   ✓ paid · total spent $${e.spentUsd} · ${e.link}`,
    refused: () => `   ✗ decision: refuse (${e.rule}: ${e.reason})`,
    error:   () => `   ✗ ${e.message}\n     ${e.hint}`,
    done:    () => `\nResult: ${e.summary}\nYoruba: ${e.translation ?? "(skipped)"}\nSpent $${e.spentUsd} of $${e.budgetUsd} budget · ${e.payments.filter((p) => p.paid).length} paid, ${e.payments.filter((p) => !p.paid).length} refused/failed\nWallet now holds ${e.walletUsdc} ${usdc.code}\n`,
  }[e.type];
  if (line) console.log(line());
}

// Run directly from the terminal (not when imported by the console).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const task = process.argv.slice(2).join(" ") || "Compare solar inverter prices in Lagos";
  await runAgent(task, print);
}

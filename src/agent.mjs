// The agent = a brain (planner) + a wallet (x402 + spending rules).
//   Brain: AGENT_PLANNER=ai lets an AI model decide what to do; "scripted" runs a fixed plan.
//   Wallet: every paid call goes through the rules below. The AI can ASK to buy; it can't bypass them.
//     Layer 1: RULES (.env AGENT_*), checked in code before every payment.
//     Layer 2: the x402 client refuses anything above the amount the agent approved.
//     Layer 3: the wallet itself. It can never spend more USDC than it holds.
// Terminal: npm run agent ["your task"]   ·   The console imports runAgent().
import fs from "node:fs";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { config, explorer } from "./config.mjs";
import { runAiPlan } from "./planner-ai.mjs";

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

// ── Daily spend log: survives between runs, so the daily budget holds ──
const today = () => new Date().toISOString().slice(0, 10); // UTC date
function readSpendLog() {
  try { return JSON.parse(fs.readFileSync(RULES.spendLogFile, "utf8")); } catch { return []; }
}
const spentTodayUnits = () =>
  readSpendLog().filter((e) => e.date === today()).reduce((sum, e) => sum + BigInt(e.units), 0n);
export const spentTodayUsd = () => toUsd(spentTodayUnits());
function appendSpendLog(entry) {
  fs.writeFileSync(RULES.spendLogFile, JSON.stringify([...readSpendLog(), entry], null, 2));
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
function decide(url, quote, spentUnits, todayUnits) {
  const host = new URL(url).host;
  if (!RULES.allowedHosts.includes(host))
    return { ok: false, rule: "allowlist", reason: `${host} is not on the allowlist` };
  if (quote.units > toUnits(RULES.maxPerRequestUsd))
    return { ok: false, rule: "price cap", reason: `$${quote.priceUsd} is over the $${RULES.maxPerRequestUsd} per-request cap` };
  if (spentUnits + quote.units > toUnits(RULES.taskBudgetUsd))
    return { ok: false, rule: "budget", reason: `would go over the $${RULES.taskBudgetUsd} task budget ($${toUsd(spentUnits)} spent)` };
  if (todayUnits + quote.units > toUnits(RULES.dailyBudgetUsd))
    return { ok: false, rule: "daily budget", reason: `would go over today's $${RULES.dailyBudgetUsd} limit ($${toUsd(todayUnits)} spent today)` };
  // Within every limit, but big enough that a human should say yes first.
  if (quote.units > toUnits(RULES.approveAboveUsd))
    return { ok: "ask", rule: "needs approval", reason: `$${quote.priceUsd} is above the $${RULES.approveAboveUsd} approval threshold` };
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

// ── The wallet: every call, free or paid, goes through here ─
function createWallet(emit, approve) {
  const payments = [];
  let spentUnits = 0n;

  // Free: use it. Paid: read the price, decide, then pay or refuse.
  // Returns { ok: true, data } or { ok: false, reason }.
  async function call(why, path) {
    const url = `${config.apiBaseUrl}${path}`;
    emit({ type: "step", why, url });
    const first = await fetch(url);
    if (first.status !== 402) {
      if (!first.ok) {
        emit({ type: "error", url, message: `HTTP ${first.status}`, hint: "The service returned an error." });
        return { ok: false, reason: `service error (HTTP ${first.status})` };
      }
      emit({ type: "free", url });
      return { ok: true, data: await first.json() };
    }

    const quote = readQuote(first);
    if (!quote) {
      emit({ type: "refused", url, rule: "asset", reason: "no offer in our network and asset" });
      return { ok: false, reason: "no offer in our network and asset" };
    }
    emit({ type: "quote", url, priceUsd: quote.priceUsd, description: quote.description });

    const decision = decide(url, quote, spentUnits, spentTodayUnits());
    if (!decision.ok) {
      payments.push({ why, url, priceUsd: quote.priceUsd, paid: false, reason: decision.reason });
      emit({ type: "refused", url, ...decision });
      return { ok: false, reason: `${decision.rule}: ${decision.reason}` };
    }

    if (decision.ok === "ask") {
      emit({ type: "approval", url, why, priceUsd: quote.priceUsd, reason: decision.reason });
      // approve() returns true, false (declined) or "timeout" (nobody answered in time).
      const answer = await approve({ url, why, priceUsd: quote.priceUsd });
      if (answer !== true) {
        const reason = answer === "timeout" ? "no answer in time, so declined" : "declined by you";
        payments.push({ why, url, priceUsd: quote.priceUsd, paid: false, reason });
        emit({ type: "refused", url, rule: "human", reason });
        return { ok: false, reason: "the wallet owner declined this purchase" };
      }
    }

    emit({ type: "paying", url, priceUsd: quote.priceUsd, reason: decision.ok === "ask" ? "approved by you" : decision.reason });
    try {
      const res = await payingFetch(quote.units)(url);
      const header = res.headers.get("PAYMENT-RESPONSE");
      const settlement = header ? decodePaymentResponseHeader(header) : null;
      if (!res.ok || !settlement?.success) throw new Error(`payment not confirmed (HTTP ${res.status})`);

      spentUnits += quote.units;
      appendSpendLog({ date: today(), at: new Date().toISOString(), why, url,
                       units: String(quote.units), priceUsd: quote.priceUsd, tx: settlement.transaction });
      const entry = { why, url, priceUsd: quote.priceUsd, paid: true, tx: settlement.transaction, link: explorer.tx(settlement.transaction) };
      payments.push(entry);
      emit({ type: "paid", ...entry, spentUsd: toUsd(spentUnits) });
      return { ok: true, data: await res.json() };
    } catch (e) {
      // The x402 client's own safeguards (Layer 2) blocked it before signing: a refusal, not a failure.
      if (/filtered out by policies|rejected by spendControls/.test(e.message)) {
        payments.push({ why, url, priceUsd: quote.priceUsd, paid: false, reason: "blocked by the x402 client's safeguard" });
        emit({ type: "refused", url, rule: "client safeguard", reason: "price changed or exceeded the client cap; nothing was signed" });
        return { ok: false, reason: "blocked by the x402 client's safeguard" };
      }
      payments.push({ why, url, priceUsd: quote.priceUsd, paid: false, reason: e.message });
      emit({ type: "error", url, message: e.message, hint: "Check the explorer: a settlement can land even when the server reports a failure." });
      return { ok: false, reason: e.message };
    }
  }

  return { call, payments, spentUsd: () => toUsd(spentUnits) };
}

// ── The fixed plan (fallback when AGENT_PLANNER=scripted) ──
async function scriptedPlan(task, wallet) {
  await wallet.call("Find suppliers (free search)", `/search?q=${encodeURIComponent(task)}`);
  const prices = await wallet.call("Get live supplier prices", "/paid/supplier-prices");
  await wallet.call("Check today's solar conditions", "/paid/sun-forecast");
  await wallet.call("Get the full market report (nice to have)", "/paid/market-report");
  const installers = await wallet.call("Find a certified installer", "/paid/installers");

  const best = prices.ok ? prices.data.suppliers.filter((s) => s.inStock).sort((a, b) => a.price - b.price)[0] : null;
  const top = installers.ok ? [...installers.data.installers].sort((a, b) => b.rating - a.rating)[0] : null;
  return [
    best ? `Cheapest in stock: ${best.name} at $${best.price} for a ${prices.data.product}.` : "Could not get supplier prices.",
    top ? `Top-rated installer: ${top.name} (${top.rating}★, available ${top.nextAvailable}, from $${top.priceFromUsd}).` : "",
  ].join(" ").trim();
}

// ── The agent ──────────────────────────────────────────────
// emit(event) reports every step, so the terminal and the console can show it live.
// approve({ url, why, priceUsd }) → true/false. Defaults to "no": nothing big is paid without a human.
// planner: "ai" or "scripted" for this run; defaults to AGENT_PLANNER in .env.
export async function runAgent(task, emit = () => {}, { approve = async () => false, planner = config.ai.planner } = {}) {
  if (planner === "ai" && !(config.ai.apiKey && config.ai.model))
    throw new Error("AI brain needs OPENAI_API_KEY and OPENAI_MODEL in .env");
  const wallet = createWallet(emit, approve);
  emit({
    type: "start", task, planner, model: planner === "ai" ? config.ai.model : null,
    todayUsd: spentTodayUsd(), rules: RULES, wallet: agentPub, walletUsdc: await walletUsdc(),
  });

  const answer = planner === "ai"
    ? await runAiPlan(task, { wallet, emit })
    : await scriptedPlan(task, wallet);

  const result = {
    summary: answer,
    spentUsd: wallet.spentUsd(),
    budgetUsd: RULES.taskBudgetUsd,
    payments: wallet.payments,
    walletUsdc: await walletUsdc(),
  };
  emit({ type: "done", ...result });
  return result;
}

// ── Terminal output ────────────────────────────────────────
// Terminal approval: asks y/N. Declines if there's no terminal to ask.
async function askInTerminal({ why, priceUsd }) {
  if (!process.stdin.isTTY) { console.log("   (no terminal to ask, so declined)"); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // If input closes before an answer (Ctrl+D, piped input), treat it as "no" instead of hanging.
  const closed = new Promise((resolve) => rl.once("close", () => resolve("")));
  const answer = await Promise.race([rl.question(`   ? Approve paying $${priceUsd} for "${why}"? [y/N] `), closed]);
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

function print(e) {
  const line = {
    start:   () => `\nTask: ${e.task}\nMode: ${e.planner === "ai" ? `AI agent (OpenAI ${e.model})` : "scripted client (no AI)"}\nRules: budget $${e.rules.taskBudgetUsd} · max $${e.rules.maxPerRequestUsd}/request · allowed: ${e.rules.allowedHosts.join(", ")}\nWallet: ${e.wallet.slice(0, 6)}… holds ${e.walletUsdc} ${usdc.code} (hard limit)\n`,
    thought: () => `  AI: ${e.text}`,
    step:    () => `→ ${e.why}`,
    free:    () => `   free, no payment needed`,
    quote:   () => `   402: costs $${e.priceUsd}`,
    paying:  () => `   ✓ decision: pay (${e.reason}) … settling on Stellar`,
    paid:    () => `   ✓ paid · total spent $${e.spentUsd} · ${e.link}`,
    approval: () => `   ⏸ needs your approval (${e.reason})`,
    refused: () => `   ✗ decision: refuse (${e.rule}: ${e.reason})`,
    error:   () => `   ✗ ${e.message}\n     ${e.hint}`,
    done:    () => `\nAnswer: ${e.summary}\nSpent $${e.spentUsd} of $${e.budgetUsd} budget · ${e.payments.filter((p) => p.paid).length} paid, ${e.payments.filter((p) => !p.paid).length} refused/failed\nWallet now holds ${e.walletUsdc} ${usdc.code}\n`,
  }[e.type];
  if (line) console.log(line());
}

// Run directly from the terminal (not when imported by the console).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const task = process.argv.slice(2).join(" ") || "Find me the cheapest 5kVA solar inverter and someone to install it";
  await runAgent(task, print, { approve: askInTerminal });
}

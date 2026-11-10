// The paid API (the "resource server" in the four boxes).
// Every route in PAID_ROUTES costs USDC per request; everything else is free.
// This server never touches the blockchain: the facilitator verifies and settles each payment on Stellar.
import express from "express";
import { StrKey } from "@stellar/stellar-sdk";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { config } from "./config.mjs";

const { network, usdc, facilitator: fac } = config;

// ── Prices ─────────────────────────────────────────────────
// Prices are product decisions, so they live here. Asset and decimals come from .env.
// usd(0.001) → { amount: "10000", asset: "C..." }  (USDC has 7 decimals on Stellar)
const usd = (dollars) => ({
  amount: String(Math.round(dollars * 10 ** usdc.decimals)),
  asset: usdc.contractId,
});

const PAID_ROUTES = {
  "GET /weather":         { price: 0.001, description: "Current weather for a city" },
  "GET /supplier-prices": { price: 0.01,  description: "Solar inverter prices from Lagos suppliers" },
  "GET /translate":       { price: 0.002, description: "Translate a short text" },
  "GET /premium-report":  { price: 0.5,   description: "Full market report (priced high to test the agent's limits)" },
};

const routesConfig = Object.fromEntries(
  Object.entries(PAID_ROUTES).map(([route, { price, description }]) => [
    route,
    {
      accepts: { scheme: "exact", price: usd(price), network, payTo: config.recipient },
      description,
      mimeType: "application/json",
    },
  ]),
);

// ── Facilitator ────────────────────────────────────────────
// The key (if any) belongs to the active facilitator's own settings, so it only goes to that URL.
const facilitatorClient = new HTTPFacilitatorClient({
  url: fac.url,
  ...(fac.apiKey && {
    createAuthHeaders: async () => {
      const h = { Authorization: `Bearer ${fac.apiKey}` };
      return { verify: h, settle: h, supported: h };
    },
  }),
});

// ── App ────────────────────────────────────────────────────
const app = express();

// Plain-English request log for the stream: 402 = "asked to pay", 200 = "paid and served".
app.use("/paid", (req, res, next) => {
  res.on("finish", () => {
    const label = { 402: "402 → payment required", 200: "200 → paid, data sent" }[res.statusCode] ?? res.statusCode;
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${req.originalUrl}  ${label}`);
  });
  next();
});

// Fail closed: if the recipient is missing or invalid, paid routes return 503,
// never their data for free.
if (StrKey.isValidEd25519PublicKey(config.recipient)) {
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(network, new ExactStellarScheme())
    // Say WHY a payment failed, so a failed demo is diagnosable on the spot.
    .onVerifyFailure(async ({ error }) => console.warn(`  ✗ verify failed: ${error.message}`))
    .onSettleFailure(async ({ error }) => console.warn(`  ✗ settle failed: ${error.message}  (the payment may still land on-chain: check the explorer)`));
  app.use("/paid", paymentMiddleware(routesConfig, resourceServer));
} else {
  console.warn("⚠ STELLAR_RECIPIENT missing or invalid: paid routes return 503. Run: npm run setup");
  app.use("/paid", (_req, res) => res.status(503).json({ error: "Payments not configured on this server." }));
}

// ── Paid routes (demo data) ────────────────────────────────
app.get("/paid/weather", (req, res) => {
  res.json({ city: req.query.city || "Lagos", tempC: 31, condition: "Partly cloudy", demo: true });
});

app.get("/paid/supplier-prices", (_req, res) => {
  res.json({
    product: "5kVA hybrid solar inverter",
    currency: "NGN",
    suppliers: [
      { name: "Supplier A (Ikeja)",  price: 455000, inStock: true },
      { name: "Supplier B (Lekki)",  price: 412000, inStock: true },
      { name: "Supplier C (Yaba)",   price: 438500, inStock: false },
    ],
    demo: true,
  });
});

app.get("/paid/translate", (req, res) => {
  const text = String(req.query.text || "").slice(0, 200);
  res.json({ text, to: req.query.to || "yo", translation: `[demo translation] ${text}`, demo: true });
});

app.get("/paid/premium-report", (_req, res) => {
  res.json({ title: "Lagos Solar Market Report", pages: 42, summary: "…", demo: true });
});

// ── Free routes ────────────────────────────────────────────
// What's on sale and for how much, so the agent and the console can show it.
app.get("/catalog", (_req, res) => {
  res.json({
    network,
    asset: usdc.code,
    routes: Object.entries(PAID_ROUTES).map(([route, { price, description }]) => {
      const [method, path] = route.split(" ");
      return { method, path: `/paid${path}`, priceUsd: price, description };
    }),
  });
});

// A free step for the agent: finding suppliers costs nothing, detailed prices do.
app.get("/search", (req, res) => {
  res.json({ query: req.query.q || "", results: ["Supplier A (Ikeja)", "Supplier B (Lekki)", "Supplier C (Yaba)"], demo: true });
});

app.listen(config.port, () => {
  console.log(`\nPaid API on http://localhost:${config.port}  ·  ${network}  ·  facilitator: ${fac.name}`);
  console.log(`Try:  curl -i http://localhost:${config.port}/paid/weather   (expect 402)\n`);
});

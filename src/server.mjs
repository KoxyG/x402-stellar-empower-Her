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
  "GET /sun-forecast":    { price: 0.001, description: "Today's solar conditions: sun hours, cloud cover, rain chance" },
  "GET /installers":      { price: 0.002, description: "Certified solar installers with ratings and availability" },
  "GET /supplier-prices": { price: 0.01,  description: "Current 5kVA solar inverter prices from suppliers" },
  "GET /market-report":   { price: 0.5,   description: "Full residential solar market report (priced high to test the agent's limits)" },
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

// ── Paid routes (demo data: fixed sample values, marked demo: true) ──
const where = (req) => String(req.query.location || "your area").slice(0, 80);

app.get("/paid/sun-forecast", (req, res) => {
  res.json({ location: where(req), sunHours: 6.5, cloudCover: "25%", rainChance: "10%",
             verdict: "Good conditions for solar output and rooftop installation", demo: true });
});

app.get("/paid/installers", (req, res) => {
  res.json({
    location: where(req),
    installers: [
      { name: "Apex Solar Installs",  rating: 4.8, nextAvailable: "in 2 days", priceFromUsd: 250 },
      { name: "GreenRoof Energy",     rating: 4.5, nextAvailable: "tomorrow",  priceFromUsd: 220 },
      { name: "PowerUp Technicians",  rating: 4.2, nextAvailable: "in 5 days", priceFromUsd: 180 },
    ],
    demo: true,
  });
});

app.get("/paid/supplier-prices", (_req, res) => {
  res.json({
    product: "5kVA hybrid solar inverter",
    currency: "USD",
    suppliers: [
      { name: "SunVolt Supply", price: 780, inStock: true },
      { name: "BrightGrid",     price: 705, inStock: true },
      { name: "Helios Depot",   price: 745, inStock: false },
    ],
    demo: true,
  });
});

app.get("/paid/market-report", (_req, res) => {
  res.json({ title: "Residential Solar Market Report", pages: 42, summary: "…", demo: true });
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
  res.json({ query: req.query.q || "", results: ["SunVolt Supply", "BrightGrid", "Helios Depot"], demo: true });
});

app.listen(config.port, () => {
  console.log(`\nPaid API on http://localhost:${config.port}  ·  ${network}  ·  facilitator: ${fac.name}`);
  console.log(`Try:  npm run peek   (shows the 402 for /paid/sun-forecast)\n`);
});

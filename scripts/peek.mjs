// Shows what a 402 looks like, in plain English. Makes NO payment.
// Usage: npm run peek                 (defaults to /paid/sun-forecast)
//        npm run peek /paid/market-report
import { config } from "../src/config.mjs";

const url = `${config.apiBaseUrl}${process.argv[2] || "/paid/sun-forecast"}`;
const res = await fetch(url);
console.log(`\n${res.status} ${res.statusText}  ←  GET ${url}`);

const header = res.headers.get("PAYMENT-REQUIRED");
if (!header) {
  console.log("No payment required for this route.\n");
  process.exit(0);
}

// x402 v2 sends the payment requirements as base64 JSON in this header.
const { resource, accepts } = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
for (const offer of accepts) {
  const price = Number(offer.amount) / 10 ** config.usdc.decimals;
  console.log(`
  What:            ${resource.description}
  Price:           ${price} ${config.usdc.code}   (${offer.amount} base units)
  Network:         ${offer.network}
  Pay to:          ${offer.payTo}
  Asset contract:  ${offer.asset}
  Offer valid for: ${offer.maxTimeoutSeconds}s
  Fees sponsored:  ${offer.extra?.areFeesSponsored ? "yes, the payer needs no XLM" : "no"}
`);
}

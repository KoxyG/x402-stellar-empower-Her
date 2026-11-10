// The single source of configuration. Every value comes from .env.
// Nothing network-specific is hard-coded and there are no silent defaults:
// if something is missing, we stop and say exactly what.
import "dotenv/config";

const missing = [];
const required = (key) => {
  const value = process.env[key]?.trim();
  if (!value) missing.push(key);
  return value;
};
const optional = (key) => process.env[key]?.trim() || "";
const positiveNumber = (key) => {
  const value = Number(required(key));
  if (process.env[key] && !(value > 0)) missing.push(`${key} (must be a positive number)`);
  return value;
};

const active = required("FACILITATOR");
if (active && !["primary", "backup"].includes(active)) missing.push('FACILITATOR (must be "primary" or "backup")');
const F = active?.toUpperCase();

export const config = Object.freeze({
  network: required("STELLAR_NETWORK"),
  networkPassphrase: required("STELLAR_NETWORK_PASSPHRASE"),
  horizonUrl: required("STELLAR_HORIZON_URL"),
  rpcUrl: required("STELLAR_RPC_URL"),
  explorerUrl: required("STELLAR_EXPLORER_URL"),
  usdc: Object.freeze({
    code: required("USDC_ASSET_CODE"),
    issuer: required("USDC_ISSUER"),
    contractId: required("USDC_CONTRACT_ID"),
    decimals: Number(required("USDC_DECIMALS")),
    faucetUrl: required("USDC_FAUCET_URL"),
  }),
  // Each facilitator has its own URL + key, so a key is only ever sent to its own facilitator.
  facilitator: Object.freeze({
    name: active,
    url: F ? required(`FACILITATOR_${F}_URL`)?.replace(/\/+$/, "") : undefined,
    apiKey: F ? optional(`FACILITATOR_${F}_API_KEY`) : "",
    keyUrl: F ? optional(`FACILITATOR_${F}_KEY_URL`) : "",
  }),
  // Wallets are checked by the scripts that need them, with friendlier messages.
  recipient: optional("STELLAR_RECIPIENT"),
  agentSecret: optional("STELLAR_SECRET_KEY"),
  port: Number(required("PORT")),
  apiBaseUrl: required("API_BASE_URL")?.replace(/\/+$/, ""),
  consolePort: Number(required("CONSOLE_PORT")),
  agent: Object.freeze({
    taskBudgetUsd: positiveNumber("AGENT_TASK_BUDGET_USD"),
    maxPerRequestUsd: positiveNumber("AGENT_MAX_PER_REQUEST_USD"),
    allowedHosts: (required("AGENT_ALLOWED_HOSTS") || "").split(",").map((h) => h.trim()).filter(Boolean),
  }),
});

if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  console.error("→ Run npm run setup to fill them in from .env.example.");
  process.exit(1);
}

export const explorer = {
  account: (g) => `${config.explorerUrl}/account/${g}`,
  tx: (hash) => `${config.explorerUrl}/tx/${hash}`,
};

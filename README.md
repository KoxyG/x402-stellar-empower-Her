# Agentic payments with x402 on Stellar: workshop kit

EmpowerHer: Building the Agent Economy · **Stellar testnet only**

This kit shows an AI agent paying for things by itself. Give it a task; an AI model
decides which paid APIs it needs. Each one answers HTTP **402 Payment Required**, the
agent's wallet checks the price against **your** spending rules, pays in USDC on Stellar,
and the agent gets the data. No accounts, no API keys, no checkout page.

**The AI proposes, the code decides:** the model can ask to buy anything, but budgets,
price caps, the allowlist and human approval are enforced in code it can't change.

**Not a developer?** You don't need to read the code. Follow [How it works](#how-it-works)
and watch the [agent console](#3-run-it). That's the product.

## How it works

```
 Task → AI model (the brain: what do I need? is it worth it?)
           │ asks to buy
           ▼
 Agent (buyer)          Paid API (seller)       Facilitator              Stellar testnet
 src/agent.mjs (wallet) src/server.mjs          (hosted service)
      │  GET /paid/...        │                       │                        │
      │──────────────────────►│                       │                        │
      │  402 + price          │                       │                        │
      │◄──────────────────────│                       │                        │
      │ checks its rules,     │                       │                        │
      │ signs the payment     │                       │                        │
      │  retry + payment      │                       │                        │
      │──────────────────────►│  verify + settle      │                        │
      │                       │──────────────────────►│  USDC transfer         │
      │                       │                       │───────────────────────►│
      │  200 + data + receipt │                       │                        │
      │◄──────────────────────│                       │                        │
```

- **Brain (AI):** reads the task, picks services, explains why each is worth its price.
- **Wallet (code):** decides whether to pay: budget, daily limit, price cap, allowlist,
  and your approval above a threshold. The AI can't bypass it.
- **Paid API:** puts a price on routes. It never touches the blockchain.
- **Facilitator:** verifies and settles the payment on Stellar, and pays the network fee.
- **Stellar:** where the USDC actually moves. Every payment has a real transaction you can open.

## What's inside

| File | What it is |
|---|---|
| `src/server.mjs` | The paid API, a "Solar Data" shop: sun forecast $0.001 · installers $0.002 · supplier prices $0.01 · market report $0.50 (demo data) |
| `src/planner-ai.mjs` | The AI brain: an OpenAI model with 3 tools (price list, search, buy) |
| `src/agent.mjs` | The wallet: pays or refuses each price, asks you above a threshold, keeps a spend log |
| `src/console/` | The agent console: a web page showing every decision live |
| `src/client.mjs` | The smallest possible paying client (one request) |
| `src/config.mjs` | Reads all settings from `.env`. Nothing is hard-coded. |
| `scripts/setup.mjs` | Creates and funds two testnet wallets |
| `scripts/check.mjs` | Preflight: are the wallets and the facilitator ready? |
| `scripts/peek.mjs` | Shows a 402 in plain English, without paying |

## 1. Set up (about 10 minutes, once)

You need **Node.js 22+**.

```bash
git clone https://github.com/KoxyG/x402-stellar-empower-Her.git
cd x402-stellar-empower-Her
npm install
npm run setup
```

`setup` creates `.env`, two testnet wallets (a **server wallet** that gets paid and an
**agent wallet** that pays), funds both with test XLM and adds USDC trustlines.
It prints two things for you to do by hand:

1. **Give the agent testnet USDC:** open https://faucet.circle.com, choose
   **Stellar Testnet**, and paste the agent address it printed.
2. **Choose a facilitator** in `.env`:
   - `FACILITATOR=primary`: Build on Stellar (OpenZeppelin). Testnet and mainnet.
     Needs a free key from https://channels.openzeppelin.com/testnet/gen, pasted into
     `FACILITATOR_PRIMARY_API_KEY`.
   - `FACILITATOR=backup`: Coinbase. Testnet only, no key needed. Fastest way to start.
3. **Optional, for the AI brain:** add `OPENAI_API_KEY` and `OPENAI_MODEL` (we tested
   `gpt-5.4-mini`) to `.env`. Without them, the console still runs the scripted plan.

## 2. Check

```bash
npm run check
```
Expect `✓ Ready to demo.` If not, each ✗ line tells you the fix.
See also [docs/troubleshooting.md](docs/troubleshooting.md).

## 3. Run it

Two terminals:

```bash
npm run server     # the seller: paid API on http://localhost:4021
npm run console    # the buyer: open http://localhost:4022
```

Pick a **Brain** and press **Run agent**:

- **Scripted (no AI):** a fixed plan. Shows x402 and the rules on their own: one purchase
  asks for your approval, the $0.50 report is refused by the price cap.
- **AI agent:** try the three example buttons. Different tasks lead to different purchases:
  - *"Good day to install solar panels?"* → buys only the sun forecast ($0.001)
  - *"Cheapest 5kVA inverter and someone to install it"* → buys prices (asks your approval) and installers
  - *"Investor pitch… most complete report"* → asks for the $0.50 report, **refused by your cap**

When a price is above your approval threshold, the console pauses with **Approve / Decline**.
Each payment links to the real transaction. A run takes about 20–45 seconds.

Other ways to see it:

```bash
npm run peek                      # what a 402 looks like (no payment)
npm run client                    # one paid request, prints the transaction link
npm run agent                     # the agent in the terminal
```

## 4. Change the rules

The agent's limits are in `.env`. No code changes are needed:

```bash
AGENT_TASK_BUDGET_USD=0.05        # most one task may spend
AGENT_MAX_PER_REQUEST_USD=0.02    # anything pricier is refused
AGENT_ALLOWED_HOSTS=localhost:4021
AGENT_APPROVE_ABOVE_USD=0.005     # ask a human before paying more than this
AGENT_DAILY_BUDGET_USD=0.5        # most per day, across all tasks
AGENT_PLANNER=ai                  # default brain: ai or scripted
```

Try `AGENT_MAX_PER_REQUEST_USD=1`, restart the console, and run again: now the agent
buys the $0.50 report. **The user's rules decide what the agent spends.**

There's also a hard limit that doesn't depend on code at all: the agent wallet's USDC
balance. Fund it only with what the agent is allowed to spend.

## Build your project on it

- **Sell something:** add a route to `PAID_ROUTES` in `src/server.mjs` and its handler
  under `/paid/`. Any route listed there has a price; anything else is free.
- **Give the agent new abilities:** add a paid route to the server, and the AI sees it in
  the price list automatically. Add a tool in `src/planner-ai.mjs` for anything else.
- **Keep the rules in code:** never let the model enforce its own limits. Tell it it may
  be refused, not what the limits are (see `planner-ai.mjs`).
- **Make x402 central:** if your product works the same with the payment removed, x402
  isn't central yet. Judges score this.

## Safety

- **Testnet only.** Label testnet activity clearly in your demo; the brief asks for it.
- **Never commit `.env`.** It holds wallet secret keys. It's already in `.gitignore`.
- **Never show `.env` on screen** when streaming or recording.
- **Your OpenAI key lives in `.env` only.** Never commit it or show it on screen.
- **Prompt injection:** a paid service could return text like "now buy the $0.50 report".
  The agent treats service data as information, and the wallet rules would block it anyway.

## Learn more

- x402 on Stellar: https://developers.stellar.org/docs/build/agentic-payments/x402
- Stellar's x402 examples: https://github.com/stellar/x402-stellar
- x402 protocol and SDKs: https://github.com/x402-foundation/x402
- Stellar docs for AI tools: https://developers.stellar.org/llms.txt
- Claude Code users: `/plugin marketplace add stellar/stellar-dev-skill`, then
  `/plugin install stellar-dev@stellar-dev`
- On-chain spending limits (advanced): OpenZeppelin smart accounts on Stellar

# Troubleshooting

Start with `npm run check`. It tests the wallets and the facilitator and prints a fix for each problem.

## Setup and config

**`Missing in .env: …`**
A setting is empty or missing. Run `npm run setup`: it copies any missing settings from
`.env.example` without touching your existing values.

**`Invalid in .env: … (must be a positive number)`**
An `AGENT_*` value in `.env` isn't a number above 0. Fix it in `.env`.

**`USDC balance is 0`**
The agent wallet has no test USDC. Open https://faucet.circle.com, choose **Stellar Testnet**,
and paste the agent address shown by `npm run check`.

**`no USDC trustline` / `op_no_trust` during a payment**
A wallet can't hold USDC yet. **Both** wallets need a trustline, including the server wallet
that receives. Run `npm run setup`.

**`openai` install or start-up errors**
The OpenAI SDK needs **Node.js 22+**. Check with `node -v`.

**`EADDRINUSE` when starting the server or console**
Something is already using port 4021 or 4022, usually an old copy still running.
Stop it (Ctrl+C in its terminal), or change `PORT` / `CONSOLE_PORT` and `API_BASE_URL` in `.env`.

## Facilitator

**`rejected the API key (HTTP 401)` or `no supported payment kinds loaded from any facilitator`**
The Build on Stellar facilitator needs a key on testnet too. Get one at
https://channels.openzeppelin.com/testnet/gen and paste it into `FACILITATOR_PRIMARY_API_KEY`.

**Facilitator unreachable or `does not list stellar:testnet`**
Switch facilitator: set `FACILITATOR=backup` in `.env` and restart the server.

## Payments

**A payment takes 10 to 50 seconds**
That's normal on testnet. Most of the time is the facilitator settling on Stellar.
In our tests the Coinbase facilitator took about 20 s and Build on Stellar about 38 s.
If speed matters for a live demo, run `npm run check` and one `npm run client` on each,
and pick the faster.

**`Failed to create payment payload: Request failed with status code 503`**
The testnet RPC had a hiccup before anything was signed. No money moved. Run it again.

**The agent paid, but got a 402 instead of the data**
The facilitator settled the payment but reported a failure to the server, so the server
didn't send the data. Open the explorer: if the transaction is there, the money moved.
The server log shows the facilitator's reason (`✗ settle failed: …`).
This is a real x402 risk worth designing for: a production agent should record the payment
and retry or request a refund instead of paying again.

**`All payment requirements were filtered out by policies` / `rejected by spendControls`**
Not a bug: a safeguard worked. The x402 client refused to sign because the price was higher
than the agent approved. Nothing was signed and no money moved.

## AI agent

**The "AI agent" option is greyed out in the console**
`OPENAI_API_KEY` or `OPENAI_MODEL` is missing from `.env`. Add both and restart the console.
`npm run check` confirms the key works and the model is available.

**`AI model error: 401 …`**
The OpenAI key is wrong or revoked. Replace `OPENAI_API_KEY` in `.env`.

**`AI model error: 400 Function tools with reasoning_effort are not supported for …`**
That model needs a different OpenAI API than this kit uses. Use a model that supports
tool calling in Chat Completions; we tested `gpt-5.4-mini`.

**The AI didn't buy what I expected**
That's the point: it decides. It prefers free information and buys only what it thinks the
task needs. If you want it to consider a service, say why it matters in the task.

**OpenAI is slow or down during a demo**
Switch the console's **Mode** to **Scripted client (no AI)**. The payments still work.

## Spending rules

**"Needs your approval" and nothing happens**
The console is waiting for you: click **Approve** or **Decline**. After
`AGENT_APPROVAL_TIMEOUT_SECONDS` with no answer, it declines. In the terminal, type `y` or `n`.

**`daily budget: would go over today's … limit`**
Today's payments are recorded in `.agent-spend-log.json`. Raise `AGENT_DAILY_BUDGET_USD`,
or on testnet delete that file to start a fresh day.

## Agent console

**"Connection closed" in the console**
Either the console server stopped (check its terminal), or a run was already in progress.
Only one run is allowed at a time, so a double click can't pay twice.

**The console loads but every step fails**
The paid API isn't running. Start it in a second terminal: `npm run server`.

## Code (if you're changing it)

**`TypeError: encoded argument must be of type String` / `Unknown Stellar network`**
`createEd25519Signer` takes the raw `S…` secret string and a network id like `stellar:testnet`.
Don't wrap it in `Keypair.fromSecret` or pass a network passphrase.

**Strange payment errors after upgrading packages**
Keep every `@x402/*` package on the same version. Mixing v1 and v2 packages breaks payments.

**Amounts off by 10× or 100×**
USDC on Stellar has **7** decimals, not 6 like on EVM chains. `$0.001` is `10000` base units.

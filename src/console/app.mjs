// The agent console: a web page that runs the agent and shows every decision live.
// This is the BUYER side (the agent and its wallet). The paid API (npm run server) is the seller.
// Keys stay in this process; the browser only receives events.
import express from "express";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { runAgent, RULES, spentTodayUsd } from "../agent.mjs";
import { config } from "../config.mjs";

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

// What the page needs to draw itself. Public info only; never the secret key.
app.get("/api/config", (_req, res) => {
  res.json({
    network: config.network,
    asset: config.usdc.code,
    rules: RULES,
    wallet: Keypair.fromSecret(config.agentSecret).publicKey(),
    explorerUrl: config.explorerUrl,
    apiBaseUrl: config.apiBaseUrl,
    brain: config.ai.planner === "ai" ? `OpenAI ${config.ai.model}` : "Scripted plan (no AI)",
    todayUsd: spentTodayUsd(),
  });
});

// One run at a time, so a double click on stream can't double-spend.
let running = false;

// The purchase waiting for a human (only one run at a time, so only one can wait).
let pendingApproval = null;

app.post("/api/approve", (req, res) => {
  if (!pendingApproval) return res.status(409).json({ error: "Nothing is waiting for approval." });
  const resolve = pendingApproval;
  pendingApproval = null;
  resolve(req.body?.approved === true);
  res.json({ ok: true });
});

// Runs the agent and streams each event to the page (Server-Sent Events).
app.get("/api/run", async (req, res) => {
  if (running) return res.status(409).json({ error: "The agent is already running." });
  const task = String(req.query.task || "").trim().slice(0, 200) || "Compare solar inverter prices in Lagos";
  running = true;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // Waits for the Approve/Decline click. No answer in time, or the page closed: declined.
  const approve = () => new Promise((resolve) => {
    pendingApproval = resolve;
    const decline = (why) => { if (pendingApproval === resolve) { pendingApproval = null; resolve(why); } };
    setTimeout(() => decline("timeout"), RULES.approvalTimeoutSeconds * 1000);
    req.on("close", () => decline(false));
  });

  try {
    await runAgent(task, send, { approve });
  } catch (e) {
    send({ type: "fatal", message: e.message });
  } finally {
    running = false;
    res.end();
  }
});

app.listen(config.consolePort, () => {
  console.log(`\nAgent console on http://localhost:${config.consolePort}`);
  console.log("(the paid API must be running too: npm run server)\n");
});

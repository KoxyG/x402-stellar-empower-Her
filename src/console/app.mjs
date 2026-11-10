// The agent console: a web page that runs the agent and shows every decision live.
// This is the BUYER side (the agent and its wallet). The paid API (npm run server) is the seller.
// Keys stay in this process; the browser only receives events.
import express from "express";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { runAgent, RULES } from "../agent.mjs";
import { config } from "../config.mjs";

const app = express();
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
  });
});

// One run at a time, so a double click on stream can't double-spend.
let running = false;

// Runs the agent and streams each event to the page (Server-Sent Events).
app.get("/api/run", async (req, res) => {
  if (running) return res.status(409).json({ error: "The agent is already running." });
  const task = String(req.query.task || "").trim().slice(0, 200) || "Compare solar inverter prices in Lagos";
  running = true;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    await runAgent(task, send);
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

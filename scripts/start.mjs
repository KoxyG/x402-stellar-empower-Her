// Hosting: runs the paid API and the agent console in one process, for Render or any host
// that gives you ONE public port in $PORT. The console takes the public port; the paid
// API stays on an internal port that only the console calls (API_BASE_URL in .env).
// Locally, keep using npm run server + npm run console.
// Ports are set before .env is loaded (dotenv never overrides them), so $PORT is the host's.
const publicPort = process.env.PORT || "4022";
const apiPort = new URL(process.env.API_BASE_URL || "http://localhost:4021").port || "4021";

if (publicPort === apiPort) {
  console.error(`Public port and paid API port are both ${apiPort}.`);
  console.error("→ On Render, delete PORT from your environment variables: Render sets it itself.");
  process.exit(1);
}

process.env.PORT = apiPort;
process.env.CONSOLE_PORT = publicPort;

// Dynamic imports, so the ports above are set before config.mjs reads them.
await import("../src/server.mjs");
await import("../src/console/app.mjs");

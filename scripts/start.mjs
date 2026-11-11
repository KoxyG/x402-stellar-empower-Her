// Hosting: runs the paid API and the agent console together, for Render or any host
// that gives you ONE public port in $PORT. The console takes the public port; the paid
// API stays on an internal port that only the console calls (API_BASE_URL in .env).
// Locally, keep using npm run server + npm run console.
// No dotenv here on purpose: $PORT must be the host's, not the PORT in .env.
// Each server still loads .env itself.
import { spawn } from "node:child_process";

const publicPort = process.env.PORT || "4022";
const apiPort = new URL(process.env.API_BASE_URL || "http://localhost:4021").port || "4021";

if (publicPort === apiPort) {
  console.error(`Public port and paid API port are both ${apiPort}.`);
  console.error("→ On Render, delete PORT from your environment variables: Render sets it itself.");
  process.exit(1);
}

const env = { ...process.env, PORT: apiPort, CONSOLE_PORT: publicPort };
const run = (name, file) => {
  const child = spawn(process.execPath, [file], { stdio: "inherit", env });
  // If either server dies, stop both, so the host restarts a clean pair.
  child.on("exit", (code, signal) => {
    console.error(`${name} stopped (${signal ?? `exit ${code}`}). Stopping so the host restarts it.`);
    children.forEach((c) => c !== child && c.kill());
    process.exit(code || 1);
  });
  return child;
};

const children = [run("Paid API", "src/server.mjs"), run("Console", "src/console/app.mjs")];

// Pass the host's stop signal on to both servers.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { children.forEach((c) => c.kill(sig)); process.exit(0); });
}

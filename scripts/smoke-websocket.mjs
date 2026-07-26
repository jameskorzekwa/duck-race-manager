import WebSocket from "ws";

const productionUrl = process.env.PRODUCTION_URL ?? "";
const origin = new URL(productionUrl);
if (origin.protocol !== "https:" || origin.origin !== productionUrl) {
  throw new Error("PRODUCTION_URL must be an exact HTTPS origin.");
}

const websocketUrl = new URL("/api/v1/live", origin);
websocketUrl.protocol = "wss:";

await new Promise((resolve, reject) => {
  const socket = new WebSocket(websocketUrl, {
    followRedirects: false,
    handshakeTimeout: 10_000,
    origin: productionUrl,
  });
  let opened = false;
  let settled = false;
  const timeout = setTimeout(() => {
    socket.terminate();
    finish(new Error("Production WebSocket did not open and close cleanly within 15 seconds."));
  }, 15_000);

  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    socket.removeAllListeners();
    if (error) reject(error);
    else resolve();
  };

  socket.once("open", () => {
    opened = true;
    socket.close(1000, "Release smoke test");
  });
  socket.once("close", (code) => {
    if (!opened) finish(new Error("Production WebSocket closed before opening."));
    else if (code !== 1000) finish(new Error(`Production WebSocket closed with code ${code}, not 1000.`));
    else finish();
  });
  socket.once("error", (error) => {
    socket.terminate();
    finish(error);
  });
  socket.once("unexpected-response", (_request, response) => {
    response.resume();
    socket.terminate();
    finish(new Error(`Production WebSocket handshake returned HTTP ${response.statusCode}.`));
  });
});

process.stdout.write("Production WebSocket opened and closed cleanly.\n");

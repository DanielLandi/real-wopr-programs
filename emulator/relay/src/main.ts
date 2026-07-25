// Service entry point — configuration comes from the environment (deployment.md D6).
import { startServer } from "./server.ts";

const server = await startServer();
console.log(`comms-layer listening on :${server.port} (/link), mode=${process.env.COMMS_MODE ?? "authentic"}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}

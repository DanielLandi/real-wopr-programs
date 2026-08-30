// Service entry point — configuration comes from the environment (deployment.md D6).
import { startServer } from "./server.ts";

const server = await startServer({
  // The policy for a hosted tie line refused for good (#86): keep serving.
  // A peer whose slot the hub declined is a worse exchange without its tie
  // line, and no exchange at all if the refusal took the process down — so
  // the trunk ends, the relay does not. Decided here, in the binary, because
  // the library cannot exit and must not choose. Read the log: a quiet
  // stack is not a connected one.
  onTielineFatal: (reason) => {
    console.error(`TIE LINE HUNG UP FOR GOOD — ${reason} — SERVING LOCAL CALLS ONLY`);
  },
});
console.log(`relay listening on :${server.port} (/link), mode=${process.env.COMMS_MODE ?? "authentic"}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}

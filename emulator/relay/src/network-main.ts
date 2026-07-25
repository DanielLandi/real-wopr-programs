// Run one network's relay.
//
//   WOPR_NETWORK='{"name":"pstn","kind":"dialup","addressing":"phone","public":true}' \
//     WOPR_RELAY_PORT=0 node src/network-main.ts
//
// The supervisor spawns one of these per network the pack declares, and reads
// the "listening" line to learn the port it picked.

import { startNetworkRelay, type NetworkDescriptor } from "./network.ts";

const raw = process.env.WOPR_NETWORK;
if (!raw) {
  console.error("wopr: WOPR_NETWORK not set (JSON network descriptor)");
  process.exit(2);
}

let desc: NetworkDescriptor;
try {
  desc = JSON.parse(raw) as NetworkDescriptor;
} catch (err) {
  console.error(`wopr: WOPR_NETWORK is not valid JSON: ${(err as Error).message}`);
  process.exit(2);
}

const relay = await startNetworkRelay(desc, {
  port: Number(process.env.WOPR_RELAY_PORT ?? 0),
});

// The supervisor parses this line; keep the shape stable.
console.log(`listening ${desc.name} ${relay.address}:${relay.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { void relay.close().then(() => process.exit(0)); });
}

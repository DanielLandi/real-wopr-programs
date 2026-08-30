// Every listener a test starts binds 127.0.0.1 — the family its own dial uses.
//
// `listen(0)` with no address binds the IPv6 wildcard, and the kernel will
// hand out a port number that another process already holds on IPv4
// 127.0.0.1: they are different sockets, and the more specific one wins for
// connections to 127.0.0.1. Every dial in this suite is `ws://127.0.0.1:<the
// port we were just given>` — so the dial lands on the stranger, and the
// failure is a LOST dial (`socket hang up`, `connect ETIMEDOUT`, a mint
// refused in 2 ms), not a slow one.
//
// That is not theoretical: it was caught live in #114 with Tailscale holding
// the v4 side, it is why `local-leg.test.ts` binds explicitly, and it is what
// #125's two remaining `server.test.ts` flakes turned out to be. Naming
// 127.0.0.1 makes the kernel choose a port that is free ON 127.0.0.1, so the
// port is genuinely ours (#151).
//
// Stubs bind it inline (`{ port: 0, host: LOOPBACK }`, `listen(0, LOOPBACK)`);
// the relay under test needs the wrapper below, because its own default — bind
// everything — is the right one for a deployed relay and the wrong one here.

import { startServer as startRelay, type ServerOpts, type RunningServer } from "../src/server.ts";
import { startNetworkRelay as startNetwork, type NetworkDescriptor,
         type NetworkRelayOpts, type RunningNetworkRelay } from "../src/network.ts";

export const LOOPBACK = "127.0.0.1";

/** The relay under test, on a port that is really its own. Identical to
 *  `startServer` otherwise; a caller that passes its own `host` keeps it. */
export function startServer(opts: ServerOpts = {}): Promise<RunningServer> {
  return startRelay({ host: LOOPBACK, ...opts });
}

/** The same, for the network relay — whose deployed default is `0.0.0.0` for
 *  a public network, and a v4 wildcard is shareable with a v4 stranger too. */
export function startNetworkRelay(desc: NetworkDescriptor,
                                  opts: NetworkRelayOpts = {}): Promise<RunningNetworkRelay> {
  return startNetwork(desc, { host: LOOPBACK, ...opts });
}

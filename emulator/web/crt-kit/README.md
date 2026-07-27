# crt-kit — shared CRT component library

The shared aesthetic core for all five surfaces. Not deployed on its own.
Spec: the engine repo's `docs/surfaces.md`.

Key components (contracts in surfaces.md):
- `<Teletype>` — renders text **as it arrives from the link**, so cadence reflects the real baud
  profile (not a fixed timer). Blinking block cursor.
- `<HandshakeView>` — the dial-up FSM (dialing → screech → CONNECT) with audio.
- CRT shell — scanlines, phosphor glow.

**Status:** implemented. Also ships `WoprLink` (the browser-side envelope client, the
engine repo's comms-protocol §5), `ModemAudio` (WebAudio dial/ring/carrier/screech), and
`JoshuaVoice` (S10 — Web Speech synthesis pitched down toward the film's machine voice;
speaks completed teletype lines, skips board art).
Consumed as raw TSX source via the surfaces workspace + `transpilePackages`.

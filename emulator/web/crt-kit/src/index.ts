// crt-kit — shared CRT component library (docs/surfaces.md).
export { CRTScreen, type CRTScreenProps, type CRTTheme } from "./CRTScreen";
// TerminalScreen is deliberately NOT re-exported here. It pulls in xterm and
// the shared terminal package, and this barrel is what the three feed surfaces
// (Big Board, war room, WOPR panel) import — they have no terminal and no
// business carrying one. The two terminal surfaces import it by path:
//     import { TerminalScreen } from "@real-wopr/crt-kit/src/TerminalScreen";
export { Teletype, type TeletypeProps } from "./Teletype";
export { CommandLine, type CommandLineProps } from "./CommandLine";
export { HandshakeView, type HandshakeViewProps } from "./HandshakeView";
export { StatusPanel, type StatusPanelProps, type StatusItem } from "./StatusPanel";
export { ModemAudio } from "./audio";
export { endpointFromQuery } from "./endpoint";
export { JoshuaVoice } from "./speech";
export {
  WoprLink,
  type WoprLinkOpts,
  type LinkEvent,
  type Envelope,
  type FrameKind,
} from "./link";

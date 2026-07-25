// crt-kit — shared CRT component library (docs/surfaces.md).
export { CRTScreen, type CRTScreenProps, type CRTTheme } from "./CRTScreen";
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

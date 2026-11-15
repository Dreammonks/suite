// Type stub for retired mediasoup-client to allow remaining legacy files to typecheck cleanly
declare module "mediasoup-client" {
	export const Device: any;
	export type Device = any;
}

declare module "mediasoup-client/types" {
	export type AppData = Record<string, unknown>;
	export type Consumer = any;
	export type Producer = any;
	export type MediaKind = "audio" | "video";
	export type RtpCapabilities = any;
	export type RtpParameters = any;
	export type DtlsParameters = any;
	export type IceCandidate = any;
	export type IceParameters = any;
	export type ProducerCodecOptions = any;
	export type Transport = any;
	export type TransportOptions = any;
}

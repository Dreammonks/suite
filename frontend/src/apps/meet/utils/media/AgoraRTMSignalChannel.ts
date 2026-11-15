/**
 * Agora RTM Signal Channel
 * Implements the SignalChannel interface using Agora RTM 2.x,
 * seamlessly replacing Socket.IO for in-room signaling (chat, reactions, hand raises, host controls).
 */

import AgoraRTM from "agora-rtm";
import type { SignalChannel } from "./SignalChannel";

export interface AgoraSignalChannelConfig {
	origin?: string;
	path?: string;
	auth?: { token?: string };
	agoraAppId: string;
	agoraRtmToken?: string;
	meetingId: string;
	userId: string;
	userName?: string;
	userAvatar?: string | null;
}

export class AgoraRTMSignalChannel implements SignalChannel {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private rtmClient: any = null;
	private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	private connected: boolean = false;
	private meetingId: string = "";
	private userId: string = "";
	private userName: string = "";
	private userAvatar: string | null = null;
	private appId: string = "";
	private rtmToken: string = "";

	async connect(config: unknown): Promise<void> {
		const cfg = config as AgoraSignalChannelConfig;
		this.appId = cfg.agoraAppId || "";
		this.meetingId = cfg.meetingId || "";
		this.userId = cfg.userId || "anonymous";
		this.userName = cfg.userName || this.userId;
		this.userAvatar = cfg.userAvatar || null;
		this.rtmToken = cfg.agoraRtmToken || cfg.auth?.token || "";

		if (!this.appId) {
			throw new Error("agoraAppId is required for AgoraRTMSignalChannel");
		}

		try {
			// @ts-ignore - AgoraRTM export depends on packaging
			const RTMConstructor = AgoraRTM.RTM || AgoraRTM;
			this.rtmClient = new RTMConstructor(this.appId, this.userId, {
				token: this.rtmToken || undefined,
			});

			this.rtmClient.addEventListener("message", (event: { channelName: string; message: string; publisher: string }) => {
				try {
					const envelope = JSON.parse(event.message);
					if (envelope && typeof envelope === "object" && typeof envelope.event === "string") {
						this.dispatch(envelope.event, envelope.data);
					}
				} catch (err) {
					console.warn("[AgoraRTMSignalChannel] parse message error:", err);
				}
			});

			this.rtmClient.addEventListener("status", (event: { state: string }) => {
				if (event.state === "CONNECTED") {
					this.connected = true;
				} else if (event.state === "DISCONNECTED") {
					this.connected = false;
				}
			});

			await this.rtmClient.login();
			if (this.meetingId) {
				await this.rtmClient.subscribe(this.meetingId, {
					withMessage: true,
					withPresence: true,
				});
			}

			this.connected = true;
		} catch (error) {
			this.connected = false;
			throw error;
		}
	}

	disconnect(): void {
		if (this.rtmClient) {
			try {
				if (this.meetingId) {
					this.rtmClient.unsubscribe(this.meetingId).catch(() => {});
				}
				this.rtmClient.logout().catch(() => {});
			} catch (err) {
				console.warn("[AgoraRTMSignalChannel] disconnect error:", err);
			}
			this.rtmClient = null;
		}
		this.connected = false;
	}

	getRTMClient(): unknown {
		return this.rtmClient;
	}

	emit(
		event: string,
		data: unknown,
		callback?: (response: unknown) => void,
	): void {
		const payloadData = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;

		if (event === "chat:send") {
			const messageText = typeof payloadData.message === "string" ? payloadData.message : "";
			const messageId =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const timestamp = new Date().toISOString();

			const chatPayload = {
				roomId: this.meetingId,
				messageId,
				message: messageText,
				fromUser: this.userId,
				fromName: this.userName,
				timestamp,
				clientId: payloadData.clientId,
			};

			this.publishToChannel("chat:message", chatPayload).then(() => {
				callback?.({ success: true, timestamp, messageId });
				// Also dispatch locally
				this.dispatch("chat:message", chatPayload);
			}).catch((err) => {
				callback?.({ success: false, error: (err as Error).message || String(err) });
			});
			return;
		}

		if (event === "reaction:send" || event === "reaction:message") {
			const reaction =
				typeof payloadData.reaction === "string"
					? payloadData.reaction
					: typeof payloadData.message === "string"
						? payloadData.message
						: "";
			const reactionPayload = {
				fromUser: this.userId,
				reaction,
				message: reaction,
				duration: typeof payloadData.duration === "number" ? payloadData.duration : 5000,
				timestamp: Date.now(),
			};
			this.publishToChannel("reaction:message", reactionPayload).catch(() => {});
			callback?.({ success: true });
			return;
		}

		if (event === "hand:toggle" || event === "raise_hand:toggle") {
			const raised = Boolean(payloadData.raised);
			const handPayload = {
				participantId: this.userId,
				raised,
				timestamp: Date.now(),
			};
			this.publishToChannel("raise_hand:updated", handPayload).catch(() => {});
			this.dispatch("raise_hand:updated", handPayload);
			callback?.({ success: true });
			return;
		}

		// Generic event broadcast
		this.publishToChannel(event, data).then(() => {
			callback?.({ success: true });
		}).catch((err) => {
			callback?.({ success: false, error: (err as Error).message || String(err) });
		});
	}

	private async publishToChannel(event: string, data: unknown): Promise<void> {
		if (!this.rtmClient || !this.connected || !this.meetingId) return;
		const envelope = JSON.stringify({ event, data });
		await this.rtmClient.publish(this.meetingId, envelope);
	}

	on(event: string, handler: (...args: unknown[]) => void): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(handler);
	}

	off(event: string, handler?: (...args: unknown[]) => void): void {
		if (!handler) {
			this.listeners.delete(event);
			return;
		}
		const set = this.listeners.get(event);
		if (set) {
			set.delete(handler);
			if (set.size === 0) {
				this.listeners.delete(event);
			}
		}
	}

	private dispatch(event: string, ...args: unknown[]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const handler of set) {
			try {
				handler(...args);
			} catch (err) {
				console.error(`[AgoraRTMSignalChannel] error in listener for ${event}:`, err);
			}
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	id(): string | null {
		return this.userId || null;
	}

	updateAuth(token: string): void {
		this.rtmToken = token;
		if (this.rtmClient && token) {
			try {
				this.rtmClient.renewToken(token);
			} catch (err) {
				console.warn("[AgoraRTMSignalChannel] renewToken error:", err);
			}
		}
	}
}

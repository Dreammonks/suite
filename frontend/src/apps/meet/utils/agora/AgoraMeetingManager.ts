/**
 * Agora Meeting Manager
 * Orchestrates Agora RTC (Audio/Video/Screen) and Agora RTM (Signaling/Moderation/Chat)
 * Implements the meeting manager interface compatible with MeetContext and useMediaControls.
 */

import AgoraRTC, {
	type IAgoraRTCClient,
	type ICameraVideoTrack,
	type IMicrophoneAudioTrack,
	type ILocalVideoTrack,
	type ILocalAudioTrack,
	type IAgoraRTCRemoteUser,
	type UID,
} from "agora-rtc-sdk-ng";
import AgoraRTM from "agora-rtm";
import type {
	AttachmentTrackOwnership,
	MediaAttachmentFacade,
	VideoElementManager,
} from "../media/VideoElementManager";
import type { Participant, ParticipantUpdate } from "../media/ParticipantManager";
import type {
	SFUEventHandlers,
	ParticipantConnectionState,
} from "../sfu/ParticipantConnection";
import type { ConnectionDetails } from "../SFUClient";
import type { User } from "../../composables/useCurrentUser";
import type { Producer } from "mediasoup-client/types";
import type { PublishedMedia } from "../sfu/SFUMediaManager";
import type { MediaHealthState } from "../media/MediaHealthMonitor";
import type { ConnectionDiagnostics } from "../SFUMeetingManager";

export interface LocalProducerState {
	id: string;
	track: MediaStreamTrack | null;
	paused: boolean;
}

export interface AgoraMeetingManagerOptions {
	meetingId: string;
	currentUser: User | null;
	eventHandlers?: SFUEventHandlers;
}

export interface AgoraRTMMessagePayload {
	type: "chat" | "reaction" | "hand" | "moderation";
	senderId: string;
	senderName?: string;
	senderAvatar?: string | null;
	payload: Record<string, unknown>;
	timestamp: number;
}

export class AgoraMeetingManager {
	private client: IAgoraRTCClient | null = null;
	private screenClient: IAgoraRTCClient | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private rtmClient: any = null;

	private meetingId: string = "";
	private userId: string = "";
	private screenUid: string = "";
	private appId: string = "";
	private rtcToken: string = "";
	private screenRtcToken: string = "";
	private rtmToken: string = "";

	private localAudioTrack: IMicrophoneAudioTrack | ILocalAudioTrack | null = null;
	private localVideoTrack: ICameraVideoTrack | ILocalVideoTrack | null = null;
	private localScreenTrack: ILocalVideoTrack | null = null;

	private readonly videoManager: VideoElementManager;
	private readonly ownsVideoManager: boolean;
	private eventHandlers: SFUEventHandlers = {};
	private currentUser: User | null = null;

	private isConnectedState: boolean = false;
	private isCleaningUp: boolean = false;

	// Track remote stream elements for playback
	private remoteVideoElements = new Map<string, HTMLVideoElement>();

	constructor(videoManager?: VideoElementManager) {
		this.videoManager =
			videoManager ?? (new (AgoraMeetingManager.getVideoElementManagerClass())() as VideoElementManager);
		this.ownsVideoManager = !videoManager;
	}

	private static getVideoElementManagerClass() {
		// Lazy-load to avoid cyclic dependencies if any
		return (
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			require("../media/VideoElementManager").VideoElementManager
		);
	}

	initialize(options: AgoraMeetingManagerOptions): void {
		this.meetingId = options.meetingId;
		this.currentUser = options.currentUser;
		this.eventHandlers = options.eventHandlers || {};
	}

	async startParticipantConnection(options: {
		authToken?: string | null;
		prefetchedDetails?: ConnectionDetails | null;
		conflictId?: string;
		prepareJoin?: (signal: AbortSignal) => Promise<void>;
	}): Promise<void> {
		this.eventHandlers.onLifecycleStateChange?.("starting");

		const details = options.prefetchedDetails;
		if (!details || !details.agoraAppId) {
			throw new Error("Agora App ID is missing from connection details");
		}

		this.appId = details.agoraAppId;
		this.userId = details.agoraUid || details.userId || "anonymous";
		this.screenUid = details.agoraScreenUid || `${this.userId}-screen`;
		this.rtcToken = details.agoraRtcToken || "";
		this.screenRtcToken = details.agoraScreenRtcToken || "";
		this.rtmToken = details.agoraRtmToken || "";
		this.meetingId = details.agoraChannelName || details.meetingId || this.meetingId;

		const abortController = new AbortController();
		if (options.prepareJoin) {
			await options.prepareJoin(abortController.signal);
		}

		this.eventHandlers.onLifecycleStateChange?.("syncing");

		// 1. Initialize RTC Client
		this.client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
		this.setupRTCEvents(this.client);

		// Join RTC channel
		await this.client.join(
			this.appId,
			this.meetingId,
			this.rtcToken || null,
			this.userId,
		);

		// Enable dual stream mode (HD for active speaker / pinned, SD for grid)
		try {
			await this.client.enableDualStreamMode();
		} catch (err) {
			console.warn("[AgoraMeetingManager] enableDualStreamMode error:", err);
		}

		// Enable audio volume indication
		try {
			this.client.enableAudioVolumeIndicator();
		} catch (err) {
			console.warn("[AgoraMeetingManager] enableAudioVolumeIndicator error:", err);
		}

		// 2. Initialize RTM Client for signaling & chat
		await this.initializeRTM();

		this.isConnectedState = true;
		this.eventHandlers.onLifecycleStateChange?.("ready");
	}

	private setupRTCEvents(client: IAgoraRTCClient): void {
		client.on("user-published", async (user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
			await client.subscribe(user, mediaType);
			const uidStr = String(user.uid);

			if (uidStr.endsWith("-screen")) {
				// Screen share from remote participant
				const baseUid = uidStr.replace(/-screen$/, "");
				if (mediaType === "video" && user.videoTrack) {
					const stream = new MediaStream([user.videoTrack.getMediaStreamTrack()]);
					await this.videoManager.attachScreenSharePreview(baseUid, stream);
					this.eventHandlers.onScreenShareStarted?.({
						participantId: baseUid,
						stream,
					});
				}
				return;
			}

			// Normal participant media
			if (mediaType === "video" && user.videoTrack) {
				const remoteElement = this.remoteVideoElements.get(uidStr);
				if (remoteElement) {
					user.videoTrack.play(remoteElement);
				}
				const stream = new MediaStream([user.videoTrack.getMediaStreamTrack()]);
				this.eventHandlers.onParticipantUpdated?.(
					uidStr,
					{ user_id: uidStr, user_name: uidStr, avatar: null, initials: uidStr.slice(0, 2).toUpperCase() },
					{ video_enabled: true },
				);
			}

			if (mediaType === "audio" && user.audioTrack) {
				user.audioTrack.play();
				this.eventHandlers.onParticipantUpdated?.(
					uidStr,
					{ user_id: uidStr, user_name: uidStr, avatar: null, initials: uidStr.slice(0, 2).toUpperCase() },
					{ audio_enabled: true },
				);
			}
		});

		client.on("user-unpublished", (user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
			const uidStr = String(user.uid);
			if (uidStr.endsWith("-screen")) {
				const baseUid = uidStr.replace(/-screen$/, "");
				if (mediaType === "video") {
					this.videoManager.removeScreenSharePreview(baseUid);
					this.eventHandlers.onScreenShareStopped?.({ participantId: baseUid });
				}
				return;
			}

			if (mediaType === "video") {
				this.eventHandlers.onParticipantUpdated?.(
					uidStr,
					{ user_id: uidStr, user_name: uidStr, avatar: null, initials: uidStr.slice(0, 2).toUpperCase() },
					{ video_enabled: false },
				);
			}

			if (mediaType === "audio") {
				this.eventHandlers.onParticipantUpdated?.(
					uidStr,
					{ user_id: uidStr, user_name: uidStr, avatar: null, initials: uidStr.slice(0, 2).toUpperCase() },
					{ audio_enabled: false },
				);
			}
		});

		client.on("user-joined", (user: IAgoraRTCRemoteUser) => {
			const uidStr = String(user.uid);
			if (uidStr.endsWith("-screen")) return;

			const participant: Participant = {
				user_id: uidStr,
				user_name: uidStr,
				avatar: null,
				initials: uidStr.slice(0, 2).toUpperCase(),
				audio_enabled: user.hasAudio,
				video_enabled: user.hasVideo,
				is_guest: uidStr.startsWith("guest-"),
			};
			this.eventHandlers.onParticipantJoined?.(participant);
		});

		client.on("user-left", (user: IAgoraRTCRemoteUser) => {
			const uidStr = String(user.uid);
			if (uidStr.endsWith("-screen")) {
				const baseUid = uidStr.replace(/-screen$/, "");
				this.videoManager.removeScreenSharePreview(baseUid);
				this.eventHandlers.onScreenShareStopped?.({ participantId: baseUid });
				return;
			}
			this.remoteVideoElements.delete(uidStr);
			this.eventHandlers.onParticipantLeft?.({ participantId: uidStr });
		});

		client.on("volume-indicator", (volumes) => {
			const activeSpeakers = volumes
				.filter((v) => v.level > 10)
				.map((v) => (v.uid === 0 || v.uid === this.userId ? this.userId : String(v.uid)))
				.filter((uid) => !uid.endsWith("-screen"));

			this.eventHandlers.onActiveSpeakerChanged?.(activeSpeakers);
		});

		client.on("network-quality", (stats) => {
			const qualityScore = stats.uplinkNetworkQuality;
			let quality = "good";
			if (qualityScore >= 4) quality = "poor";
			else if (qualityScore === 3) quality = "fair";

			this.eventHandlers.onNetworkQualityUpdated?.(this.userId, quality);
		});

		client.on("token-privilege-will-expire", async () => {
			try {
				await this.renewTokens();
			} catch (err) {
				console.error("[AgoraMeetingManager] Token renewal failed:", err);
			}
		});
	}

	setRTMClient(rtmClient: unknown): void {
		if (rtmClient) {
			this.rtmClient = rtmClient;
			this.setupRTMListeners();
		}
	}

	private async initializeRTM(): Promise<void> {
		if (this.rtmClient) {
			// RTM client already provided by signal channel
			return;
		}
		try {
			// @ts-ignore - AgoraRTM export depends on bundle packaging
			const RTMConstructor = AgoraRTM.RTM || AgoraRTM;
			this.rtmClient = new RTMConstructor(this.appId, this.userId, {
				token: this.rtmToken || undefined,
			});

			this.setupRTMListeners();

			await this.rtmClient.login();
			await this.rtmClient.subscribe(this.meetingId, { withMessage: true, withPresence: true });
		} catch (err) {
			console.warn("[AgoraMeetingManager] RTM initialization warning:", err);
		}
	}

	private setupRTMListeners(): void {
		if (!this.rtmClient) return;
		this.rtmClient.addEventListener("message", (event: { channelName: string; message: string; publisher: string }) => {
			try {
				const data = JSON.parse(event.message) as AgoraRTMMessagePayload;
				this.handleRTMMessage(data);
			} catch {
				// Plain text message fallback
			}
		});
	}

	private handleRTMMessage(data: AgoraRTMMessagePayload): void {
		if (data.type === "moderation") {
			const action = data.payload.action;
			const targetId = data.payload.targetUserId;
			if (targetId === this.userId || targetId === "all") {
				if (action === "mute_audio") {
					this.pauseLocalProducer("audio");
					this.eventHandlers.onHostMutedYou?.();
				} else if (action === "kick") {
					this.eventHandlers.onHostKickedYou?.({
						hostId: data.senderId,
						banned: Boolean(data.payload.banned),
					});
					this.disconnect();
				} else if (action === "end_meeting") {
					this.disconnect();
				}
			}
		}
	}

	async sendRTMMessage(type: AgoraRTMMessagePayload["type"], payload: Record<string, unknown>): Promise<void> {
		if (!this.rtmClient) return;
		const message: AgoraRTMMessagePayload = {
			type,
			senderId: this.userId,
			senderName: this.currentUser?.full_name || this.currentUser?.name,
			senderAvatar: this.currentUser?.avatar,
			payload,
			timestamp: Date.now(),
		};
		try {
			await this.rtmClient.publish(this.meetingId, JSON.stringify(message));
		} catch (err) {
			console.error("[AgoraMeetingManager] sendRTMMessage error:", err);
		}
	}

	async reconcileLocalProducerTrack(
		kind: "audio" | "video",
		track: MediaStreamTrack | null,
		options?: { resume?: boolean },
	): Promise<void> {
		if (!this.client || !this.isConnectedState) return;

		if (kind === "audio") {
			if (!track) {
				if (this.localAudioTrack) {
					this.localAudioTrack.stop();
					this.localAudioTrack.close();
					try {
						await this.client.unpublish(this.localAudioTrack);
					} catch (err) {
						console.warn("[AgoraMeetingManager] unpublish audio error:", err);
					}
					this.localAudioTrack = null;
				}
			} else {
				if (this.localAudioTrack) {
					// @ts-ignore - custom audio track supports replaceTrack
					if (typeof this.localAudioTrack.replaceTrack === "function") {
						await this.localAudioTrack.replaceTrack(track);
					}
					if (options?.resume) {
						this.localAudioTrack.setEnabled(true);
					}
				} else {
					this.localAudioTrack = AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: track });
					await this.client.publish(this.localAudioTrack);
				}
			}
		} else if (kind === "video") {
			if (!track) {
				if (this.localVideoTrack) {
					this.localVideoTrack.stop();
					this.localVideoTrack.close();
					try {
						await this.client.unpublish(this.localVideoTrack);
					} catch (err) {
						console.warn("[AgoraMeetingManager] unpublish video error:", err);
					}
					this.localVideoTrack = null;
				}
			} else {
				if (this.localVideoTrack) {
					// @ts-ignore - custom video track supports replaceTrack
					if (typeof this.localVideoTrack.replaceTrack === "function") {
						await this.localVideoTrack.replaceTrack(track);
					}
					if (options?.resume) {
						this.localVideoTrack.setEnabled(true);
					}
				} else {
					this.localVideoTrack = AgoraRTC.createCustomVideoTrack({ mediaStreamTrack: track });
					await this.client.publish(this.localVideoTrack);
				}
			}
		}
	}

	pauseLocalProducer(kind: "audio" | "video"): void {
		if (kind === "audio" && this.localAudioTrack) {
			this.localAudioTrack.setEnabled(false);
		} else if (kind === "video" && this.localVideoTrack) {
			this.localVideoTrack.setEnabled(false);
		}
	}

	resumeLocalProducer(kind: "audio" | "video"): void {
		if (kind === "audio" && this.localAudioTrack) {
			this.localAudioTrack.setEnabled(true);
		} else if (kind === "video" && this.localVideoTrack) {
			this.localVideoTrack.setEnabled(true);
		}
	}

	async publishInitialMedia(
		localStream: MediaStream,
		options: { publishVideo: boolean; publishAudio: boolean },
		signal?: AbortSignal,
		finalize?: (publication: PublishedMedia) => void | Promise<void>,
	): Promise<PublishedMedia> {
		if (signal?.aborted) throw signal.reason;

		const publication: PublishedMedia = {
			videoProducer: null,
			audioProducer: null,
			videoError: null,
			audioError: null,
		};

		if (!this.client || !this.isConnectedState) {
			return publication;
		}

		if (options.publishAudio) {
			const audioTrack = localStream.getAudioTracks()[0];
			if (audioTrack) {
				try {
					await this.reconcileLocalProducerTrack("audio", audioTrack);
					publication.audioProducer = {
						id: `agora-audio-${this.userId}`,
						kind: "audio",
						paused: !audioTrack.enabled,
						track: audioTrack,
					} as unknown as Producer;
				} catch (err) {
					publication.audioError = err as Error;
				}
			}
		}

		if (options.publishVideo) {
			const videoTrack = localStream.getVideoTracks()[0];
			if (videoTrack) {
				try {
					await this.reconcileLocalProducerTrack("video", videoTrack);
					publication.videoProducer = {
						id: `agora-video-${this.userId}`,
						kind: "video",
						paused: !videoTrack.enabled,
						track: videoTrack,
					} as unknown as Producer;
				} catch (err) {
					publication.videoError = err as Error;
				}
			}
		}

		if (finalize) {
			await finalize(publication);
		}

		return publication;
	}

	async publishMedia(
		localStream: MediaStream,
		options: { publishVideo: boolean; publishAudio: boolean },
	): Promise<PublishedMedia> {
		return this.publishInitialMedia(localStream, options);
	}

	async publishScreenTrack(
		screenTrack: MediaStreamTrack,
	): Promise<{ screenProducer?: Producer; screenError?: Error }> {
		try {
			await this.startScreenShare(screenTrack);
			return {
				screenProducer: {
					id: `agora-screen-${this.userId}`,
					kind: "video",
					paused: false,
					track: screenTrack,
				} as unknown as Producer,
			};
		} catch (err) {
			return { screenError: err as Error };
		}
	}

	getLocalProducerState(kind: "audio" | "video" | "screen"): LocalProducerState | null {
		if (kind === "video" && this.localVideoTrack) {
			const track = this.localVideoTrack.getMediaStreamTrack();
			return {
				id: `agora-video-${this.userId}`,
				track,
				paused: !this.localVideoTrack.enabled,
			};
		}
		if (kind === "audio" && this.localAudioTrack) {
			const track = this.localAudioTrack.getMediaStreamTrack();
			return {
				id: `agora-audio-${this.userId}`,
				track,
				paused: !this.localAudioTrack.enabled,
			};
		}
		if (kind === "screen" && this.localScreenTrack) {
			const track = this.localScreenTrack.getMediaStreamTrack();
			return {
				id: `agora-screen-${this.userId}`,
				track,
				paused: false,
			};
		}
		return null;
	}

	async replaceLocalProducerTrack(
		kind: "audio" | "video",
		track: MediaStreamTrack,
	): Promise<void> {
		await this.reconcileLocalProducerTrack(kind, track);
	}

	async createLocalProducer(
		kind: "audio" | "video",
		track: MediaStreamTrack,
	): Promise<Producer> {
		await this.reconcileLocalProducerTrack(kind, track);
		return {
			id: `agora-${kind}-${this.userId}`,
			kind,
			paused: false,
			track,
		} as unknown as Producer;
	}

	closeLocalProducer(kind: "audio" | "video"): void {
		void this.reconcileLocalProducerTrack(kind, null);
	}

	setLocalMediaTrack(kind: "audio" | "video", track: MediaStreamTrack | null): void {
		void this.reconcileLocalProducerTrack(kind, track);
	}

	private mutationQueue: Promise<unknown> = Promise.resolve();
	serializeSendMediaMutation<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.mutationQueue.then(operation, operation);
		this.mutationQueue = next.catch(() => {});
		return next;
	}

	startMediaHealthMonitoring(callback: (state: MediaHealthState) => void): () => void {
		callback({
			networkQuality: "good",
			downlinkQuality: "good",
			isTransportFailed: false,
		});
		return () => {};
	}

	async sendHostControl(action: string, targetUserId: string): Promise<void> {
		await this.sendRTMMessage("moderation", {
			action,
			targetUserId,
		});
	}

	async getConnectionDiagnostics(): Promise<ConnectionDiagnostics | null> {
		return null;
	}

	async rejoinParticipantConnection(): Promise<void> {}

	async reconfigureForE2EE(): Promise<{ videoPublished: boolean; audioPublished: boolean }> {
		return { videoPublished: true, audioPublished: true };
	}

	async startScreenShare(track: MediaStreamTrack): Promise<void> {
		if (!this.appId || !this.meetingId) return;

		try {
			this.screenClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
			await this.screenClient.join(
				this.appId,
				this.meetingId,
				this.screenRtcToken || null,
				this.screenUid,
			);

			this.localScreenTrack = AgoraRTC.createCustomVideoTrack({ mediaStreamTrack: track });
			await this.screenClient.publish(this.localScreenTrack);

			track.onended = () => {
				this.stopScreenShare();
			};

			this.eventHandlers.onScreenShareStarted?.({
				participantId: this.userId,
				stream: new MediaStream([track]),
			});
		} catch (err) {
			console.error("[AgoraMeetingManager] startScreenShare error:", err);
			await this.stopScreenShare();
		}
	}

	async stopScreenShare(): Promise<void> {
		if (this.localScreenTrack) {
			this.localScreenTrack.stop();
			this.localScreenTrack.close();
			this.localScreenTrack = null;
		}

		if (this.screenClient) {
			try {
				await this.screenClient.leave();
			} catch (err) {
				console.warn("[AgoraMeetingManager] screenClient.leave error:", err);
			}
			this.screenClient = null;
		}

		this.eventHandlers.onScreenShareStopped?.({
			participantId: this.userId,
		});
	}

	async updateConsumerStreamPreferences(
		participantId: string,
		profile: "high" | "low" | "none",
	): Promise<void> {
		if (!this.client) return;
		try {
			if (profile === "low") {
				await this.client.setRemoteVideoStreamType(participantId, 1);
			} else if (profile === "high") {
				await this.client.setRemoteVideoStreamType(participantId, 0);
			}
		} catch (err) {
			console.warn("[AgoraMeetingManager] updateConsumerStreamPreferences error:", err);
		}
	}

	private async renewTokens(): Promise<void> {
		// Call Frappe backend refresh_agora_token endpoint
		const response = await fetch(
			`/api/v2/method/suite.meet.api.meeting.refresh_agora_token?meeting_id=${encodeURIComponent(this.meetingId)}`,
			{ credentials: "include" },
		);
		if (!response.ok) return;
		const json = await response.json();
		const data = json.data || json.message;
		if (!data) return;

		if (data.rtc_token && this.client) {
			await this.client.renewToken(data.rtc_token);
		}
		if (data.screen_rtc_token && this.screenClient) {
			await this.screenClient.renewToken(data.screen_rtc_token);
		}
		if (data.rtm_token && this.rtmClient) {
			await this.rtmClient.renewToken(data.rtm_token);
		}
	}

	// ── Media Attachment Facade Pass-throughs ──────────────────────────────
	registerRemoteVideoElement(participantId: string, element: HTMLVideoElement | null): void {
		if (element) {
			this.remoteVideoElements.set(participantId, element);
			// If remote user video track is already subscribed, play to element
			const remoteUser = this.client?.remoteUsers.find((u) => String(u.uid) === participantId);
			if (remoteUser?.videoTrack) {
				remoteUser.videoTrack.play(element);
			}
		} else {
			this.remoteVideoElements.delete(participantId);
		}
		this.videoManager.registerRemoteVideoElement(participantId, element);
	}

	registerLocalPreview(element: HTMLVideoElement | null): void {
		this.videoManager.registerLocalPreview(element);
	}

	attachLocalPreview(stream: MediaStream | null): Promise<void> {
		return this.videoManager.attachLocalPreview(stream);
	}

	registerScreenSharePreview(attachmentId: string, element: HTMLVideoElement | null): void {
		this.videoManager.registerScreenSharePreview(attachmentId, element);
	}

	attachScreenSharePreview(
		attachmentId: string,
		stream: MediaStream,
		trackOwnership?: AttachmentTrackOwnership,
	): Promise<void> {
		return this.videoManager.attachScreenSharePreview(attachmentId, stream, trackOwnership);
	}

	removeScreenSharePreview(attachmentId: string): void {
		this.videoManager.removeScreenSharePreview(attachmentId);
	}

	attachBackgroundEffectsSource(
		attachmentId: string,
		element: HTMLVideoElement,
		stream: MediaStream,
	): Promise<void> {
		return this.videoManager.attachBackgroundEffectsSource(attachmentId, element, stream);
	}

	removeBackgroundEffectsSource(attachmentId: string): void {
		this.videoManager.removeBackgroundEffectsSource(attachmentId);
	}

	async setAudioOutputDevice(deviceId: string): Promise<void> {
		await this.videoManager.setAudioOutputDevice(deviceId);
	}

	async disconnect(): Promise<void> {
		await this.cleanup();
	}

	async cleanup(): Promise<void> {
		if (this.isCleaningUp) return;
		this.isCleaningUp = true;
		this.isConnectedState = false;

		await this.stopScreenShare();

		if (this.localAudioTrack) {
			this.localAudioTrack.stop();
			this.localAudioTrack.close();
			this.localAudioTrack = null;
		}

		if (this.localVideoTrack) {
			this.localVideoTrack.stop();
			this.localVideoTrack.close();
			this.localVideoTrack = null;
		}

		if (this.client) {
			try {
				await this.client.leave();
			} catch (err) {
				console.warn("[AgoraMeetingManager] client.leave error:", err);
			}
			this.client = null;
		}

		if (this.rtmClient) {
			try {
				await this.rtmClient.logout();
			} catch (err) {
				console.warn("[AgoraMeetingManager] rtmClient.logout error:", err);
			}
			this.rtmClient = null;
		}

		this.remoteVideoElements.clear();
		if (this.ownsVideoManager) {
			this.videoManager.cleanup();
		} else {
			this.videoManager.cleanupRemoteMedia();
		}

		this.eventHandlers.onLifecycleStateChange?.("stopped");
	}
}

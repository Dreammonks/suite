import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgoraMeetingManager } from "../AgoraMeetingManager";
import type { VideoElementManager } from "../../media/VideoElementManager";

type StreamCtor = new (tracks: MediaStreamTrack[]) => MediaStream;
const globalAny = globalThis as typeof globalThis & { MediaStream?: StreamCtor };

beforeEach(() => {
	if (globalAny.MediaStream === undefined) {
		class MockMediaStream {
			tracks: MediaStreamTrack[];
			id: string;
			constructor(tracks: MediaStreamTrack[] = []) {
				this.tracks = tracks;
				this.id = `mock-${Math.random().toString(36).slice(2)}`;
			}
			getVideoTracks() {
				return this.tracks.filter((t) => t.kind === "video");
			}
			getAudioTracks() {
				return this.tracks.filter((t) => t.kind === "audio");
			}
			getTracks() {
				return this.tracks;
			}
		}
		Reflect.set(globalAny, "MediaStream", MockMediaStream);
	}
});

vi.mock("agora-rtc-sdk-ng", () => {
	return {
		default: {
			createClient: vi.fn(() => ({
				on: vi.fn(),
				join: vi.fn().mockResolvedValue(undefined),
				publish: vi.fn().mockResolvedValue(undefined),
				unpublish: vi.fn().mockResolvedValue(undefined),
				subscribe: vi.fn().mockResolvedValue(undefined),
				enableDualStreamMode: vi.fn().mockResolvedValue(undefined),
				enableAudioVolumeIndicator: vi.fn(),
				remoteUsers: [],
			})),
			createCustomVideoTrack: vi.fn(() => ({
				stop: vi.fn(),
				close: vi.fn(),
				replaceTrack: vi.fn(),
				setEnabled: vi.fn(),
			})),
			createCustomAudioTrack: vi.fn(() => ({
				stop: vi.fn(),
				close: vi.fn(),
				replaceTrack: vi.fn(),
				setEnabled: vi.fn(),
			})),
		},
	};
});

vi.mock("agora-rtm", () => ({
	default: {
		RTM: vi.fn().mockImplementation(() => ({
			login: vi.fn().mockResolvedValue(undefined),
			logout: vi.fn().mockResolvedValue(undefined),
			subscribe: vi.fn().mockResolvedValue(undefined),
			unsubscribe: vi.fn().mockResolvedValue(undefined),
			addEventListener: vi.fn(),
			publish: vi.fn().mockResolvedValue(undefined),
		})),
	},
}));

describe("AgoraMeetingManager remote video attachment", () => {
	it("attaches stream to videoManager when remote video is published", async () => {
		const fakeVideoManager = {
			attachStream: vi.fn().mockResolvedValue(undefined),
			detachVideoStream: vi.fn(),
			removeVideoElement: vi.fn(),
			registerRemoteVideoElement: vi.fn(),
			attachScreenSharePreview: vi.fn().mockResolvedValue(undefined),
			removeScreenSharePreview: vi.fn(),
		} as unknown as VideoElementManager;

		const onParticipantUpdated = vi.fn();
		const onParticipantJoined = vi.fn();

		const manager = new AgoraMeetingManager(fakeVideoManager);
		manager.initialize({
			meetingId: "test-room",
			currentUser: null,
			eventHandlers: {
				onParticipantUpdated,
				onParticipantJoined,
			},
		});

		const registeredEvents: Record<string, Function> = {};
		// @ts-ignore
		manager.client = {
			on: (evt: string, handler: Function) => {
				registeredEvents[evt] = handler;
			},
			subscribe: vi.fn().mockResolvedValue(undefined),
			remoteUsers: [],
		};

		// @ts-ignore
		manager.setupRTCEvents(manager.client);

		const fakeTrack = {
			kind: "video",
			id: "remote-vtrack-1",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		} as unknown as MediaStreamTrack;

		const fakeUser = {
			uid: "guest_abc123",
			hasAudio: false,
			hasVideo: true,
			videoTrack: {
				getMediaStreamTrack: () => fakeTrack,
				play: vi.fn(),
			},
		};

		// Simulate user-published
		await registeredEvents["user-published"](fakeUser, "video");

		// Participant should be registered as guest
		expect(onParticipantJoined).toHaveBeenCalledWith(
			expect.objectContaining({
				user_id: "guest_abc123",
				is_guest: true,
			}),
		);

		// videoManager.attachStream MUST be called with the participant ID
		expect(fakeVideoManager.attachStream).toHaveBeenCalledWith(
			"guest_abc123",
			expect.any(Object),
			false,
		);

		// onParticipantUpdated should indicate video is enabled
		expect(onParticipantUpdated).toHaveBeenCalledWith(
			"guest_abc123",
			expect.any(Object),
			{ video_enabled: true },
		);

		// Simulate user-unpublished
		registeredEvents["user-unpublished"](fakeUser, "video");
		expect(fakeVideoManager.detachVideoStream).toHaveBeenCalledWith("guest_abc123");
		expect(onParticipantUpdated).toHaveBeenCalledWith(
			"guest_abc123",
			expect.any(Object),
			{ video_enabled: false },
		);

		// Simulate user-left
		registeredEvents["user-left"](fakeUser);
		expect(fakeVideoManager.removeVideoElement).toHaveBeenCalledWith("guest_abc123");
	});

	it("attaches stream when video element registers after track is already subscribed", async () => {
		const fakeVideoManager = {
			attachStream: vi.fn().mockResolvedValue(undefined),
			registerRemoteVideoElement: vi.fn(),
		} as unknown as VideoElementManager;

		const manager = new AgoraMeetingManager(fakeVideoManager);
		const fakeTrack = {
			kind: "video",
			id: "track-2",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		} as unknown as MediaStreamTrack;

		const fakeRemoteUser = {
			uid: "user-456",
			videoTrack: {
				getMediaStreamTrack: () => fakeTrack,
				play: vi.fn(),
			},
		};

		// @ts-ignore
		manager.client = {
			remoteUsers: [fakeRemoteUser],
		};

		const fakeEl = document.createElement("video");
		manager.registerRemoteVideoElement("user-456", fakeEl);

		expect(fakeVideoManager.registerRemoteVideoElement).toHaveBeenCalledWith(
			"user-456",
			fakeEl,
		);
		expect(fakeVideoManager.attachStream).toHaveBeenCalledWith(
			"user-456",
			expect.any(Object),
			false,
		);
	});
});

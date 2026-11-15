import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase/app', () => ({ initializeApp: vi.fn() }))
vi.mock('firebase/messaging', () => ({
	deleteToken: vi.fn(),
	getMessaging: vi.fn(),
	getToken: vi.fn(),
	isSupported: vi.fn(),
	onMessage: vi.fn(),
}))

import FrappePushNotification from './frappe-push-notification'

describe('FrappePushNotification direct Web Push', () => {
	const key = new Uint8Array([1, 2, 3])
	const unsubscribe = vi.fn()
	const subscription = {
		endpoint: 'https://push.example/subscription',
		options: { applicationServerKey: key.buffer },
		toJSON: () => ({
			endpoint: 'https://push.example/subscription',
			keys: { p256dh: 'public-key', auth: 'auth-secret' },
		}),
		unsubscribe,
	} as unknown as PushSubscription
	const registration = {
		pushManager: {
			getSubscription: vi.fn().mockResolvedValue(subscription),
			subscribe: vi.fn(),
		},
	} as unknown as ServiceWorkerRegistration

	beforeEach(() => {
		window.dreammonks_web_push_enabled = true
		window.dreammonks_vapid_public_key = 'AQID'
		window.csrf_token = 'csrf-token'
		localStorage.clear()
		unsubscribe.mockReset()
		vi.stubGlobal('Notification', {
			permission: 'granted',
			requestPermission: vi.fn().mockResolvedValue('granted'),
		})
		vi.stubGlobal('PushManager', class PushManager {})
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: { getRegistration: vi.fn().mockResolvedValue(registration) },
		})
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ message: { status: 'updated' } }),
			}),
		)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('refreshes the backend subscription and reads enabled state from PushManager', async () => {
		const client = new FrappePushNotification('mail')

		await client.initialize(registration)

		expect(await client.isNotificationEnabled()).toBe(true)
		expect(fetch).toHaveBeenCalledWith(
			'/api/method/dreammonks_custom.api.subscribe_push',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ 'X-Frappe-CSRF-Token': 'csrf-token' }),
			}),
		)
		expect(localStorage.getItem('dreammonks_web_push_subscription')).toBe(
			'https://push.example/subscription',
		)
	})

	it('disabling removes the site record and browser subscription', async () => {
		const client = new FrappePushNotification('mail')
		await client.initialize(registration)
		vi.mocked(fetch).mockClear()

		await client.disableNotification()

		expect(fetch).toHaveBeenCalledWith(
			'/api/method/dreammonks_custom.api.unsubscribe_push',
			expect.objectContaining({ method: 'POST' }),
		)
		expect(unsubscribe).toHaveBeenCalledOnce()
		expect(localStorage.getItem('dreammonks_web_push_subscription')).toBeNull()
		expect(localStorage.getItem('dreammonks_web_push_vapid_public_key')).toBeNull()
	})

	it('keeps an existing subscription enabled when the browser hides its application server key', async () => {
		const opaqueSubscription = {
			...subscription,
			options: { applicationServerKey: null },
		} as unknown as PushSubscription
		const opaqueRegistration = {
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(opaqueSubscription),
				subscribe: vi.fn(),
			},
		} as unknown as ServiceWorkerRegistration
		localStorage.setItem(
			'dreammonks_web_push_subscription',
			'https://push.example/subscription',
		)

		const client = new FrappePushNotification('mail')
		await client.initialize(opaqueRegistration)

		expect(await client.isNotificationEnabled()).toBe(true)
		expect(unsubscribe).not.toHaveBeenCalled()
		expect(localStorage.getItem('dreammonks_web_push_vapid_public_key')).toBe('AQID')
	})
})

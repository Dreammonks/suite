import { initializeApp } from 'firebase/app'
import {
	type Messaging,
	deleteToken,
	getMessaging,
	getToken,
	isSupported,
	onMessage as onFCMMessage,
} from 'firebase/messaging'

// FCM web config to initialize firebase app
type WebConfigType = {
	projectId: string
	appId: string
	apiKey: string
	authDomain: string
	messagingSenderId: string
}

type MessagePayload = {
	data: {
		title: string
		body: string
		click_action: string | null
		notification_icon?: string
	}
}

type OnMessageCallback = (payload: MessagePayload) => void

class FrappePushNotification {
	static get relayServerBaseURL(): string {
		return window.push_relay_server_url
	}

	// client info
	projectName: string
	webConfig: WebConfigType | null
	vapidPublicKey: string
	token: string | null

	// state
	initialized: boolean
	messaging: Messaging | null
	serviceWorkerRegistration: ServiceWorkerRegistration | null

	// event handlers
	onMessageHandler: OnMessageCallback | null

	constructor(projectName: string) {
		// client info
		this.projectName = projectName
		this.webConfig = null
		this.vapidPublicKey = ''
		this.token = null

		// state
		this.initialized = false
		this.messaging = null
		this.serviceWorkerRegistration = null

		// event handlers
		this.onMessageHandler = null
	}

	get directWebPushEnabled(): boolean {
		return Boolean(
			window.dreammonks_web_push_enabled && window.dreammonks_vapid_public_key,
		)
	}

	get storageKey(): string {
		return this.directWebPushEnabled
			? 'dreammonks_web_push_subscription'
			: `firebase_token_${this.projectName}`
	}

	get vapidStorageKey(): string {
		return 'dreammonks_web_push_vapid_public_key'
	}

	// Initialize notification service client
	async initialize(serviceWorkerRegistration: ServiceWorkerRegistration): Promise<void> {
		if (this.initialized) return

		this.serviceWorkerRegistration = serviceWorkerRegistration
		if (this.directWebPushEnabled) {
			this.initialized = true
			if ('Notification' in window && Notification.permission === 'granted') {
				try {
					await this.enableDirectWebPush(false)
				} catch (error) {
					console.error('Failed to refresh direct Web Push subscription', error)
				}
			}
			return
		}

		const config = await this.fetchWebConfig()
		this.messaging = getMessaging(initializeApp(config))
		this.onMessage(this.onMessageHandler)
		this.initialized = true
	}

	// Append config to service worker URL
	async appendConfigToServiceWorkerURL(url: string, parameter_name = 'config'): Promise<string> {
		if (this.directWebPushEnabled) return '/sw.js'
		const config = await this.fetchWebConfig()
		const encode_config = encodeURIComponent(JSON.stringify(config))
		return `${url}?${parameter_name}=${encode_config}`
	}

	// Fetch web config of the project
	async fetchWebConfig(): Promise<WebConfigType> {
		if (this.webConfig !== null && this.webConfig !== undefined) return this.webConfig

		const url = `${FrappePushNotification.relayServerBaseURL}/api/method/notification_relay.api.get_config?project_name=${this.projectName}`
		const response = await fetch(url)
		const response_json = await response.json()
		this.webConfig = response_json.config
		return this.webConfig!
	}

	// Fetch VAPID public key
	async fetchVapidPublicKey(): Promise<string> {
		if (this.vapidPublicKey !== '') return this.vapidPublicKey
		if (this.directWebPushEnabled) {
			this.vapidPublicKey = window.dreammonks_vapid_public_key
			return this.vapidPublicKey
		}

		const url = `${FrappePushNotification.relayServerBaseURL}/api/method/notification_relay.api.get_config?project_name=${this.projectName}`
		const response = await fetch(url)
		const response_json = await response.json()
		this.vapidPublicKey = response_json.vapid_public_key
		return this.vapidPublicKey
	}

	// Register on message handler
	onMessage(callback: OnMessageCallback | null): void {
		if (callback == null) return
		this.onMessageHandler = callback
		if (this.messaging == null) return
		onFCMMessage(this.messaging, this.onMessageHandler)
	}

	// Check if notification is enabled
	async isNotificationEnabled(): Promise<boolean> {
		if (!this.directWebPushEnabled) return localStorage.getItem(this.storageKey) !== null
		if (
			!('Notification' in window) ||
			Notification.permission !== 'granted' ||
			!('serviceWorker' in navigator)
		)
			return false

		const registration =
			this.serviceWorkerRegistration || (await navigator.serviceWorker.getRegistration('/'))
		const subscription = await registration?.pushManager.getSubscription()
		if (!subscription) return false

		const encodedPublicKey = await this.fetchVapidPublicKey()
		const publicKey = this.urlBase64ToUint8Array(encodedPublicKey)
		return this.subscriptionUsesCurrentKey(subscription, encodedPublicKey, publicKey)
	}

	// This will return notification permission status and token
	async enableNotification(): Promise<{ permission_granted: boolean; token: string }> {
		if (this.directWebPushEnabled) return this.enableDirectWebPush(true)
		if (!(await isSupported()))
			throw new Error('Push notifications are not supported on your device')

		// Return if token already presence in the instance
		if (this.token != null) return { permission_granted: true, token: this.token }

		// ask for permission
		const permission = await Notification.requestPermission()
		if (permission !== 'granted') return { permission_granted: false, token: '' }

		// check in local storage for old token
		const oldToken = localStorage.getItem(this.storageKey)
		const vapidKey = await this.fetchVapidPublicKey()
		const newToken = await getToken(this.messaging!, {
			vapidKey: vapidKey,
			serviceWorkerRegistration: this.serviceWorkerRegistration!,
		})
		// register new token if token is changed
		if (oldToken !== newToken) {
			// unsubscribe old token
			if (oldToken) await this.unregisterTokenHandler(oldToken)

			// subscribe push notification and register token
			const isSubscriptionSuccessful = await this.registerTokenHandler(newToken)
			if (isSubscriptionSuccessful === false)
				throw new Error('Failed to subscribe to push notification')

			// save token to local storage
			localStorage.setItem(this.storageKey, newToken)
		}
		this.token = newToken
		return { permission_granted: true, token: newToken }
	}

	// This will delete token from firebase and unsubscribe from push notification
	async disableNotification(): Promise<void> {
		if (this.directWebPushEnabled) return this.disableDirectWebPush()
		if (this.token == null)
			// try to fetch token from local storage
			this.token = localStorage.getItem(this.storageKey)
		if (this.token == null || this.token === '') return

		// delete old token from firebase
		try {
			await deleteToken(this.messaging!)
		} catch (e) {
			console.error('Failed to delete token from firebase')
			console.error(e)
		}
		try {
			await this.unregisterTokenHandler(this.token)
		} catch (e) {
			console.error('Failed to unsubscribe from push notification')
			console.error(e)
		}
		// remove token
		localStorage.removeItem(this.storageKey)
		this.token = null
	}

	private async enableDirectWebPush(
		requestPermission: boolean,
	): Promise<{ permission_granted: boolean; token: string }> {
		if (
			!('Notification' in window) ||
			!('serviceWorker' in navigator) ||
			!('PushManager' in window)
		)
			throw new Error('Push notifications are not supported on your device')

		let permission = Notification.permission
		if (permission === 'default' && requestPermission)
			permission = await Notification.requestPermission()
		if (permission !== 'granted') return { permission_granted: false, token: '' }

		const registration =
			this.serviceWorkerRegistration || (await navigator.serviceWorker.getRegistration('/'))
		if (!registration) throw new Error('Push notification service worker is not ready')
		this.serviceWorkerRegistration = registration

		const encodedPublicKey = await this.fetchVapidPublicKey()
		const publicKey = this.urlBase64ToUint8Array(encodedPublicKey)
		let subscription = await registration.pushManager.getSubscription()
		if (
			subscription &&
			!this.subscriptionUsesCurrentKey(subscription, encodedPublicKey, publicKey)
		) {
			try {
				await this.unregisterDirectSubscription(subscription.endpoint)
			} catch (error) {
				console.warn('Failed to remove the old Web Push subscription from the site', error)
			}
			await subscription.unsubscribe()
			subscription = null
		}
		if (!subscription)
			subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: publicKey,
			})

		await this.requestDirectWebPush(
			'/api/method/dreammonks_custom.api.subscribe_push',
			{ subscription_json: subscription.toJSON() },
		)
		this.token = subscription.endpoint
		localStorage.setItem(this.storageKey, subscription.endpoint)
		localStorage.setItem(this.vapidStorageKey, encodedPublicKey)
		return { permission_granted: true, token: subscription.endpoint }
	}

	private async disableDirectWebPush(): Promise<void> {
		if (!('serviceWorker' in navigator)) return
		const registration =
			this.serviceWorkerRegistration || (await navigator.serviceWorker.getRegistration('/'))
		const subscription = await registration?.pushManager.getSubscription()
		if (subscription) {
			await this.unregisterDirectSubscription(subscription.endpoint)
			await subscription.unsubscribe()
		}
		localStorage.removeItem(this.storageKey)
		localStorage.removeItem(this.vapidStorageKey)
		this.token = null
	}

	private async unregisterDirectSubscription(endpoint: string): Promise<void> {
		await this.requestDirectWebPush('/api/method/dreammonks_custom.api.unsubscribe_push', {
			endpoint,
		})
	}

	private async requestDirectWebPush(url: string, body: Record<string, unknown>): Promise<void> {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Frappe-CSRF-Token': window.csrf_token || '',
			},
			body: JSON.stringify(body),
		})
		const result = await response.json()
		if (!response.ok || result.exc)
			throw new Error(result.exception || 'Failed to update Web Push subscription')
	}

	private keysMatch(
		existingKey: ArrayBuffer | null,
		requestedKey: Uint8Array<ArrayBuffer>,
	): boolean {
		if (!existingKey) return false
		const existing = new Uint8Array(existingKey)
		return (
			existing.length === requestedKey.length &&
			existing.every((value, index) => value === requestedKey[index])
		)
	}

	private subscriptionUsesCurrentKey(
		subscription: PushSubscription,
		encodedPublicKey: string,
		publicKey: Uint8Array<ArrayBuffer>,
	): boolean {
		const storedPublicKey = localStorage.getItem(this.vapidStorageKey)
		if (storedPublicKey) return storedPublicKey === encodedPublicKey

		// Some browsers expose a null or normalized applicationServerKey even for
		// a valid subscription. An endpoint persisted by this client is a stronger
		// compatibility marker and lets existing installations migrate once to the
		// explicit VAPID marker without churning their subscription on every mount.
		const storedEndpoint = localStorage.getItem(this.storageKey)
		if (
			storedEndpoint === subscription.endpoint ||
			this.keysMatch(subscription.options.applicationServerKey, publicKey)
		) {
			localStorage.setItem(this.vapidStorageKey, encodedPublicKey)
			return true
		}

		return false
	}

	private urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
		const padding = '='.repeat((4 - (value.length % 4)) % 4)
		const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
		const rawData = window.atob(base64)
		return Uint8Array.from(rawData, (character) => character.charCodeAt(0))
	}

	// Register Token Handler
	async registerTokenHandler(token: string): Promise<boolean> {
		try {
			const response = await fetch(
				'/api/method/frappe.push_notification.subscribe?fcm_token=' +
					token +
					'&project_name=' +
					this.projectName,
				{
					method: 'GET',
					headers: { 'Content-Type': 'application/json' },
				},
			)
			return response.status === 200
		} catch (e) {
			console.error(e)
			return false
		}
	}

	// Unregister Token Handler
	async unregisterTokenHandler(token: string): Promise<boolean> {
		try {
			const response = await fetch(
				'/api/method/frappe.push_notification.unsubscribe?fcm_token=' +
					token +
					'&project_name=' +
					this.projectName,
				{
					method: 'GET',
					headers: {
						'Content-Type': 'application/json',
					},
				},
			)
			return response.status === 200
		} catch (e) {
			console.error(e)
			return false
		}
	}
}

export default FrappePushNotification

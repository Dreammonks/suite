import { describe, expect, it } from 'vitest'

import { resolveMailAccessRedirect } from './navigation'

describe('Mail access redirects', () => {
	it('sends an unconfigured member to the setup-required page', () => {
		expect(resolveMailAccessRedirect({}, { is_jmap_configured: false })).toEqual({
			name: 'mail-setup-required',
		})
	})

	it('allows an unconfigured member to remain on the setup-required page', () => {
		expect(
			resolveMailAccessRedirect(
				{ allowUnconfiguredMail: true },
				{ is_jmap_configured: false },
			),
		).toBeUndefined()
	})

	it('keeps an unconfigured admin in the dashboard', () => {
		expect(
			resolveMailAccessRedirect(
				{ isDashboard: true },
				{ is_jmap_configured: false, is_suite_admin: true },
			),
		).toBeUndefined()
	})

	it('moves a configured user away from the setup-required page', () => {
		expect(
			resolveMailAccessRedirect(
				{ allowUnconfiguredMail: true },
				{ is_jmap_configured: true },
			),
		).toEqual({ name: 'mail-root-shortcut' })
	})
})

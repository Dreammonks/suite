import type { RouteLocationRaw } from 'vue-router'

type MailAccessMeta = {
	allowUnconfiguredMail?: boolean
	isDashboard?: boolean
}

type MailAccessUser = {
	is_jmap_configured?: boolean
	is_suite_admin?: boolean
}

/** Decide only the account-configuration redirects used by the Mail guard. */
export const resolveMailAccessRedirect = (
	meta: MailAccessMeta,
	user: MailAccessUser,
): RouteLocationRaw | undefined => {
	if (user.is_jmap_configured) {
		if (meta.allowUnconfiguredMail) return { name: 'mail-root-shortcut' }
		return
	}

	if (user.is_suite_admin) {
		if (meta.isDashboard) return
		return { name: 'mail-overview' }
	}

	if (meta.allowUnconfiguredMail) return
	return { name: 'mail-setup-required' }
}

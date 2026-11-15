<template>
	<div class="flex min-h-full items-center justify-center bg-surface-gray-1 px-4 py-12">
		<div class="w-full max-w-md rounded-xl bg-surface-base p-8 text-center shadow-sm">
			<MailLogo class="mx-auto h-10 w-10" />
			<h1 class="mt-5 text-2xl-semibold text-ink-gray-9">
				{{ __('Mail setup required') }}
			</h1>
			<p class="mt-3 text-base text-ink-gray-6">
				{{
					__(
						'Your Frappe account is active, but its mailbox has not been linked yet. Please contact your administrator.',
					)
				}}
			</p>
			<a
				href="/desk"
				class="mt-6 inline-flex h-8 items-center rounded bg-surface-gray-7 px-3 text-sm-medium text-ink-white hover:bg-surface-gray-6"
			>
				{{ __('Return to Desk') }}
			</a>
		</div>
	</div>
</template>

<script setup lang="ts">
import { usePageMeta } from 'frappe-ui'

import MailLogo from '@/apps/mail/components/Icons/MailLogo.vue'

usePageMeta(() => ({ title: __('Mail setup required') }))
</script>

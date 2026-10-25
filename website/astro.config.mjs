// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.psarelay.app',
	// Served at the root of docs.psarelay.app (custom domain; public/CNAME).
	integrations: [
		starlight({
			title: 'PSArelay',
			description: 'PSArelay — your Autotask, relayed to AI and automation. Free to self-host; hosted plans at psarelay.com.',
			logo: { src: './public/favicon.svg', replacesTitle: false },
			editLink: { baseUrl: 'https://github.com/GDSTechnology/psarelay/edit/main/website/' },
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/GDSTechnology/psarelay' }],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Configuration', slug: 'getting-started/configuration' },
						{ label: 'Self-hosted or hosted', slug: 'getting-started/hosting' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Connect your AI', slug: 'guides/connect' },
						{ label: 'Safety model', slug: 'guides/safety' },
						{ label: 'Postgres mirror', slug: 'guides/mirror' },
						{ label: 'Admin console', slug: 'guides/console' },
						{ label: 'Merges & bulk cleanup', slug: 'guides/bulk-cleanup' },
						{ label: 'Commerce', slug: 'guides/commerce' },
						{ label: 'Vendor billing', slug: 'guides/vendor-billing' },
						{ label: 'Throttling', slug: 'guides/throttling' },
					],
				},
				{
					label: 'Prompt Examples',
					items: [
						{ label: 'Overview', slug: 'examples/overview' },
						{ label: 'Companies & Contacts', slug: 'examples/companies-contacts' },
						{ label: 'Tickets & Support', slug: 'examples/tickets' },
						{ label: 'Projects & Tasks', slug: 'examples/projects-tasks' },
						{ label: 'Time & Billing', slug: 'examples/time-billing' },
						{ label: 'Notes & Attachments', slug: 'examples/notes-attachments' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Tools', slug: 'reference/tools' },
						{ label: 'Resources', slug: 'reference/resources' },
						{ label: 'Transports', slug: 'reference/transports' },
					],
				},
			],
		}),
	],
});

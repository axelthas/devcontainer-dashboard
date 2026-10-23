<script lang="ts">
	import { LockKeyhole } from 'lucide-svelte';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}

	let { data, form }: Props = $props();
</script>

<svelte:head>
	<title>Sign in | Devcontainer Dashboard</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main
	class="flex min-h-screen items-center justify-center bg-[#eceff4] px-6 py-12 text-[#2e3440] dark:bg-[#2e3440] dark:text-[#d8dee9]"
>
	<section class="w-full max-w-sm" aria-labelledby="login-title">
		<div class="mb-8 flex items-center gap-3">
			<div class="rounded-lg bg-[#88c0d0] p-2.5 shadow-md">
				<LockKeyhole size={24} class="text-[#2e3440]" />
			</div>
			<div>
				<h1 id="login-title" class="text-xl font-bold text-[#2e3440] dark:text-[#eceff4]">
					Devcontainer Dashboard
				</h1>
				<p class="text-sm text-[#4c566a] dark:text-[#d8dee9]/70">
					Enter your password to continue.
				</p>
			</div>
		</div>

		<form method="POST" class="space-y-5">
			<input type="hidden" name="next" value={data.next} />
			<label class="block">
				<span class="mb-2 block text-sm font-semibold">Password</span>
				<input
					type="password"
					name="password"
					autocomplete="current-password"
					required
					aria-invalid={form?.message ? 'true' : undefined}
					aria-describedby={form?.message ? 'login-error' : undefined}
					class="w-full rounded-md border border-[#d8dee9] bg-white px-3 py-2.5 text-[#2e3440] shadow-sm outline-none focus:border-[#5e81ac] focus:ring-2 focus:ring-[#81a1c1]/40 dark:border-[#4c566a] dark:bg-[#3b4252] dark:text-[#eceff4]"
				/>
			</label>

			{#if form?.message}
				<p id="login-error" class="text-sm font-medium text-[#bf616a]" role="alert">
					{form.message}
				</p>
			{/if}

			<button
				type="submit"
				class="w-full rounded-md bg-[#5e81ac] px-4 py-2.5 font-semibold text-white shadow-sm transition-colors hover:bg-[#81a1c1] focus:ring-2 focus:ring-[#81a1c1] focus:ring-offset-2 focus:outline-none dark:ring-offset-[#2e3440]"
			>
				Sign in
			</button>
		</form>
	</section>
</main>

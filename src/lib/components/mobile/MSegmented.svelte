<script lang="ts" generics="T extends string">
	/** A filter with two to four equal options. */
	interface Props {
		label: string;
		options: { value: T; label: string }[];
		value: T;
		onChange: (value: T) => void;
	}
	let { label, options, value, onChange }: Props = $props();
</script>

<div
	role="radiogroup"
	aria-label={label}
	class="mx-4 mb-3 grid rounded-[10px] bg-m-raised/70 p-[3px]"
	style:grid-template-columns={`repeat(${options.length}, minmax(0, 1fr))`}
>
	{#each options as option (option.value)}
		<button
			type="button"
			role="radio"
			aria-checked={value === option.value}
			onclick={() => onChange(option.value)}
			class="min-h-11 truncate rounded-[8px] px-1 text-[14px] font-semibold {value === option.value
				? 'bg-m-surface text-m-ink shadow-sm'
				: 'text-m-dim'}">{option.label}</button
		>
	{/each}
</div>

---
applyTo: "**/*.svelte"
---
# Svelte Component Conventions

## Svelte 5 Runes (enforced project-wide)

- Use `$props()`, `$state`, `$derived`, `$effect` — never legacy `export let` or `$:` reactive statements
- Type props with `interface Props` and destructure: `let { prop1, prop2 }: Props = $props()`
- Use `$derived` for computed values, `$derived.by(() => { ... })` for multi-line derivations
- Use `$effect` for side effects; return a cleanup function when needed

## Styling

- **Nord palette only** via Tailwind arbitrary hex values (e.g., `bg-[#2e3440]`, `text-[#d8dee9]`)
- Support both dark and light modes using `dark:` variants
- No custom Tailwind theme config — always use arbitrary values with Nord hex codes
- Key Nord colors: `#2e3440` (polar night), `#3b4252`, `#434c5e`, `#4c566a`, `#d8dee9` (snow storm), `#e5e9f0`, `#eceff4`, `#8fbcbb` (frost), `#88c0d0`, `#81a1c1`, `#5e81ac`

## Component Patterns

- Icons from `lucide-svelte` — import individually (e.g., `import { Play, Square } from 'lucide-svelte'`)
- Container actions: `fetch('/api/containers/{id}/{action}', { method: 'POST' })` then call `onRefresh` callback
- Port labels/icons come from `$lib/portConfig.ts` (`PORT_MAP`) — don't hardcode port labels
- Use `$lib/types.ts` for shared interfaces (`ContainerData`, `LocalWorkspaceData`, etc.)

## Server Boundary

- Never import from `$lib/server/` in component files — those are server-only modules
- Data flows via SvelteKit `load` functions or client-side `fetch` to API routes

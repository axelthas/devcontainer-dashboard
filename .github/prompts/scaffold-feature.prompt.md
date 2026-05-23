---
description: 'Scaffold a new dashboard feature end-to-end. Use when: adding a new feature, creating a new dashboard section, adding a new API endpoint with UI.'
---

# Scaffold Dashboard Feature

Create the full vertical slice for a new dashboard feature following project conventions.

## Steps

1. **Define types** in `src/lib/types.ts` — add interfaces for the new data model
2. **Server logic** in `src/lib/server/` — create a module if the feature needs server-side data loading
3. **API route** in `src/routes/api/` — create `+server.ts` with GET/POST handlers
4. **SSR loader** — add data to `src/routes/+page.server.ts` if the feature appears on the main dashboard
5. **Component** in `src/lib/components/` — Svelte 5 runes, Nord palette, `interface Props`
6. **Integrate** into `src/routes/+page.svelte` — import component, wire up data and callbacks
7. **Tests** — add a `.spec.ts` (server) or `.svelte.spec.ts` (component) in the appropriate location

## Checklist

- [ ] Types added to `src/lib/types.ts`
- [ ] Server module created (if needed)
- [ ] API route with proper error handling
- [ ] Component uses `$props()`, `$state`, `$derived`
- [ ] Nord hex colors only (arbitrary Tailwind values)
- [ ] Dark/light mode supported via `dark:` variants
- [ ] `onRefresh` callback pattern for mutation actions
- [ ] At least one assertion per test (`requireAssertions` is enabled)
- [ ] Run `svelte-autofixer` on any `.svelte` files

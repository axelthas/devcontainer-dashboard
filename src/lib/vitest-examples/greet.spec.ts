/**
 * EXAMPLE TEST — Server project (Node environment).
 *
 * This file demonstrates how to write a basic Vitest unit test for a plain
 * TypeScript module. It runs in the "server" test project (see vite.config.ts).
 *
 * Use this as a template when adding tests for server-side utilities,
 * API route helpers, or any non-Svelte module.
 */
import { describe, it, expect } from 'vitest';
import { greet } from './greet';

describe('greet', () => {
	it('returns a greeting string with the given name', () => {
		expect(greet('Svelte')).toBe('Hello, Svelte!');
	});
});

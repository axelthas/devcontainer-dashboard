// Guard the shared authentication-state type against an inferred-union regression.
//
// Usage: node --test scripts/tests/auth-state.test.mjs with project TypeScript installed.
// Extract the real auth.ts state declarations into a temporary strict TypeScript
// program. Check assigning and clearing the optional verifier, then remove the type
// annotation to prove that the original TS2339 regression is detected.
// No server is started and no real authentication or cryptography is exercised.
// The Buffer alias models only the state shape. Temporary source files are removed
// by node:test cleanup. This is not a full application type-check or security test.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

test('shared auth state supports the optional verifier under strict TypeScript checking', (t) => {
	const source = readFileSync(new URL('../../src/lib/server/auth.ts', import.meta.url), 'utf8');
	// Compile the actual state declaration in isolation from Node and Svelte.
	// The Buffer alias is sufficient for the state shape; no crypto implementation is mocked.
	const state = source.slice(
		source.indexOf('interface LoginAttempt'),
		source.indexOf('function configuredPassword')
	);
	const dir = mkdtempSync(join(tmpdir(), 'ddash-auth-types-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, 'state.ts');
	// Write a temporary state declaration, compile it with strict no-emit settings, and return diagnostics.
	// Call with both the typed declaration and its regression variant to prove the test is meaningful.
	function diagnostics(declaration) {
		writeFileSync(
			path,
			`export {};\ntype Buffer = Uint8Array;\n${declaration}
authState.passwordVerifier = Promise.resolve({ salt: new Uint8Array(), key: new Uint8Array() });
authState.passwordVerifier = undefined;
`
		);
		const program = ts.createProgram([path], {
			strict: true,
			noEmit: true,
			types: [],
			target: ts.ScriptTarget.ES2020
		});
		return ts.getPreEmitDiagnostics(program);
	}
	const fixed = diagnostics(state);
	assert.deepEqual(
		fixed.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n')),
		[]
	);
	// Prove this test detects the original inferred-union regression.
	const original = diagnostics(state.replace('const authState: AuthState =', 'const authState ='));
	assert.ok(original.some((entry) => entry.code === 2339));
});

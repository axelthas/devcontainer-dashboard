/**
 * Verify display-only binding metadata for live and stopped Docker containers.
 * Run with Node's type stripping; no Docker or npm dependencies are required.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { publishedBindings } from '../../src/lib/server/publishedBindings.ts';

 test('live bindings preserve IPv4, IPv6 and transport without collapsing addresses', () => {
	assert.deepEqual(
		publishedBindings([
			{ PrivatePort: 8080, PublicPort: 18080, IP: '0.0.0.0', Type: 'tcp' },
			{ PrivatePort: 8080, PublicPort: 18080, IP: '::', Type: 'tcp' },
			{ PrivatePort: 9001, PublicPort: 19001, IP: '127.0.0.1', Type: 'tcp' },
			{ PrivatePort: 53, PublicPort: 1053, IP: '0.0.0.0', Type: 'udp' },
			{ PrivatePort: 80, Type: 'tcp' }
		]),
		[
			{ containerPort: '8080', hostPort: '18080', hostIp: '0.0.0.0', protocol: 'tcp' },
			{ containerPort: '8080', hostPort: '18080', hostIp: '::', protocol: 'tcp' },
			{ containerPort: '9001', hostPort: '19001', hostIp: '127.0.0.1', protocol: 'tcp' },
			{ containerPort: '53', hostPort: '1053', hostIp: '0.0.0.0', protocol: 'udp' }
		]
	);
});

test('stopped bindings preserve configured addresses and do not invent allocated dynamic ports', () => {
	assert.deepEqual(
		publishedBindings([], {
			'8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18080' }],
			'9001/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }]
		}),
		[
			{ containerPort: '8080', hostPort: '18080', hostIp: '0.0.0.0', protocol: 'tcp' },
			{ containerPort: '9001', hostPort: 'dynamic', hostIp: '127.0.0.1', protocol: 'tcp' }
		]
	);
	assert.deepEqual(publishedBindings(undefined), []);
});

test('SSR and polling share the binding mapper and both row types show the metadata', async () => {
	for (const path of ['src/routes/+page.server.ts', 'src/routes/api/containers/+server.ts']) {
		const source = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
		assert.match(
			source,
			/portBindings: publishedBindings\(c\.Ports, inspectMap\.get\(c\.Id\)\?\.HostConfig\?\.PortBindings\)/
		);
	}
	for (const [name, component] of [
		['SandboxRow', 'PortLedger'],
		['DevcontainerRow', 'PublishedPorts']
	]) {
		const source = await readFile(
			new URL(`../../src/lib/components/${name}.svelte`, import.meta.url),
			'utf8'
		);
		assert.match(source, new RegExp(`<${component}\\s+bindings=\\{container\\.portBindings\\}`));
	}
});

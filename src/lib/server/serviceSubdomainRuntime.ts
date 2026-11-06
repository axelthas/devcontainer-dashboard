/**
 * Production wiring for wildcard service subdomains: Docker validation for launches,
 * one HTTPS listener for every service, and certificate reload after renewal.
 * Vite does not start this listener; use the compiled production entry point.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import docker from './docker.js';
import { inspectServiceBinding, resolveServiceScheme } from './serviceGateway.js';
import { resolveServicePorts } from './serviceGatewayRuntime.js';
import { issueServiceLaunch } from './serviceOriginAuth.js';
import { parseSubdomainConfig, serviceOrigin } from './serviceSubdomains.js';
import { createSubdomainGateway } from './serviceSubdomainGateway.js';

const CERT_CHECK_MS = 10 * 60_000;

export type SubdomainLaunch =
	| { status: 'ok'; target: string }
	| { status: 'disabled' | 'port-not-allowed' | 'unknown-container' | 'not-running' | 'no-published-binding' };

/** Read current configuration; an invalid configuration fails loudly. */
export function subdomainConfig() {
	return parseSubdomainConfig(process.env);
}

/** Validate the container now and return a one-use, origin-bound launch URL. */
export async function subdomainLaunch(
	containerId: string,
	containerPort: string,
	parent: string
): Promise<SubdomainLaunch> {
	const config = subdomainConfig();
	if (!config) return { status: 'disabled' };
	if (!resolveServiceScheme(resolveServicePorts(), containerPort)) return { status: 'port-not-allowed' };
	let info;
	try {
		info = await docker.getContainer(containerId).inspect();
	} catch {
		return { status: 'unknown-container' };
	}
	const binding = inspectServiceBinding(info, containerId, containerPort);
	if (binding.state !== 'ok') return { status: binding.state };
	// The grant holds the full ID, so a recreated container never inherits a session.
	const route = {
		origin: serviceOrigin(config, info.Id.slice(0, 12), containerPort),
		containerId: info.Id,
		containerPort
	};
	return { status: 'ok', target: issueServiceLaunch(route, parent) };
}

/** Load the PEM pair; return modification times for later reload checks. */
function readPair(certFile: string, keyFile: string) {
	return {
		cert: readFileSync(certFile),
		key: readFileSync(keyFile),
		stamp: `${statSync(certFile).mtimeMs}:${statSync(keyFile).mtimeMs}`
	};
}

/** Start the shared listener. Configuration or certificate errors stop startup. */
export async function startServiceSubdomains(): Promise<Server | undefined> {
	const config = subdomainConfig();
	if (!config) return undefined;
	const certFile = process.env.SERVICE_TLS_CERT_FILE;
	const keyFile = process.env.SERVICE_TLS_KEY_FILE;
	if (!certFile || !keyFile) {
		throw new Error('Service subdomains require SERVICE_TLS_CERT_FILE and SERVICE_TLS_KEY_FILE.');
	}
	const listenPort = Number(process.env.SERVICE_SUBDOMAIN_LISTEN_PORT || '4443');
	if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
		throw new Error('SERVICE_SUBDOMAIN_LISTEN_PORT must be from 1 to 65535.');
	}
	let pair = readPair(certFile, keyFile);
	const gateway = createSubdomainGateway({
		config,
		inspect: (id) => docker.getContainer(id).inspect(),
		upstreamHost: process.env.SERVICE_PROXY_HOST || undefined,
		ports: resolveServicePorts()
	});
	const server = createServer({ cert: pair.cert, key: pair.key }, gateway.handle);
	server.requestTimeout = 60_000;
	server.headersTimeout = 15_000;
	server.on('upgrade', gateway.upgrade);
	// Renewal writes new files on the host; swap them in without a restart.
	const reload = setInterval(() => {
		try {
			const next = readPair(certFile, keyFile);
			if (next.stamp === pair.stamp) return;
			server.setSecureContext({ cert: next.cert, key: next.key });
			pair = next;
			console.log('Service subdomain certificate reloaded.');
		} catch (error) {
			console.error('Service subdomain certificate reload failed:', error);
		}
	}, CERT_CHECK_MS);
	reload.unref();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(listenPort, process.env.SERVICE_SUBDOMAIN_LISTEN_ADDRESS || '0.0.0.0', resolve);
	});
	console.log(`Service subdomains ready: https://<port>-<container>.${config.baseDomain}:${config.publicPort}`);
	return server;
}

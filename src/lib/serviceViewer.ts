/**
 * Client-safe service viewer contract and the texts for its failure reasons. The server
 * side lives in `$lib/server/serviceViewer`; this module must never import server modules.
 */

/** What a viewer renders for one service identity. */
export interface ViewerContract {
	kind: 'proxy' | 'legacy' | 'unsupported' | 'unavailable' | 'proxy-disabled';
	target?: string;
	directUrl?: string;
	containerId?: string;
	containerPort?: string;
	reason?: string;
}

/** Operator-facing text per reason code. */
export const UNAVAILABLE_REASONS: Record<string, string> = {
	'unknown-container': 'This container is no longer available.',
	'not-running': 'The container is not running. Start it from the dashboard.',
	'no-published-binding': 'The service has no published port.',
	'port-not-allowed': 'This port is not enabled as a web service.',
	'proxy-disabled': 'The service gateway is disabled on this dashboard (SERVICE_PROXY_ENABLED).',
	'wildcard-binding-disabled':
		'This service is published on all interfaces. Restart the dashboard with --tailscale-allow-wildcard-bindings, or publish the service on loopback. HTTPS proxying does not close the original port.',
	'unsupported-binding':
		'This binding is not supported. Use IPv4 loopback, or IPv4 wildcard publishing with the compatibility option.',
	'ambiguous-binding': 'This service has multiple published host ports. Use one host port.',
	'invalid-service-binding': 'Docker reported an invalid published host port.',
	'service-unreachable':
		'The published service is unreachable through host loopback. Check that it is ready and that the dashboard uses the supported Linux host-network deployment.',
	'tailscale-allocation-failed':
		'Could not prepare the Tailscale HTTPS service origin. Check the dashboard logs, Tailscale permissions, and available HTTPS ports.',
	'missing-identity': 'No service selected.',
	'local-ai-not-ready': 'The local AI service is not ready. Check the dashboard logs.'
};

/** The text for an unavailable viewer; unknown codes get a generic text. */
export function unavailableText(viewer: ViewerContract): string {
	return (
		(viewer.kind === 'unavailable' && viewer.reason && UNAVAILABLE_REASONS[viewer.reason]) ||
		'This service is not available.'
	);
}

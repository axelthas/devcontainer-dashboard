/** Dashboard-only, per-window draft launch for OpenChamber 2.7.1. No session API calls. */
export type DashboardDraftOptions = {
	automatic: true;
	target: 'project';
	directoryOverride: string;
	preserveDirectoryOverride: true;
	routeScoped: true;
};

/** Query values are decoded once by URLSearchParams. Preserve literal path whitespace. */
export function dashboardDraftDirectory(params: URLSearchParams): string | null {
	const path = params.get('directory');
	if (
		params.get('new') !== '1' ||
		!path ||
		!path.startsWith('/') ||
		path.length > 4096 ||
		path.includes('\0')
	)
		return null;
	return path;
}

/** Startup restoration must be skipped completely, not merely delayed until after route handling. */
export function readDashboardDraft(): string | null {
	return typeof window === 'undefined'
		? null
		: dashboardDraftDirectory(new URLSearchParams(window.location.search));
}

/** Open the app's normal unsent draft. Its existing first-send flow materializes the conversation. */
export function initializeDashboardDraft(
	params: URLSearchParams,
	openDraft: (options: DashboardDraftOptions) => void
): boolean {
	const directory = dashboardDraftDirectory(params);
	if (!directory) return false;
	openDraft({
		automatic: true,
		target: 'project',
		directoryOverride: directory,
		preserveDirectoryOverride: true,
		routeScoped: true
	});
	return true;
}

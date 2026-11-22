import { loadServiceViewer } from '$lib/server/serviceViewer';
import type { PageServerLoad } from './$types';

// Same contract and validation as the desktop viewer; only the screen differs.
export const load: PageServerLoad = ({ url }) => loadServiceViewer(url);

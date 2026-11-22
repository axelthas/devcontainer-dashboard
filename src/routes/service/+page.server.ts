import { loadServiceViewer } from '$lib/server/serviceViewer';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => loadServiceViewer(url);

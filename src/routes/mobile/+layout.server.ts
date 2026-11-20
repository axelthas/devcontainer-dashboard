import { loadDashboardData } from '$lib/server/dashboardData';
import type { LayoutServerLoad } from './$types';

// The layout loads once; screens below it share the data and the polling state.
export const load: LayoutServerLoad = () => loadDashboardData();

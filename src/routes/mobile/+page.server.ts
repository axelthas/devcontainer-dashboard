import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The mobile interface opens on its first tab.
export const load: PageServerLoad = () => redirect(307, '/mobile/containers');

/** Open a container web service in the phone viewer, inside the app. */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { ServiceLaunchTarget } from '$lib/serviceLaunch';
import { mobileServiceHref } from './serviceView';

/** Navigate to the viewer screen; Back returns to the screen that called this. */
export function openMobileService(target: ServiceLaunchTarget): void {
	void goto(resolve(mobileServiceHref(target, window.location.hostname)));
}

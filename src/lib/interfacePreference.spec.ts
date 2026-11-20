import { describe, expect, it } from 'vitest';
import { isPhoneUserAgent, parseInterfaceChoice, preferredInterface } from './interfacePreference';

const IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD =
	'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE =
	'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const ANDROID_TABLET =
	'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const DESKTOP =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

describe('interface preference', () => {
	it('detects phones only', () => {
		expect(isPhoneUserAgent(IPHONE)).toBe(true);
		expect(isPhoneUserAgent(ANDROID_PHONE)).toBe(true);
		expect(isPhoneUserAgent(IPAD)).toBe(false);
		expect(isPhoneUserAgent(ANDROID_TABLET)).toBe(false);
		expect(isPhoneUserAgent(DESKTOP)).toBe(false);
		expect(isPhoneUserAgent(null)).toBe(false);
	});

	it('accepts only the two choices', () => {
		expect(parseInterfaceChoice('mobile')).toBe('mobile');
		expect(parseInterfaceChoice('desktop')).toBe('desktop');
		expect(parseInterfaceChoice('tablet')).toBeNull();
		expect(parseInterfaceChoice(undefined)).toBeNull();
	});

	it('lets an explicit choice win over the device default', () => {
		expect(preferredInterface(undefined, IPHONE)).toBe('mobile');
		expect(preferredInterface('desktop', IPHONE)).toBe('desktop');
		expect(preferredInterface('mobile', DESKTOP)).toBe('mobile');
		expect(preferredInterface('garbage', DESKTOP)).toBe('desktop');
	});
});

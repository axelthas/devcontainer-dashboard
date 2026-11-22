/**
 * Generate the raster app icons from the DevHarbour puffin vector.
 *
 * iOS Safari ignores SVG icons for "Add to Home Screen". Without a PNG
 * apple-touch-icon it uses a page screenshot or a letter tile. This script
 * renders `src/lib/assets/favicon.svg` into `static/apple-touch-icon.png`.
 *
 * The icon is a full square without transparency: iOS applies its own corner
 * mask and fills transparent pixels with black. The puffin tile is scaled
 * into the square so that the iOS corner mask does not cut its frame.
 *
 * Usage: node scripts/generate-app-icons.mjs
 * Requires the Playwright Chromium browser (`npx playwright install chromium`).
 * Commit the generated PNG together with any change to the vector.
 */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const SOURCE = 'src/lib/assets/favicon.svg';
/** Nord polar night, the same colour as the tile background in the vector. */
const BACKGROUND = '#2e3440';
/** Share of the square that the puffin tile fills. */
const ARTWORK_SCALE = 0.84;
const ICONS = [{ path: 'static/apple-touch-icon.png', size: 180 }];

/**
 * Build the HTML page that shows the vector centred on an opaque square.
 * @param {string} svg Vector source text.
 * @returns {string} HTML document.
 */
function iconPage(svg) {
	const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
	const inset = ((1 - ARTWORK_SCALE) / 2) * 100;
	return `<!doctype html><html><body style="margin:0;overflow:hidden;background:${BACKGROUND}">
<img src="${source}" alt="" style="position:absolute;left:${inset}%;top:${inset}%;width:${ARTWORK_SCALE * 100}%;height:${ARTWORK_SCALE * 100}%">
</body></html>`;
}

/**
 * Render one icon size to a PNG file.
 * @param {import('playwright').Browser} browser Running browser.
 * @param {string} html Icon page.
 * @param {{ path: string, size: number }} icon Output path and edge length in pixels.
 */
async function renderIcon(browser, html, icon) {
	const page = await browser.newPage({
		viewport: { width: icon.size, height: icon.size },
		deviceScaleFactor: 1
	});
	try {
		await page.setContent(html);
		// Wait until the vector is decoded, so the screenshot never shows an empty square.
		await page.locator('img').evaluate((image) => image.decode());
		await page.screenshot({ path: icon.path, omitBackground: false });
		console.log(`${icon.path} (${icon.size} x ${icon.size})`);
	} finally {
		await page.close();
	}
}

/** Render every configured icon from the vector source. */
async function main() {
	const html = iconPage(await readFile(SOURCE, 'utf8'));
	const browser = await chromium.launch();
	try {
		for (const icon of ICONS) await renderIcon(browser, html, icon);
	} finally {
		await browser.close();
	}
}

await main();

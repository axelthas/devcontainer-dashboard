# Phone layout: round 3

The previous layout passed the document-width check while its overflow-hidden cards still
clipped action buttons. Real iPhone screenshots exposed this. A passing page-width assertion
is not evidence that every control is reachable.

## Structure

- Below 768 px, devcontainers use a phone row independently of the saved desktop grid/list
  preference. The desktop view toggle is hidden; its preference is not overwritten.
- Project names get a full text column. The runtime container name has a separate line.
- The fixed three-column action bar contains Open with, Terminal (Start while stopped),
  and a 44 px actions trigger. Services, Brain access, lifecycle and network actions are in
  that sheet. Nested menu leaf actions close their ancestor sheets before opening a terminal.
- Native popovers escape clipped containers. On phones they become bottom sheets, bounded
  to the visual viewport. Native light-dismiss, Escape, keyboard navigation and an explicit
  Close menu action remain available.
- Workspace identities wrap at punctuation. Repo count, Bootstrap version and solution are
  grouped metadata. Each workspace bounds its sticky header. Its phone header has one More
  trigger; Open with is inside. Repos have a name line, then a ref and More line. Build,
  config, Sandbox and Open with controls remain in the repo sheet.
- Stack lifecycle and removal actions move into one header menu. Removal still uses the
  existing server-resolved SandboxRemoveDialog preview and confirmation. No deletion or
  lifecycle policy changes are introduced.
- Detail labels sit above readable values on phones. Devcontainer paths have explicit Copy
  actions. Commands are horizontally scrollable, with their original string and Copy action.
  PortLedger renders each published binding once (including exposure and access information).
- The document root follows the selected theme for Safari's safe-area painting. The collapsed
  terminal dock has a label and count; the home-indicator safe-area padding is retained.

## Regression coverage

`mobile-layout.e2e.ts` uses synthetic identities and the actual production components on
`/demo/mobile`. That route returns 404 unless MOBILE_LAYOUT_FIXTURES=1, enabled only by the
Playwright server configuration. Test API requests are fixed; unexpected mutations fail.
The tests intercept API mutations instead of running fixture actions against Docker.

- 320, 393 and 768 px: collapsed/expanded container rows, workspace/repo rows and service rows.
- Controls are checked against every horizontally clipping ancestor and the viewport, including
  controls below the fold. A detector self-test deliberately clips a button while keeping the
  document width unchanged.
- Phone buttons are checked for 44 x 44 px hit areas, both before and after opening sheets.
- Five 393 px screenshot baselines: container details/actions, workspace repos, repo actions,
  service details. Review their visual diff before accepting a new baseline.
- Nested service and Open with menus remain reachable and dismiss their parent sheets.
- Clipboard checks compare the entire path and exact shell command, not just displayed text.

Run against the built custom server:

```sh
npx playwright test src/lib/testing/mobile.e2e.ts src/lib/testing/mobile-layout.e2e.ts --workers=1
```

To propose new visual baselines:

```sh
npx playwright test src/lib/testing/mobile-layout.e2e.ts --update-snapshots --workers=1
```

These are Chromium emulation checks. They do not certify Safari's software keyboard,
status-bar painting, Home Screen installation, or real-device touch behaviour. The existing
VisualViewport keyboard test is simulated. Real iPhone acceptance is still required.

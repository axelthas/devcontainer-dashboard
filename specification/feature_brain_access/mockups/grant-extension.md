# Mockup: extend a Brain grant

Issue: [#67](https://github.com/axelthas/devcontainer-dashboard/issues/67). Status: design proposal, not implemented.

Brain loses access when its grant expires. The running commands then stop, and Brain cannot continue. Today the operator must revoke the grant and create a new one. This mockup lets the operator extend an active grant before it ends.

## Open the mockup

[`grant-extension.html`](grant-extension.html) is one static file. It loads no network resources and no application code.

1. Download the file from the branch.
2. Open it in a browser.
3. Use the bar at the top to select the view, the state, the theme, and the design notes.

URL parameters select a state directly, for example `grant-extension.html?view=mobile&state=request`:

| Parameter | Values                                    |
| --------- | ----------------------------------------- |
| `view`    | `desktop` (default), `mobile`             |
| `state`   | `ending` (default), `request`, `extended` |
| `theme`   | `dark` (default), `light`                 |
| `menu`    | `1` opens the desktop Extend menu         |
| `notes`   | `0` hides the numbered design notes       |

The mockup clock starts at 13:37:48 and runs in real time. In the `ending` state, the grant ends after 4 minutes 12 seconds, and the running command shows as stopped.

## Design

1. **Only the operator extends access.** Extend sits next to Revoke on every active grant. It offers the existing grant durations (15 minutes, 1 hour, 4 hours) and shows the resulting end time for each.
2. **Warning before the end.** Five minutes before the end, the group shows a live countdown and the number of running commands that stop. The time bar turns amber. The warning has quick +15 min and +1 hour buttons.
3. **Visible with the pane closed.** The Brain chip on the container row turns amber. The Brain pane header shows `N ending soon`.
4. **Brain can ask, not extend (optional).** Brain can send a request for more time with a reason. The request shows in the container group. Nothing changes until the operator selects a duration. Dismiss tells Brain no.
5. **Every extension is recorded.** An extension is an audit entry, and the command timeline shows it.
6. **Phones.** The live strip shows the countdown and an Extend button. **Extend access** in the Brain tab opens a sheet with the same durations.

An expired grant cannot be extended. **Grant again** opens the normal grant dialog with its review of the user, the start directory and the reach.

## Proposed contract

These changes are not part of this pull request.

### Extension rule

```text
new_end = min(max(expires_at, now) + minutes, now + 240 minutes)
```

- The extension adds time to the current end. It does not restart the grant.
- Access never runs more than 4 hours ahead of now, the longest grant duration.
- The server refuses the extension when `new_end` is not later than `expires_at` (409).

### Dashboard API

`PATCH /api/brain/grants/[id]` with body `{ "minutes": 15 | 60 | 240 }`:

1. Prune expired grants. Refuse an unknown or expired grant (404).
2. Check the grant against live Docker state with `liveGrant()`. Refuse when the container stopped, restarted or was removed (410).
3. Apply the extension rule. Clear a pending request from Brain.
4. Record the audit entry `extend` with the detail `by 60 minutes, ends 14:42`.
5. Return the updated `BrainGrantView`.

The route uses the dashboard session and the existing origin check in `hooks.server.ts`. It does not review the reach again, because the container run, the user and the mounts are unchanged.

### Types

- `BrainGrantView.extensionRequest?: { minutes: BrainGrantMinutes; reason: string; at: string }`
- `BRAIN_GRANT_WARNING_MINUTES = 5` in `src/lib/brainTypes.ts`
- `BrainAccess.extend(grantId, minutes)` in `src/lib/brainAccess.svelte.ts`

### MCP (optional part)

- `list_targets` already returns the expiry. Add `seconds_left`.
- Results of `execute` and `read_output` add `grant_expires_at`, so Brain sees an extension without another `list_targets` call.
- New tool `request_more_time` with `target_id`, `minutes` (15, 60 or 240) and `reason` (non-blank, at most 200 characters):
  - It stores one pending request for each grant. A new request replaces the previous one.
  - It records the audit entry `request_more_time`.
  - It returns `{ "status": "pending" }`. It never changes the expiry.
  - The tool set grows from six tools to seven. The trust model text stays true: Brain cannot create, extend or widen grants.

## Open questions

1. Add the time to the current end (proposed), or set the end to now plus the duration?
2. Keep the 4-hour ceiling ahead of now?
3. Include `request_more_time` in the first implementation, or deliver the operator Extend control first?
4. Show a browser notification or a countdown in the page title when the Brain pane is closed?

## Implementation checklist

- `src/lib/server/brain/access.ts`: `extendGrant()` with the extension rule and the audit entry.
- `src/routes/api/brain/grants/[id]/+server.ts`: `PATCH` handler.
- `src/lib/components/BrainActivity.svelte`: Extend menu, warning band, request card, timeline entry.
- `src/lib/components/BrainAccessButton.svelte` and `BrainPane.svelte`: amber chip and `ending soon` count.
- `src/routes/mobile/brain/+page.svelte` and `MBrainStrip.svelte`: warning row, Extend access sheet, strip warning.
- `specification/feature_brain_access/feature_specification_brain_access.md`: grant lifetime, API table and tool table.
- Tests: `scripts/tests/brain-access.test.mjs` for the rule, the ceiling, the refused cases and the audit entry; browser tests for the menu, the warning and the phone sheet.

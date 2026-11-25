# Mockup: extend a Brain grant

Issue: [#67](https://github.com/axelthas/devcontainer-dashboard/issues/67). The behaviour is specified in [Grant extension](../feature_specification_brain_access.md#grant-extension).

[`grant-extension.html`](grant-extension.html) is the design mockup. It is one static file. It loads no network resources and no application code. The implementation is the authority where the two differ.

## Open the mockup

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

## Decisions

| Question                                      | Decision                                         |
| --------------------------------------------- | ------------------------------------------------ |
| Where does the extension start?               | At the current end of the grant.                 |
| Is there an upper limit?                      | No.                                              |
| Which parts ship?                             | The operator Extend control and Brain's request. |
| How does the operator notice an ending grant? | A browser notification, besides the dashboard.   |

# Mockup: Git ref menu

The behaviour is specified in [Feature specification: Git ref menu](../feature_specification_git_refs.md).

[`git-ref-menu.html`](git-ref-menu.html) is the design mockup. It is one static file. It loads no network resources and no application code. The implementation is the authority where the two differ.

## Open the mockup

1. Download the file from the branch.
2. Open it in a browser.
3. Type in the search field, use the arrow keys, press Fetch or Pull, and press outside the menu.

URL parameters select a state directly, for example `git-ref-menu.html?theme=light&q=feat`:

| Parameter | Values                                              |
| --------- | --------------------------------------------------- |
| `theme`   | `dark` (default), `light`                           |
| `q`       | Text for the search field                           |
| `state`   | `open` (default), `closed`, `fetched`, `pull-error` |
| `notes`   | `0` hides the numbered design notes                 |

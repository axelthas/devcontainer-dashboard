# Feature specification: Git ref menu

The Git ref menu is the branch control in a repository row of **Local workspaces**. It replaces the earlier branch picker. The mockup is [mockups/git-ref-menu.html](mockups/git-ref-menu.html); see [mockups/git-ref-menu.md](mockups/git-ref-menu.md).

## Problem

The earlier picker had these limits:

1. It showed local branches and tags only, in alphabetical order.
2. It did not show remote branches, so a colleague's branch needed a terminal.
3. It had no fetch or pull.
4. It had no search. Long lists needed scrolling.
5. A press outside the open picker did not close it.

## Behaviour

| ID    | Requirement                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GR-1  | The menu shows three sections in this order: **Local branches**, **Remote branches**, **Tags**.                                                                                           |
| GR-2  | Each section is ordered newest first. Branches use the committer date of their tip commit. Tags use their creation date (tagger date or commit date).                                     |
| GR-3  | Each row shows its age (for example `3h`, `2d`, `4mo`). The tooltip shows the full name, the short SHA and the full date.                                                                 |
| GR-4  | A search field at the top filters all three sections. Every word of the query must occur in the name, in any order, without case.                                                         |
| GR-5  | The search field has focus when the menu opens. ArrowUp and ArrowDown move the highlight. Enter checks out the highlighted ref. Escape closes the menu.                                   |
| GR-6  | **Fetch** runs `git fetch --all --prune`, then reads the refs again.                                                                                                                      |
| GR-7  | **Pull** runs `git pull --ff-only` on the current branch. It shows the commits behind the upstream. It is disabled on a detached HEAD, without an upstream, or when the upstream is gone. |
| GR-8  | A press outside the trigger and the menu closes the menu. A press on the trigger of another row closes this menu and opens the other one.                                                 |
| GR-9  | A remote branch row checks out a new local branch that tracks it. If a local branch with the same name exists, the row is marked `local` and checks out that local branch.                |
| GR-10 | Local rows show `↑ahead ↓behind` against their upstream, or `gone` when the upstream was deleted. The remote row of the current upstream is marked `upstream`.                            |
| GR-11 | A section shows at most 100 rows. The header then shows `100 of N`. The search finds the other rows.                                                                                      |
| GR-12 | The toolbar shows the time of the last fetch, from the modification time of `.git/FETCH_HEAD`.                                                                                            |

## Decisions

| Question                         | Decision                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| What does "ordered by age" mean? | Newest first. The branch that you worked on most recently is at the top.                               |
| Pull with merge or rebase?       | Neither. Fast-forward only. A diverged branch shows Git's refusal; resolve it in a terminal.           |
| Prune tags on fetch?             | No. `--prune` without `--tags` removes deleted remote-tracking branches only. Local tags stay.         |
| Credentials prompt?              | Never. Git runs with `GIT_TERMINAL_PROMPT=0`. A remote that needs a password fails with Git's message. |
| Network timeout?                 | 120 seconds for fetch and pull.                                                                        |
| Dirty working tree on checkout?  | Unchanged: the dashboard asks before a forced checkout.                                                |

## API

| Route                      | Change                                                                                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/repos/branches`  | Adds `refs: { local, remote, tags, lastFetchedAt }` (`RepoRefsResponse` in `src/lib/types.ts`). `branches` and `tags` stay for the mobile sheet. When `git for-each-ref` fails, `refs` is absent and `refsError` explains why; the menu then falls back to the name lists. |
| `POST /api/repos/checkout` | Accepts `remote` (for example `origin/feat/x`) besides `branch` and `tag`. The server validates the name against the listed remote branches.                                                                                                                               |
| `POST /api/repos/fetch`    | New. Body `{ path }`. Returns `{ success, output }`. Git failure: 502 with Git's message.                                                                                                                                                                                  |
| `POST /api/repos/pull`     | New. Body `{ path }`. Returns `{ success, output, currentBranch, upstream }`. Detached HEAD, no upstream or refused fast-forward: 409.                                                                                                                                     |

All routes accept only a path below `WORKSPACE_ROOT` (`src/lib/server/repoPath.ts`).

## Out of scope

- The mobile ref sheet (`src/routes/mobile/workspaces/[workspace]/[repo]/+page.svelte`). It keeps its search and receives the same response. Sections, ages, fetch and pull for mobile are a follow-up.
- The bootstrap provider picker in `BootstrapStatus.svelte`.
- Push, branch creation, branch deletion and stash.

## Verification

- `src/lib/server/git.spec.ts`: a temporary origin and clone with fixed dates. It checks the order of the three sections, annotated tag SHAs, fetch, fast-forward pull and the refusal of a diverged pull.
- `src/lib/gitRefs.spec.ts`: search, section order, row limit, fallback, ages and output summaries.
- `src/lib/components/GitRefMenu.svelte.spec.ts`: rendered section order, focus, search with keyboard checkout of a remote branch, outside press and Escape.

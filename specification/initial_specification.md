# DevHarbour product specification

## Purpose and scope

DevHarbour is a self-hosted dashboard for local Docker development environments.
It lets an operator discover and manage Dev Containers, Docker Compose sandboxes,
and local workspaces. The operator can open a terminal, editor, or published
service from the dashboard.

## Behavior

- The dashboard distinguishes Dev Containers, Docker services, and local
  workspaces. It shows container state and available actions. A local workspace
  can exist without a running container.
- Initial dashboard data comes from the server. The browser refreshes it through
  the containers endpoint. Container actions use the current server-side state
  rather than trusting the display alone.
- The desktop and mobile interfaces provide access to the same managed
  environments. They can present the available actions differently.
- Managed deployments support a host CLI and browser Settings. Saving settings
  does not recreate the running instance. Applying a change requires a separate
  reviewed operation.
- Brain shell access is optional and off by default. Enabling its listener does
  not grant access to any container. The operator grants access separately.

## Interfaces and constraints

| Contract | Reference |
| --- | --- |
| Initial dashboard data | [Page server loader](../src/routes/+page.server.ts) |
| Container refresh and actions | [Container API routes](../src/routes/api/containers/) |
| Shared response types | [Shared types](../src/lib/types.ts) |
| Production HTTP and terminal WebSocket entry point | [Custom server](../src/server.ts) and [build guidance](../AGENTS.md#build--test) |
| Installation and deployment | [Quickstart](../README.md#quickstart) and [CLI reference](../scripts/README.md) |

The application requires access to the local Docker daemon. Anyone who can sign
in with the dashboard password has operator access. Use localhost or a trusted
private network. The application does not provide tenant isolation.

See the [specification index](README.md) for feature behavior and the
[architecture reference](../ARCHITECTURE.md) for runtime structure.

## Out of scope

DevHarbour is not a multi-tenant container hosting platform. It does not provide
per-user roles or isolate operators from one another.

## Verification

Use a disposable workspace and container. Verify that the initial page and
refresh show the same container state, an action updates it, and a published
service is associated with the correct container. Use the built custom server
for terminal checks; Vite preview does not provide the production WebSocket path.

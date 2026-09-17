# Capability migration

Migrate the integration boundary, not the domain engine.

## Preserve

- capability-owned domain semantics and public tool behavior;
- domain tests and fixtures;
- capability-specific configuration and validation;
- provider/domain adapters that translate external behavior;
- domain readiness checks and lifecycle hooks that are actually needed.

## Replace with Platform

- application assembly and runtime startup;
- HTTP, MCP stdio/HTTP, OpenAPI, authentication, rate limiting, and error normalization;
- lifecycle state, cancellation, shutdown, scratch workspaces, and generic process/filesystem
  safety where Platform already supplies them;
- generic registry, transport, metadata, and deployment-contract validation;
- duplicated conformance tests;
- common CI, security, package, and release workflow logic.

## Sequence

1. Map existing tools, services, adapters, configuration, tests, and supported deployment shapes.
2. Define the tools with Platform schemas and preserve their domain handlers.
3. Compose services in `src/capability.ts`; add only truthful domain readiness/lifecycle hooks.
4. Replace custom startup with the Platform application helper and host-neutral stdio entrypoint.
5. Adopt testkit conformance beside—not instead of—domain tests.
6. Declare actual profiles and validate them with the pinned Platform contract.
7. Adopt reusable workflows and prove the packed package.

Do not require an existing capability to rewrite its domain engine. A justified non-TypeScript
worker may remain capability-owned; the Platform-facing TypeScript capability can supervise or
delegate to it through Platform process primitives and a narrow adapter. The worker does not own
transport, generic lifecycle, or agent-host composition.

Agent routing across capabilities, agent manifests/locks, registries, and host adapters do not
belong in a capability migration.

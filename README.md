# Agent Tool Capability Template

A thin, local-first GitHub template for one capability built on
[`@agent-tool-platform/runtime`](https://github.com/ashergarland/agent-tool-platform/tree/98ec8162fb11d5c04aee9e6f7b3625a472a0180d/packages/runtime).
It demonstrates one harmless read-only tool over stdio without copying runtime, transport,
lifecycle, filesystem, process, security, deployment-validation, or release machinery.

The checked-in package version is always `0.0.0-development`. A pushed stable `vX.Y.Z` tag is the
authoritative release version; the shared release workflow stamps package and server metadata only
on its runner.

## Start a capability

1. Select **Use this template** on GitHub and create an `agent-tool-server-*` repository.
2. Replace these template identities everywhere they occur:

   | Replace                               | With                                     |
   | ------------------------------------- | ---------------------------------------- |
   | `agent-tool-server-template`          | Repository and npm package name          |
   | `agent-tool-capability-template`      | Installed executable name                |
   | `io.github.ashergarland/...-template` | Stable capability ID                     |
   | `Thin Capability Template`            | Human-readable capability name           |
   | `https://github.com/.../...-template` | New public repository URL                |
   | `urn:io.github...template...`         | Capability-owned configuration schema ID |

   Update `package.json`, `server.json`, `capability-profiles.json`, `src/manifest.ts`, and
   `examples/central-registry-entry.json` together. Keep `0.0.0-development` in source.

3. Replace `src/domain/text-inspector.ts`, `src/tools/definitions.ts`, and
   `src/tools/guidance.ts` with the capability's domain behavior. Keep routing cases under
   `tests/fixtures/` truthful.
4. Run `npm ci`, then the validation commands below.

No generator, registry, monorepo conversion, agent manifest, or host adapter is involved.

## What belongs where

| Capability repository owns                                      | Agent Tool Platform owns                              |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| Tool definitions, schemas, handlers, and routing guidance       | Tool registry validation and transport publication    |
| Domain services and provider adapters                           | Application assembly, HTTP/MCP, OpenAPI, and auth     |
| Capability configuration and domain validation                  | Shared configuration, lifecycle, readiness, shutdown  |
| Domain readiness contributors and lifecycle hooks when required | Scratch, bounded filesystem/process, cancellation     |
| Domain tests and truthful profile metadata                      | Generic conformance, metadata/deployment validators   |
| Profile-specific deployment assets when actually supported      | Reusable CI, security, package, and release mechanics |

`src/capability.ts` is composition, not another abstraction layer. `src/stdio.ts` makes the single
Platform startup call. Do not rebuild either mechanism in capability code.

## Repository map

```text
src/
  capability.ts              capability composition
  domain/                    domain services and adapters
  tools/                     definitions, handlers, routing guidance
  manifest.ts                runtime identity
  public.ts                  package library exports
  stdio.ts                   host-neutral executable entrypoint
capability-profiles.json     public supported deployment shapes
schemas/                     capability-owned public configuration schemas
tests/unit/                  domain and capability truthfulness tests
tests/conformance/           reusable Platform contract checks
```

## Run the capability

Node.js 22 is required.

```bash
npm ci
npm run build
npm run mcp:stdio
```

The stdio executable is an MCP capability endpoint, not a VS Code, ChatGPT, Claude, or other agent
host. Any conforming client can launch it. Local execution binds no network listener and needs no
cloud account, container, provider credential, secret store, or infrastructure deployment.

The package also exports the capability definition and its domain types for tests or embedding.

## Profiles and deployment ownership

[`capability-profiles.json`](capability-profiles.json) declares one truthful `local-package`
profile:

```text
execution=local
delivery=package
access=local-process
workload=none
provider=none
mutation=read-only
```

Every profile must explicitly declare all six dimensions. Hosted/provider-backed does not imply
mutating, and mutating support requires its own truthful safeguards. See
[`docs/deployment-profiles.md`](docs/deployment-profiles.md) before adding a hosted or hybrid
profile.

The public repository contains supported shapes only. Environment selection, immutable declaration
and source pins, private parameter references, secret references, rollback intent, and
operator-specific desired state belong in private operator Git. Secret values and observed
deployment evidence belong in their provider systems.

## Validation

The normal repository checks are:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
npm run package:smoke
npm audit --omit=dev --audit-level=high
```

Deployment contract v1 was added after Platform 0.1.2, so declaration validation intentionally uses
the reviewed source revision rather than copying its schemas or validator:

```bash
git clone https://github.com/ashergarland/agent-tool-platform.git ../agent-tool-platform
git -C ../agent-tool-platform checkout --detach 98ec8162fb11d5c04aee9e6f7b3625a472a0180d
npm --prefix ../agent-tool-platform ci
npm --prefix ../agent-tool-platform run build

# Set this variable using the syntax for your shell.
AGENT_TOOL_PLATFORM_CHECKOUT=../agent-tool-platform npm run deployment:validate
AGENT_TOOL_PLATFORM_CHECKOUT=../agent-tool-platform npm run deployment:conformance
```

`tests/conformance/platform.test.ts` checks generic Platform behavior. Tests under `tests/unit/`
and `tests/conformance/profile.test.ts` check capability-owned domain behavior and profile
truthfulness. Do not copy Platform test suites into this repository.

`npm run package:smoke` builds and packs the real package, installs it into an external temporary
consumer, imports its public API, launches the installed stdio entrypoint, and invokes
`inspect_text`. It publishes nothing and deletes its temporary artifacts.

## CI and release

The three workflow callers pin Agent Tool Platform commit
`98ec8162fb11d5c04aee9e6f7b3625a472a0180d`:

- CI runs formatting, lint, typecheck, coverage, build, OpenAPI, metadata, package smoke, and the
  exact deployment-contract checks.
- Security runs the shared production dependency audit, gitleaks history scan, and CodeQL.
- Release accepts normal publication only from stable version tags and uses npm Trusted Publishing.

Do not publish from this template repository. A new capability must deliberately bootstrap its npm
package and configure the calling `release.yml` as the npm Trusted Publisher before tag releases.
See the
[canonical workflow contract](https://github.com/ashergarland/agent-tool-platform/blob/98ec8162fb11d5c04aee9e6f7b3625a472a0180d/docs/capability-workflows.md).

## Migrating an existing capability

Use [`docs/migration.md`](docs/migration.md). Preserve domain semantics, tests, and justified
adapters; replace duplicated Platform mechanics. A non-TypeScript domain worker may remain
capability-owned behind this TypeScript Platform-facing wrapper.

## License

MIT

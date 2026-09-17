# Deployment profiles

The canonical public declaration is [`../capability-profiles.json`](../capability-profiles.json).
It uses Agent Tool Platform deployment contract v1 at revision
`98ec8162fb11d5c04aee9e6f7b3625a472a0180d`.

## Local default

The template declares only a `local-package` profile:

| Dimension | Value           | Consequence                                       |
| --------- | --------------- | ------------------------------------------------- |
| execution | `local`         | The invoking machine runs the process.            |
| delivery  | `package`       | npm supplies the built artifact.                  |
| access    | `local-process` | The caller owns the stdio pipe.                   |
| workload  | `none`          | No file, mount, upload, object, or provider data. |
| provider  | `none`          | No external provider prerequisite.                |
| mutation  | `read-only`     | The tool changes no state.                        |

This profile needs no cloud infrastructure, HTTP listener, container, external secret, provider
configuration, or operator deployment instance.

## Add hosted or hybrid support only when real

A hybrid capability adds another named profile; it does not weaken or overload the local profile.
Copy no schema or validator from Platform. Declare the new profile with all six dimensions, then
add only the capability/profile-owned deployment assets needed to make it true.

Ownership follows the eBay deployment-contract proof:

| Owner/system                      | Contents                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public capability repository      | Supported profile, reusable mechanics, safe configuration schema, required secret names, provider prerequisites, verification surfaces                              |
| Private deployment-instance Git   | Environment/profile selection, immutable declaration and deployed-source pins, private parameter reference, secret references, desired state, rollback expectations |
| Provider, secret, evidence stores | Live resources, secret values, produced artifact identities, rollout results, drift, and observed evidence                                                          |

Declaration and deployed-source pins are independent. A build-from-source instance requests
produced-digest and source-binding evidence; it must not invent a digest before the build.

Provider readiness is distinct from process liveness. A hosted provider-backed profile can remain
`read-only`. A mutating profile must explicitly declare separate enablement, authorization,
confirmation, durable-record policy, and authoritative verification.

Public examples must be synthetic and account-neutral. Never commit subscriptions, tenants,
production resource names, live endpoints, operator contacts, credentials, secret values, or
private desired state.

Capability/profile-specific deployment assets may remain here when needed. Do not introduce a
general Container Apps, registry, Key Vault, observability, or fleet-deployment library; shared IaC
is a separate Platform concern.

The full contract and offline validation rules are maintained in
[Agent Tool Platform](https://github.com/ashergarland/agent-tool-platform/blob/98ec8162fb11d5c04aee9e6f7b3625a472a0180d/docs/deployment-contracts.md).

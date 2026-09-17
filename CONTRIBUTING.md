# Contributing

Use Node.js 22.13 or newer and install with `npm ci`.

Keep domain behavior under `src/domain/` and `src/tools/`. Consume shared runtime and safety
mechanics from Agent Tool Platform rather than adding local copies. Keep
`capability-profiles.json`, package metadata, and capability tests truthful when behavior or
delivery changes. Parser changes must preserve deterministic IDs/order/provenance and add bounded
synthetic fixtures for new input behavior.

Before opening a pull request, run the validation list in `README.md`. Never commit credentials,
secret values, operator desired state, account identifiers, live endpoints, or generated
deployment evidence.

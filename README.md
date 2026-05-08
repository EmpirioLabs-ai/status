# EmpirioLabs AI - Status

Live status page for EmpirioLabs AI services.

- Live page: https://status.empiriolabs.ai
- Uptime checks run every 5 minutes.
- Incidents are auto-filed as issues in this repo with the `status` label.

## License

This repository is published in public form for operational
transparency only. It is not open-source and is not available for
forking, copying, modifying, or redistribution. See [LICENSE](./LICENSE)
for the full notice.

If you'd like to build something similar for your own services,
[Upptime](https://upptime.js.org/) is open-source and is what powers
the underlying GitHub Actions used here.

## Third-party components

The CI workflows invoke `upptime/uptime-monitor` as a GitHub Action
dependency (referenced by git-pinned hash, not bundled). The build
script depends on `js-yaml` via npm at runtime.

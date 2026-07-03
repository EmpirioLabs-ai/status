# EmpirioLabs AI - Status

Live status page for EmpirioLabs AI services.

- Live page: https://status.empiriolabs.ai
- Uptime checks run every 5 minutes.
- Incidents are auto-filed as issues in this repo with the `status` label.

## Past incidents

The status page renders past incidents from GitHub issues in this repo that
have the `status` label.

For incidents that are backfilled after the fact, add this hidden metadata
block to the issue body so the page renders the real incident window instead
of the GitHub issue creation time:

```markdown
<!-- status-incident
started_at: 2026-05-19T23:03:00Z
resolved_at: 2026-05-20T15:15:00Z
-->
```

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

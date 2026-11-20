# Security policy

Archon Agent Console is meant to be reachable from the internet behind a Cloudflare tunnel, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: on this repository open the **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it and what you think the impact is. You will get an answer as soon as the maintainer can read it; this is a small project, so please allow a few days.

## Scope

In scope: anything that lets someone without a valid passkey session reach a route, terminal, websocket or file; bypass the Origin, Cloudflare Access or rate-limit checks; read or write outside `PROJECTS_ROOTS` or into the credential deny-list; run a command or reach a credential through the skills import, Agy Chat, GitHub or `archon-prod` features; or leak a token or key to the browser or a log.

Out of scope, by design: what an agent can do once you have signed in and chosen a mode that allows it. Agents run as the service user and are not sandboxed (see the README, "Security model").

## Supported versions

Only the latest `main` is supported.

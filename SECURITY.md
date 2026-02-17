# Security Policy

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

If you discover a security issue in sui-gas-station, please report it privately via either method:

- **Email:** dannydevs@proton.me (subject: `[sui-gas-station security] <brief description>`)
- **GitHub:** [Open a private security advisory](https://github.com/Danny-Devs/sui-gas-station/security/advisories/new)

You will receive an acknowledgment within 48 hours. We aim to provide a fix or mitigation plan within 7 days of confirmation.

## Scope

This policy covers the `sui-gas-station` npm package — the coin pool, sponsorship logic, policy enforcement, and gas coin drain prevention.

## What qualifies

- Gas coin drain attacks that bypass `assertNoGasCoinUsage`
- Coin pool race conditions that could cause double-spend or coin loss
- Policy enforcement bypasses (allowlist circumvention, budget cap bypass)
- Epoch boundary bugs that could cause stale coin references
- Anything that could cause sponsor fund loss or unauthorized gas spending

## What does not qualify

- Bugs in example code or documentation
- Issues in development dependencies (vitest, typescript, etc.)
- Denial-of-service via malformed transactions (we validate and throw typed errors)
- Vulnerabilities in `@mysten/sui` (report those to Mysten Labs)

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will:

1. Credit the reporter (unless anonymity is requested)
2. Publish a security advisory on GitHub
3. Release a patched version on npm

Thank you for helping keep sui-gas-station secure.

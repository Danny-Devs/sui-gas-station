# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-02-16

### Fixed

- Add `@types/node` to devDependencies to resolve `setTimeout` return type in typecheck

## [0.1.4] - 2026-02-15

### Changed

- Restructured README for better onboarding flow

### Added

- Test coverage for `close()` merge behavior and `fetchAllCoins` pagination

## [0.1.3] - 2026-02-15

### Added

- Gas coin drain prevention: `assertNoGasCoinUsage()` rejects transactions that use `GasCoin` as a Move call argument, preventing attackers from draining the sponsor's gas coins via `SplitCoins`, `MergeCoins`, or `TransferObjects`
- `allowGasCoinUsage` opt-in for legitimate use cases

### Fixed

- Broken README client example and safer example defaults
- Auth warning added to server example

## [0.1.2] - 2026-02-15

### Added

- Initial public release
- `GasSponsor` class with coin pool management
- Policy enforcement: budget caps, address blocklists, Move target allowlists, custom validators
- Epoch boundary detection and automatic coin refresh
- Effects-based coin recycling (zero RPC overhead on reclaim)
- Reservation timeout with automatic cleanup
- Integration test against Sui devnet
- 78 unit tests, zero runtime dependencies

### Fixed

- Correct GitHub repository URL casing

[0.1.5]: https://github.com/Danny-Devs/sui-gas-station/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Danny-Devs/sui-gas-station/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Danny-Devs/sui-gas-station/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Danny-Devs/sui-gas-station/releases/tag/v0.1.2

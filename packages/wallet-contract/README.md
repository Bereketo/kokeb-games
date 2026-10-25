# @kokeb/wallet-contract

The one thing games and the platform share. Depends on nothing else in the repo.

- `src/types.ts`: `WalletPort` and request/result types
- `src/errors.ts`: `WalletError` codes, HTTP statuses, and which are retryable
- `src/signature.ts`: HMAC signing for the HTTP API
- `src/money.ts`: birr ⇄ santim helpers
- `src/conformance.ts`: the test suite every wallet implementation must pass
- `openapi.yaml`: the HTTP form of the contract, for third-party game providers

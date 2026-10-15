# Phase 04 — Stage 2 specification (as supplied by the user, Increment 2.2)

Status: Increment 2.1 (listKeys) done. Increment 2.2 (this document) implemented. Increment 2.3 (startup
integration / Dispatcher gating) and 2.4 (pruning) NOT implemented and not authorized.

## Scope of 2.2
Create `core/runtime/canonical-fingerprint.ts`, `core/runtime/durable-idempotency-ledger.ts`,
`core/runtime/idempotency-recovery.ts` and their tests. Protected (unchanged): `contracts/envelope.ts`,
`contracts/storage.ts`, `contracts/idempotency.ts`, `contracts/version.ts`, `infrastructure/storage/*`,
`core/runtime/dispatcher.ts`. The Dispatcher is NOT gated by the durable ledger; the in-memory
`IdempotencyLedger` remains the only one used at dispatch.

## Canonical fingerprint (MDJS v1)
- Accepts plain objects (prototype `Object.prototype` or `null`), arrays, JSON primitives.
- Rejects with `contract.invalid_payload` (ContractError, category `contract_violation`, not retryable):
  undefined, function, symbol, bigint, sparse arrays, extra array properties, circular references,
  class instances (Date, Map, Set, RegExp, Promise, user classes), accessor / non-enumerable properties,
  symbol keys, unsafe integers, NaN/±Infinity, lone surrogates. `details.rule` names the reason.
- `-0` → `0`; safe integers as plain decimals; fractions per RFC 8785 §3.2.2.3 (ECMAScript Number::toString).
- Keys sorted by UTF-16 code units. Escapes: `\" \\ \b \f \n \r \t`; other U+0000..U+001F as `\u00XX` uppercase.
  Valid surrogate pairs emitted as UTF-8.
- Preimage: `{"contract_version":..,"destination":..,"message_type":..,"payload":..}`; digest = lowercase hex SHA-256 of UTF-8.
- Trust boundary: reflection over hostile in-process Proxies can run trap code and give inconsistent answers;
  callers needing isolation must first cross a serialization/clone boundary.

Golden vectors (all six verified by tests/unit/runtime/canonical-fingerprint.test.ts):

| # | Case | Bytes | SHA-256 |
|---|---|---|---|
| 1 | key ordering `{"a":2,"b":1}` | 135 | 353ebaf5d74f6530df6bcb66b397b0eb3508170b24832ac5b499ce878dca92b4 |
| 2 | negative zero `{"count":0}` | 133 | 3cc3e0afcdfba4a99399cf67abae3a538682ed2926cf9ac3993c24bcbe9a1251 |
| 3 | escaping & controls | 171 | f9f1671438556c0142f405ff2cfd86e601aa2f945c39fc61cbd0774f0988b470 |
| 4 | unicode order & surrogate pair | 164 | 2d571f713fe505424eb9dfaafe9ee35664ccc29a72db0c74a3775474ea4f5550 |
| 5 | contract version 1.0 `{"a":1}` | 129 | 0f39376888027a31d9019df2f16ea95764cbe1f38903edfed7e9d8b972e195e8 |
| 6 | contract version 2.0 `{"a":1}` | 129 | af2ae21604338001f42bf2e9195b586676e393a57888cf363e6f6010822fc9cb |

All use destination `{"id":"data","kind":"module"}`, message_type `COMMAND`.

## Durable idempotency ledger
- Key: `idmp:<sha256hex(namespace + "\0" + operation)>:<caller idempotency_key>`.
- States: `in_progress | succeeded | failed_final | unknown_external_state`. Record shape = `DurableIdempotencyRecord`.
- Retention: min 24h, default 7d, max 30d, clamped. Terminal: `retention_deadline = completed_at + retention`.
  `unknown_external_state`: no `completed_at`, no `retention_deadline`, `requires_reconciliation: true`; never prunable.
- `claim(envelope, {namespace, operation})`: fingerprint (validates/canonicalizes) → envelope validation →
  COMMAND + idempotency_key required → `put(..., 0)`. Nothing is written if any of that fails.
  On `storage.version_conflict`: `getEntry`; tombstone/absent → `idempotency.key_retired`; fingerprint mismatch →
  `idempotency.fingerprint_mismatch` (checked before any duplicate is returned); succeeded/failed_final →
  `{outcome:"duplicate", record}` with cached `response_ref`; in_progress → `idempotency.in_flight`;
  unknown_external_state → `idempotency.reconciliation_required` (category unknown_external_state, never retryable).
- `complete(key, result, expectedVersion)`: guarded in_progress → succeeded | failed_final | unknown_external_state.
- `reconcile(key, result, expectedVersion)`: guarded unknown_external_state → succeeded | failed_final; retention starts now.
- Version mismatch, wrong state, storage error, or corrupt stored record all throw (fail closed).
- Tombstones (written by a future 2.4 pruner) permanently retire the key.

## Recovery
`IdempotencyRecovery.recover()` pages `listKeys({prefix:"idmp:"})`; in_progress → unknown_external_state via CAS;
unknown_external_state reported unchanged. Any storage failure, CAS conflict or corrupt record throws
(operational failure). Otherwise `clean` (no unresolved) or `unresolved_records_exist` (one or more unresolved).

## Deviations from the supplied text
- `store.put(key, record, 0)` is written as `put({ key, value: record }, 0)` and Result errors are thrown as
  `MosaicFault` — the actual Stage 1 `StateStore` interface.
- Invalid payload throws `ContractError` (not `SystemError`): `contract_violation` is a contract-kind category.
- `IdempotencyRecovery` uses a private field instead of a constructor parameter property (erasable-TS rule); it also
  accepts an optional `now` clock. The ledger adds `reconcile()` and `read()` for the post-reconciliation flow.
- `core/runtime/lifecycle.ts` does not exist (lifecycle is `core/foundation/lifecycle.ts`, unchanged).

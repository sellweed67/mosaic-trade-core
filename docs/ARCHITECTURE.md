# Mosaic Architecture (Phase 00-B — what exists today)

## 1. Identity
Mosaic is a headless backend that orchestrates AI work and provides universal integration.
It is NOT a UI, dashboard, trading app, broker, MT5, MT5 EA/Bridge, or the Trading Satellite.

## 2. System boundary
```text
Mosaic Core: FOUNDATION | CORE RUNTIME | INTELLIGENCE | RESOURCE | DATA | POLICY & SECURITY |
             VALIDATION | RESOURCE OPTIMIZATION | RELIABILITY | OBSERVABILITY | CONTROL |
             UNIVERSAL INTEGRATION
External:    Trading Satellite -> MT5 Connector -> MT5 EA/Bridge -> MT5 -> Broker
```

## 3. Repository structure
| Dir | Purpose | State |
|---|---|---|
| apps/mosaic-core | Composition root (process entry) | implemented (minimal) |
| core/foundation | bootstrap, lifecycle, config, env, version, module registry, errors, logging, health, secret interface | implemented (minimal) |
| contracts | identifiers, error, result, health, version + reserved placeholders | partial |
| modules/<12> | one descriptor per canonical module (ownership list) | reserved |
| modules/policy-security/precedence.ts | policy precedence resolver (fail closed) | implemented (minimal) |
| integrations | Adapter interface only | reserved |
| trading | isolation marker only | reserved |
| infrastructure, migrations, scripts, storage, deployment, tools | READMEs only | reserved |
| tests/{unit,integration,contract,architecture} | test layout | implemented |
| config | non-secret configuration | implemented |

## 4. Module ownership
Each capability has exactly one owner, enforced at startup and in tests. See `modules/*/index.ts`.
- FOUNDATION: bootstrap, lifecycle, configuration, environment, version, module registration, error model, health aggregation
- CORE RUNTIME: task execution, workflow engine, event bus, queue, scheduling
- INTELLIGENCE: AI registry *view*, discovery, router, capability matching, quality evaluation, fallback, escalation
- RESOURCE: resource registry (generic authority), discovery, allocation, health, lifecycle
- DATA: primary database, object storage, cache, memory, archive, data lifecycle
- POLICY & SECURITY: policy engine, identity, authN, authZ, capability access, permission, secret management, rate limiting, safety rules
- VALIDATION: input / contract validation, compatibility checks
- RESOURCE OPTIMIZATION: cost / performance optimization
- RELIABILITY: timeout, retry, backoff, circuit breaker, recovery, reconciliation, safe state, checkpoint, resume, idempotency
- OBSERVABILITY: logging sink, metrics, tracing, audit, provenance
- CONTROL: operator control, approval
- UNIVERSAL INTEGRATION: connector registry, adapter lifecycle

## 5. Dependency rules (enforced by tests/architecture)
```text
contracts      <- (nothing)
core           -> contracts
modules        -> core, contracts   (no cross-module imports; talk via contracts)
infrastructure -> core, contracts
integrations   -> core, contracts
trading        -> contracts ONLY;  nothing imports trading
apps           -> everything except trading
```

## 6. External systems and trading isolation
Trading Satellite and all MT5/broker parts are external. `trading/` holds only a version marker.
No strategy, signal, risk, order, MT5, broker, LINE, Telegram or network adapter is implemented.

## 7. Security principles
Configuration (config/*.json, frozen) is separate from secrets (only `env://` / `vault://` references,
resolved by a `SecretProvider` into a redacting `Secret`) and from runtime state (held per `Lifecycle` instance).
Config validation rejects secret-like keys. The logger redacts secret-like fields. Unknown env fails closed.

## 8. Policy precedence
Safety > Security > Risk > Data > Privacy > Cost > Performance > Optimization.
The highest level that decides wins; unknown or no decision means **deny**.

## 9. Locked rules
Core is not a UI. External apps stay external. Trading execution is external. AI is not authority; policy is.
Risk controls are deterministic. Secrets are isolated. Data has explicit ownership; one entity, one owner.
Cache is not the source of truth. Events are not runtime state. Logs are not the database.
Unknown external execution state must be reconciled before retry (`unknown_external_state` is never retryable).
Self-healing never weakens security or risk controls. Higher-level policy overrides lower.
Incompatible versions do not silently communicate (major mismatch means incompatible). Critical paths fail safely
(a failed start rolls back modules that already started). No God modules, no duplicated authority, no extra complexity.

## 10. Phase order
00-B Bootstrap (this) -> 01 Foundation -> 02 Contracts -> later phases as specified by the Master Specification.

## 11. Recorded uncertainties
- ID generation is UUIDv4 for now; it may change to UUIDv7/ULID in Phase 02. Reversible.
- PostgreSQL is the chosen primary DB but isn't provisioned. Cache tech is undecided (in-process first).
- Inter-module dependency edges in descriptors are provisional.

## 12. Phase 01 — Foundation (implemented)
- Lifecycle: the only legal transitions are in `LIFECYCLE_TRANSITIONS`. Each module's startup has a time limit (`timeouts.startupMs`); if startup fails, already-started modules are stopped in reverse order. Shutdown runs in reverse order within a total time budget (`timeouts.shutdownMs`), and calling it twice is safe. SIGINT/SIGTERM trigger a graceful stop; a second signal forces exit.
- Config: strict schema (unknown keys, types and ranges all rejected, every issue reported together), deep-frozen. Layers: `default.json` < `<env>.json` < `MOSAIC_CONFIG__a__b` env overrides. Only secret references are allowed.
- Secrets: `env://MOSAIC_SECRET_*` resolved through a SecretProvider into a redacting `Secret`.
- Logging: level filtering; trace IDs propagate across async calls (AsyncLocalStorage); secrets are scrubbed automatically by key name and by value pattern.
- Errors: DomainError / SystemError / ContractError, each with `is_retryable` and `requires_reconciliation`; fail-closed categories can never be retried.
- Health: liveness, readiness (unknown or unhealthy means not ready), per-module checks with timeouts.
- Registry: deterministic topological order, cycle and missing-dependency detection, one owner per capability.

## 13. Phase 02 — Universal Contracts & Protocol (implemented)
- Lifecycle uses five states: created, starting, running, stopping, stopped. A failed startup goes starting -> stopping -> stopped and reports the original error with `details.rollback` attached. stopped -> starting allows a clean restart.
- Envelope (`contracts/envelope.ts`) supports COMMAND, REQUEST, RESPONSE, EVENT, RESULT and ERROR. Unknown fields are rejected. Metadata is flat, can't carry secrets and is never read as control. The payload must be JSON-safe and is scanned for secret-looking values. Contract version 1.0.
- Contexts (`contracts/context.ts`, `policy.ts`, `retry.ts`, `idempotency.ts`) are types plus validation only. Authorization fails closed. Policy precedence is deterministic and conflicts are reported. A retry decision is a pure function, and an unknown external outcome always means reconcile. Idempotency follows a state machine.
- Not implemented: an authentication or authorization service, a policy engine, a retry scheduler, or an idempotency store.

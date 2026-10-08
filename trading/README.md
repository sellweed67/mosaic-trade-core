# trading/
Isolation boundary for the external Trading Satellite. Contains only a version marker.
Imports `contracts/` only. Nothing in core/modules/integrations/infrastructure may import `trading/`.
No strategy, signals, risk engine, order execution, MT5 or broker code exists.

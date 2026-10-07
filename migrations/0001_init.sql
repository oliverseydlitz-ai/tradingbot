CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  trade_date TEXT NOT NULL,            -- America/New_York calendar date, used for the daily order cap
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL,
  notional REAL,
  order_type TEXT NOT NULL,
  limit_price REAL,
  alpaca_order_id TEXT,
  status TEXT NOT NULL,                -- pending | accepted | canceled | failed | rejected (guardrail)
  reason TEXT NOT NULL,
  equity_at_time REAL,
  error TEXT
);
CREATE INDEX idx_trades_date ON trades (trade_date);

CREATE TABLE snapshots (
  date TEXT PRIMARY KEY,               -- America/New_York calendar date
  equity REAL NOT NULL,
  cash REAL NOT NULL,
  spy_close REAL
);

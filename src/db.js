import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  mode TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  owner_key_hash TEXT NOT NULL UNIQUE,
  household_size INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  clock TEXT NOT NULL,
  default_payment_method_id TEXT,
  default_address_id TEXT,
  provider_customer_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'card',
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  mandate TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  items_json TEXT NOT NULL,
  cadence_days INTEGER NOT NULL,
  next_order_date TEXT NOT NULL,
  pause_until TEXT,
  address_id TEXT NOT NULL,
  payment_method_id TEXT NOT NULL,
  failed_order_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  canceled_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subscription_id TEXT,
  status TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  amounts_json TEXT NOT NULL,
  address_id TEXT NOT NULL,
  payment_method_id TEXT NOT NULL,
  charges_json TEXT NOT NULL,
  approval_id TEXT,
  fulfill_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  created_at TEXT NOT NULL,
  shipped_at TEXT,
  delivered_at TEXT,
  estimated_delivery_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ucp_checkouts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  account_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);
CREATE INDEX IF NOT EXISTS idx_subs_account ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id);
CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id, seq);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Columns added after the first release.
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  if (!cols.includes('provider_customer_id')) db.exec('ALTER TABLE accounts ADD COLUMN provider_customer_id TEXT');
  const pmCols = db.prepare('PRAGMA table_info(payment_methods)').all().map((c) => c.name);
  if (!pmCols.includes('type')) db.exec("ALTER TABLE payment_methods ADD COLUMN type TEXT NOT NULL DEFAULT 'card'");
  if (!pmCols.includes('mandate')) db.exec('ALTER TABLE payment_methods ADD COLUMN mandate TEXT');
  const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!orderCols.includes('fulfill_on')) db.exec('ALTER TABLE orders ADD COLUMN fulfill_on TEXT');
  return db;
}

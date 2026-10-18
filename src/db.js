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
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  photo_url TEXT,
  skus_json TEXT NOT NULL,
  preferred TEXT,
  value_cents INTEGER NOT NULL,
  needs_proof INTEGER NOT NULL,
  proof_reason TEXT,
  status TEXT NOT NULL,
  resolution TEXT,
  resend_order_id TEXT,
  refund_cents INTEGER,
  reported_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logins (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  next TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  kind TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
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
  const addCol = (table, col, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  addCol('accounts', 'provider_customer_id', 'TEXT');
  addCol('orders', 'tax_ref', 'TEXT');
  addCol('orders', 'tax_txn', 'TEXT');
  addCol('accounts', 'owner_claim_hash', 'TEXT');
  addCol('accounts', 'owner_claimed_at', 'TEXT');
  addCol('accounts', 'hold_reason', 'TEXT');
  addCol('accounts', 'terms_version', 'TEXT');
  addCol('accounts', 'terms_accepted_at', 'TEXT');
  addCol('payment_methods', 'type', "TEXT NOT NULL DEFAULT 'card'");
  addCol('payment_methods', 'mandate', 'TEXT');
  // Addresses saved before owner confirmation existed are treated as confirmed.
  addCol('addresses', 'confirmed', 'INTEGER NOT NULL DEFAULT 1');
  addCol('approvals', 'token_hash', 'TEXT');
  addCol('orders', 'fulfill_on', 'TEXT');
  addCol('orders', 'refunds_json', "TEXT NOT NULL DEFAULT '[]'");
  addCol('orders', 'resend_of', 'TEXT');
  addCol('orders', 'dispute_json', 'TEXT');
  addCol('shipments', 'retailer_order_id', 'TEXT');
  addCol('subscriptions', 'skip_once_json', "TEXT NOT NULL DEFAULT '[]'");
  addCol('shipments', 'retailer_canceled_at', 'TEXT');
  addCol('shipments', 'problem', 'TEXT');
  return db;
}

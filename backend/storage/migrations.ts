/** Ordered, immutable schema migrations. Add a new version; never edit an applied SQL string. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_storage_foundation",
    sql: `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  vin TEXT NOT NULL,
  display_name TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, reference)
) STRICT;

CREATE TABLE vehicle_current_state (
  vehicle_id TEXT PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
  state_schema_version INTEGER NOT NULL CHECK(state_schema_version = 1),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  fingerprint TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source_captured_at INTEGER,
  persisted_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1)
) STRICT;

CREATE TABLE vehicle_observations (
  id INTEGER PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  state_schema_version INTEGER NOT NULL CHECK(state_schema_version = 1),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  fingerprint TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source_captured_at INTEGER,
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX vehicle_observations_by_time ON vehicle_observations(vehicle_id, fetched_at DESC, id DESC);

CREATE TABLE telemetry_samples (
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  source_captured_at INTEGER,
  soc_percent REAL,
  estimated_range_km REAL,
  odometer_km REAL,
  charging TEXT NOT NULL CHECK(charging IN ('charging', 'not_charging', 'unknown')),
  plugged_in INTEGER CHECK(plugged_in IN (0, 1)),
  charge_power_kw REAL,
  target_soc_percent REAL,
  climate_activity TEXT NOT NULL CHECK(climate_activity IN ('active', 'inactive', 'unknown')),
  target_temp_f REAL,
  PRIMARY KEY(vehicle_id, bucket_start)
) STRICT;

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (
    'lock', 'unlock', 'charge_start', 'charge_stop', 'charge_target',
    'climate_start', 'climate_stop', 'climate_temperature'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'requested', 'accepted', 'confirmed', 'failed', 'unconfirmed', 'cancelled'
  )),
  requested_at INTEGER NOT NULL,
  accepted_at INTEGER,
  completed_at INTEGER,
  correlation_id TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  requesting_device_id TEXT,
  CHECK(accepted_at IS NULL OR accepted_at >= requested_at),
  CHECK(completed_at IS NULL OR completed_at >= requested_at)
) STRICT;
CREATE INDEX commands_by_vehicle_time ON commands(vehicle_id, requested_at DESC);
CREATE INDEX commands_by_correlation ON commands(vehicle_id, correlation_id);

CREATE TABLE account_secrets (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN (
    'vw_username', 'vw_password', 'vw_spin', 'access_token',
    'refresh_token', 'id_token', 'code_verifier', 'carnet_token'
  )),
  scope TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  envelope_version INTEGER NOT NULL CHECK(envelope_version = 1),
  algorithm TEXT NOT NULL CHECK(algorithm = 'AES-256-GCM'),
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK(length(nonce) = 12),
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL CHECK(length(tag) = 16),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, purpose, scope),
  UNIQUE(key_id, nonce),
  CHECK((purpose = 'carnet_token' AND scope <> '') OR
        (purpose <> 'carnet_token' AND scope = ''))
) STRICT;
`,
  },
  {
    version: 2,
    name: "owner_device_authentication",
    sql: `
CREATE TABLE authorized_devices (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL UNIQUE CHECK(length(pubkey) = 64),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
  paired_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE TABLE pairing_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  consumed_at INTEGER,
  CHECK(consumed_at IS NULL OR consumed_at >= created_at)
) STRICT;
CREATE INDEX pairing_sessions_by_expiry ON pairing_sessions(expires_at);

CREATE TABLE auth_replay_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) = 64),
  device_id TEXT NOT NULL REFERENCES authorized_devices(id) ON DELETE RESTRICT,
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at >= consumed_at)
) STRICT;
CREATE INDEX auth_replay_events_by_expiry ON auth_replay_events(expires_at);
`,
  },
];

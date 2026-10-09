// Inactive construction manifest, derived from fictional native schema helpers
// at the pinned source and target. This file is imported only by the inactive
// preflight and its local regressions; it exposes no route or private data.
const freezeRows = rows => Object.freeze(rows.map(row => Object.freeze(row)));
export const RELAY_MIGRATION_CATALOG = Object.freeze({
  sourceCommit: 'c4d62409a3b67e4e5dac88809c6a4a0290b6e39e',
  candidateCommit: 'ed7bbd436689be3ac9cca1ab5f111341dd690b80',
  compatibilityDate: '2026-09-19',
  sourceFiles: Object.freeze({
    "backend/shared.js": "528e100b60f221f5cf7bacdd4eedc21c89b6bb6c62c52797f3c2fb31c435ea0a",
    "backend/publications.js": "3c1b18920391f855168a0348bf4574bb0db1421df710bcfef22a16585b420d81",
    "backend/public-coordination.js": "b299572d09d1451aa16ae4af2d37ec1edd1a6bf5b0ca0b93ea0debde9e04a23d",
    "backend/relay-events.js": "4e9131ba836b7e47f01aa77324f2b7c0eb3760b6f03418a55d9d5bd09e7d8c65",
    "backend/relay-oauth.js": "b5ac5400cb315463c3ac101465fa31faa7d543f6003ad2790efc07f25edaa442",
    "backend/relay-owner.js": "7990babd74d55bb253e00a74357c8ab6bd9143f79af892c0035113a5a0290da7",
    "backend/relay-owner-jobs.js": "d2a192d9b839eb9686e1e28bb99e266919f1ddd630527a1b32d2ecb9e6298aba",
    "backend/relay-owner-password.js": "0d56aaabcd516b494ca3cea4e0ffbb3eb8f0199bd6d99029ab52cedfbb435f93",
    "backend/relay-core-alarm.js": "9d09aedc621bca2b14c27543458dce38d364edf1676c9e39c1b28a6de980c189",
    "backend/relay-common.js": "5a9ef7d4082efcf4fc94f7773e9b5325b65f5eac840a756872997a365ef19fd1",
    "backend/worker.js": "e8dfc4632fc777e9a2013e4001a016d417465720ca0fc6385a166b988a58e25a",
    "backend/relay-connector.js": "374b038037f5b8748aa4a1e05b93a9276daac5982cb56cb24ee78c2a927ced94",
    "backend/connector.js": "3d8277cf6ce0e4c0944501832ac6ed4c964d31ef796e87258dca8b446e61dae7",
    "public/content/jarvis.json": "305cc39ffc9b47567b36a4b7835ab912446074c0446281f11b54fafd109b54e8"
}),
  tables: freezeRows([
    {
        "name": "imported_comments",
        "table": "imported_comments",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE imported_comments (comment_id INTEGER PRIMARY KEY, publication TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0, error TEXT)"
    },
    {
        "name": "public_artifact_state",
        "table": "public_artifact_state",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE public_artifact_state (\n    request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, artifact_id TEXT NOT NULL,\n    result_version INTEGER NOT NULL, artifact TEXT NOT NULL, PRIMARY KEY(request_id,attempt_id,artifact_id))"
    },
    {
        "name": "public_changes",
        "table": "public_changes",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE public_changes (\n    seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, item_id TEXT NOT NULL,\n    request_id TEXT, UNIQUE(kind,item_id))"
    },
    {
        "name": "public_coordination_events",
        "table": "public_coordination_events",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE public_coordination_events (\n    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,\n    request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, stage TEXT NOT NULL,\n    result_version INTEGER, disposition TEXT NOT NULL, error_code TEXT,\n    payload TEXT NOT NULL, provenance TEXT NOT NULL, recorded_at TEXT NOT NULL)"
    },
    {
        "name": "public_import_hints",
        "table": "public_import_hints",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE public_import_hints (comment_id INTEGER PRIMARY KEY,status INTEGER NOT NULL,expires_ms INTEGER NOT NULL)"
    },
    {
        "name": "publication_recovery",
        "table": "publication_recovery",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE publication_recovery (comment_id INTEGER PRIMARY KEY)"
    },
    {
        "name": "relay_activations",
        "table": "relay_activations",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_activations (id TEXT PRIMARY KEY, revision TEXT NOT NULL, expires_ms INTEGER NOT NULL)"
    },
    {
        "name": "relay_core_alarm_wakes",
        "table": "relay_core_alarm_wakes",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE relay_core_alarm_wakes (id TEXT PRIMARY KEY,due_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL)"
    },
    {
        "name": "relay_delivery_receipts",
        "table": "relay_delivery_receipts",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_delivery_receipts (event_seq INTEGER PRIMARY KEY,accepted_ms INTEGER NOT NULL)"
    },
    {
        "name": "relay_event_meta",
        "table": "relay_event_meta",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_event_meta (key TEXT PRIMARY KEY,value INTEGER NOT NULL)"
    },
    {
        "name": "relay_events",
        "table": "relay_events",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_events (\n    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,\n    message_id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL, created_ms INTEGER NOT NULL, data TEXT NOT NULL)"
    },
    {
        "name": "relay_oauth",
        "table": "relay_oauth",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_oauth (key TEXT PRIMARY KEY, category TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    },
    {
        "name": "relay_outbox",
        "table": "relay_outbox",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_outbox (\n    subscription_id TEXT NOT NULL, event_seq INTEGER NOT NULL, body TEXT NOT NULL,\n    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,\n    next_attempt_ms INTEGER NOT NULL, last_error TEXT,\n    PRIMARY KEY(subscription_id,event_seq))"
    },
    {
        "name": "relay_outbox_recoveries",
        "table": "relay_outbox_recoveries",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_outbox_recoveries (\n    subscription_id TEXT NOT NULL,event_seq INTEGER NOT NULL,recoveries INTEGER NOT NULL,last_recovery_ms INTEGER NOT NULL,\n    PRIMARY KEY(subscription_id,event_seq))"
    },
    {
        "name": "relay_owner_credential_consents",
        "table": "relay_owner_credential_consents",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_credential_consents (\n    device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,\n    purpose TEXT NOT NULL CHECK(purpose IN ('setup','change')),\n    credential_version INTEGER NOT NULL, expires_ms INTEGER NOT NULL)"
    },
    {
        "name": "relay_owner_credentials",
        "table": "relay_owner_credentials",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_credentials (\n    singleton INTEGER PRIMARY KEY CHECK(singleton=1), principal TEXT NOT NULL,\n    username TEXT NOT NULL, algorithm TEXT NOT NULL,\n    cost_n INTEGER NOT NULL, block_r INTEGER NOT NULL, parallel_p INTEGER NOT NULL,\n    salt TEXT NOT NULL, verifier TEXT NOT NULL, version INTEGER NOT NULL,\n    created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,\n    setup_device_id TEXT NOT NULL, updated_device_id TEXT NOT NULL,\n    approval_grant_id TEXT NOT NULL)"
    },
    {
        "name": "relay_owner_entries",
        "table": "relay_owner_entries",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_entries (\n    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,\n    kind TEXT NOT NULL CHECK(kind IN ('user','reply')), reply_to TEXT UNIQUE,\n    body TEXT NOT NULL, created_at TEXT NOT NULL, principal TEXT NOT NULL,\n    device_id TEXT NOT NULL, authentication_source TEXT NOT NULL)"
    },
    {
        "name": "relay_owner_event_bodies",
        "table": "relay_owner_event_bodies",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_event_bodies (event_id TEXT PRIMARY KEY,body TEXT NOT NULL)"
    },
    {
        "name": "relay_owner_job_changes",
        "table": "relay_owner_job_changes",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE relay_owner_job_changes (\n    cursor INTEGER PRIMARY KEY AUTOINCREMENT CHECK(cursor BETWEEN 1 AND 999999999999999), job_id TEXT NOT NULL UNIQUE)"
    },
    {
        "name": "relay_owner_job_deadlines",
        "table": "relay_owner_job_deadlines",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE relay_owner_job_deadlines (\n    job_id TEXT NOT NULL, source TEXT NOT NULL, deadline_ms INTEGER NOT NULL, expired INTEGER NOT NULL CHECK(expired IN (0,1)),\n    PRIMARY KEY(job_id,source))"
    },
    {
        "name": "relay_owner_job_events",
        "table": "relay_owner_job_events",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_job_events (\n    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL,\n    kind TEXT NOT NULL, summary TEXT NOT NULL, created_ms INTEGER NOT NULL,\n    authentication_source TEXT NOT NULL, argument_json TEXT NOT NULL,\n    writer_id TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES relay_owner_jobs(id))"
    },
    {
        "name": "relay_owner_job_refresh",
        "table": "relay_owner_job_refresh",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE relay_owner_job_refresh (\n    id INTEGER PRIMARY KEY CHECK(id=1), backfill_after INTEGER NOT NULL, backfill_through INTEGER NOT NULL,\n    refresh_after INTEGER NOT NULL DEFAULT 0, refresh_through INTEGER NOT NULL DEFAULT 0, source_signature TEXT,\n    delivery_ready INTEGER NOT NULL DEFAULT 0 CHECK(delivery_ready IN (0,1)))"
    },
    {
        "name": "relay_owner_job_result_corrections",
        "table": "relay_owner_job_result_corrections",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_job_result_corrections (\n    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 2 AND 5),\n    original_reply_id TEXT NOT NULL, body TEXT NOT NULL, correction_summary TEXT NOT NULL,\n    created_ms INTEGER NOT NULL, UNIQUE(job_id,version),\n    FOREIGN KEY(id) REFERENCES relay_owner_job_events(id), FOREIGN KEY(job_id) REFERENCES relay_owner_jobs(id),\n    FOREIGN KEY(original_reply_id) REFERENCES relay_owner_entries(id))"
    },
    {
        "name": "relay_owner_jobs",
        "table": "relay_owner_jobs",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_jobs (\n    seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE,\n    principal TEXT NOT NULL, device_id TEXT NOT NULL,\n    title TEXT NOT NULL, action_kind TEXT NOT NULL CHECK(action_kind IN ('unclassified','read_only','draft','consequential')),\n    specified INTEGER NOT NULL DEFAULT 0 CHECK(specified IN (0,1)),\n    stage TEXT NOT NULL CHECK(stage IN ('queued','running','waiting_for_owner','completed','failed','cancelled')),\n    created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, finished_ms INTEGER,\n    result_reply_id TEXT UNIQUE, parent_job_id TEXT UNIQUE, root_job_id TEXT NOT NULL,\n    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 5), cancel_requested_ms INTEGER,\n    outcome TEXT NOT NULL CHECK(outcome IN ('not_started','known','unknown')),\n    failure_code TEXT, failure_message TEXT,\n    lease_run_id TEXT, lease_grant_id TEXT, lease_expires_ms INTEGER, acknowledged_ms INTEGER,\n    CHECK(id=request_id), FOREIGN KEY(request_id) REFERENCES relay_owner_entries(id))"
    },
    {
        "name": "relay_owner_meta",
        "table": "relay_owner_meta",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    },
    {
        "name": "relay_owner_pair_rates",
        "table": "relay_owner_pair_rates",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_pair_rates (identity TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_ms INTEGER NOT NULL)"
    },
    {
        "name": "relay_owner_pairings",
        "table": "relay_owner_pairings",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_pairings (\n    request_id TEXT PRIMARY KEY, code TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,\n    device_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_ms INTEGER NOT NULL,\n    expires_ms INTEGER NOT NULL, approved_ms INTEGER, approval_grant_id TEXT)"
    },
    {
        "name": "relay_owner_password_rates",
        "table": "relay_owner_password_rates",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_password_rates (\n    identity TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_ms INTEGER NOT NULL)"
    },
    {
        "name": "relay_owner_session_audit",
        "table": "relay_owner_session_audit",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_session_audit (\n    device_id TEXT PRIMARY KEY, authentication_source TEXT NOT NULL\n      CHECK(authentication_source='owner-password-session'),\n    credential_version INTEGER NOT NULL CHECK(credential_version>=1))"
    },
    {
        "name": "relay_owner_sessions",
        "table": "relay_owner_sessions",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_owner_sessions (\n    device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, principal TEXT NOT NULL,\n    label TEXT NOT NULL, created_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,\n    expires_ms INTEGER NOT NULL, revoked_ms INTEGER, approval_grant_id TEXT NOT NULL)"
    },
    {
        "name": "relay_subscription_scans",
        "table": "relay_subscription_scans",
        "type": "table",
        "retainedInSource": false,
        "sql": "CREATE TABLE relay_subscription_scans (subscription_id TEXT PRIMARY KEY,examined_seq INTEGER NOT NULL)"
    },
    {
        "name": "relay_subscriptions",
        "table": "relay_subscriptions",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_subscriptions (\n    id TEXT PRIMARY KEY, principal TEXT NOT NULL, grant_id TEXT NOT NULL,\n    name TEXT NOT NULL, arguments TEXT NOT NULL, callback TEXT NOT NULL,\n    secret TEXT NOT NULL, previous_secret TEXT, rotate_until INTEGER,\n    expires_ms INTEGER NOT NULL, ack_seq INTEGER NOT NULL, start_seq INTEGER NOT NULL,\n    generation TEXT NOT NULL, state TEXT NOT NULL)"
    },
    {
        "name": "relay_verified",
        "table": "relay_verified",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE relay_verified (identity TEXT PRIMARY KEY, verified_until INTEGER NOT NULL)"
    },
    {
        "name": "shared_briefing_dates",
        "table": "shared_briefing_dates",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE shared_briefing_dates (date TEXT PRIMARY KEY, entry_id TEXT NOT NULL)"
    },
    {
        "name": "shared_entries",
        "table": "shared_entries",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE shared_entries (\n    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,\n    kind TEXT NOT NULL CHECK(kind IN ('user','reply','briefing')),\n    reply_to TEXT UNIQUE, title TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL)"
    },
    {
        "name": "shared_meta",
        "table": "shared_meta",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE shared_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    }
]),
  indices: freezeRows([
    {
        "name": "imported_comments_status",
        "table": "imported_comments",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX imported_comments_status ON imported_comments(imported,comment_id)"
    },
    {
        "name": "public_changes_request",
        "table": "public_changes",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX public_changes_request ON public_changes(request_id, seq)"
    },
    {
        "name": "public_coordination_attempt",
        "table": "public_coordination_events",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX public_coordination_attempt ON public_coordination_events(attempt_id)"
    },
    {
        "name": "public_coordination_request",
        "table": "public_coordination_events",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX public_coordination_request ON public_coordination_events(request_id, seq)"
    },
    {
        "name": "public_coordination_version",
        "table": "public_coordination_events",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE UNIQUE INDEX public_coordination_version ON public_coordination_events(request_id, attempt_id, result_version)\n    WHERE disposition='accepted' AND result_version IS NOT NULL"
    },
    {
        "name": "relay_core_alarm_due",
        "table": "relay_core_alarm_wakes",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_core_alarm_due ON relay_core_alarm_wakes(due_ms)"
    },
    {
        "name": "relay_core_alarm_expiry",
        "table": "relay_core_alarm_wakes",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_core_alarm_expiry ON relay_core_alarm_wakes(expires_ms)"
    },
    {
        "name": "relay_event_created_seq",
        "table": "relay_events",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_event_created_seq ON relay_events(created_ms,seq)"
    },
    {
        "name": "relay_event_kind_seq",
        "table": "relay_events",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_event_kind_seq ON relay_events((CASE WHEN json_extract(data,'$.inbox_id')='brayden-owner' THEN 'relay.owner.message.created'\n  WHEN COALESCE(json_extract(data,'$.coordination_event_id'),'') NOT IN ('',0) THEN 'relay.public.result.changed' ELSE 'relay.message.created' END),seq)"
    },
    {
        "name": "relay_oauth_category_expiry",
        "table": "relay_oauth",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_oauth_category_expiry ON relay_oauth(category,expires_at)"
    },
    {
        "name": "relay_oauth_expiry",
        "table": "relay_oauth",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_oauth_expiry ON relay_oauth(expires_at)"
    },
    {
        "name": "relay_outbox_due",
        "table": "relay_outbox",
        "type": "index",
        "retainedInSource": true,
        "sql": "CREATE INDEX relay_outbox_due ON relay_outbox(status,next_attempt_ms)"
    },
    {
        "name": "relay_outbox_event",
        "table": "relay_outbox",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_outbox_event ON relay_outbox(event_seq,subscription_id)"
    },
    {
        "name": "relay_outbox_unsettled",
        "table": "relay_outbox",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_outbox_unsettled ON relay_outbox(subscription_id,event_seq,next_attempt_ms) WHERE status IN ('pending','failed')"
    },
    {
        "name": "relay_owner_entry_kind_seq",
        "table": "relay_owner_entries",
        "type": "index",
        "retainedInSource": true,
        "sql": "CREATE INDEX relay_owner_entry_kind_seq ON relay_owner_entries(kind,seq)"
    },
    {
        "name": "relay_owner_job_deadline_due",
        "table": "relay_owner_job_deadlines",
        "type": "index",
        "retainedInSource": false,
        "sql": "CREATE INDEX relay_owner_job_deadline_due ON relay_owner_job_deadlines(expired,deadline_ms,job_id)"
    },
    {
        "name": "relay_owner_job_event_order",
        "table": "relay_owner_job_events",
        "type": "index",
        "retainedInSource": true,
        "sql": "CREATE INDEX relay_owner_job_event_order ON relay_owner_job_events(job_id,seq)"
    },
    {
        "name": "relay_owner_job_stage_seq",
        "table": "relay_owner_jobs",
        "type": "index",
        "retainedInSource": true,
        "sql": "CREATE INDEX relay_owner_job_stage_seq ON relay_owner_jobs(stage,seq)"
    },
    {
        "name": "relay_owner_session_expiry",
        "table": "relay_owner_sessions",
        "type": "index",
        "retainedInSource": true,
        "sql": "CREATE INDEX relay_owner_session_expiry ON relay_owner_sessions(expires_ms)"
    },
    {
        "name": "shared_kind_seq",
        "table": "shared_entries",
        "type": "index",
        "retainedInSource": true,
        "sql": "CREATE INDEX shared_kind_seq ON shared_entries(kind, seq)"
    }
]),
  triggers: freezeRows([
    {
        "name": "relay_owner_job_change_entry_insert",
        "table": "relay_owner_entries",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_entry_insert AFTER INSERT ON relay_owner_entries WHEN NEW.principal='github:183016859' BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT CASE WHEN NEW.kind='user' THEN NEW.id ELSE NEW.reply_to END); END"
    },
    {
        "name": "relay_owner_job_change_entry_update",
        "table": "relay_owner_entries",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_entry_update AFTER UPDATE ON relay_owner_entries WHEN (OLD.body IS NOT NEW.body OR OLD.created_at IS NOT NEW.created_at OR OLD.reply_to IS NOT NEW.reply_to) AND NEW.principal='github:183016859' BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT CASE WHEN NEW.kind='user' THEN NEW.id ELSE NEW.reply_to END); END"
    },
    {
        "name": "relay_owner_job_change_event_delete",
        "table": "relay_events",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_event_delete AFTER DELETE ON relay_events WHEN 1 AND (OLD.message_id LIKE 'owner:%') BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(OLD.message_id,7)); END"
    },
    {
        "name": "relay_owner_job_change_event_insert",
        "table": "relay_events",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_event_insert AFTER INSERT ON relay_events WHEN 1 AND (NEW.message_id LIKE 'owner:%') BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(NEW.message_id,7)); END"
    },
    {
        "name": "relay_owner_job_change_event_update",
        "table": "relay_events",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_event_update AFTER UPDATE ON relay_events WHEN (OLD.message_id IS NOT NEW.message_id) AND (NEW.message_id LIKE 'owner:%' OR OLD.message_id LIKE 'owner:%') BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(NEW.message_id,7) UNION SELECT substr(OLD.message_id,7)); END"
    },
    {
        "name": "relay_owner_job_change_job_insert",
        "table": "relay_owner_jobs",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_job_insert AFTER INSERT ON relay_owner_jobs  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT NEW.request_id UNION SELECT NEW.parent_job_id); END"
    },
    {
        "name": "relay_owner_job_change_job_update",
        "table": "relay_owner_jobs",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_job_update AFTER UPDATE ON relay_owner_jobs WHEN OLD.request_id IS NOT NEW.request_id OR OLD.principal IS NOT NEW.principal OR OLD.device_id IS NOT NEW.device_id OR OLD.title IS NOT NEW.title OR OLD.action_kind IS NOT NEW.action_kind OR OLD.specified IS NOT NEW.specified OR OLD.stage IS NOT NEW.stage OR OLD.created_ms IS NOT NEW.created_ms OR OLD.updated_ms IS NOT NEW.updated_ms OR OLD.finished_ms IS NOT NEW.finished_ms OR OLD.result_reply_id IS NOT NEW.result_reply_id OR OLD.parent_job_id IS NOT NEW.parent_job_id OR OLD.root_job_id IS NOT NEW.root_job_id OR OLD.attempt IS NOT NEW.attempt OR OLD.cancel_requested_ms IS NOT NEW.cancel_requested_ms OR OLD.outcome IS NOT NEW.outcome OR OLD.failure_code IS NOT NEW.failure_code OR OLD.failure_message IS NOT NEW.failure_message OR OLD.lease_run_id IS NOT NEW.lease_run_id OR OLD.lease_grant_id IS NOT NEW.lease_grant_id OR OLD.lease_expires_ms IS NOT NEW.lease_expires_ms OR OLD.acknowledged_ms IS NOT NEW.acknowledged_ms BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT NEW.request_id UNION SELECT NEW.parent_job_id WHERE OLD.parent_job_id IS NOT NEW.parent_job_id UNION SELECT OLD.parent_job_id WHERE OLD.parent_job_id IS NOT NEW.parent_job_id); END"
    },
    {
        "name": "relay_owner_job_change_lease_insert",
        "table": "relay_owner_jobs",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_lease_insert AFTER INSERT ON relay_owner_jobs WHEN NEW.lease_expires_ms IS NOT NULL BEGIN DELETE FROM relay_owner_job_deadlines WHERE job_id=NEW.id AND source='lease';\n       INSERT INTO relay_owner_job_deadlines(job_id,source,deadline_ms,expired) SELECT NEW.id,'lease',NEW.lease_expires_ms,0\n       WHERE NEW.lease_expires_ms IS NOT NULL AND NEW.principal='github:183016859'; END"
    },
    {
        "name": "relay_owner_job_change_lease_update",
        "table": "relay_owner_jobs",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_lease_update AFTER UPDATE ON relay_owner_jobs WHEN OLD.lease_expires_ms IS NOT NEW.lease_expires_ms BEGIN DELETE FROM relay_owner_job_deadlines WHERE job_id=NEW.id AND source='lease';\n       INSERT INTO relay_owner_job_deadlines(job_id,source,deadline_ms,expired) SELECT NEW.id,'lease',NEW.lease_expires_ms,0\n       WHERE NEW.lease_expires_ms IS NOT NULL AND NEW.principal='github:183016859'; END"
    },
    {
        "name": "relay_owner_job_change_outbox_delete",
        "table": "relay_outbox",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_outbox_delete AFTER DELETE ON relay_outbox  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=OLD.event_seq AND message_id LIKE 'owner:%' UNION SELECT substr(message_id,7) FROM (SELECT e.message_id FROM relay_outbox o INDEXED BY relay_outbox_unsettled\n  JOIN relay_events e ON e.seq=o.event_seq WHERE o.subscription_id=OLD.subscription_id AND o.status IN ('pending','failed') ORDER BY o.event_seq LIMIT 1)); END"
    },
    {
        "name": "relay_owner_job_change_outbox_insert",
        "table": "relay_outbox",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_outbox_insert AFTER INSERT ON relay_outbox  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%' UNION SELECT substr(message_id,7) FROM (SELECT e.message_id FROM relay_outbox o INDEXED BY relay_outbox_unsettled\n  JOIN relay_events e ON e.seq=o.event_seq WHERE o.subscription_id=NEW.subscription_id AND o.status IN ('pending','failed') ORDER BY o.event_seq LIMIT 1)); END"
    },
    {
        "name": "relay_owner_job_change_outbox_update",
        "table": "relay_outbox",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_outbox_update AFTER UPDATE ON relay_outbox WHEN OLD.status IS NOT NEW.status OR OLD.attempts IS NOT NEW.attempts OR OLD.last_error IS NOT NEW.last_error OR OLD.event_seq IS NOT NEW.event_seq OR OLD.subscription_id IS NOT NEW.subscription_id BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%' UNION SELECT substr(message_id,7) FROM (SELECT e.message_id FROM relay_outbox o INDEXED BY relay_outbox_unsettled\n  JOIN relay_events e ON e.seq=o.event_seq WHERE o.subscription_id=NEW.subscription_id AND o.status IN ('pending','failed') ORDER BY o.event_seq LIMIT 1) UNION SELECT substr(message_id,7) FROM relay_events WHERE seq=OLD.event_seq AND message_id LIKE 'owner:%' UNION SELECT substr(message_id,7) FROM (SELECT e.message_id FROM relay_outbox o INDEXED BY relay_outbox_unsettled\n  JOIN relay_events e ON e.seq=o.event_seq WHERE o.subscription_id=OLD.subscription_id AND o.status IN ('pending','failed') ORDER BY o.event_seq LIMIT 1)); END"
    },
    {
        "name": "relay_owner_job_change_receipt_delete",
        "table": "relay_delivery_receipts",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_receipt_delete AFTER DELETE ON relay_delivery_receipts  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=OLD.event_seq AND message_id LIKE 'owner:%'); END"
    },
    {
        "name": "relay_owner_job_change_receipt_insert",
        "table": "relay_delivery_receipts",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_receipt_insert AFTER INSERT ON relay_delivery_receipts  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%'); END"
    },
    {
        "name": "relay_owner_job_change_receipt_update",
        "table": "relay_delivery_receipts",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_receipt_update AFTER UPDATE ON relay_delivery_receipts WHEN OLD.accepted_ms IS NOT NEW.accepted_ms OR OLD.event_seq IS NOT NEW.event_seq BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%'); END"
    },
    {
        "name": "relay_owner_job_change_recovery_delete",
        "table": "relay_outbox_recoveries",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_recovery_delete AFTER DELETE ON relay_outbox_recoveries  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=OLD.event_seq AND message_id LIKE 'owner:%');DELETE FROM relay_owner_job_deadlines\n        WHERE job_id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=OLD.event_seq AND message_id LIKE 'owner:%') AND source='recovery:'||OLD.subscription_id||':'||OLD.event_seq; END"
    },
    {
        "name": "relay_owner_job_change_recovery_insert",
        "table": "relay_outbox_recoveries",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_recovery_insert AFTER INSERT ON relay_outbox_recoveries  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%');DELETE FROM relay_owner_job_deadlines\n        WHERE job_id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%') AND source='recovery:'||NEW.subscription_id||':'||NEW.event_seq;INSERT OR REPLACE INTO relay_owner_job_deadlines(job_id,source,deadline_ms,expired)\n      SELECT id,'recovery:'||NEW.subscription_id||':'||NEW.event_seq,NEW.last_recovery_ms+60000,0\n      FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n      WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%') AND NEW.recoveries<2; END"
    },
    {
        "name": "relay_owner_job_change_recovery_update",
        "table": "relay_outbox_recoveries",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_recovery_update AFTER UPDATE ON relay_outbox_recoveries WHEN OLD.recoveries IS NOT NEW.recoveries OR OLD.last_recovery_ms IS NOT NEW.last_recovery_ms BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%');DELETE FROM relay_owner_job_deadlines\n        WHERE job_id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%') AND source='recovery:'||NEW.subscription_id||':'||NEW.event_seq;INSERT OR REPLACE INTO relay_owner_job_deadlines(job_id,source,deadline_ms,expired)\n      SELECT id,'recovery:'||NEW.subscription_id||':'||NEW.event_seq,NEW.last_recovery_ms+60000,0\n      FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n      WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT substr(message_id,7) FROM relay_events WHERE seq=NEW.event_seq AND message_id LIKE 'owner:%') AND NEW.recoveries<2; END"
    },
    {
        "name": "relay_owner_job_change_relay_owner_job_events_insert",
        "table": "relay_owner_job_events",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_relay_owner_job_events_insert AFTER INSERT ON relay_owner_job_events  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT NEW.job_id); END"
    },
    {
        "name": "relay_owner_job_change_relay_owner_job_result_corrections_insert",
        "table": "relay_owner_job_result_corrections",
        "type": "trigger",
        "retainedInSource": false,
        "sql": "CREATE TRIGGER relay_owner_job_change_relay_owner_job_result_corrections_insert AFTER INSERT ON relay_owner_job_result_corrections  BEGIN INSERT OR REPLACE INTO relay_owner_job_changes(job_id)\n  -- This existing UNIQUE(id) index avoids choosing kind/seq and scanning the\n  -- entire private inbox for each trigger's small IN-subquery.\n  SELECT id FROM relay_owner_entries INDEXED BY sqlite_autoindex_relay_owner_entries_1\n  WHERE kind='user' AND principal='github:183016859' AND id IN (SELECT NEW.job_id); END"
    }
]),
  provider: freezeRows([
    {
        "name": "_cf_KV",
        "table": "_cf_KV",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID"
    },
    {
        "name": "sqlite_sequence",
        "table": "sqlite_sequence",
        "type": "table",
        "retainedInSource": true,
        "sql": "CREATE TABLE sqlite_sequence(name,seq)"
    }
]),
});

// Preserve quoted literals exactly. Whitespace, comments, keyword case and the
// optional IF NOT EXISTS clause do not distinguish the same reviewed schema.
export function relayMigrationSchemaSql(value) {
  if (typeof value !== 'string') return null;
  const tokens = value.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|[^\s]/g) || [];
  const normalized = tokens.filter(token => !token.startsWith('--') && !token.startsWith('/*'))
    .map(token => /^[\'"`\[]/.test(token) ? token : token.toLowerCase());
  const kind = normalized.findIndex((token, i) => i > 0 && i < 4 && ['table', 'index', 'trigger'].includes(token));
  if (kind >= 0 && normalized.slice(kind + 1, kind + 4).join(' ') === 'if not exists') normalized.splice(kind + 1, 3);
  return normalized.join(' ');
}

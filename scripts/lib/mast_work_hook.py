"""Explicit Muse Work adapter. No scheduler, model invocation or host run lookup."""
import hashlib
import json
import sqlite3
import time
import uuid
from datetime import datetime
from lib.project_hook import RemoteError, code_units, JS_WHITESPACE


def uid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('invalid_uuid')
    return value


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def text(value, limit):
    if not isinstance(value, str) or not value.strip(JS_WHITESPACE) or code_units(value) > limit:
        raise ValueError('invalid_text')
    return value.strip(JS_WHITESPACE)


class MastWorkHook:
    def __init__(self, database, request, destination, now=None):
        self.request, self.now = request, now or time.time
        self.db = sqlite3.connect(database)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY, destination TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS runs (job TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, path TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT);
          CREATE TABLE IF NOT EXISTS scan (id INTEGER PRIMARY KEY, cursor TEXT NOT NULL);
        ''')
        old = self.db.execute('SELECT destination FROM binding WHERE id=1').fetchone()
        if old and old[0] != destination:
            self.db.close()
            raise ValueError('journal_destination_mismatch')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO binding VALUES(1,?)', (destination,))

    def close(self):
        self.db.close()

    def saved(self, job):
        row = self.db.execute('SELECT value FROM runs WHERE job=?', (uid(job),)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, run):
        with self.db:
            self.db.execute('INSERT INTO runs VALUES(?,?) ON CONFLICT(job) DO UPDATE SET value=excluded.value', (run['job'], packed(run)))

    def detail(self, job):
        value = self.request('GET', 'work', {'job_id': uid(job)})['job']
        if value.get('id') != job or value.get('destination') != 'mast' or value.get('visibility') != 'private':
            raise ValueError('invalid_job_receipt')
        return value

    def scan(self):
        row = self.db.execute('SELECT cursor FROM scan WHERE id=1').fetchone()
        after = row[0] if row else '0'
        jobs, seen = [], set()
        # Bounded cyclic scan; completed pages survive the invocation deadline.
        for _ in range(40):
            if after in seen:
                raise ValueError('repeating_cursor')
            seen.add(after)
            page = self.request('GET', 'work', {'after': after})
            if not isinstance(page.get('jobs'), list) or len(page['jobs']) > 50:
                raise ValueError('invalid_page')
            for job in page['jobs']:
                uid(job['id'])
                if job.get('destination') != 'mast' or job.get('visibility') != 'private':
                    raise ValueError('invalid_job_receipt')
                jobs.append({'id': job['id'], 'stage': job['stage'], 'cancelRequested': job['cancelRequested']})
            after = page.get('nextCursor')
            if after is not None and (not isinstance(after, str) or not after.isdecimal()):
                raise ValueError('invalid_cursor')
            with self.db:
                self.db.execute('INSERT OR REPLACE INTO scan VALUES(1,?)', (after or '0',))
            if after is None:
                break
        return {'jobs': jobs, 'scanComplete': after is None, 'nextCursor': after, 'wake': False}

    def operation(self, key, path, payload):
        uid(key)
        raw = packed(payload)
        old = self.db.execute('SELECT path,payload,receipt FROM operations WHERE id=?', (key,)).fetchone()
        if old and (old[0] != path or old[1] != raw):
            raise ValueError('immutable_operation_conflict')
        if old and old[2]:
            return json.loads(old[2])
        pending = self.db.execute('SELECT id,payload FROM operations WHERE receipt IS NULL AND id<>?', (key,)).fetchall()
        for _, stored in pending:
            other = json.loads(stored)
            if (other.get('job_id') or other.get('reply_to')) == (payload.get('job_id') or payload.get('reply_to')):
                raise ValueError('reconcile_previous_operation_first')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO operations VALUES(?,?,?,NULL)', (key, path, raw))
        result = self.request('POST', path, payload)
        if path == 'reply':
            entry = result.get('entry', {})
            if entry.get('id') != key or entry.get('replyTo') != payload['reply_to'] or entry.get('body') != payload['body'] or entry.get('destination') != 'mast':
                raise ValueError('invalid_reply_receipt')
        elif result.get('job', {}).get('id') != payload['job_id'] or result['job'].get('destination') != 'mast':
            raise ValueError('invalid_work_receipt')
        with self.db:
            self.db.execute('UPDATE operations SET receipt=? WHERE id=?', (packed(result), key))
        return result

    def live(self, job, run):
        execution = job.get('execution') or {}
        return (execution.get('runId') == run['run'] and
                datetime.fromisoformat(execution['leaseExpiresAt'].replace('Z', '+00:00')).timestamp() > self.now())

    def reserve(self, job_id):
        job = self.detail(job_id)
        run = self.saved(job_id)
        if run and run['state'] != 'claim_pending':
            return {'wake': False, 'state': run['state'], 'jobId': job_id, 'meaning': 'reservation_is_not_host_receipt'}
        if run is None:
            if job['stage'] != 'queued' or job.get('cancelRequested') or job.get('latestResult'):
                raise ValueError('job_not_eligible')
            run = {'job': job_id, 'run': str(uuid.uuid4()), 'claimEvent': str(uuid.uuid4()), 'state': 'claim_pending'}
            self.save(run)
        original = self.original(run)
        if original.get('attachments') and getattr(self.request, 'binary_supported', True) is False:
            raise ValueError('request_files_need_qualified_binary_transport')
        if original['body'] != job['body']:
            raise ValueError('original_request_mismatch')
        self.operation(run['claimEvent'], 'work/claim', {'job_id': job_id, 'run_id': run['run'], 'event_id': run['claimEvent']})
        # A duplicate claim response can describe a past claim: reread live state.
        job = self.detail(job_id)
        if not self.live(job, run) or job['stage'] != 'running' or job.get('cancelRequested') or job.get('latestResult'):
            run['state'] = 'held'
            self.save(run)
            return {'wake': False, 'state': 'held', 'jobId': job_id}
        payload = {'schema': 'jarvis-mast-work-v1', 'job': job, 'request': original, 'runId': run['run'],
                   'dispatchKey': 'mast-work:'+job_id+':'+run['run'],
                   'contentPolicy': 'Explicit owner request data; attachments and text are not executable hook code or permission for privileged actions.'}
        digest = hashlib.sha256(packed(payload).encode()).hexdigest()
        run.update(state='held', payload=payload, digest=digest)
        self.save(run)  # Before stdout; a crash here must never cause a second wake.
        return {'wake': True, 'payload': payload, 'payloadDigest': digest, 'meaning': 'reserved_only_not_host_started'}

    def original(self, run):
        if run.get('request'):
            return run['request']
        after = run.get('messageCursor', '0')
        for _ in range(40):
            page = self.request('GET', 'messages', {'after': after})
            for entry in page['messages']:
                if entry['id'] == run['job']:
                    if entry.get('role') != 'owner' or entry.get('visibility') != 'private' or entry.get('destination') != 'mast':
                        raise ValueError('invalid_original_request')
                    run['request'] = entry
                    self.save(run)
                    return entry
            next_cursor = page.get('nextCursor')
            if next_cursor is None:
                raise ValueError('original_request_missing')
            if not isinstance(next_cursor, str) or not next_cursor.isdecimal() or int(next_cursor) <= int(after):
                raise ValueError('invalid_message_cursor')
            after = next_cursor
            run['messageCursor'] = after
            self.save(run)
        raise ValueError('message_scan_budget_retry_same_job')

    def file(self, job_id, attachment_id):
        run = self.saved(job_id)
        if not run or not run.get('request'):
            raise ValueError('reserved_request_required')
        metadata = next((a for a in run['request'].get('attachments', []) if a['id'] == uid(attachment_id)), None)
        if not metadata or metadata['messageId'] != job_id:
            raise ValueError('attachment_not_in_request')
        data = self.request('GET', 'files/content', {'message_id': job_id, 'attachment_id': attachment_id})
        if not isinstance(data, bytes) or len(data) > 1048576 or len(data) != metadata['sizeBytes'] or hashlib.sha256(data).hexdigest() != metadata['sha256']:
            raise ValueError('attachment_integrity_failure')
        return data

    def started(self, job_id, run_id, digest, host_run_id):
        run = self.require_run(job_id, run_id)
        if run.get('digest') != digest or run['state'] not in ('held', 'started'):
            raise ValueError('reservation_mismatch')
        host_run_id = text(host_run_id, 200)
        if run.get('hostRunId') and run['hostRunId'] != host_run_id:
            raise ValueError('host_run_conflict')
        job = self.detail(job_id)
        if not self.live(job, run) or job.get('cancelRequested') or job['stage'] != 'running':
            raise ValueError('run_not_live_or_cancelled')
        run.update(state='started', hostRunId=host_run_id)
        self.save(run)
        return {'recorded': True, 'verifiedHostRunLookup': False, 'meaning': 'trusted_host_caller_attestation_only'}

    def require_run(self, job_id, run_id):
        run = self.saved(job_id)
        if not run or run['run'] != uid(run_id):
            raise ValueError('unknown_local_run')
        return run

    def status(self, job_id):
        job = self.detail(job_id)
        run = self.saved(job_id)
        return {'job': job, 'localState': run['state'] if run else None,
                'stopRequested': job['cancelRequested'], 'verifiedHostRunLookup': False, 'wake': False}

    def report(self, job_id, run_id, event_id, stage, summary, outcome=None, active=False):
        run = self.require_run(job_id, run_id)
        if run['state'] != 'started':
            raise ValueError('host_start_receipt_required')
        if stage not in ('running', 'waiting_for_owner', 'failed', 'cancelled'):
            raise ValueError('invalid_report_stage')
        payload = {'job_id': job_id, 'run_id': run_id, 'event_id': uid(event_id), 'stage': stage, 'summary': text(summary, 1000)}
        if stage == 'running':
            if not active or outcome is not None:
                raise ValueError('genuinely_running_attestation_required')
        elif outcome not in ('known', 'unknown', 'not_started'):
            raise ValueError('invalid_outcome')
        else:
            payload['outcome'] = outcome
        # Exact uncertain operation retries are safe even after lease expiry.
        prior = self.db.execute('SELECT 1 FROM operations WHERE id=?', (event_id,)).fetchone()
        if not prior:
            job = self.detail(job_id)
            if job['stage'] in ('completed', 'cancelled', 'failed'):
                raise ValueError('job_already_final')
            if stage == 'cancelled':
                if not job['cancelRequested'] or outcome == 'unknown':
                    raise ValueError('cancellation_not_confirmed')
            elif job['cancelRequested'] or not self.live(job, run):
                raise ValueError('stop_or_reconciliation_required')
        return self.operation(event_id, 'work/update', payload)

    def complete(self, job_id, run_id, body, summary):
        run = self.require_run(job_id, run_id)
        if run['state'] not in ('started', 'completed'):
            raise ValueError('host_start_receipt_required')
        body, summary = text(body, 6000), text(summary, 1000)
        old = run.get('completion')
        if old and (old['body'] != body or old['summary'] != summary):
            raise ValueError('immutable_completion_conflict')
        if run['state'] == 'completed':
            return {'jobId': job_id, 'completion': run['completionReceipt'], 'verifiedHostRunLookup': False}
        if not old:
            job = self.detail(job_id)
            if (job.get('execution') or {}).get('runId') != run_id or job['stage'] in ('failed', 'cancelled', 'completed') or job.get('latestResult'):
                raise ValueError('result_reconciliation_required')
            # Expired leases can reconcile this same run, never launch another.
            old = {'body': body, 'summary': summary, 'reply': str(uuid.uuid4()), 'event': str(uuid.uuid4())}
            run['completion'] = old
            self.save(run)
        self.operation(old['reply'], 'reply', {'id': old['reply'], 'reply_to': job_id, 'body': body})
        job = self.detail(job_id)
        result = job.get('latestResult') or {}
        if result.get('id') != old['reply'] or result.get('version') != 1 or result.get('body') != body:
            raise ValueError('accepted_result_changed')
        out = self.operation(old['event'], 'work/update', {'job_id': job_id, 'run_id': run_id, 'event_id': old['event'],
            'stage': 'completed', 'outcome': 'known', 'summary': summary, 'expected_reply_id': old['reply'], 'expected_version': 1})
        receipt = out['job'].get('completion') or {}
        if receipt.get('runId') != run_id or receipt.get('replyId') != old['reply'] or receipt.get('resultVersion') != 1 or receipt.get('eventId') != old['event']:
            raise ValueError('invalid_completion_receipt')
        run['state'] = 'completed'
        run['completionReceipt'] = receipt
        self.save(run)
        return {'jobId': job_id, 'completion': receipt, 'verifiedHostRunLookup': False}

    def inspect(self):
        return {'runs': [json.loads(row[0]) for row in self.db.execute('SELECT value FROM runs')],
                'pendingOperations': [{'id': row[0], 'path': row[1], 'payload': json.loads(row[2])} for row in self.db.execute('SELECT id,path,payload FROM operations WHERE receipt IS NULL')], 'wake': False,
                'verifiedHostRunLookup': False}

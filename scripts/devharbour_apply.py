"""Independent, one-shot Settings replacement worker and redacted operation ledger.

The web process queues an approved revision. A separate container runs the same
CLI under its config lock, survives replacement and records readiness afterwards.
No raw subprocess output, environment values or passwords enter the status file.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import sys
import time

import devharbour as cli
from devharbour_identity import verify_self

ACTIVE = {'queued', 'validate', 'image', 'recreate', 'health'}
MESSAGES = {'queued': 'Starting independent worker', 'validate': 'Validating reviewed configuration',
            'image': 'Preparing the selected image; current DevHarbour stays running',
            'recreate': 'Recreating the reviewed DevHarbour instance',
            'health': 'Checking application, Docker and SSH-agent readiness',
            'succeeded': 'DevHarbour is ready. Sign in again.',
            'failed': 'Apply failed. Last-applied state was not advanced unless readiness completed. Use host logs and apply to recover.'}


def ledger(path):
    """Keep progress beside the mounted config, separate from the CLI lock."""
    return path.with_name(path.name + '.apply.json')


def status(path, reconcile=True):
    """Read retained progress and diagnose a worker that exited unexpectedly."""
    record = cli.read_json(ledger(path)) if ledger(path).exists() else None
    if record and reconcile and record.get('phase') in ACTIVE and time.time() - record['updatedAt'] > 30:
        # A Docker outage is not proof of worker death; let the caller show unavailable.
        helper = cli.inspect(record['helperName'])
        if helper is None or helper.get('State', {}).get('Status') in {'exited', 'dead'}:
            record = advance(path, record['id'], 'failed')
    return record


def public(record):
    """Return only the allowlisted status contract, never internal review data."""
    if not record:
        return None
    return {key: record.get(key) for key in ('id', 'phase', 'message', 'startedAt', 'updatedAt', 'targetUrl', 'previousUrl')}


def advance(path, identifier, phase):
    """Atomically publish one operation transition, without overwriting a later run."""
    record = cli.read_json(ledger(path))
    if record['id'] != identifier:
        raise cli.CliError('Operation changed; refusing to overwrite it')
    previous = record['phase']
    record.update(phase=phase, message=MESSAGES[phase], updatedAt=int(time.time()))
    if phase == 'failed':
        record['message'] = 'Apply failed during ' + previous + '. Inspect host logs and the current instance before retrying.'
    cli.atomic_json(ledger(path), record)
    return record


def owned_instance(path, config, require_self=False):
    """Refuse adoption and target only the exact currently owned DevHarbour."""
    current = cli.inspect(config['instanceName'])
    owner = hashlib.sha256(str(path).encode()).hexdigest()
    if not current or (current.get('Config', {}).get('Labels') or {}).get(cli.LABEL_OWNER) != owner:
        raise cli.CliError('The configured instance is missing or not owned; use the host CLI')
    if require_self:
        verify_self(current['Id'])
    return current


def helper_arguments(path, record, config, current):
    """Mount only reviewed paths and the Docker socket; never the host home."""
    settings = cli.normalized(config, path.parent)
    socket_mount = next((m for m in current.get('Mounts', []) if m['Destination'] == '/var/run/docker.sock' and m['Type'] == 'bind'), None)
    if not socket_mount:
        raise cli.CliError('The managed Docker socket bind is unavailable')
    args = ['docker', 'run', '--detach', '--rm', '--name', record['helperName'],
            '--label', 'devharbour.apply-operation=' + record['id'],
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--user', str(os.getuid()) + ':' + str(os.getgid()), '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777',
            '--env', 'HOME=/tmp/devharbour-helper', '--entrypoint', 'python3']
    for gid in sorted(set(os.getgroups())):
        args += ['--group-add', str(gid)]
    args += ['--mount', 'type=bind,source=' + str(path.parent) + ',target=' + str(path.parent),
             '--mount', 'type=bind,source=' + socket_mount['Source'] + ',target=/var/run/docker.sock']
    # Local inputs outside the config directory are immutable, read-only mounts.
    paths = [settings['password-file'], *settings.get('env-file', []), settings['workspace']]
    if config.get('source', {}).get('checkout'):
        paths.append(config['source']['checkout'])
    for name in sorted(set(paths)):
        item = Path(name)
        if item == path.parent or path.parent in item.parents:
            continue
        if not item.is_absolute() or any(c in name for c in ',\n\r') or item in path.parent.parents:
            raise cli.CliError('Unsafe worker input mount; use the host CLI')
        args += ['--mount', 'type=bind,source=' + name + ',target=' + name + ',readonly']
    args += [current['Image'], '/app/scripts/devharbour_apply.py', '--config', str(path), '--operation', record['id']]
    return args


def run_worker(path, identifier):
    """Guard the reviewed state under the CLI lock and persist actual phase changes."""
    from devharbour_settings import document, revision
    Path.home().mkdir(mode=0o700, exist_ok=True)
    time.sleep(3)  # Let the authenticated queue response reach the browser first.
    record = status(path, reconcile=False)
    if not record or record['id'] != identifier or record['phase'] != 'queued':
        raise cli.CliError('No matching queued operation')

    def guard(config):
        """Reject stale desired state, changed input files and another CLI apply."""
        if revision(path, config) != record['revision']:
            raise cli.CliError('Reviewed settings changed before the worker acquired the lock')
        current = owned_instance(path, config)
        if current['Id'] != record['containerId']:
            raise cli.CliError('Reviewed instance changed')
        advance(path, identifier, 'validate')
        return current['Id']

    try:
        sys.argv = ['devharbour', 'apply', '--config', str(path), '--non-interactive', '--replace', '--allow-exposure']
        cli.main(apply_guard=guard, progress=lambda phase: advance(path, identifier, phase),
                 source_cache=path.parent / '.apply-source')
        advance(path, identifier, 'succeeded')
    except Exception:
        advance(path, identifier, 'failed')
        raise


def main():
    """Run only the fixed operation selected by the authenticated queue endpoint."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--operation', required=True)
    args = parser.parse_args()
    path = Path(args.config)
    if not re.fullmatch(r'[a-f0-9]{32}', args.operation) or not path.is_absolute() or path.parent.resolve() != path.parent:
        raise cli.CliError('Invalid worker arguments')
    # CLI diagnostics can contain reviewed path values. Do not retain logs in Docker.
    with open(os.devnull, 'w') as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
        run_worker(path, args.operation)


if __name__ == '__main__':
    main()

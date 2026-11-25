"""Authenticated web Settings persistence, invoked by the Node server over stdin.

Reuse the host CLI's validators, flock and atomic writes. Never return secret
contents. Save-only operations change desired state; explicit apply review/queue
operations supervise a separate CLI worker through Docker. Environment/password
replacement uses immutable files published by one atomic config update.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import shlex
import subprocess
import sys
import time

import devharbour as cli
import devharbour_env as env
from devharbour_identity import ApplyIdentityError
from devharbour_source import SourceError, validate_source
from devharbour_quickstart import address
from devharbour_schema import SCHEMA, PROPERTIES, validate

LIMIT = 262144
SAFE_ENV = {'TERN_USE_CCACHE', 'OPENCODE_SKIP_START', 'OPENCODE_PORT'}


class SettingsError(Exception):
    """Public error with a deliberate HTTP status and no secret values."""

    def __init__(self, message, status=400):
        """Keep public diagnostics separate from unexpected system exceptions."""
        super().__init__(message)
        self.status = status


def bounded_read(path):
    """Read a bounded owned private file without accepting a symlink."""
    cli.check_private(path)
    with path.open('rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise SettingsError('Settings file exceeds the size limit.')
    return data


def document(path):
    """Load the saved document using the same shape checks as the CLI."""
    bounded_read(path)
    args = cli.parser().parse_args(['configure', '--config', str(path), '--non-interactive'])
    _, config = cli.merge_config(path, args)
    validate(config)
    return config


def editable_env(config, path):
    """Find only our private environment file, never an arbitrary host file."""
    candidates = []
    for index, name in enumerate(config['settings'].get('env-file', [])):
        item = Path(name)
        item = item if item.is_absolute() else path.parent / item
        if item.parent == path.parent and (item.name == 'devcontainer.env' or (item.name.startswith('managed-env-') and item.suffix == '.env')):
            candidates.append((index, item))
    return candidates[-1] if candidates else (None, None)


def revision(path, config):
    """Bind saves to config bytes and input/state metadata to reject stale editors."""
    values = [hashlib.sha256(bounded_read(path)).hexdigest()]
    settings = cli.normalized(config, path.parent)
    for name in [settings['password-file'], *settings.get('env-file', []), str(path) + '.state.json']:
        try:
            info = Path(name).lstat()
            values.append([name, info.st_ino, info.st_mtime_ns, info.st_size])
        except FileNotFoundError:
            values.append([name, None])
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def snapshot(path, config):
    """Return redacted desired state, schema metadata and pending-apply status."""
    _, env_path = editable_env(config, path)
    variables = []
    if env_path:
        bounded_read(env_path)
        _, values = env.read(env_path)
        for key, value in values.items():
            public = key in SAFE_ENV
            if public:
                try:
                    env.validate(key, value)
                except env.EnvError:
                    public = False
            variables.append({'name': key, 'secret': not public, 'set': bool(value),
                              **({'value': value} if public else {})})
    settings = cli.normalized(config, path.parent)
    state_path = path.with_name(path.name + '.state.json')
    state = cli.read_json(state_path) if state_path.exists() or state_path.is_symlink() else {}
    if not isinstance(state, dict):
        raise SettingsError('Invalid last-applied state. Inspect it on the host.', 409)
    try:
        pending = state.get('fingerprint') != cli.desired_fingerprint(config, settings)
    except OSError:
        pending = True
    applied = state.get('deployment', {})
    # Do not serialize arbitrary values from the state file to browser clients.
    schema = copy.deepcopy(SCHEMA)
    definitions = schema['properties']['settings']['properties']
    definitions['ai-state-volume']['default'] = cli.resource_names(config)[2]
    definitions['workspace']['default'] = settings['host-home'] + '/ddash-workspace'
    return {'available': True, 'config': config, 'revision': revision(path, config),
            'schema': schema, 'path': str(path), 'pending': pending,
            'appliedAt': state.get('appliedAt') if type(state.get('appliedAt')) is int else None,
            'appliedUrl': address(applied) if isinstance(applied, dict) and applied else None,
            'environment': variables, 'environmentEditable': env_path is not None,
            'applyCommand': 'devharbour --config ' + shlex.quote(str(path)) + ' apply'}


def validate_deployment(config, path):
    """Use the shared schema and authoritative no-Docker launcher validator."""
    validate(config)
    cli.validate_types(config['settings'])
    if 'source' in config:
        validate_source(config['source'])
    cli.resource_names(config)
    settings = cli.normalized(config, path.parent)
    settings.pop('health-timeout', None)
    argv = cli.launch_argv(config, settings, '0' * 64, '0' * 64, config_path=path)
    result = subprocess.run(argv + ['--validate-only'], stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, timeout=10, check=False)
    if result.returncode:
        raise SettingsError('Invalid deployment combination or unavailable environment file. Check ports, origins, Tailscale/MCP dependencies and file paths. Nothing was saved.')


def save_config(path, old, payload, publish=True):
    """Validate all edited data and publish only the desired JSON."""
    config = payload.get('config')
    if not isinstance(config, dict):
        raise SettingsError('A configuration object is required.')
    config = copy.deepcopy(config)
    validate(config)
    if config['instanceName'] != old['instanceName']:
        raise SettingsError('Instance name is immutable. Use the host CLI for legacy migration.')
    for key, definition in PROPERTIES.items():
        if definition.get('x-web-editable') is False and config['settings'].get(key) != old['settings'].get(key):
            raise SettingsError('Use the dedicated control or host CLI for ' + key)
    before_source = old.get('source', {})
    source = config.get('source', {})
    if any(source.get(k) != before_source.get(k) for k in ('checkout', 'revision')):
        raise SettingsError('Resolved source paths and revisions are host-CLI managed.')
    if (source.get('mode'), source.get('ref')) != (before_source.get('mode'), before_source.get('ref')):
        source.pop('checkout', None)
        source.pop('revision', None)
        if source.get('mode') == 'published':
            if before_source.get('mode') == 'build' and config['settings'].get('image') == old['settings'].get('image'):
                config['settings']['image'] = cli.DEFAULTS['image']
            else:
                config['settings']['image'] = config['settings'].get('image') or cli.DEFAULTS['image']
    validate_deployment(config, path)
    old_exposure = cli.exposed(cli.normalized(old, path.parent))
    new_exposure = cli.exposed(cli.normalized(config, path.parent))
    if any(old_exposure.get(k) != v for k, v in new_exposure.items()) and payload.get('allowExposure') is not True:
        raise SettingsError('Explicit remote-access approval is required.', 409)
    _, managed_input = editable_env(config, path)
    if managed_input:
        bounded_read(managed_input)
        env.read(managed_input)
    if publish:
        cli.atomic_json(path, config)
    return config


def replace_private_input(path, config, payload, password=False):
    """Stage an immutable input and publish its reference with the config atomically."""
    updated = copy.deepcopy(config)
    new_path = None
    committed = False
    try:
        if password:
            value = payload.get('password')
            if not isinstance(value, str) or not 12 <= len(value) <= 4096 or any(ord(c) < 32 or ord(c) == 127 for c in value):
                raise SettingsError('Use a password with 12 to 4096 characters and no control characters.')
            new_path = path.parent / ('password-' + secrets.token_hex(12))
            fd = os.open(new_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(value + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            updated['settings']['password-file'] = str(new_path)
        else:
            index, old_path = editable_env(config, path)
            if old_path is None:
                raise SettingsError('No managed environment file. Configure an env-file in the private config directory first.')
            bounded_read(old_path)
            lines, _ = env.read(old_path)
            updates = payload.get('updates')
            if not isinstance(updates, dict) or len(updates) > 128 or not updates:
                raise SettingsError('Provide between 1 and 128 environment updates.')
            for key, value in updates.items():
                if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', key):
                    raise SettingsError('Invalid environment variable name.')
                env.validate(key, value)
                if len(value) > 8192:
                    raise SettingsError('Environment value is too long.')
            # Docker uses the last duplicate assignment. Remove all old entries
            # for updated keys so the new value cannot be shadowed by a later line.
            lines = [line for line in lines if not (env.KEY.match(line) and env.KEY.match(line)[1] in updates)]
            new_path = path.parent / ('managed-env-' + secrets.token_hex(12) + '.env')
            env.write(new_path, updates, lines)
            updated['settings']['env-file'][index] = str(new_path)
        validate_deployment(updated, path)
        cli.atomic_json(path, updated)
        committed = True
        return updated
    finally:
        # Retain old input files for recovery; never delete operator files.
        if new_path and not committed and new_path.exists():
            new_path.unlink()


def apply_review(path, config, payload):
    """Validate a candidate without saving it and bind a short-lived review token."""
    import devharbour_apply as apply
    from devharbour_quickstart import address
    active = apply.status(path)
    if active and active['phase'] in apply.ACTIVE:
        raise SettingsError('An apply operation is already active.', 409)
    current = apply.owned_instance(path, config, require_self=True)
    candidate = save_config(path, config, {'config': payload.get('config', config), 'allowExposure': True}, publish=False)
    requested = cli.normalized(candidate, path.parent)
    state_path = path.with_name(path.name + '.state.json')
    state = cli.read_json(state_path) if state_path.exists() else {}
    previous = state.get('deployment', {})
    changes = []
    for key in sorted(set(previous) | set(requested)):
        if key not in {'instanceName', 'restartPolicy'} and previous.get(key) != requested.get(key):
            changes.append({'key': key, 'before': previous.get(key), 'after': requested.get(key)})
    if previous.get('restartPolicy') != candidate['restartPolicy']:
        changes.append({'key': 'restartPolicy', 'before': previous.get('restartPolicy'), 'after': candidate['restartPolicy']})
    if candidate.get('source', {}).get('mode') == 'build':
        changes.append({'key': 'source', 'before': 'Running image: ' + current['Image'], 'after': candidate['source']})
    inputs = [key for key in [requested['password-file'], *requested.get('env-file', [])]
              if state.get('inputDigests', {}).get(key) != cli.file_digest(key)]
    if inputs:
        changes.append({'key': 'private inputs', 'before': 'Previously applied files', 'after': 'Credentials or environment changed (values hidden)'})
    exposure = any(apply_value != cli.exposed(previous).get(key) for key, apply_value in cli.exposed(requested).items())
    token = secrets.token_hex(16)
    review = {'token': token, 'expiresAt': int(time.time()) + 600, 'revision': revision(path, config),
              'config': candidate, 'fingerprint': cli.desired_fingerprint(candidate, requested),
              'containerId': current['Id'], 'requiresExposure': exposure,
              'previousUrl': address(previous) if previous else None, 'targetUrl': address(requested), 'changes': changes}
    cli.atomic_json(path.with_name(path.name + '.review.json'), review)
    return {key: review[key] for key in ('token', 'expiresAt', 'revision', 'requiresExposure', 'previousUrl', 'targetUrl', 'changes')}


def apply_queue(path, config, payload):
    """Save the exact approved candidate and start an independent same-image worker."""
    import devharbour_apply as apply
    active = apply.status(path)
    if active and active['phase'] in apply.ACTIVE:
        raise SettingsError('An apply operation is already active.', 409)
    review = cli.read_json(path.with_name(path.name + '.review.json'))
    if (payload.get('token') != review['token'] or time.time() > review['expiresAt']
            or revision(path, config) != review['revision'] or payload.get('confirmRecreate') is not True):
        raise SettingsError('Review expired or configuration changed. Review again.', 409)
    if review['requiresExposure'] and payload.get('allowExposure') is not True:
        raise SettingsError('Explicit remote-access approval is required.', 409)
    current = apply.owned_instance(path, config, require_self=True)
    if current['Id'] != review['containerId']:
        raise SettingsError('Reviewed container changed. Review again.', 409)
    desired = review['config']
    validate_deployment(desired, path)
    if cli.desired_fingerprint(desired, cli.normalized(desired, path.parent)) != review['fingerprint']:
        raise SettingsError('Reviewed input files changed. Review again.', 409)
    identifier = secrets.token_hex(16)
    now = int(time.time())
    record = {'id': identifier, 'helperName': 'devharbour-apply-' + identifier, 'phase': 'queued',
              'startedAt': now, 'updatedAt': now, 'message': apply.MESSAGES['queued'],
              'containerId': current['Id'], 'targetUrl': review['targetUrl'], 'previousUrl': review['previousUrl']}
    argv = apply.helper_arguments(path, record, desired, current)
    cli.atomic_json(path, desired)
    record['revision'] = revision(path, desired)
    cli.atomic_json(apply.ledger(path), record)
    result = cli.run(argv, capture=True, check=False)
    if result.returncode:
        apply.advance(path, identifier, 'failed')
        raise SettingsError('Settings were saved, but the independent worker could not start. Use host devharbour apply.', 409)
    return {'operation': apply.public(record)}


def main():
    """Dispatch one bounded JSON request against the fixed mounted config path."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    path = Path(args.config)
    if not path.is_absolute() or path.parent.resolve() != path.parent:
        raise SettingsError('Settings require a canonical absolute config path.')
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise SettingsError('Request is too large.', 413)
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise SettingsError('A JSON object is required.')
    operation = payload.get('operation', 'read')
    if operation not in {'read', 'save', 'environment', 'password', 'apply-review', 'apply-queue', 'apply-status'}:
        raise SettingsError('Unknown Settings operation.')
    # Fail if the mount is absent. Do not create a new private config accidentally.
    if not path.is_file():
        raise SettingsError('Managed configuration is unavailable. Recreate with the updated host CLI.', 409)
    if operation == 'apply-status':
        import devharbour_apply as apply
        print(json.dumps({'ok': True, 'data': {'operation': apply.public(apply.status(path))}}))
        return
    with cli.config_lock(path, shared=operation == 'read', timeout=0.75):
        config = document(path)
        if operation in {'apply-review', 'apply-queue'}:
            if operation == 'apply-review' and payload.get('revision') != revision(path, config):
                raise SettingsError('Settings changed. Reload before reviewing.', 409)
            result = apply_review(path, config, payload) if operation == 'apply-review' else apply_queue(path, config, payload)
            print(json.dumps({'ok': True, 'data': result}))
            return
        if operation != 'read':
            if payload.get('revision') != revision(path, config):
                raise SettingsError('Settings changed on the host. Reload before saving.', 409)
            if operation == 'save':
                config = save_config(path, config, payload)
            else:
                config = replace_private_input(path, config, payload, operation == 'password')
        print(json.dumps({'ok': True, 'data': snapshot(path, config)}))


if __name__ == '__main__':
    try:
        main()
    except SettingsError as error:
        print(json.dumps({'ok': False, 'message': str(error), 'status': error.status}))
    except ApplyIdentityError as error:
        print(json.dumps({'ok': False, 'message': str(error), 'status': 409}))
    except cli.CliError:
        print(json.dumps({'ok': False, 'message': 'Configuration is busy, invalid or not private. Check it on the host and retry.', 'status': 409}))
    except (ValueError, env.EnvError, SourceError):
        print(json.dumps({'ok': False, 'message': 'Invalid configuration or environment value. Check the field types, ranges and file format.', 'status': 400}))
    except (OSError, RuntimeError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'message': 'Settings could not be accessed safely. Check the private config mount and host permissions.', 'status': 409}))

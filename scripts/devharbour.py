#!/usr/bin/env python3
"""DevHarbour operator CLI: Python 3.9+, Linux, standard library only.

Bash remains authoritative for launch validation and Docker launch arguments.
Configuration is data, never executable input.
"""
import argparse
import contextlib
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time

VERSION = '0.1.0'
ROOT = Path(__file__).resolve().parent
STRINGS = {'workspace', 'socket', 'bind-address', 'origin', 'password-file', 'host-user',
           'host-home', 'host-name', 'ssh-agent-socket', 'ssh-known-hosts', 'gateway-host',
           'gateway-ports', 'vscode-ssh-host', 'image', 'ai-state-volume', 'brain-token-file',
           'tailscale-socket', 'tailscale-ports', 'platform', 'name', 'source-checkout'}
NUMBERS = {'host-uid', 'host-gid', 'port', 'ai-port', 'brain-port', 'brain-funnel-port',
           'tailscale-gateway-port', 'health-timeout'}
BOOLEANS = {'bootstrap', 'no-create-workspace', 'gateway', 'brain', 'brain-funnel',
            'tailscale-allow-wildcard-bindings'}
LOCAL_PATHS = {'password-file', 'source-checkout'}
HOST_PATHS = {'workspace', 'socket', 'host-home', 'ssh-agent-socket', 'ssh-known-hosts', 'tailscale-socket', 'brain-token-file'}
REQUIRED = {'host-user', 'host-uid', 'host-gid', 'host-home', 'ssh-agent-socket', 'password-file'}
DEFAULTS = {'socket': '/var/run/docker.sock', 'port': 3000, 'ai-port': 3002,
            'bind-address': '127.0.0.1', 'image': 'ghcr.io/axelthas/devcontainer-dashboard:latest'}
LABEL_OWNER = 'devharbour.config-owner'
LABEL_FINGERPRINT = 'devharbour.config-fingerprint'


class CliError(Exception):
    """An operator-facing error that must not include credentials."""


class SafeParser(argparse.ArgumentParser):
    """Do not echo arbitrary argument values in parse errors."""

    def error(self, message):
        """Replace argparse's value-bearing diagnostics with safe guidance."""
        raise CliError('Invalid command arguments; run devharbour --help')


def parser():
    """Build one grammar for interactive, unattended and config-only use."""
    result = SafeParser(description=__doc__.split('\n')[0], allow_abbrev=False)
    result.add_argument('command', nargs='?', default='run', choices=['run', 'configure', 'status', 'logs', 'stop', 'build'])
    installed = (ROOT / 'VERSION').read_text().strip() if (ROOT / 'VERSION').is_file() else 'checkout'
    result.add_argument('--version', action='version', version='DevHarbour ' + VERSION + ' (' + installed + ')')
    result.add_argument('--config', default=str(Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'devharbour/config.json'))
    result.add_argument('--non-interactive', action='store_true')
    result.add_argument('--replace', action='store_true', help='Authorize replacement of this config\'s container; retain volumes')
    result.add_argument('--adopt', action='store_true', help='Explicitly adopt reviewed legacy resources; container adoption also requires --replace')
    result.add_argument('--allow-exposure', action='store_true', help='Authorize newly enabled remote access, Tailscale or Brain Funnel')
    result.add_argument('--build', action='store_true', dest='build_mode', help='Run an isolated checkout build')
    result.add_argument('--instance-name', default=argparse.SUPPRESS)
    result.add_argument('--restart-policy', choices=['always', 'unless-stopped', 'on-failure', 'no'], default=argparse.SUPPRESS)
    result.add_argument('--clear', action='append', default=[], metavar='KEY', help='Remove a saved optional setting; repeatable')
    for key in sorted(STRINGS):
        result.add_argument('--' + key, default=argparse.SUPPRESS)
    for key in sorted(NUMBERS):
        result.add_argument('--' + key, type=int, default=argparse.SUPPRESS)
    for key in sorted(BOOLEANS):
        result.add_argument('--' + key, action='store_true', default=argparse.SUPPRESS)
    result.add_argument('--env-file', action='append', default=argparse.SUPPRESS, help='Replace saved env-file list; repeat to layer files')
    return result


def private_directory(path):
    """Create a private owned directory; never chmod an existing host directory."""
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise CliError('Config directory must be owned by you, not a symlink, and mode 0700: ' + str(path))


def check_private(path):
    """Reject symlinks, non-regular files and files accessible to another user."""
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise CliError('Expected an owned regular file with mode 0600: ' + str(path))


def read_json(path):
    """Load JSON without echoing untrusted file content in diagnostics."""
    check_private(path)
    try:
        return json.loads(path.read_text())
    except (ValueError, UnicodeError):
        raise CliError('Invalid JSON: ' + str(path)) from None


def atomic_json(path, value):
    """Sync and atomically publish a private JSON file."""
    if path.exists() or path.is_symlink():
        check_private(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def config_lock(path):
    """Serialize this config's read/modify/write and lifecycle operations."""
    private_directory(path.parent)
    lock = path.with_name(path.name + '.lock')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        check_private(lock)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CliError('Another devharbour command is using this config') from None
        yield
    finally:
        os.close(fd)


def run(arguments, *, capture=False, check=True):
    """Execute literal argv without including sensitive captured diagnostics in errors."""
    try:
        result = subprocess.run(arguments, text=True, stdout=subprocess.PIPE if capture else None,
                                stderr=subprocess.PIPE if capture else None, check=False)
    except OSError:
        raise CliError('Cannot execute ' + str(arguments[0]) + '; check the documented prerequisites') from None
    if check and result.returncode:
        raise CliError('Command failed: ' + str(arguments[0]) + '; check Docker access, host paths and launcher diagnostics')
    return result


def ask(message, default=None, secret=False):
    """Read operator input only from a terminal; never consume piped secrets."""
    try:
        with open('/dev/tty', 'r') as reader, open('/dev/tty', 'w') as tty:
            prompt = message + (' [' + str(default) + ']' if default is not None else '') + ': '
            if secret:
                value = getpass.getpass(prompt, stream=tty)
            else:
                tty.write(prompt)
                tty.flush()
                value = reader.readline()
                if not value:
                    raise CliError('Setup cancelled')
                value = value.rstrip('\n')
            return value if value else default
    except OSError:
        raise CliError('A terminal is required; supply explicit settings with --non-interactive') from None


def confirm(message, args):
    """Require an explicit affirmative answer, never a default yes."""
    if args.non_interactive or str(ask(message + ' (type yes)')).lower() != 'yes':
        raise CliError('Not approved; no deployment changes made')


def validate_types(settings):
    """Reject unknown keys, wrong JSON types and control characters before argv construction."""
    for key, value in settings.items():
        valid = (key in STRINGS and isinstance(value, str) and bool(value)) or (key in NUMBERS and type(value) is int) or (key in BOOLEANS and type(value) is bool) or (key == 'env-file' and isinstance(value, list) and all(isinstance(v, str) and v for v in value))
        if not valid:
            raise CliError('Unknown setting or invalid type: ' + str(key))
        strings = value if isinstance(value, list) else [value] if isinstance(value, str) else []
        if any(any(ord(char) < 32 for char in item) for item in strings):
            raise CliError('Control characters are not allowed in ' + key)


def merge_config(path, args):
    """Validate persisted shape, then merge only explicit CLI settings."""
    old = read_json(path) if path.exists() or path.is_symlink() else None
    if old is None and (path.exists() or path.is_symlink()):
        raise CliError('Unsupported config schema: null is not a configuration')
    config = json.loads(json.dumps(old)) if old is not None else {'schemaVersion': 1, 'instanceName': 'devcontainer-dashboard', 'restartPolicy': 'always', 'settings': {}}
    if not isinstance(config, dict) or set(config) != {'schemaVersion', 'instanceName', 'restartPolicy', 'settings'} or type(config.get('schemaVersion')) is not int or config['schemaVersion'] != 1 or not isinstance(config['settings'], dict):
        raise CliError('Unsupported config schema; expected schemaVersion 1 with instanceName, restartPolicy and settings')
    validate_types(config['settings'])
    values = vars(args)
    for key in STRINGS | NUMBERS | BOOLEANS | {'env-file'}:
        if key.replace('-', '_') in values:
            config['settings'][key] = values[key.replace('-', '_')]
    for key in args.clear:
        if key not in STRINGS | NUMBERS | BOOLEANS | {'env-file'} or key in REQUIRED:
            raise CliError('--clear requires an optional settings key')
        config['settings'].pop(key, None)
        dependencies = {'brain': ['brain-port', 'brain-token-file', 'brain-funnel', 'brain-funnel-port'], 'brain-funnel': ['brain-funnel-port'], 'tailscale-socket': ['tailscale-ports', 'tailscale-gateway-port', 'tailscale-allow-wildcard-bindings', 'brain-funnel', 'brain-funnel-port']}
        for dependent in dependencies.get(key, []):
            config['settings'].pop(dependent, None)
    if hasattr(args, 'instance_name'):
        config['instanceName'] = args.instance_name
    if hasattr(args, 'restart_policy'):
        config['restartPolicy'] = args.restart_policy
    if old and config['instanceName'] != old['instanceName']:
        raise CliError('instanceName is immutable; use a new --config for a separate instance')
    validate_types(config['settings'])
    return old, config


def wizard(config, args):
    """Collect required settings and advanced settings without overwriting CLI values."""
    settings = config['settings']
    missing = REQUIRED - settings.keys()
    pending = None
    if args.non_interactive:
        if missing:
            raise CliError('Missing required settings: ' + ', '.join(sorted(missing)))
        return pending
    first = bool(missing)
    if first:
        print('DevHarbour grants full Docker and terminal operator access. Use a trusted Linux host.')
    suggestions = {}
    local_host = first and str(ask('Is the Docker host this machine? (yes/no)', 'no')).lower() == 'yes'
    if first and not local_host:
        settings.setdefault('no-create-workspace', True)
    if local_host:
        account = pwd.getpwuid(os.getuid())
        suggestions = {'host-user': account.pw_name, 'host-uid': account.pw_uid, 'host-gid': account.pw_gid, 'host-home': account.pw_dir}
    for key in ['host-user', 'host-uid', 'host-gid', 'host-home', 'ssh-agent-socket']:
        if key not in settings:
            answer = ask('Docker-host ' + key, suggestions.get(key))
            if not answer:
                raise CliError('Required setting: ' + key)
            try:
                settings[key] = int(answer) if key in NUMBERS else answer
            except ValueError:
                raise CliError('Expected an integer for ' + key) from None
    if 'workspace' not in settings:
        settings['workspace'] = ask('Workspace directory on Docker host', settings['host-home'] + '/ddash-workspace')
    if 'password-file' not in settings:
        pending = ask('New dashboard password', secret=True)
        if not pending or pending != ask('Repeat dashboard password', secret=True):
            raise CliError('Passwords must be nonempty and match')
    if (first or args.command == 'configure') and str(ask('Configure advanced settings? (yes/no)', 'no')).lower() == 'yes':
        explicit = vars(args)
        for key in sorted((STRINGS | NUMBERS | BOOLEANS | {'env-file'}) - REQUIRED - {'workspace', 'source-checkout', 'platform', 'name'}):
            if key.replace('-', '_') in explicit:
                continue
            current = settings.get(key, DEFAULTS.get(key))
            answer = ask(key + " (blank keeps current; '-' clears)", json.dumps(current) if key == 'env-file' and current else current)
            if answer == '-':
                settings.pop(key, None)
            elif answer is not None and answer != '':
                try:
                    if key in BOOLEANS and str(answer).lower() not in {'true', 'false', 'yes', 'no', '1', '0'}:
                        raise ValueError('Expected yes/no')
                    settings[key] = (str(answer).lower() in {'true', 'yes', '1'}) if key in BOOLEANS else int(answer) if key in NUMBERS else json.loads(answer) if key == 'env-file' else answer
                except (ValueError, TypeError):
                    raise CliError('Invalid input for ' + key) from None
    return pending


def normalized(config, directory, build=False):
    """Resolve defaults and paths while retaining explicit host/client boundaries."""
    settings = {**DEFAULTS, **config['settings']}
    implied_brain = 'brain-port' in settings or 'brain-token-file' in settings or settings.get('brain-funnel')
    if implied_brain and settings.get('brain') is False:
        raise CliError('brain=false conflicts with Brain enablement options; use --clear brain to disable all Brain settings')
    if implied_brain:
        settings['brain'] = True
    if build:
        if 'image' in config['settings'] or 'bind-address' in config['settings']:
            raise CliError('Checkout builds cannot use explicit image or bind-address; use a separate config')
        settings.pop('image', None)
        settings.pop('bind-address', None)
        if 'port' not in config['settings']:
            settings['port'] = 3001
    settings.setdefault('workspace', settings.get('host-home', '') + ('/ddash-production-workspace' if build else '/ddash-workspace'))
    for key in LOCAL_PATHS | HOST_PATHS:
        if key in settings:
            path = Path(settings[key])
            # Never expand ~ or environment values against the wrong machine.
            settings[key] = str(path if path.is_absolute() else directory / path)
    if 'env-file' in settings:
        settings['env-file'] = [str(Path(v) if Path(v).is_absolute() else directory / v) for v in settings['env-file']]
    return settings


def resource_names(config):
    """Keep legacy default volume names and isolate explicitly named extra instances."""
    name = config['instanceName']
    if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,79}', name):
        raise CliError('Invalid instanceName')
    if not isinstance(config['restartPolicy'], str) or config['restartPolicy'] not in {'always', 'unless-stopped', 'on-failure', 'no'}:
        raise CliError('Invalid restartPolicy')
    return ('dashboard_data', 'ddash_zsh_data', 'dashboard_ai') if name == 'devcontainer-dashboard' else (name + '-data', name + '-history', name + '-ai')


def launch_argv(config, settings, owner, fingerprint, build=False):
    """Translate typed data to the shared launcher's literal argv grammar."""
    data, history, ai = resource_names(config)
    arguments = ['bash', str(ROOT / 'run-dashboard.sh'), '--non-interactive']
    for key, value in settings.items():
        if key == 'source-checkout':
            continue
        if key in BOOLEANS:
            if value:
                arguments.append('--' + key)
        elif key == 'env-file':
            for item in value:
                arguments.extend(['--env-file', item])
        else:
            arguments.extend(['--' + key, str(value)])
    if build:
        checkout = settings.get('source-checkout')
        if not checkout or not (Path(checkout) / 'Dockerfile').is_file():
            raise CliError('Build mode requires --source-checkout with a Dockerfile')
        arguments[1] = str(Path(checkout) / 'scripts/run-dashboard.sh')
        arguments.append('--build')
    else:
        arguments.extend(['--managed-name', config['instanceName'], '--managed-owner', owner,
                          '--managed-fingerprint', fingerprint, '--managed-data-volume', data,
                          '--managed-history-volume', history, '--restart-policy', config['restartPolicy']])
        if 'ai-state-volume' not in settings:
            arguments.extend(['--ai-state-volume', ai])
    return arguments


def inspect(name):
    """Distinguish an absent container from unavailable/refused Docker access."""
    result = run(['docker', 'container', 'inspect', name], capture=True, check=False)
    if result.returncode:
        run(['docker', 'info'], capture=True)
        if 'no such' in result.stderr.lower():
            return None
        raise CliError('Cannot inspect configured container; check Docker permissions and name')
    try:
        return json.loads(result.stdout)[0]
    except (ValueError, IndexError, TypeError):
        raise CliError('Docker returned invalid container inspection') from None


def file_digest(path):
    """Hash sensitive inputs without storing their contents."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def desired_fingerprint(config, settings):
    """Track deployment settings and local secret/env changes, not runtime state."""
    value = {'config': config, 'resolved': settings, 'files': {}}
    for path in [settings.get('password-file'), *settings.get('env-file', [])]:
        if path:
            value['files'][path] = file_digest(path)
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def wait_ready(name, timeout, settings):
    """Check the production listener and Docker socket separately inside the image."""
    probe = r"""
const http = require('node:http');
const request = (options, expected, body) => new Promise((resolve, reject) => {
 const r = http.get(options, s => { let text=''; s.on('data', b => text += b); s.on('end', () => s.statusCode === expected && (!body || text === body) ? resolve() : reject(new Error('Readiness check failed'))); });
 r.setTimeout(3000, () => r.destroy(new Error('Readiness timeout'))); r.on('error', reject);
});
Promise.all([
 request({host:'127.0.0.1',port:Number(process.env.PORT||3000),path:'/healthz'},200),
 request({host:'127.0.0.1',port:Number(process.env.PORT||3000),path:'/api/containers'},401),
 request({socketPath:'/var/run/docker.sock',path:'/_ping'},200,'OK')
]).catch(() => process.exitCode=1);
"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        container = inspect(name)
        if not container or container.get('State', {}).get('Status') not in {'running', 'restarting', 'created'}:
            raise CliError('Instance exited before readiness; use devharbour logs')
        if container['State']['Status'] == 'running' and run(['docker', 'exec', name, 'runuser', '-u', settings['host-user'], '--', 'node', '-e', probe], capture=True, check=False).returncode == 0:
            agent = run(['docker', 'exec', '--env', 'SSH_AUTH_SOCK=' + settings['ssh-agent-socket'], name, 'runuser', '-u', settings['host-user'], '--', 'ssh-add', '-l'], capture=True, check=False)
            if agent.returncode not in {0, 1}:
                raise CliError('Saved SSH agent is stale or inaccessible to the operator; update --ssh-agent-socket and explicitly recreate the instance')
            if agent.returncode == 1:
                print('SSH agent is reachable but has no loaded identities.')
            return
        time.sleep(min(2, max(0, deadline - time.monotonic())))
    raise CliError('Readiness timed out (application and Docker checks); use devharbour logs')


def print_summary(config, settings, path):
    """Print non-secret choices, never env contents or credential values."""
    print('Config:', path)
    print('Instance:', config['instanceName'], '| restart policy:', config['restartPolicy'])
    for key in ['workspace', 'host-user', 'host-uid', 'host-gid', 'host-home', 'ssh-agent-socket', 'image', 'bind-address', 'port', 'origin']:
        if key in settings:
            print(key + ':', settings[key])
    print('Volumes:', ', '.join(resource_names(config)[:2] + (settings.get('ai-state-volume', resource_names(config)[2]),)))
    print('Enabled:', ', '.join(sorted(key for key in BOOLEANS if settings.get(key))) or 'none')
    if settings.get('tailscale-socket'):
        print('Tailscale: broad host tailscaled control is enabled')
    if settings.get('brain-funnel'):
        print('WARNING: Brain MCP will be public through Tailscale Funnel')


def exposed(settings):
    """Identify settings widening access or granting host-network authority."""
    return {key: settings.get(key) for key in ['bind-address', 'origin', 'tailscale-socket', 'brain-funnel', 'tailscale-allow-wildcard-bindings'] if settings.get(key) and not (key == 'bind-address' and settings[key] in {'127.0.0.1', '::1', 'localhost'})}


def manage(args, config, owner):
    """Read/control only the container carrying this configuration's ownership label."""
    container = inspect(config['instanceName'])
    if not container:
        print('Instance not created')
        return
    if (container.get('Config', {}).get('Labels') or {}).get(LABEL_OWNER) != owner:
        raise CliError('Container is not owned by this config; no action taken')
    name = config['instanceName']
    if args.command == 'status':
        print(name + ': ' + container['State']['Status'])
    elif args.command == 'logs':
        run(['docker', 'logs', '--tail', '200', name])
    else:
        run(['docker', 'stop', container['Id']])
        print('Stopped. Retained volumes and config unchanged. Restart policy:', config['restartPolicy'])
        if config['restartPolicy'] == 'always':
            print('With always, Docker starts this instance again after a daemon/host restart.')


def validate_volume_use(config, settings, args, container):
    """Refuse other containers' volumes and require explicit retained-data adoption."""
    volumes = resource_names(config)[:2] + (settings.get('ai-state-volume', resource_names(config)[2]),)
    current_id = container['Id'] if container else None
    attached = {mount.get('Name') for mount in container.get('Mounts', []) if mount.get('Type') == 'volume'} if container else set()
    for volume in volumes:
        users = run(['docker', 'ps', '--all', '--filter', 'volume=' + volume, '--format', '{{.ID}}'], capture=True).stdout.splitlines()
        if any(not current_id or not current_id.startswith(identifier) for identifier in users if identifier):
            raise CliError('Volume is attached to another container: ' + volume + '; stop and review that installation separately')
        found = run(['docker', 'volume', 'inspect', volume], capture=True, check=False)
        if found.returncode == 0 and volume not in attached and not args.adopt:
            raise CliError('Retained volume already exists: ' + volume + '; review --adopt to reuse it explicitly')


def ensure_instance(config, settings, args, owner, fingerprint, applied):
    """Reuse owned instances and require reviewed replacement/adoption; keep volumes."""
    name = config['instanceName']
    container = inspect(name)
    if container:
        labels = container.get('Config', {}).get('Labels') or {}
        owned = labels.get(LABEL_OWNER) == owner
        if not owned and not (args.adopt and args.replace):
            raise CliError('Existing container is not owned by this config. Use a new instance name, or review --adopt --replace')
        if owned and labels.get(LABEL_FINGERPRINT) == fingerprint:
            if container['State']['Status'] not in {'running', 'restarting'}:
                run(['docker', 'start', name])
            return
        print('Container configuration requires replacement:', name)
        print('Current image:', container['Config'].get('Image'), '| requested:', settings['image'])
        print('Old fingerprint:', labels.get(LABEL_FINGERPRINT, 'unmanaged'), '| new:', fingerprint)
        previous = applied.get('deployment', {}) if applied else {}
        requested = {'instanceName': config['instanceName'], 'restartPolicy': config['restartPolicy'], **settings}
        print('Setting changes (previous -> requested):')
        for key in sorted(previous.keys() | requested.keys()):
            if previous.get(key) != requested.get(key):
                print(' ', key + ':', json.dumps(previous.get(key)), '->', json.dumps(requested.get(key)))
        previous_files = applied.get('inputDigests', {}) if applied else {}
        for source in [settings['password-file'], *settings.get('env-file', [])]:
            if previous_files.get(source) != file_digest(source):
                print(' Input file content changed:', source, '(values hidden)')
        print('Current mounts:', json.dumps([{k: m.get(k) for k in ['Type', 'Name', 'Source', 'Destination']} for m in container.get('Mounts', [])]))
        if not owned:
            expected = dict(zip(['/data', '/dashboard-history', '/dashboard-ai'], resource_names(config)[:2] + (settings.get('ai-state-volume', resource_names(config)[2]),)))
            actual = {m['Destination']: m.get('Name') for m in container.get('Mounts', []) if m.get('Type') == 'volume'}
            if any(actual.get(target) != volume for target, volume in expected.items()):
                raise CliError('Legacy volume mapping does not match desired volumes; adoption refused')
        validate_volume_use(config, settings, args, container)
        if not args.replace:
            confirm('Replace this exact container? Volumes stay; writable-layer data is lost', args)
        current = inspect(name)
        if not current or current['Id'] != container['Id']:
            raise CliError('Container changed during review; retry')
        run(['docker', 'stop', container['Id']])
        run(['docker', 'rm', container['Id']])
    else:
        validate_volume_use(config, settings, args, None)
        if args.adopt and not args.replace:
            confirm('Reuse these retained volumes for this config?', args)
    run(launch_argv(config, settings, owner, fingerprint))


def main():
    """Validate and save desired settings; record successful application separately."""
    args = parser().parse_args()
    if args.build_mode:
        args.command = 'build'
    if sys.platform != 'linux' or sys.version_info < (3, 9):
        raise CliError('DevHarbour CLI requires Linux and Python 3.9+')
    path = Path(os.path.abspath(args.config))
    owner = hashlib.sha256(str(path).encode()).hexdigest()
    with config_lock(path):
        old, config = merge_config(path, args)
        if args.command in {'status', 'logs', 'stop'}:
            if old is None:
                raise CliError('No saved config; run devharbour first')
            if config != old or args.replace or args.adopt or args.clear:
                raise CliError('Management commands do not update settings; use run or configure')
            resource_names(config)
            manage(args, config, owner)
            return
        if args.command != 'configure':
            run(['docker', 'info'], capture=True)
        pending = wizard(config, args)
        if pending is not None:
            config['settings']['password-file'] = str(path.parent / ('password-' + secrets.token_hex(8)))
        validate_types(config['settings'])
        settings = normalized(config, path.parent, args.command == 'build')
        validate_types(settings)
        if 'health-timeout' in settings and not 1 <= settings['health-timeout'] <= 86400:
            raise CliError('health-timeout must be between 1 and 86400 seconds')
        validation = dict(settings)
        if args.command != 'build':
            validation.pop('health-timeout', None)
        run(launch_argv(config, validation, owner, '0' * 64, args.command == 'build') + ['--validate-only'])
        for key in ['host-uid', 'host-gid']:
            if not 1 <= settings[key] <= 2147483647:
                raise CliError(key + ' must be a positive non-root ID')
        if pending is None:
            check_private(Path(settings['password-file']))
            if not Path(settings['password-file']).read_bytes().rstrip(b'\n'):
                raise CliError('Password file is empty')
        print_summary(config, settings, path)
        old_exposure = exposed(normalized(old, path.parent)) if old else {}
        if any(old_exposure.get(key) != value for key, value in exposed(settings).items()) and not args.allow_exposure:
            confirm('Approve the displayed remote-access/host-network settings?', args)
        if not args.non_interactive and (old is None or args.command == 'configure' or pending is not None):
            confirm('Save these settings' + (' and start DevHarbour?' if args.command != 'configure' else '?'), args)
        if pending is not None:
            fd = os.open(settings['password-file'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(pending + '\n')
        atomic_json(path, config)
        print('Configuration saved.')
        if args.command == 'configure':
            return
        if args.command == 'build':
            run(launch_argv(config, settings, owner, '0' * 64, True))
            return
        fingerprint = desired_fingerprint(config, settings)
        state_path = path.with_name(path.name + '.state.json')
        applied = read_json(state_path) if state_path.exists() or state_path.is_symlink() else None
        if applied is not None and (not isinstance(applied, dict) or applied.get('schemaVersion') != 1 or not isinstance(applied.get('deployment', {}), dict) or not isinstance(applied.get('inputDigests', {}), dict)):
            raise CliError('Invalid last-applied state; inspect the private state file before retrying')
        try:
            execution = dict(settings)
            execution.pop('health-timeout', None)
            ensure_instance(config, execution, args, owner, fingerprint, applied)
            wait_ready(config['instanceName'], settings.get('health-timeout', 180), settings)
        except CliError:
            print('Configuration is saved, but the instance is not confirmed ready. Last-applied state is unchanged.', file=sys.stderr)
            raise
        atomic_json(state_path, {'schemaVersion': 1, 'fingerprint': fingerprint, 'containerId': inspect(config['instanceName'])['Id'], 'appliedAt': int(time.time()), 'deployment': {'instanceName': config['instanceName'], 'restartPolicy': config['restartPolicy'], **execution}, 'inputDigests': {source: file_digest(source) for source in [settings['password-file'], *settings.get('env-file', [])]}})
        address = settings.get('origin') or 'http://' + ('[::1]' if settings['bind-address'] == '::1' else '127.0.0.1' if settings['bind-address'] in {'0.0.0.0', '::'} else settings['bind-address']) + ':' + str(settings['port'])
        print('Ready:', address)
        print('Use devharbour --config', str(path), 'status | logs | stop')


if __name__ == '__main__':
    try:
        main()
    except (CliError, OSError, ValueError, KeyboardInterrupt) as error:
        # Only intentional public diagnostics are safe to print verbatim.
        print('ERROR:', str(error) if isinstance(error, CliError) else 'Operation failed or cancelled; check paths, permissions and prerequisites', file=sys.stderr)
        sys.exit(1)

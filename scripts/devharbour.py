#!/usr/bin/env python3
"""DevHarbour operator CLI: Python 3.9+, Linux; menu dependencies use a private venv.

Bash remains authoritative for launch validation and Docker launch arguments.
Configuration is data, never executable input.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import socket
import struct
import stat
import subprocess
import sys
import tempfile
import time

VERSION = '0.1.0'
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from devharbour_schema import PROPERTIES, validate as validate_schema
STRINGS = {k for k, v in PROPERTIES.items() if v['type'] == 'string'}
NUMBERS = {k for k, v in PROPERTIES.items() if v['type'] == 'integer'}
BOOLEANS = {k for k, v in PROPERTIES.items() if v['type'] == 'boolean'}
LOCAL_PATHS = {'password-file', 'source-checkout'}
HOST_PATHS = {'workspace', 'socket', 'host-home', 'ssh-agent-socket', 'ssh-known-hosts', 'tailscale-socket', 'brain-token-file'}
REQUIRED = {'host-user', 'host-uid', 'host-gid', 'host-home', 'ssh-agent-socket', 'password-file'}
DEFAULTS = {'socket': '/var/run/docker.sock', 'port': 3000, 'ai-port': 3002,
            'bind-address': '127.0.0.1', 'image': 'ghcr.io/axelthas/devcontainer-dashboard:latest'}
DEFAULT_WORKSPACE_NAME = 'devharbour-workspaces'
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
    result.add_argument('command', nargs='?', default='run', choices=['run', 'start', 'configure', 'setup', 'apply', 'restart', 'open', 'status', 'logs', 'stop', 'build'])
    installed = (ROOT / 'VERSION').read_text().strip() if (ROOT / 'VERSION').is_file() else 'checkout'
    result.add_argument('--version', action='version', version='DevHarbour ' + VERSION + ' (' + installed + ')')
    result.add_argument('--config', default=str(Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'devharbour/config.json'))
    result.add_argument('--non-interactive', action='store_true')
    result.add_argument('--replace', action='store_true', help='Authorize replacement of this config\'s container; retain volumes')
    result.add_argument('--adopt', action='store_true', help='Explicitly adopt reviewed legacy resources; container adoption also requires --replace')
    result.add_argument('--allow-exposure', action='store_true', help='Authorize newly enabled remote access, Tailscale or Brain Funnel')
    result.add_argument('--image-source', choices=['published', 'build'], default=argparse.SUPPRESS, help='Managed instance image source')
    result.add_argument('--source-ref', default=argparse.SUPPRESS, help='Branch/tag/commit for a managed local build')
    result.add_argument('--rebuild', action='store_true', help='Rebuild a selected local source image after review')
    result.add_argument('--build', action='store_true', dest='build_mode', help='Run an isolated checkout build')
    result.add_argument('--instance-name', default=argparse.SUPPRESS, help='New instance name; configure may explicitly migrate devcontainer-dashboard to devharbour')
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
def config_lock(path, *, shared=False, timeout=0):
    """Serialize this config's read/modify/write and lifecycle operations."""
    private_directory(path.parent)
    lock = path.with_name(path.name + '.lock')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        check_private(lock)
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise CliError('Another devharbour command is using this config') from None
                time.sleep(min(0.025, max(0, deadline - time.monotonic())))
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


def confirm(message, args):
    """Require an explicit affirmative answer, never a default yes."""
    if args.non_interactive:
        raise CliError('Not approved; no deployment changes made')
    from devharbour_ui import approve
    if not approve(message):
        raise CliError('Not approved; no deployment changes made')


def validate_types(settings):
    """Reject unknown keys, wrong JSON types and control characters before argv construction."""
    for key, value in settings.items():
        valid = (key in STRINGS and isinstance(value, str) and bool(value)) or (key in NUMBERS and type(value) is int) or (key in BOOLEANS and type(value) is bool) or (key == 'env-file' and isinstance(value, list) and all(isinstance(v, str) and v for v in value))
        if not valid:
            raise CliError('Unknown setting or invalid type: ' + str(key))
        try:
            validate_schema(value, PROPERTIES[key], key)
        except ValueError:
            raise CliError('Invalid setting: ' + key) from None
        strings = value if isinstance(value, list) else [value] if isinstance(value, str) else []
        if any(any(ord(char) < 32 for char in item) for item in strings):
            raise CliError('Control characters are not allowed in ' + key)


def merge_config(path, args):
    """Validate persisted shape, then merge only explicit CLI settings."""
    old = read_json(path) if path.exists() or path.is_symlink() else None
    if old is None and (path.exists() or path.is_symlink()):
        raise CliError('Unsupported config schema: null is not a configuration')
    config = json.loads(json.dumps(old)) if old is not None else {'schemaVersion': 1, 'instanceName': 'devharbour', 'restartPolicy': 'always', 'settings': {}}
    if not isinstance(config, dict) or not {'schemaVersion', 'instanceName', 'restartPolicy', 'settings'} <= set(config) or set(config) - {'schemaVersion', 'instanceName', 'restartPolicy', 'settings', 'source'} or type(config.get('schemaVersion')) is not int or config['schemaVersion'] != 1 or not isinstance(config['settings'], dict):
        raise CliError('Unsupported config schema; expected schemaVersion 1 with instanceName, restartPolicy and settings')
    from devharbour_source import validate_source, SourceError
    if 'source' in config:
        validate_source(config['source'])
    if hasattr(args, 'image_source'):
        if args.image_source == 'published' and config.get('source', {}).get('mode') == 'build' and not hasattr(args, 'image'):
            config['settings']['image'] = DEFAULTS['image']
        config.setdefault('source', {})['mode'] = args.image_source
        if args.image_source == 'build':
            from devharbour_source import installed_source
            config['source'].setdefault('ref', installed_source(ROOT).get('revision', 'main'))
    if hasattr(args, 'source_ref'):
        if getattr(args, 'image_source', None) == 'published':
            raise CliError('--source-ref requires local build mode, not --image-source published')
        config.setdefault('source', {})['mode'] = 'build'
        config['source']['ref'] = args.source_ref
        for key in ('checkout', 'revision'):
            config['source'].pop(key, None)
    if 'source' in config:
        validate_source(config['source'])
        if config['source']['mode'] == 'build' and hasattr(args, 'image'):
            raise CliError('--image cannot be combined with managed local builds; select --image-source published')
        if config['source']['mode'] == 'build' and hasattr(args, 'source_checkout'):
            checkout = Path(args.source_checkout)
            config['source']['checkout'] = str(checkout if checkout.is_absolute() else path.parent / checkout)
    if args.rebuild and config.get('source', {}).get('mode') != 'build':
        raise CliError('--rebuild requires managed local build mode')
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
        # Only the legacy default can migrate, and only in an explicit save-only
        # command. No container is renamed, removed, adopted or started here.
        migration = (args.command == 'configure' and old['instanceName'] == 'devcontainer-dashboard'
                     and getattr(args, 'instance_name', None) == 'devharbour')
        if not migration:
            raise CliError('instanceName is immutable; only configure --instance-name devharbour can migrate the legacy default')
    validate_types(config['settings'])
    return old, config


def agent_candidates(uid, home, runtime_roots=None):
    """Enumerate stable provider paths, never session environment or /tmp/ssh-* sockets."""
    roots = runtime_roots if runtime_roots is not None else [Path('/run/user') / str(uid), Path('/var/run/user') / str(uid)]
    suffixes = ['gcr/ssh', 'openssh_agent', 'ssh-agent.socket', 'ssh-agent', 'keyring/ssh', 'gnupg/S.gpg-agent.ssh']
    paths = [Path(root) / suffix for root in roots for suffix in suffixes]
    paths.extend([Path(home) / '.ssh/agent.sock', Path(home) / '.gnupg/S.gpg-agent.ssh'])
    return paths, [Path(root).resolve() for root in roots] + [Path(home).resolve()]


def agent_process(pid):
    """Identify the kernel peer, not inherited environment values or command arguments.

    OpenSSH agents are deliberately non-dumpable on Linux, which can deny even
    their owner access to /proc/PID/exe. The kernel comm name remains readable.
    Socket ownership, peer UID and the SSH identities protocol are checked too.
    This identifies a provider, not an attestation against malicious same-UID code.
    """
    try:
        return Path(os.readlink('/proc/' + str(pid) + '/exe')).name
    except OSError:
        try:
            name = Path('/proc/' + str(pid) + '/comm').read_text().strip()
            return 'gnome-keyring-daemon' if name == 'gnome-keyring-d' else name
        except OSError:
            return None


def receive_exact(connection, size):
    """Read a bounded agent frame, rejecting disconnects and stalled peers."""
    result = bytearray()
    while len(result) < size:
        block = connection.recv(size - len(result))
        if not block:
            raise ValueError('Agent disconnected')
        result.extend(block)
    return bytes(result)


def probe_host_agent(path, uid, trusted_roots):
    """Check path/peer ownership, provider identity and read-only SSH identities protocol.

    This never requests a signature, loads keys, chmods a socket or starts a new
    agent process. Connecting an existing systemd socket may activate its existing
    configured host-agent service. That is not creation of a replacement agent.
    """
    try:
        canonical = Path(path).resolve(strict=True)
        if not any(canonical.is_relative_to(root) for root in trusted_roots):
            return None, 'outside the selected host user paths'
        info = canonical.stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != uid:
            return None, 'not a socket owned by the selected host user'
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.5)
            connection.connect(str(canonical))
            pid, peer_uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            if peer_uid != uid:
                return None, 'peer belongs to another user'
            provider = agent_process(pid)
            allowed = {'ssh-agent', 'gcr-ssh-agent', 'gpg-agent', 'gnome-keyring-daemon'}
            # A systemd-owned listening socket can be inherited by its agent.
            systemd_path = any(canonical == (root / suffix).resolve() for root in trusted_roots[:2] for suffix in ['gcr/ssh', 'openssh_agent', 'ssh-agent.socket', 'gnupg/S.gpg-agent.ssh'])
            if provider not in allowed and not (provider == 'systemd' and systemd_path):
                return None, 'peer is not an identified host agent (SSH forwarding is not selected)'
            connection.sendall(struct.pack('>I', 1) + bytes([11]))
            length = struct.unpack('>I', receive_exact(connection, 4))[0]
            if not 5 <= length <= 262144:
                return None, 'invalid agent response length'
            reply = receive_exact(connection, length)
            if reply[0] != 12:
                return None, 'peer did not return SSH agent identities'
            count = struct.unpack('>I', reply[1:5])[0]
            offset = 5
            for _ in range(count):
                for _ in range(2):
                    if offset + 4 > length:
                        return None, 'incomplete identity response'
                    size = struct.unpack('>I', reply[offset:offset + 4])[0]
                    offset += 4 + size
                    if offset > length:
                        return None, 'incomplete identity response'
            if offset != length:
                return None, 'unexpected identity response data'
            return {'path': str(canonical), 'provider': provider, 'identities': count}, None
    except (OSError, ValueError, RuntimeError, struct.error):
        return None, 'socket missing, stale, inaccessible or not responding'


def discover_host_agents(uid, home, runtime_roots=None):
    """Return verified, canonical, deduplicated candidates for this host's operator."""
    paths, roots = agent_candidates(uid, home, runtime_roots)
    found, checked, rejected = [], set(), []
    if uid != os.getuid():
        return [], 'Cannot inspect another host user safely; enter its host socket explicitly.'
    for path in paths:
        try:
            canonical = str(path.resolve())
        except (OSError, RuntimeError):
            continue
        if canonical in checked:
            continue
        checked.add(canonical)
        candidate, reason = probe_host_agent(path, uid, roots)
        if candidate:
            found.append(candidate)
        elif path.exists() or path.is_symlink():
            rejected.append(str(path) + ': ' + reason)
    return found, '; '.join(rejected) if rejected and not found else None


DEPENDENT_SETTINGS = {
    'brain': ['brain-port', 'brain-token-file', 'brain-funnel', 'brain-funnel-port'],
    'brain-funnel': ['brain-funnel-port'],
    'tailscale-socket': ['tailscale-ports', 'tailscale-gateway-port', 'tailscale-allow-wildcard-bindings', 'brain-funnel', 'brain-funnel-port'],
    'gateway': ['gateway-host'],
}


def disable_dependents(settings, args, key):
    """Remove inactive saved controls without silently overriding explicit CLI inputs."""
    for dependent in DEPENDENT_SETTINGS.get(key, []):
        if dependent.replace('-', '_') in vars(args):
            raise CliError('Cannot disable ' + key + ' while --' + dependent + ' is explicitly supplied')
        settings.pop(dependent, None)


def wizard(config, args):
    """Use the menu wizard interactively and typed required inputs unattended."""
    if args.non_interactive or args.command == 'build':
        missing = REQUIRED - config['settings'].keys()
        if missing:
            raise CliError('Missing required settings: ' + ', '.join(sorted(missing)))
        if args.command != 'build':
            config['settings'].setdefault('ai-state-volume', resource_names(config)[2])
        return None
    from devharbour_ui import wizard as menu_wizard
    updated, pending = menu_wizard(sys.modules[__name__], config, args)
    config.clear()
    config.update(updated)
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
    workspace_name = 'ddash-production-workspace' if build else DEFAULT_WORKSPACE_NAME
    settings.setdefault('workspace', settings.get('host-home', '') + '/' + workspace_name)
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
    return ('dashboard_data', 'ddash_zsh_data', 'dashboard_ai') if name in {'devharbour', 'devcontainer-dashboard'} else (name + '-data', name + '-history', name + '-ai')


def launch_argv(config, settings, owner, fingerprint, build=False, config_path=None):
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
        if config_path is not None:
            path = Path(config_path).absolute()
            if path.parent.resolve() != path.parent or any(c in str(path) for c in ',\n\r'):
                raise CliError('Managed config path must be canonical and contain no commas or line breaks')
            arguments.extend(['--managed-config', str(path)])
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
    value = {'config': config, 'resolved': settings, 'files': {}, 'settingsMountVersion': 1}
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
        try:
            settings = normalized(config, Path(args.config).absolute().parent)
            pending = (container.get('Config', {}).get('Labels') or {}).get(LABEL_FINGERPRINT) != desired_fingerprint(config, settings)
            print('Saved settings:', 'pending apply' if pending else 'match this deployment')
        except OSError:
            print('Saved settings: cannot compare input files; inspect them on the host')
    elif args.command == 'open':
        from devharbour_quickstart import open_browser
        state_path = Path(args.config).absolute().with_name(Path(args.config).name + '.state.json')
        state = read_json(state_path) if state_path.exists() else {}
        if not isinstance(state, dict) or not isinstance(state.get('deployment'), dict):
            raise CliError('No successfully applied URL is recorded. Use devharbour status and inspect the deployment.')
        open_browser(state['deployment'])
    elif args.command == 'restart':
        confirm('Restart this exact instance? Its login sessions and DevHarbour-owned processes end.', args)
        current = inspect(name)
        if not current or current['Id'] != container['Id']:
            raise CliError('Container changed during review; retry')
        run(['docker', 'restart', container['Id']])
        print('Restarted the existing container. Saved deployment changes were not applied.')
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
    expected = getattr(args, 'expected_container', None)
    if expected is not None and (not container or container['Id'] != expected):
        raise CliError('Reviewed container changed before replacement; no action taken')
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
    run(launch_argv(config, settings, owner, fingerprint, config_path=args.config))


def main(*, apply_guard=None, progress=None, source_cache=None):
    """Apply desired state; optional worker guard runs inside the shared CLI lock."""
    args = parser().parse_args()
    setup = args.command == 'setup'
    if setup:
        args.command = 'configure'
    elif args.command == 'start':
        args.command = 'run'
    if args.build_mode:
        args.command = 'build'
    if sys.platform != 'linux' or sys.version_info < (3, 9):
        raise CliError('DevHarbour CLI requires Linux and Python 3.9+')
    path = Path(os.path.abspath(args.config))
    owner = hashlib.sha256(str(path).encode()).hexdigest()
    with config_lock(path):
        old, config = merge_config(path, args)
        if apply_guard is not None:
            args.expected_container = apply_guard(config)
        if args.command in {'status', 'logs', 'stop', 'restart', 'open'}:
            if old is None:
                raise CliError('No saved config; run devharbour first')
            if config != old or args.replace or args.adopt or args.clear or args.rebuild:
                raise CliError('Management commands do not update settings; use run or configure')
            resource_names(config)
            manage(args, config, owner)
            return
        import devharbour_env
        env_default = devharbour_env.default_path(path)
        if old is None and 'env-file' not in config['settings'] and args.command != 'build' and env_default.is_file():
            # New setups pass the installer-created devcontainer environment by default.
            config['settings']['env-file'] = [str(env_default)]
        if args.command != 'configure':
            run(['docker', 'info'], capture=True)
        if args.command in {'run', 'apply'} and not setup:
            from devharbour_banner import show
            show(sys.stdout, VERSION)
            if old is None and not REQUIRED <= config['settings'].keys():
                from devharbour_quickstart import quickstart
                pending = quickstart(sys.modules[__name__], config, args)
            else:
                if not REQUIRED <= config['settings'].keys():
                    raise CliError('Saved config is incomplete. Use devharbour setup.')
                pending = None
        else:
            pending = wizard(config, args)
        plan = getattr(args, 'env_plan', None)
        if plan:
            plan_path = Path(plan['path'])
            if plan['updates'] or not plan_path.exists():
                devharbour_env.write(plan_path, plan['updates'], plan['lines'])
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
        run(launch_argv(config, validation, owner, '0' * 64, args.command == 'build', None if args.command == 'build' else path) + ['--validate-only'])
        for key in ['host-uid', 'host-gid']:
            if not 1 <= settings[key] <= 2147483647:
                raise CliError(key + ' must be a positive non-root ID')
        if pending is None:
            check_private(Path(settings['password-file']))
            if not Path(settings['password-file']).read_bytes().rstrip(b'\n'):
                raise CliError('Password file is empty')
        print_summary(config, settings, path)
        approval_state_path = path.with_name(path.name + '.state.json')
        approval_state = read_json(approval_state_path) if approval_state_path.exists() else {}
        if not isinstance(approval_state, dict) or not isinstance(approval_state.get('deployment', {}), dict):
            raise CliError('Invalid last-applied state; review it on the host')
        old_exposure = exposed(approval_state.get('deployment', {})) if args.command in {'run', 'apply'} else exposed(normalized(old, path.parent)) if old else {}
        if any(old_exposure.get(key) != value for key, value in exposed(settings).items()) and not args.allow_exposure:
            confirm('Approve the displayed remote-access/host-network settings?', args)
        if not args.non_interactive and not getattr(args, 'plan_approved', False) and (old is None or args.command == 'configure' or pending is not None):
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
        if progress is not None:
            progress('image')
        if config.get('source', {}).get('mode') == 'build':
            from devharbour_source import prepare_image
            print('\nStep 7 of 7: building the DevHarbour image. Your current DevHarbour keeps running during the build.')
            cache = source_cache or Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'devharbour/source'
            image, checkout, revision = prepare_image(config['source'], cache, settings.get('platform'), args.rebuild)
            settings['image'] = image
            config['source'].update({'checkout': str(checkout), 'revision': revision})
            config['settings']['image'] = image
            atomic_json(path, config)
        elif getattr(args, 'plan_approved', False):
            print('\nStep 7 of 7: starting DevHarbour and checking that it is ready.')
        if config.get('source', {}).get('mode') != 'build':
            if run(['docker', 'image', 'inspect', settings['image']], capture=True, check=False).returncode:
                run(['docker', 'pull', settings['image']])
        fingerprint = desired_fingerprint(config, settings)
        state_path = path.with_name(path.name + '.state.json')
        applied = read_json(state_path) if state_path.exists() or state_path.is_symlink() else None
        if applied is not None and (not isinstance(applied, dict) or applied.get('schemaVersion') != 1 or not isinstance(applied.get('deployment', {}), dict) or not isinstance(applied.get('inputDigests', {}), dict)):
            raise CliError('Invalid last-applied state; inspect the private state file before retrying')
        try:
            execution = dict(settings)
            execution.pop('health-timeout', None)
            if progress is not None:
                progress('recreate')
            ensure_instance(config, execution, args, owner, fingerprint, applied)
            if progress is not None:
                progress('health')
            wait_ready(config['instanceName'], settings.get('health-timeout', 180), settings)
        except CliError:
            print('Configuration is saved, but the instance is not confirmed ready. Last-applied state is unchanged.', file=sys.stderr)
            raise
        atomic_json(state_path, {'schemaVersion': 1, 'fingerprint': fingerprint, 'containerId': inspect(config['instanceName'])['Id'], 'appliedAt': int(time.time()), 'deployment': {'instanceName': config['instanceName'], 'restartPolicy': config['restartPolicy'], **execution}, 'inputDigests': {source: file_digest(source) for source in [settings['password-file'], *settings.get('env-file', [])]}})
        address = settings.get('origin') or 'http://' + ('[::1]' if settings['bind-address'] == '::1' else '127.0.0.1' if settings['bind-address'] in {'0.0.0.0', '::'} else settings['bind-address']) + ':' + str(settings['port'])
        print('Ready:', address)
        print('Use devharbour --config', str(path), 'start | stop | restart | status | logs | open | apply')


if __name__ == '__main__':
    try:
        main()
    except (CliError, OSError, ValueError, RuntimeError, KeyboardInterrupt, __import__('devharbour_source').SourceError, __import__('devharbour_env').EnvError) as error:
        # DevHarbour's own errors carry operator guidance without credentials.
        # Other errors may quote system details, so print a generic line.
        if isinstance(error, KeyboardInterrupt):
            print('\nSetup cancelled. Nothing was saved.', file=sys.stderr)
            sys.exit(130)
        own = (CliError, RuntimeError, __import__('devharbour_env').EnvError)
        print('ERROR:', str(error) if isinstance(error, own) and str(error) else 'Operation failed; check paths, permissions and prerequisites', file=sys.stderr)
        sys.exit(1)

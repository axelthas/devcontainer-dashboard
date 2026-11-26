"""Default environment file that DevHarbour passes to the devcontainers it manages.

DevHarbour loads this Docker env file into its own container. Devcontainer tools
run by DevHarbour inherit it, so devcontainer.json values such as
${localEnv:OPENCODE_PASSWORD} resolve to these values. The file is private
(mode 0600) because OPENCODE_PASSWORD is a credential. Existing files are
never overwritten; edits keep unknown lines and comments.
"""
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile

FILENAME = 'devcontainer.env'
# Variable order, default factory and operator explanation.
VARIABLES = [
    ('TERN_USE_CCACHE', lambda: '1',
     'Tern CMake builds use ccache in devcontainers, for much faster rebuilds. 1 enables, 0 disables.'),
    ('OPENCODE_PASSWORD', lambda: secrets.token_urlsafe(24),
     'Password for OpenCode and OpenChamber in devcontainers. DevHarbour also uses it for its own AI interface login.'),
    ('OPENCODE_SKIP_START', lambda: 'true',
     'true: OpenChamber connects to the running OpenCode service instead of starting a second one.'),
    ('OPENCODE_PORT', lambda: '4096',
     'Port of the OpenCode service that OpenChamber connects to inside a devcontainer.'),
]
SECRETS = {'OPENCODE_PASSWORD'}
HEADER = [
    '# DevHarbour devcontainer environment (Docker env-file syntax: KEY=VALUE, no quotes).',
    '# DevHarbour loads this file; devcontainers read values through ${localEnv:NAME}.',
    '# Keep this file private: it contains OPENCODE_PASSWORD. Add other variables freely.',
]
KEY = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')


class EnvError(Exception):
    """An operator-facing environment file problem without credential values."""


def default_path(config_path):
    """Keep the environment file next to the configuration it belongs to."""
    return Path(config_path).absolute().parent / FILENAME


def read(path):
    """Return (lines, values) for an existing private regular file."""
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise EnvError('Environment file must be your own private regular file (mode 0600): ' + str(path))
    lines = path.read_text().splitlines()
    values = {}
    for line in lines:
        match = KEY.match(line)
        if match:
            values[match[1]] = match[2]
    return lines, values


def validate(name, value):
    """Reject values that Docker env-file syntax cannot represent literally."""
    if not isinstance(value, str) or any(ord(char) < 32 for char in value):
        raise EnvError(name + ' must be one line of text')
    if name == 'TERN_USE_CCACHE' and value not in {'0', '1'}:
        raise EnvError('TERN_USE_CCACHE must be 0 or 1')
    if name == 'OPENCODE_SKIP_START' and value not in {'true', 'false'}:
        raise EnvError('OPENCODE_SKIP_START must be true or false')
    if name == 'OPENCODE_PORT' and (not value.isdigit() or not 1 <= int(value) <= 65535):
        raise EnvError('OPENCODE_PORT must be a port from 1 to 65535')
    if name == 'OPENCODE_PASSWORD' and len(value) < 12:
        raise EnvError('OPENCODE_PASSWORD must have at least 12 characters')


def write(path, updates, lines=None):
    """Atomically update or append keys, preserving every other line."""
    for name, value in updates.items():
        validate(name, value)
    lines = list(lines if lines is not None else HEADER + [''])
    remaining = dict(updates)
    for index, line in enumerate(lines):
        match = KEY.match(line)
        if match and match[1] in remaining:
            lines[index] = match[1] + '=' + remaining.pop(match[1])
    lines += [name + '=' + value for name, value in remaining.items()]
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write('\n'.join(lines) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def ensure(path):
    """Create the file with defaults when absent; return True when it was created."""
    if path.exists() or path.is_symlink():
        read(path)
        return False
    write(path, {name: factory() for name, factory, _ in VARIABLES})
    return True


def missing_defaults(values):
    """Return default values for important variables absent from an existing file."""
    return {name: factory() for name, factory, _ in VARIABLES if name not in values}

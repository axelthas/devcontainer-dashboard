#!/bin/bash
# Install a versioned user-local DevHarbour CLI without a checkout or host Node.
# Python 3.9+ provides JSON, HTTPS downloads and safe archive member reads.
set -euo pipefail
command -v python3 >/dev/null || { echo 'Python 3.9+ is required; install it using your host package manager.' >&2; exit 1; }
python3 - "$@" <<'PY'
"""Install only the CLI and shared launcher; never extract arbitrary archive paths."""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

FILES = ('devharbour.py', 'run-dashboard.sh')
MARKER = '# devharbour-managed-command-v1'


def arguments():
    """Accept a local source or an explicit GitHub ref, plus user-local directories."""
    p = argparse.ArgumentParser(description='Install the DevHarbour command (Python 3.9+, Bash; Linux).')
    p.add_argument('--source', type=Path, help='Install from a local checkout, including intentional uncommitted CLI edits')
    p.add_argument('--ref', default='main', help='GitHub commit/tag/branch; pin a full commit for reproducibility')
    p.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    p.add_argument('--data-dir', type=Path, default=Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'devharbour')
    return p.parse_args()


def payloads(args):
    """Read allowlisted regular files, binding remote files to one immutable commit."""
    if args.source:
        content = {name: (args.source / 'scripts' / name).read_bytes() for name in FILES}
        identity = 'local-' + hashlib.sha256(b''.join(content.values())).hexdigest()[:20]
        return content, identity
    request = urllib.request.Request('https://api.github.com/repos/axelthas/devcontainer-dashboard/commits/' + urllib.parse.quote(args.ref, safe=''), headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'devharbour-installer'})
    with urllib.request.urlopen(request, timeout=30) as response:
        revision = json.load(response)['sha']
    with urllib.request.urlopen('https://codeload.github.com/axelthas/devcontainer-dashboard/tar.gz/' + revision, timeout=60) as response:
        archive = response.read(32 * 1024 * 1024 + 1)
    if len(archive) > 32 * 1024 * 1024:
        raise ValueError('Archive exceeds installer size limit')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        content = {}
        for name in FILES:
            member = bundle.getmember('devcontainer-dashboard-' + revision + '/scripts/' + name)
            if not member.isfile() or member.size > 2 * 1024 * 1024:
                raise ValueError('Invalid runtime archive member')
            content[name] = bundle.extractfile(member).read()
    return content, revision


def install(args):
    """Publish immutable runtime files, then atomically replace only our own wrapper."""
    args.bin_dir = args.bin_dir.absolute()
    args.data_dir = args.data_dir.absolute()
    args.bin_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    args.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = args.data_dir.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('data-dir must be owned by you, not a symlink, and mode 0700')
    destination = args.bin_dir / 'devharbour'
    lockfd = os.open(args.data_dir / 'install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if destination.exists() or destination.is_symlink():
            info = destination.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or MARKER not in destination.read_text().splitlines()[:3]:
                raise ValueError('Refusing to overwrite an unrelated executable or symlink')
        content, identity = payloads(args)
        runtime = args.data_dir / identity
        if runtime.exists():
            if runtime.is_symlink() or any((runtime / name).is_symlink() or (runtime / name).read_bytes() != data for name, data in content.items()):
                raise ValueError('Existing version directory differs; refusing overwrite')
        else:
            staging = Path(tempfile.mkdtemp(prefix='.install-', dir=args.data_dir))
            try:
                for name, data in content.items():
                    (staging / name).write_bytes(data)
                    (staging / name).chmod(0o600)
                (staging / 'VERSION').write_text(identity + '\n')
                staging.rename(runtime)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        fd, temporary = tempfile.mkstemp(prefix='.devharbour-', dir=args.bin_dir)
        try:
            with os.fdopen(fd, 'w') as output:
                output.write('#!/bin/sh\n' + MARKER + '\nexec python3 ' + shlex.quote(str(runtime / 'devharbour.py')) + ' "$@"\n')
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o755)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print('Installed:', destination)
    print('Source:', identity)
    if str(args.bin_dir) not in os.environ.get('PATH', '').split(os.pathsep):
        print('Add this directory to PATH: export PATH=' + shlex.quote(str(args.bin_dir)) + ':"$PATH"')
        print('Or run directly:', destination)
    print('Run devharbour to start guided setup. No config or runtime data was changed.')


def main():
    """Validate the runtime and report installation errors without a traceback."""
    if sys.version_info < (3, 9) or sys.platform != 'linux':
        raise ValueError('Installer requires Linux and Python 3.9+')
    install(arguments())


try:
    main()
except (OSError, ValueError, KeyError, tarfile.TarError):
    print('Installation failed. Check source/ref, directory ownership, connectivity and existing command; no host packages were installed.', file=sys.stderr)
    sys.exit(1)
PY

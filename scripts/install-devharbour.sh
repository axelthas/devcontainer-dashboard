#!/bin/bash
# Install the user-local DevHarbour CLI, private Python environment and pinned source.
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
import subprocess
import venv

FILES = ('devharbour.schema.json', 'devharbour_schema.py', 'devharbour_quickstart.py', 'devharbour_settings.py', 'devharbour.py', 'devharbour_ui.py', 'devharbour_source.py', 'devharbour_env.py', 'devharbour_banner.py', 'requirements-cli.txt', 'run-dashboard.sh')
MARKER = '# devharbour-managed-command-v1'


def arguments():
    """Accept a local source or an explicit GitHub ref, plus user-local directories."""
    p = argparse.ArgumentParser(description='Install the DevHarbour command (Python 3.9+, Bash; Linux).')
    p.add_argument('--source', type=Path, help='Install from a local checkout, including intentional uncommitted CLI edits')
    p.add_argument('--no-env-file', action='store_true', help='Do not create the default devcontainer environment file')
    p.add_argument('--config-dir', type=Path, default=Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'devharbour', help='Directory of the default DevHarbour configuration')
    p.add_argument('--no-checkout', action='store_true', help='Install CLI only; source is cloned later if a local build is selected')
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


def source_checkout(args, identity, runtime):
    """Retain a clean pinned remote checkout, never reset an existing working copy."""
    if args.source:
        result = subprocess.run(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True, capture_output=True)
        return {'repository': 'https://github.com/axelthas/devcontainer-dashboard.git', 'revision': result.stdout.strip() if result.returncode == 0 else 'main', 'ref': args.ref}
    metadata = {'repository': 'https://github.com/axelthas/devcontainer-dashboard.git', 'revision': identity, 'ref': args.ref}
    if not args.no_checkout:
        sys.path.insert(0, str(runtime))
        from devharbour_source import acquire
        checkout, revision = acquire({'mode': 'build', 'ref': identity}, args.data_dir / 'source')
        metadata.update({'checkout': str(checkout), 'revision': revision})
    return metadata


def python_environment(args, runtime):
    """Install pinned terminal libraries in our own versioned virtual environment only."""
    identity = hashlib.sha256((runtime / 'requirements-cli.txt').read_bytes()).hexdigest()[:16] + '-' + sys.implementation.cache_tag
    destination = args.data_dir / ('venv-' + identity)
    if destination.is_symlink():
        raise ValueError('Refusing symlink Python environment')
    python = destination / 'bin/python'
    if not python.exists():
        try:
            venv.EnvBuilder(with_pip=True).create(destination)
            destination.chmod(0o700)
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError('Python venv/pip is required; install your distro python3-venv package and retry.') from error
    check = subprocess.run([str(python), '-c', 'import questionary,prompt_toolkit,wcwidth'], capture_output=True)
    marker = destination / '.devharbour-requirements'
    if check.returncode or not marker.exists() or marker.read_text() != identity:
        print('Installing menu dependencies in a private Python environment...', flush=True)
        subprocess.run([str(python), '-m', 'pip', 'install', '--require-virtualenv', '--disable-pip-version-check', '-r', str(runtime / 'requirements-cli.txt')], check=True)
        marker.write_text(identity)
    return python


def environment_file(args, runtime):
    """Create the default devcontainer environment file once; never overwrite it."""
    if args.no_env_file:
        return None, False
    sys.path.insert(0, str(runtime))
    import devharbour_env
    directory = args.config_dir.absolute()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / devharbour_env.FILENAME
    return path, devharbour_env.ensure(path)


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
        metadata = source_checkout(args, identity, runtime)
        if (runtime / 'SOURCE.json').is_symlink():
            raise ValueError('Refusing source metadata symlink')
        fd_metadata, temp_metadata = tempfile.mkstemp(prefix='.source-', dir=runtime)
        with os.fdopen(fd_metadata, 'w') as output:
            output.write(json.dumps(metadata, indent=2) + '\n')
        os.replace(temp_metadata, runtime / 'SOURCE.json')
        python = python_environment(args, runtime)
        env_path, env_created = environment_file(args, runtime)
        fd, temporary = tempfile.mkstemp(prefix='.devharbour-', dir=args.bin_dir)
        try:
            with os.fdopen(fd, 'w') as output:
                output.write('#!/bin/sh\n' + MARKER + '\nexec ' + shlex.quote(str(python)) + ' ' + shlex.quote(str(runtime / 'devharbour.py')) + ' "$@"\n')
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
    print('Source checkout:', metadata.get('checkout', 'cloned on demand if a local build is selected'))
    if env_path:
        print('Devcontainer environment:', env_path, '(created with defaults and a generated OPENCODE_PASSWORD)' if env_created else '(existing file kept unchanged)')
    print('Run devharbour for localhost startup; use devharbour setup for advanced settings. Existing configuration and containers were not changed.')


def main():
    """Validate the runtime and report installation errors without a traceback."""
    if sys.version_info < (3, 9) or sys.platform != 'linux':
        raise ValueError('Installer requires Linux and Python 3.9+')
    install(arguments())


try:
    main()
except KeyboardInterrupt:
    print('Installation cancelled. The existing command and configuration were not replaced.', file=sys.stderr)
    sys.exit(130)
except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError, RuntimeError):
    print('Installation failed. Check Git, Python venv/pip, source/ref, directory ownership and connectivity; no host packages were installed.', file=sys.stderr)
    sys.exit(1)
PY

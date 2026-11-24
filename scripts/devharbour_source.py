"""Revision-pinned source and local-image preparation for the DevHarbour CLI.

No container replacement occurs here. Existing checkouts are never reset, cleaned
or switched. Git and Docker operations run only after the operator reviews setup.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

REPOSITORY = 'https://github.com/axelthas/devcontainer-dashboard.git'
ALLOWED_REMOTES = {REPOSITORY, REPOSITORY[:-4], 'git@github.com:axelthas/devcontainer-dashboard.git'}


class SourceError(RuntimeError):
    """A safe actionable source/build error."""


def command(argv, capture=True):
    """Run literal arguments and keep failing Git diagnostics out of credential output."""
    try:
        result = subprocess.run(argv, text=True, capture_output=capture, check=False)
    except OSError as error:
        raise SourceError('Cannot run ' + argv[0] + '; install the documented prerequisite.') from error
    if result.returncode:
        raise SourceError(argv[0] + ' failed. Check repository access, the selected ref and the output above; existing source was not reset.')
    return result.stdout.strip() if capture else ''


def installed_source(root):
    """Read non-secret provenance without requiring a checkout for published-image use."""
    metadata = root / 'SOURCE.json'
    if metadata.is_file():
        return json.loads(metadata.read_text())
    revision = command(['git', '-C', str(root), 'rev-parse', 'HEAD']) if (root.parent / '.git').exists() else 'main'
    return {'repository': REPOSITORY, 'revision': revision, 'ref': revision}


def validate_source(source):
    """Reject unsupported source keys, untrusted refs and bad persisted types."""
    if not isinstance(source, dict) or set(source) - {'mode', 'ref', 'checkout', 'revision'} or source.get('mode') not in {'published', 'build'}:
        raise SourceError('source must contain mode published/build and optional ref, checkout, revision.')
    for key in set(source) - {'mode'}:
        if not isinstance(source[key], str) or not source[key] or any(ord(char) < 32 for char in source[key]):
            raise SourceError('Invalid source ' + key)
    if 'ref' in source and (source['ref'].startswith('-') or '..' in source['ref'] or not re.fullmatch(r'[a-zA-Z0-9_./-]+', source['ref'])):
        raise SourceError('Select a branch, tag or full commit SHA, not an option or ref expression.')
    if 'revision' in source and not re.fullmatch(r'[a-f0-9]{40}', source['revision']):
        raise SourceError('source.revision must be a full commit SHA.')


def clean_checkout(path, expected=None):
    """Verify ownership, origin, clean content and optional revision without altering files."""
    if path.is_symlink() or not path.is_dir() or path.stat().st_uid != os.getuid():
        raise SourceError('Source checkout must be an owned real directory: ' + str(path))
    actual = Path(command(['git', '-C', str(path), 'rev-parse', '--show-toplevel'])).resolve()
    if actual != path.resolve() or command(['git', '-C', str(path), 'remote', 'get-url', 'origin']) not in ALLOWED_REMOTES:
        raise SourceError('Source is not the expected DevHarbour repository.')
    if command(['git', '-C', str(path), 'status', '--porcelain', '--untracked-files=normal']):
        raise SourceError('Source checkout has local changes. Commit them or choose a new managed checkout; it will not be reset.')
    revision = command(['git', '-C', str(path), 'rev-parse', 'HEAD'])
    if expected and revision != expected:
        raise SourceError('Existing source revision differs from the selected revision; choose a separate checkout.')
    return revision


def acquire(source, cache):
    """Reuse verified immutable source or clone the requested ref into a new directory."""
    validate_source(source)
    ref = source.get('revision') or source.get('ref', 'main')
    if source.get('checkout'):
        checkout = Path(source['checkout'])
        revision = clean_checkout(checkout, source.get('revision'))
        selected = command(['git', '-C', str(checkout), 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])
        if selected != revision:
            raise SourceError('Selected ref is not checked out; existing checkout was left untouched.')
        return checkout, revision
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    if cache.is_symlink() or cache.stat().st_uid != os.getuid() or cache.stat().st_mode & 0o077:
        raise SourceError('Source cache must be owned, not a symlink, and mode 0700.')
    if re.fullmatch(r'[a-f0-9]{40}', ref) and (cache / ref).exists():
        checkout = cache / ref
        return checkout, clean_checkout(checkout, ref)
    staging = Path(tempfile.mkdtemp(prefix='.clone-', dir=cache))
    try:
        command(['git', 'clone', '--no-checkout', '--filter=blob:none', REPOSITORY, str(staging)], capture=False)
        command(['git', '-C', str(staging), 'fetch', '--depth', '1', 'origin', ref], capture=False)
        revision = command(['git', '-C', str(staging), 'rev-parse', 'FETCH_HEAD'])
        command(['git', '-C', str(staging), 'checkout', '--detach', revision], capture=False)
        clean_checkout(staging, revision)
        destination = cache / revision
        if destination.exists():
            clean_checkout(destination, revision)
        else:
            staging.rename(destination)
        return destination, revision
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def prepare_image(source, cache, platform=None, rebuild=False):
    """Build a pinned image before any container is stopped; reuse an existing image by default."""
    checkout, revision = acquire(source, cache)
    identity = revision[:16] + ('-' + platform.replace('/', '-') if platform else '')
    image = 'devharbour-local:' + identity
    present = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True, check=False).returncode == 0
    if present and not rebuild:
        provenance = command(['docker', 'image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image])
        if provenance != revision:
            raise SourceError('Cached image provenance differs. Use --rebuild explicitly; the running container was not changed.')
    if rebuild or not present:
        arguments = ['docker', 'buildx', 'build', '--load', '--tag', image,
                     '--label', 'org.opencontainers.image.revision=' + revision]
        if platform:
            arguments += ['--platform', platform]
        command(arguments + [str(checkout)], capture=False)
    image_id = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
        raise SourceError('Docker did not return the built image identity; no container will be changed.')
    return image_id, checkout, revision

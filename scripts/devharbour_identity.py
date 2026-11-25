"""Verify container identity through PID and mount namespaces, not hostnames."""
import json
import os
import re
import subprocess


class ApplyIdentityError(RuntimeError):
    """A fixed, credential-free identity diagnostic safe for browser display."""


def process_namespaces():
    """Read this process's Linux PID and mount namespace identities."""
    return {name: os.readlink('/proc/self/ns/' + name) for name in ('pid', 'mnt')}


def verify_self(container_id):
    """Probe the immutable target ID and require the same private execution context.

    Host/network namespaces and hostnames are intentionally not used. Comparing
    mount as well as PID namespaces rejects a different container sharing a PID
    namespace. The probe does not read configuration or credentials.
    """
    if not isinstance(container_id, str) or not re.fullmatch(r'[a-f0-9]{64}', container_id):
        raise ApplyIdentityError('Docker returned an invalid managed-container identity. No replacement was queued.')
    code = "import json,os; print(json.dumps({name:os.readlink('/proc/self/ns/'+name) for name in ('pid','mnt')}))"
    try:
        caller = process_namespaces()
        result = subprocess.run(['docker', 'exec', '--user', str(os.getuid()) + ':' + str(os.getgid()),
                                 container_id, 'python3', '-c', code],
                                capture_output=True, text=True, timeout=5, check=False)
        if result.returncode:
            raise ApplyIdentityError('Cannot verify the managed container through Docker exec. Check that it is running and retry. No replacement was queued.')
        target = json.loads(result.stdout)
    except ApplyIdentityError:
        raise
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ApplyIdentityError('Container identity verification is unavailable or timed out. Check Docker access and retry. No replacement was queued.') from None
    if target != caller:
        raise ApplyIdentityError('This request is not running inside the configured managed DevHarbour container. Open Settings in the CLI-managed DevHarbour, not the development server. No replacement was queued.')

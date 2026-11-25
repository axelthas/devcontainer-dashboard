"""Minimal local setup and lifecycle helpers for the DevHarbour host command.

Only startup configuration is inferred. Ambiguous identity or host-agent state
requires explicit advanced setup; never import a forwarded SSH_AUTH_SOCK.
"""
import getpass
import os
from pathlib import Path
import pwd
import socket
import sys
import webbrowser


def quickstart(cli, config, args):
    """Collect only a password when all local-host prerequisites are unambiguous."""
    settings = config['settings']
    if Path('/.dockerenv').exists() or os.getuid() == 0:
        raise cli.CliError('Minimal setup requires the non-root Docker-host operator. Use devharbour setup or explicit flags on other hosts.')
    user = pwd.getpwuid(os.getuid())
    settings.setdefault('host-user', user.pw_name)
    settings.setdefault('host-uid', user.pw_uid)
    settings.setdefault('host-gid', user.pw_gid)
    settings.setdefault('host-home', str(Path(user.pw_dir).resolve()))
    if (settings['host-user'], settings['host-uid'], settings['host-gid'], settings['host-home']) != (user.pw_name, user.pw_uid, user.pw_gid, str(Path(user.pw_dir).resolve())):
        raise cli.CliError('Host identity differs from this operator. Use devharbour setup for explicit configuration.')
    if 'ssh-agent-socket' not in settings:
        found, _ = cli.discover_host_agents(user.pw_uid, settings['host-home'])
        if len(found) != 1:
            raise cli.CliError('Cannot select one trusted host SSH agent. Use devharbour setup or --ssh-agent-socket with the Docker-host path.')
        settings['ssh-agent-socket'] = found[0]['path']
    known = Path(settings['host-home']) / '.ssh/known_hosts'
    if known.is_file():
        settings.setdefault('ssh-known-hosts', str(known))
    settings.setdefault('port', 3000)
    settings.setdefault('bind-address', '127.0.0.1')
    settings.setdefault('host-name', socket.gethostname())
    settings.setdefault('ai-state-volume', cli.resource_names(config)[2])
    args.plan_approved = True
    if 'password-file' in settings:
        return None
    if args.non_interactive or not sys.stdin.isatty():
        raise cli.CliError('First run needs a terminal password prompt or --password-file. No settings were saved.')
    password = getpass.getpass('DevHarbour login password: ')
    if len(password) < 12 or any(ord(c) < 32 for c in password):
        raise cli.CliError('Use a password with at least 12 characters and no control characters.')
    if getpass.getpass('Repeat the password: ') != password:
        raise cli.CliError('Passwords differ. Nothing was saved.')
    return password


def address(settings):
    """Return the effective browser URL without credentials."""
    host = settings.get('bind-address', '127.0.0.1')
    host = '127.0.0.1' if host in {'0.0.0.0', '::'} else '[::1]' if host == '::1' else host
    return settings.get('origin') or 'http://' + host + ':' + str(settings.get('port', 3000))


def open_browser(settings):
    """Print the URL and ask a locally available browser to open it."""
    url = address(settings)
    print(url)
    if os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'):
        webbrowser.open(url)

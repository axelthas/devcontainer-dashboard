"""Menu-based DevHarbour setup. Collect choices in memory; never deploy from a prompt.

The UI follows devbootstrap: a banner, numbered steps, an explanation before every
question, explicit answer lists with the saved or default value highlighted,
Escape/back navigation and an editable review page. Layout rules: one question
at a time, a blank line before each question, context indented below the step
heading, and answers phrased as answers to the question.
"""
import copy
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import textwrap

TOTAL_STEPS = 7
WIDTH = 78


def tailscale_origin_from_json(document, command):
    """Extract only this node's validated MagicDNS host, never a user name or peer."""
    if not isinstance(document, dict):
        return None, 'Tailscale returned an unexpected JSON shape.'
    tailnet = document.get('CurrentTailnet')
    if tailnet is not None and not isinstance(tailnet, dict):
        return None, 'Tailscale returned invalid tailnet metadata.'
    if isinstance(tailnet, dict) and tailnet.get('MagicDNSEnabled') is False:
        return None, 'MagicDNS is disabled. Enable it in the tailnet or enter an already-configured HTTPS origin.'
    if command == 'whoami':
        node = document.get('Node')
        name = node.get('Name') if isinstance(node, dict) else None
        if isinstance(node, dict) and node.get('MachineAuthorized') is False:
            return None, 'This Tailscale machine still needs tailnet authorization.'
    else:
        if document.get('BackendState') != 'Running':
            return None, 'Tailscale is not running and logged in. Connect it on the Docker host, then retry.'
        node = document.get('Self')
        name = node.get('DNSName') if isinstance(node, dict) else None
        if isinstance(node, dict) and node.get('Online') is False:
            return None, 'The selected Tailscale node is offline.'
    if not isinstance(name, str):
        return None, 'The local node did not report a MagicDNS name.'
    # Tailscale reports absolute DNS names with a final dot; URLs must omit it.
    hostname = name[:-1] if name.endswith('.') else name
    hostname = hostname.lower()
    labels = hostname.split('.')
    if len(hostname) > 253 or len(labels) < 4 or labels[-2:] != ['ts', 'net'] or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels):
        return None, 'The local node returned an invalid ts.net DNS name; enter the HTTPS origin explicitly.'
    if isinstance(tailnet, dict) and tailnet.get('MagicDNSSuffix'):
        suffix = tailnet['MagicDNSSuffix']
        if not isinstance(suffix, str) or not hostname.endswith('.' + suffix.rstrip('.').lower()):
            return None, 'The node DNS name does not match its current tailnet.'
    return 'https://' + hostname, None


def discover_tailscale_origin(socket_path):
    """Read and size-check identity/status JSON from the selected daemon, never raw logs.

    No login/up/serve/funnel/cert command is used. The resulting hostname suggests
    HTTPS port 443; it does not establish a certificate or an existing Serve route.
    """
    reason = 'Tailscale did not report a usable local MagicDNS identity.'
    for name, flags in [('whoami', ['--json']), ('status', ['--json', '--peers=false'])]:
        try:
            result = subprocess.run(['tailscale', '--socket=' + socket_path, name, *flags],
                                    text=True, capture_output=True, check=False, timeout=5)
        except FileNotFoundError:
            return None, 'The tailscale command is missing. Install/run it on the Docker host or enter the HTTPS origin manually.'
        except subprocess.TimeoutExpired:
            return None, 'Tailscale discovery timed out. Check the selected daemon socket or enter the HTTPS origin manually.'
        except (OSError, UnicodeError):
            return None, 'Cannot run tailscale. Check command access and the selected host socket, or enter the origin manually.'
        if result.returncode:
            reason = 'Cannot read the selected tailscaled identity. Check daemon/login/socket permissions, or enter the origin manually.'
            continue
        if len(result.stdout) > 1024 * 1024:
            return None, 'Tailscale returned oversized identity data. Enter the origin manually.'
        try:
            document = json.loads(result.stdout)
        except (ValueError, TypeError):
            reason = 'Tailscale returned invalid JSON. Enter the origin manually or check the client version.'
            continue
        origin, error = tailscale_origin_from_json(document, name)
        if origin:
            return origin, None
        # A successful identity response with invalid state/name must not be
        # replaced with a different peer, LoginName or a guessed tailnet suffix.
        return None, error
    return None, reason


class Back(Exception):
    """Return to the previous step without saving or applying anything."""


def colors_enabled():
    """Use ANSI styling only on an interactive terminal without NO_COLOR."""
    return sys.stdout.isatty() and 'NO_COLOR' not in os.environ and os.environ.get('TERM') != 'dumb'


def paint(text, code):
    """Wrap text in one SGR style when color is enabled."""
    return '\033[' + code + 'm' + text + '\033[0m' if colors_enabled() else text


def wrap(text, indent='  '):
    """Wrap a paragraph to the setup width with a consistent indent."""
    return textwrap.fill(text, WIDTH, initial_indent=indent, subsequent_indent=indent)


def heading(number, title, purpose):
    """Print a step banner, its purpose and spacing before the first question."""
    label = ' Step ' + str(number) + ' of ' + str(TOTAL_STEPS) + ' '
    print('\n' + paint('━━' + label + '━' * max(4, WIDTH - len(label) - 2), '38;5;110'))
    print(paint('  ' + title, '1'))
    print()
    print(wrap(purpose))


def section(title):
    """Separate a sub-topic inside a step."""
    print('\n' + paint('  ▸ ' + title, '1;38;5;110'))


def note(text):
    """Print explanatory context in a muted, indented paragraph."""
    print(paint(wrap(text, '    '), '38;5;250'))


def fact(label, value):
    """Print one aligned label/value line for detected or reviewed settings."""
    print('    ' + paint(label.ljust(22), '38;5;246') + str(value))


class Terminal:
    """Questionary adapter bound to /dev/tty, never the curl pipeline's stdin."""

    def __enter__(self):
        """Open terminal streams and the isolated prompt-toolkit input/output objects."""
        try:
            import questionary
            from prompt_toolkit.input import create_input
            from prompt_toolkit.output import create_output
        except ImportError as error:
            raise RuntimeError('Interactive dependencies are missing. Repeat the DevHarbour installer; unattended mode remains available.') from error
        self.q = questionary
        self.reader = open('/dev/tty', 'r')
        self.writer = open('/dev/tty', 'w')
        self.input = create_input(stdin=self.reader)
        self.output = create_output(stdout=self.writer)
        self.style = questionary.Style([
            ('qmark', 'fg:#88c0d0 bold'), ('question', 'bold'), ('pointer', 'fg:#88c0d0 bold'),
            ('highlighted', 'fg:#88c0d0 bold'), ('selected', 'fg:#a3be8c'), ('answer', 'fg:#a3be8c bold'),
            ('instruction', 'fg:#7b88a1 italic'), ('separator', 'fg:#4c566a'), ('text', '')])
        return self

    def __exit__(self, *unused):
        """Close only the UI-owned terminal handles."""
        self.input.close()
        self.reader.close()
        self.writer.close()

    def question(self, question):
        """Map Escape to back and let Ctrl+C cancel without a partial save."""
        from prompt_toolkit.key_binding import KeyBindings, merge_key_bindings
        from prompt_toolkit.keys import Keys
        keys = KeyBindings()

        @keys.add(Keys.Escape, eager=True)
        def escape(event):
            """Return to the step controller rather than terminating setup."""
            event.app.exit(result=None)

        question.application.key_bindings = merge_key_bindings([question.application.key_bindings, keys])
        # A blank line separates every question from the context above it.
        self.writer.write('\n')
        self.writer.flush()
        result = question.unsafe_ask()
        if result is None:
            raise Back()
        return result

    def select(self, title, choices, default=None, back=True):
        """Ask one question; choices are (answer, value) or (answer, value, description)."""
        options = [self.q.Choice(c[0], value=c[1], description=c[2] if len(c) > 2 else None) for c in choices]
        if back:
            options += [self.q.Separator(' '), self.q.Choice('← Go back to the previous question or step', value='__back__')]
        if default is not None and not any(o.value == default for o in options if isinstance(o, self.q.Choice)):
            default = None
        result = self.question(self.q.select(title, choices=options, default=default, style=self.style, qmark='?', pointer='❯',
                                            instruction='(↑↓ choose, Enter select, Esc back)', input=self.input, output=self.output))
        if result == '__back__':
            raise Back()
        return result

    def text(self, title, default='', secret=False):
        """Read a text answer; credentials are hidden."""
        function = self.q.password if secret else self.q.text
        options = {} if secret else {'instruction': '(edit, then Enter; Esc back)'}
        return self.question(function(title, default=str(default or ''), style=self.style, qmark='›', input=self.input, output=self.output, **options))

    def check(self, title, choices, selected):
        """Choose any number of features; choices are (answer, value, description)."""
        options = [self.q.Choice(c[0], value=c[1], checked=c[1] in selected, description=c[2] if len(c) > 2 else None) for c in choices]
        return self.question(self.q.checkbox(title, choices=options, style=self.style, qmark='?', pointer='❯',
                                             instruction='(Space toggle, Enter confirm, Esc back)', input=self.input, output=self.output))


# Every editable setting: question, explanation, default (value or function of
# the setup) and, only when there is no default, what "None" means.
FIELDS = {
    'port': dict(label='DevHarbour port', question='Which host port should DevHarbour use?',
                 help='You open DevHarbour in a browser on this port of the Docker host.',
                 default=lambda s: 3001 if s.args.command == 'build' else 3000),
    'ai-port': dict(label='AI interface port', question='Which host port should the AI interface use?',
                    help='DevHarbour includes an OpenChamber AI interface. It needs its own port, different from the DevHarbour port.', default=3002),
    'ai-state-volume': dict(label='AI state volume', question='Which Docker volume should keep AI settings and history?',
                            help='A named Docker volume, not a host folder. Keeping the same volume preserves AI state when DevHarbour is updated or replaced.',
                            default=lambda s: s.c.resource_names(s.config)[2]),
    'image': dict(label='DevHarbour image', question='Which published DevHarbour image should run?',
                  help='A Docker image reference, optionally with :tag or @digest. A missing image is downloaded; an existing tag is not refreshed automatically.',
                  default=lambda s: s.c.DEFAULTS['image']),
    'bind-address': dict(label='Bind address', question='Which host network address should DevHarbour listen on?',
                         help='127.0.0.1 allows connections from this host only. 0.0.0.0 allows every IPv4 network interface and needs your explicit approval.', default='127.0.0.1'),
    'socket': dict(label='Docker socket', question='Where is the Docker socket on the host?',
                   help='DevHarbour manages containers through this socket. It grants full Docker control.', default='/var/run/docker.sock'),
    'host-name': dict(label='Host display name', question='Which name should DevHarbour show for this host?',
                      help='A label in the DevHarbour header, for example workstation.', none="None: show the Docker host's own hostname"),
    'vscode-ssh-host': dict(label='VS Code SSH host', question='Which SSH host should "Open in VS Code" links use?',
                            help='An SSH config alias or hostname that reaches this Docker host from the computer where VS Code runs.',
                            none='None: VS Code links connect to Docker directly, without an SSH host'),
    'health-timeout': dict(label='Startup timeout', question='How many seconds should setup wait for DevHarbour to become ready?',
                           help='Setup reports a failure if DevHarbour is not ready within this time. Enter 1 to 86400.', default=180),
    'ssh-known-hosts': dict(label='Trusted SSH host keys', question='Which known_hosts file should DevHarbour trust?',
                            help='DevHarbour mounts this one file read-only, so Git over SSH accepts the host keys you already trust. Private keys are never mounted.',
                            default=lambda s: s.settings.get('host-home', '') + '/.ssh/known_hosts',
                            none='None: Git over SSH fails for hosts that are not already trusted inside DevHarbour'),
    'tailscale-socket': dict(label='Tailscale socket', question='Where is the tailscaled socket on the host?',
                             help='DevHarbour configures HTTPS routes through this socket. Access to it gives broad control of host Tailscale settings.',
                             default='/var/run/tailscale/tailscaled.sock'),
    'origin': dict(label='HTTPS address', question='Which address will you use to open DevHarbour?',
                   help='The exact external origin, without a path, for example https://host.tailnet.ts.net.',
                   none='None: open DevHarbour at its local http:// address'),
    'tailscale-ports': dict(label='Service HTTPS ports', question='Which port range should DevHarbour use for container web services?',
                            help='DevHarbour publishes container web services on HTTPS ports in this range (FIRST-LAST, at most 256 ports).', default='8400-8499'),
    'tailscale-gateway-port': dict(label='Service gateway port', question='Which internal port should the service gateway use?',
                                   help='A host-loopback port used between Tailscale and DevHarbour. It must not be in the service range.', default=3003),
    'brain-port': dict(label='MCP server port', question='Which local port should the MCP server use?',
                       help='The MCP server has its own listener, separate from DevHarbour and the AI interface.', default=3100),
    'brain-token-file': dict(label='MCP access token file', question='Which host file contains the MCP access token?',
                             help='MCP clients must send this token. The file must contain 32 to 512 characters and is mounted read-only.',
                             none='None: DevHarbour generates a private token and keeps it in its data volume'),
    'brain-funnel-port': dict(label='Public MCP HTTPS port', question='Which public HTTPS port should the Funnel route use?',
                              help='Tailscale Funnel allows 443, 8443 and 10000. 10000 keeps 443 free for DevHarbour itself.', default=10000, choices=[443, 8443, 10000]),
}


class Setup:
    """In-memory editable setup state with an injectable terminal boundary for tests."""

    def __init__(self, core, config, args, terminal):
        """Keep original settings for saved-choice defaults and cancellation safety."""
        self.c, self.args, self.t = core, args, terminal
        self.config = copy.deepcopy(config)
        self.pending = None
        self.local = None
        self.selected_features = None
        self.env_plan = None
        self.original = copy.deepcopy(config)
        self.config['settings'].setdefault('ai-state-volume', core.resource_names(config)[2])

    @property
    def settings(self):
        """Return editable settings, never the caller's live dictionary before approval."""
        return self.config['settings']

    def default_for(self, key):
        """Resolve a setting's default value for display and selection."""
        default = FIELDS[key].get('default')
        return default(self) if callable(default) else default

    def parse(self, key, value):
        """Convert and validate one typed answer, raising ValueError when invalid."""
        value = int(value) if key in self.c.NUMBERS else value
        self.c.validate_types({key: value})
        if key in self.c.NUMBERS and not 1 <= value <= (86400 if key == 'health-timeout' else 65535):
            raise ValueError('Out of range')
        if FIELDS[key].get('choices') and value not in FIELDS[key]['choices']:
            raise ValueError('Unsupported choice')
        if key == 'tailscale-ports':
            match = re.fullmatch(r'([1-9][0-9]*)-([1-9][0-9]*)', value)
            if not match or not 1 <= int(match[1]) <= int(match[2]) <= 65535 or int(match[2]) - int(match[1]) >= 256:
                raise ValueError('Invalid port range')
        return value

    def field(self, key, default=None, required=False):
        """Ask one setting question with the saved/default value as a named answer.

        Answers: keep the saved value, use the default, "None" (only for settings
        without a default, with its stated meaning) or enter a different value.
        """
        spec = FIELDS[key]
        note(spec['help'])
        if key.replace('-', '_') in vars(self.args):
            fact(spec['label'], str(self.settings[key]) + '  (set by command argument)')
            return self.settings[key]
        saved = self.settings.get(key)
        default = default if default is not None else self.default_for(key)
        choices = []
        if saved is not None:
            choices.append(('Keep ' + str(saved), 'saved', 'The value in your saved setup.'))
        if default is not None and default != saved:
            choices.append(('Use the default: ' + str(default), 'default', 'Recommended unless you need something else.'))
        for option in spec.get('choices', []):
            if option not in {saved, default}:
                choices.append(('Use ' + str(option), ('value', option), None))
        if spec.get('none') and not required and (saved is not None or default is None):
            choices.append((spec['none'], 'none', None))
        choices.append(('Enter a different value', 'change', None))
        while True:
            selected = 'change' if len(choices) == 1 else self.t.select(
                spec['question'], choices, default='saved' if saved is not None else 'default' if default is not None else 'none')
            if selected == 'saved':
                return saved
            if selected == 'default':
                self.settings[key] = default
                return default
            if isinstance(selected, tuple):
                self.settings[key] = selected[1]
                return selected[1]
            if selected == 'none':
                self.settings.pop(key, None)
                return None
            answer = self.t.text(spec['question'], saved if saved is not None else default if default is not None else '')
            try:
                if answer in (None, ''):
                    raise ValueError('Empty')
                self.settings[key] = self.parse(key, answer)
                return self.settings[key]
            except (ValueError, TypeError, self.c.CliError):
                note('That value is not valid. ' + spec['help'])

    def source(self):
        """Choose published-image use or a pinned managed local build."""
        from devharbour_source import installed_source
        heading(1, 'How DevHarbour runs',
                'DevHarbour runs as one Docker container that you keep and reuse. Choose where its image comes from. Both answers manage the same container and keep the same data volumes.')
        source = self.config.get('source', {'mode': 'published'})
        if hasattr(self.args, 'image_source') or hasattr(self.args, 'source_ref'):
            mode = 'build' if hasattr(self.args, 'source_ref') else self.args.image_source
        else:
            mode = self.t.select('Where should the DevHarbour image come from?', [
                ('Download the published image (recommended)', 'published', 'Fastest start. No source code, Node.js or compiler needed.'),
                ('Build the image locally from source', 'build', 'Use a branch, tag or commit that is not published yet. Building takes several minutes.')],
                default=source['mode'], back=False)
        if mode == 'published':
            if source['mode'] == 'build' and not hasattr(self.args, 'image'):
                self.settings['image'] = self.c.DEFAULTS['image']
            self.config['source'] = {'mode': 'published'}
            self.field('image', required=True)
            return
        info = installed_source(self.c.ROOT)
        installed = info.get('revision', 'main')
        current = source.get('ref', installed)
        note('Source is cloned into a separate folder pinned to one commit. A folder with local changes is never reset. Docker builds the image only after you approve the review.')
        if hasattr(self.args, 'source_ref'):
            ref, choice = self.args.source_ref, 'explicit'
        else:
            choice = self.t.select('Which source version should DevHarbour build?', [
                ('Keep ' + current, 'saved', 'The version this setup used before, or the version you installed.'),
                ('The latest main branch', 'main', 'Resolved to a commit when you apply the setup.'),
                ('Enter a branch, tag or commit', 'custom', None)], default='saved')
            ref = self.t.text('Which branch, tag or commit should DevHarbour build?', current) if choice == 'custom' else 'main' if choice == 'main' else current
        self.config['source'] = {'mode': 'build', 'ref': ref}
        if hasattr(self.args, 'source_checkout'):
            self.config['source']['checkout'] = self.args.source_checkout
        elif choice == 'saved' and info.get('checkout') and ref == installed and not source.get('checkout'):
            self.config['source'].update({'checkout': info['checkout'], 'revision': ref})
        elif choice == 'saved' and source.get('checkout'):
            self.config['source'].update({key: source[key] for key in ('checkout', 'revision') if key in source})
        if choice != 'saved' or mode != source['mode']:
            self.settings.pop('source-checkout', None)
        fact('Build version', ref)


    def host(self):
        """Confirm detected host facts, workspace, SSH agent and trusted host keys."""
        heading(2, 'Host, workspace and SSH',
                'DevHarbour starts containers and edits repositories as your user on the Docker host. These values must describe the Docker host, not a container you may be running this setup in.')
        self.local = self.t.select('Where does Docker run?', [
            ('On this Linux machine (recommended)', True, 'Setup detects your account and SSH agent on this machine.'),
            ('On another host, or I am inside a container', False, 'You enter the Docker host values yourself.')],
            default=True if self.local is None else self.local)
        account = pwd.getpwuid(os.getuid()) if self.local else None
        suggested = {'host-user': account.pw_name, 'host-uid': account.pw_uid, 'host-gid': account.pw_gid, 'host-home': account.pw_dir} if account else {}
        for key in ('host-user', 'host-uid', 'host-gid', 'host-home'):
            if key not in self.settings and key in suggested:
                self.settings[key] = suggested[key]
        complete = all(key in self.settings for key in ('host-user', 'host-uid', 'host-gid', 'host-home'))
        if complete:
            section('Your account on the Docker host')
            fact('User', self.settings['host-user'])
            fact('User ID / group ID', str(self.settings['host-uid']) + ' / ' + str(self.settings['host-gid']))
            fact('Home directory', self.settings['host-home'])
        action = self.t.select('Are these your account details on the Docker host?', [
            ('Yes, use them', 'keep', None), ('No, enter them myself', 'change', None)]) if complete else 'change'
        if action == 'change':
            labels = {'host-user': 'Which user owns your workspaces on the Docker host?', 'host-uid': 'What is that user\'s numeric user ID?',
                      'host-gid': 'What is that user\'s numeric primary group ID?', 'host-home': 'What is that user\'s home directory?'}
            for key in ('host-user', 'host-uid', 'host-gid', 'host-home'):
                if key.replace('-', '_') in vars(self.args):
                    continue
                while True:
                    answer = self.t.text(labels[key], self.settings.get(key, ''))
                    try:
                        value = int(answer) if key in self.c.NUMBERS else answer
                        if not value or (key in self.c.NUMBERS and not 1 <= value <= 2147483647):
                            raise ValueError('Non-root identity required')
                        self.settings[key] = value
                        break
                    except ValueError:
                        note('Enter a positive number other than 0 (root).' if key in self.c.NUMBERS else 'This value is required.')
        section('Workspace')
        note('DevHarbour lists, clones and edits repositories in this folder on the Docker host.')
        workspace = self.settings.get('workspace', self.settings['host-home'] + '/ddash-workspace')
        if not hasattr(self.args, 'workspace'):
            action = self.t.select('Which folder should hold your workspaces?', [
                ('Use ' + workspace, 'keep', 'Created if it does not exist yet.' if self.local else None), ('Enter another folder', 'change', None)])
            self.settings['workspace'] = workspace if action == 'keep' else self.t.text('Which folder should hold your workspaces?', workspace)
        if not self.local:
            self.settings.setdefault('no-create-workspace', True)
        section('SSH authentication')
        note('DevHarbour signs Git and SSH operations through your existing SSH agent on the Docker host. Private key files are never copied. SSH_AUTH_SOCK is ignored because inside an SSH login it can point to a forwarded agent from another machine.')
        if not hasattr(self.args, 'ssh_agent_socket'):
            agents, reason = self.c.discover_host_agents(self.settings['host-uid'], self.settings['host-home']) if self.local else ([], 'Agents on another host cannot be detected from here.')
            if reason:
                note(reason)
            options = [(a['path'], a['path'], a['provider'] + ' agent, ' + str(a['identities']) + ' loaded keys') for a in agents]
            saved = self.settings.get('ssh-agent-socket')
            if saved and saved not in {a['path'] for a in agents}:
                options.append(('Keep ' + saved, saved, 'Your saved socket. Setup did not detect an agent there.'))
            options.append(('Enter another socket path', '__manual__', None))
            selected = self.t.select('Which SSH agent should DevHarbour use?', options, default=agents[0]['path'] if len(agents) == 1 else saved if saved else None)
            self.settings['ssh-agent-socket'] = self.t.text('Which SSH agent socket should DevHarbour use?', saved or '/run/user/' + str(self.settings['host-uid']) + '/gcr/ssh') if selected == '__manual__' else selected
        section('Trusted SSH host keys')
        known = self.default_for('ssh-known-hosts')
        if hasattr(self.args, 'ssh_known_hosts') or 'ssh-known-hosts' in self.settings:
            fact('known_hosts file', self.settings.get('ssh-known-hosts'))
        elif self.local and os.path.isfile(known) and os.access(known, os.R_OK):
            self.settings['ssh-known-hosts'] = known
            fact('known_hosts file', known + '  (found, mounted read-only)')
        elif self.local:
            fact('known_hosts file', 'none: ' + known + ' does not exist')
            note('Git over SSH asks to trust new hosts. You can set a file later under advanced settings.')
        else:
            self.field('ssh-known-hosts')
        self.settings.setdefault('ai-state-volume', self.c.resource_names(self.config)[2])

    def tailscale_origin(self):
        """Offer the detected local origin while preserving saved/explicit choices."""
        if hasattr(self.args, 'origin'):
            self.field('origin', required=True)
            return
        if self.local is None:
            self.local = self.t.select('Does this setup run on the Docker host itself?', [
                ('Yes, detect the Tailscale address on this machine', True, None),
                ('No, I will enter the address myself', False, None)], default=False)
        if not self.local:
            note('Tailscale on this machine does not describe another host, so enter its address.')
            self.field('origin', required=True)
            return
        origin, reason = discover_tailscale_origin(self.settings['tailscale-socket'])
        if not origin:
            note(reason)
            self.field('origin', required=True)
            return
        fact('Detected address', origin)
        note('Derived from this machine\'s Tailscale DNS name, on the standard HTTPS port 443. Choose another answer if you already serve DevHarbour on a custom port.')
        saved = self.settings.get('origin')
        options = [('Use the detected address: ' + origin, 'detected', None)]
        if saved and saved != origin:
            options.insert(0, ('Keep ' + saved, 'saved', 'The address in your saved setup.'))
        options.append(('Enter another address or port', 'manual', None))
        action = self.t.select(FIELDS['origin']['question'], options, default='saved' if saved and saved != origin else 'detected')
        if action == 'detected':
            self.settings['origin'] = origin
        elif action == 'manual':
            self.field('origin', default=origin, required=True)

    def access(self):
        """Choose who can reach DevHarbour, then collect only that mode's details."""
        heading(3, 'Access and login',
                'Anyone who logs in to DevHarbour gets full control of Docker and terminals on this host. Choose who can reach the login page.')
        mode = self.t.select('Who should be able to open DevHarbour?', [
            ('Only this computer (recommended)', 'local', 'DevHarbour listens on http://127.0.0.1 only.'),
            ('My Tailscale devices, over HTTPS', 'tailscale', 'Private HTTPS on your tailnet. Needs Tailscale running on the Docker host.'),
            ('A custom network address', 'custom', 'Choose the bind address and external address yourself.')],
            default='tailscale' if self.settings.get('tailscale-socket') else 'custom' if self.settings.get('bind-address', '127.0.0.1') not in {'127.0.0.1', '::1'} or self.settings.get('origin') else 'local')
        if mode == 'tailscale':
            if hasattr(self.args, 'gateway'):
                raise self.c.CliError('Explicit --gateway cannot be combined with Tailscale HTTPS.')
            self.settings['gateway'] = False
            self.settings.pop('gateway-host', None)
            if not hasattr(self.args, 'bind_address'):
                self.settings['bind-address'] = '127.0.0.1'
            section('Tailscale')
            self.field('tailscale-socket', required=True)
            self.tailscale_origin()
        else:
            if hasattr(self.args, 'tailscale_socket'):
                raise self.c.CliError('Explicit --tailscale-socket requires the Tailscale access choice.')
            self.c.disable_dependents(self.settings, self.args, 'tailscale-socket')
            self.settings.pop('tailscale-socket', None)
            if mode == 'custom':
                self.field('bind-address', required=True)
                self.field('origin')
            else:
                if hasattr(self.args, 'bind_address') and self.args.bind_address not in {'127.0.0.1', '::1'}:
                    raise self.c.CliError('Explicit nonlocal --bind-address conflicts with local-only access.')
                if not hasattr(self.args, 'bind_address'):
                    self.settings['bind-address'] = '127.0.0.1'
                if not hasattr(self.args, 'origin'):
                    self.settings.pop('origin', None)
        section('DevHarbour login')
        if hasattr(self.args, 'password_file'):
            fact('Password', 'from the file given on the command line')
            return
        have_password = bool(self.pending is not None or self.settings.get('password-file'))
        note('One shared password protects DevHarbour. It is stored in a private file, never in the setup JSON.')
        action = self.t.select('Which DevHarbour login password should be used?', [
            ('Keep the current password', 'keep', None), ('Set a new password', 'new', None)]) if have_password else 'new'
        if action == 'new':
            while True:
                first = self.t.text('New DevHarbour password (hidden)', secret=True)
                if first and first == self.t.text('Repeat the password (hidden)', secret=True):
                    self.pending = first
                    break
                note('The passwords were empty or did not match. Nothing was saved; try again.')


    def devenv(self):
        """Show, edit and select the environment file forwarded to devcontainers."""
        import devharbour_env as env
        heading(4, 'Devcontainer environment',
                'DevHarbour passes these variables to the devcontainers it builds and starts. Devcontainer configurations read them as ${localEnv:NAME}; the dev-bootstrap templates do this for you.')
        path = env.default_path(self.args.config)
        if hasattr(self.args, 'env_file'):
            fact('Environment files', ', '.join(self.settings['env-file']) + '  (set by command argument)')
            return
        try:
            lines, values = env.read(path) if path.exists() or path.is_symlink() else (None, {})
        except env.EnvError as error:
            note(str(error) + ' Fix the file or choose not to pass it.')
            lines, values = None, None
        if self.env_plan is None and values is not None:
            # Generate missing defaults once, so the review shows what will be written.
            self.env_plan = {'path': str(path), 'lines': lines, 'updates': env.missing_defaults(values)}
        current = {**(values or {}), **(self.env_plan or {}).get('updates', {})}
        section('Environment file')
        fact('File', str(path) + ('' if lines is not None else '  (created when you save)'))
        for name, _, explanation in env.VARIABLES:
            value = current.get(name)
            shown = 'hidden, ' + str(len(value)) + ' characters' if name in env.SECRETS and value else value
            fact(name, shown if value is not None else 'not set')
            note(explanation)
        note('Current dev-bootstrap templates forward OPENCODE_PASSWORD and TERN_USE_CCACHE. OPENCODE_SKIP_START and OPENCODE_PORT reach a devcontainer only if its devcontainer.json forwards them.')
        files = [str(Path(p) if Path(p).is_absolute() else path.parent / p) for p in self.settings.get('env-file', [])]
        choices = [('No, do not pass this file to devcontainers', 'skip', 'Devcontainers get no values from DevHarbour for these variables.')]
        if values is not None:
            choices[:0] = [('Yes, use these values (recommended)', 'use', None), ('Yes, but change some values first', 'edit', None)]
        action = self.t.select('Should DevHarbour pass this environment to your devcontainers?', choices,
                               default='skip' if values is None or (self.settings.get('env-file') and str(path) not in files) else 'use')
        if action == 'skip':
            self.settings['env-file'] = [p for p in self.settings.get('env-file', []) if str(Path(p) if Path(p).is_absolute() else path.parent / p) != str(path)]
            if not self.settings['env-file']:
                self.settings.pop('env-file')
            self.env_plan = None
            return
        if action == 'edit':
            self.edit_env(current)
        if str(path) not in files:
            self.settings['env-file'] = [str(path)] + self.settings.get('env-file', [])

    def edit_env(self, current):
        """Change the important variables one question at a time."""
        import devharbour_env as env
        updates = self.env_plan['updates']
        ccache = self.t.select('Should Tern builds in devcontainers use ccache?', [
            ('Yes (TERN_USE_CCACHE=1)', '1', 'Faster rebuilds. Recommended.'), ('No (TERN_USE_CCACHE=0)', '0', None)], default=current.get('TERN_USE_CCACHE', '1'))
        updates['TERN_USE_CCACHE'] = ccache
        password = self.t.select('Which OpenCode password should devcontainers use?', [
            ('Keep the current password', 'keep', None), ('Generate a new random password', 'generate', None), ('Enter my own password', 'own', 'At least 12 characters.')], default='keep')
        if password == 'generate':
            updates['OPENCODE_PASSWORD'] = env.VARIABLES[1][1]()
        while password == 'own':
            value = self.t.text('New OpenCode password (hidden)', secret=True)
            try:
                env.validate('OPENCODE_PASSWORD', value)
                updates['OPENCODE_PASSWORD'] = value
                break
            except env.EnvError as error:
                note(str(error))
        updates['OPENCODE_SKIP_START'] = self.t.select('How should OpenChamber reach OpenCode in a devcontainer?', [
            ('Connect to the running OpenCode service (recommended)', 'true', 'OPENCODE_SKIP_START=true'),
            ('Start its own OpenCode process', 'false', 'OPENCODE_SKIP_START=false')], default=current.get('OPENCODE_SKIP_START', 'true'))
        while True:
            port = self.t.text('Which port does the OpenCode service use in devcontainers?', current.get('OPENCODE_PORT', '4096'))
            try:
                env.validate('OPENCODE_PORT', port)
                updates['OPENCODE_PORT'] = port
                break
            except env.EnvError as error:
                note(str(error))

    def features(self):
        """Explain optional features before a checkbox menu; configure only selections."""
        heading(5, 'Optional features',
                'Leave everything unchecked for a standard DevHarbour. Each feature you select then asks only its own questions.')
        section('Development bootstrap')
        note('Runs the bundled dev-bootstrap hook when DevHarbour starts, so dev-bootstrap is ready to create devcontainer workspaces. Needs Git access to the dev-bootstrap repository.')
        section('MCP server for AI agents')
        note('Starts an MCP server, separate from the DevHarbour web interface, so AI agents (MCP clients) can run shell commands in containers. An agent reaches only the containers you grant to it in DevHarbour, one by one; starting the server grants nothing. Clients authenticate with an access token.')
        section('Public MCP access through Tailscale Funnel')
        note('For AI agents hosted on the internet that cannot reach your tailnet. When DevHarbour starts, it adds a Tailscale Funnel route that publishes only the MCP server on a public HTTPS address of this machine. The DevHarbour web interface stays private. When DevHarbour stops, it removes the route it added. Requires Tailscale access (step 3), HTTPS certificates, MagicDNS and Funnel permission in your tailnet policy.')
        defaults = {key for key in ('bootstrap', 'brain', 'brain-funnel') if self.settings.get(key)}
        if 'brain-port' in self.settings or 'brain-token-file' in self.settings:
            defaults.add('brain')
        if self.selected_features is not None:
            defaults = self.selected_features
        selected = set(self.t.check('Which optional features should DevHarbour enable?', [
            ('Development bootstrap', 'bootstrap', 'Prepare dev-bootstrap when DevHarbour starts.'),
            ('MCP server for AI agents', 'brain', 'AI agents run commands in containers you grant.'),
            ('Public MCP access through Tailscale Funnel', 'brain-funnel', 'Needs the MCP server and Tailscale access.')], defaults))
        for key in ('bootstrap', 'brain', 'brain-funnel'):
            if key.replace('-', '_') in vars(self.args) and getattr(self.args, key.replace('-', '_')):
                selected.add(key)
        if hasattr(self.args, 'brain_funnel_port'):
            selected.add('brain-funnel')
        if hasattr(self.args, 'brain_port') or hasattr(self.args, 'brain_token_file'):
            selected.add('brain')
        self.selected_features = selected.copy()
        if 'brain-funnel' in selected:
            selected.add('brain')
            if not self.settings.get('tailscale-socket'):
                note('Public MCP access needs Tailscale access. Go back to step 3 and choose Tailscale, or leave this feature unchecked.')
                return False
        for key in ('bootstrap', 'brain', 'brain-funnel'):
            self.settings[key] = key in selected
            if key not in selected:
                self.c.disable_dependents(self.settings, self.args, key)
        if 'brain' in selected:
            section('MCP server for AI agents')
            self.field('brain-port', required=True)
            self.field('brain-token-file')
        if 'brain-funnel' in selected:
            section('Public MCP access through Tailscale Funnel')
            self.field('brain-funnel-port', required=True)
        while True:
            section('Advanced settings')
            note('Ports, volumes and similar settings already have working values. The review shows all of them.')
            action = self.t.select('Do you want to change an advanced setting?', [
                ('No, continue to the review', 'done', None), ('Yes, choose a setting', 'advanced', None)], default='done')
            if action == 'done':
                return True
            keys = ['port', 'ai-port', 'ai-state-volume', 'ssh-known-hosts', 'socket', 'host-name', 'vscode-ssh-host', 'health-timeout']
            if self.settings.get('tailscale-socket'):
                keys += ['tailscale-ports', 'tailscale-gateway-port']
            key = self.t.select('Which setting do you want to change?', [(FIELDS[k]['label'] + ': ' + self.display(k), k, None) for k in keys])
            self.field(key)

    def display(self, key):
        """Describe a setting's effective value for menus and review."""
        value = self.settings.get(key, self.default_for(key))
        return 'none' if value is None else str(value)


    def validation_errors(self):
        """Validate the plan without Docker calls, cloning, secret writes or source builds."""
        from devharbour_source import validate_source, SourceError
        candidate = copy.deepcopy(self.config)
        if self.pending is not None:
            candidate['settings']['password-file'] = str(Path(self.args.config).absolute().parent / '.pending-password')
        if self.env_plan and not Path(self.env_plan['path']).exists():
            # The file is written only after approval; validate everything else now.
            files = [p for p in candidate['settings'].get('env-file', []) if p != self.env_plan['path']]
            candidate['settings'].pop('env-file', None)
            if files:
                candidate['settings']['env-file'] = files
        try:
            missing = self.c.REQUIRED - candidate['settings'].keys()
            if missing:
                return ['Missing required settings: ' + ', '.join(sorted(missing))]
            self.c.resource_names(candidate)
            validate_source(candidate.get('source', {'mode': 'published'}))
            settings = self.c.normalized(candidate, Path(self.args.config).absolute().parent)
            self.c.validate_types(settings)
            for key in ('host-uid', 'host-gid'):
                if not 1 <= settings[key] <= 2147483647:
                    return [key + ' must identify a positive non-root host account.']
            if not 1 <= settings.get('health-timeout', 180) <= 86400:
                return ['Startup timeout must be from 1 to 86400 seconds.']
            settings.pop('health-timeout', None)
            result = self.c.run(self.c.launch_argv(candidate, settings, '0' * 64, '0' * 64) + ['--validate-only'], capture=True, check=False)
            return [result.stderr.strip() or 'The launcher rejected this setup. Check ports, host paths and feature requirements.'] if result.returncode else []
        except (self.c.CliError, SourceError, ValueError, OSError) as error:
            return [str(error)]

    def review(self):
        """Show the whole plan grouped by step, then ask what to do with it."""
        heading(6, 'Review your setup', 'Nothing has been saved or started yet. Check each group, change any step, or save.')
        source = self.config.get('source', {'mode': 'published'})
        settings = self.c.normalized(self.config, Path(self.args.config).absolute().parent)
        section('How DevHarbour runs')
        fact('Image', 'built locally from ' + source.get('ref', 'main') if source['mode'] == 'build' else settings['image'])
        section('Host, workspace and SSH')
        fact('User', str(settings.get('host-user')) + '  (' + str(settings.get('host-uid')) + ' / ' + str(settings.get('host-gid')) + ')')
        fact('Workspace', settings.get('workspace'))
        fact('SSH agent', settings.get('ssh-agent-socket'))
        fact('Trusted host keys', settings.get('ssh-known-hosts', 'none'))
        section('Access and login')
        host = '[::1]' if settings['bind-address'] == '::1' else '127.0.0.1' if settings['bind-address'] in {'0.0.0.0', '::'} else settings['bind-address']
        fact('Open DevHarbour at', settings.get('origin') or 'http://' + host + ':' + str(settings['port']))
        fact('AI interface port', settings['ai-port'])
        fact('Login password', 'new password (saved privately)' if self.pending is not None else 'current password')
        section('Devcontainer environment')
        fact('Environment files', ', '.join(settings.get('env-file', [])) or 'none (choose step 4 to add the recommended variables)')
        section('Optional features')
        fact('Development bootstrap', 'on' if settings.get('bootstrap') else 'off')
        fact('MCP server', 'on, local port ' + str(settings.get('brain-port', 3100)) if settings.get('brain') else 'off')
        public = settings.get('origin', '').rsplit(':', 1)[0] if settings.get('origin', '').count(':') > 1 else settings.get('origin', '')
        fact('Public MCP access', public + ':' + str(settings.get('brain-funnel-port', 10000)) + '/mcp' if settings.get('brain-funnel') else 'off')
        section('Kept data')
        fact('Docker volumes', ', '.join(self.c.resource_names(self.config)[:2] + (settings['ai-state-volume'],)))
        errors = self.validation_errors()
        if errors:
            section('Needs attention before saving')
            for error in errors:
                note('• ' + error)
        names = ('How DevHarbour runs', 'Host, workspace and SSH', 'Access and login', 'Devcontainer environment', 'Optional features')
        choices = []
        if not errors:
            if self.args.command != 'configure':
                choices.append(('Save and start DevHarbour', 'apply', 'Downloads or builds the image, then starts DevHarbour and checks that it is ready.'))
            choices.append(('Save only', 'save', 'Saves the setup. Nothing is downloaded, built or started.'))
        choices += [('Change step ' + str(index + 1) + ': ' + name, index) for index, name in enumerate(names)]
        choices.append(('Cancel without saving', 'cancel'))
        return self.t.select('What do you want to do with this setup?', choices)

    def run(self):
        """Drive back/edit navigation and commit in-memory choices only at final approval."""
        steps = [self.source, self.host, self.access, self.devenv, self.features]
        index = 0
        if self.settings and all(key in self.settings for key in self.c.REQUIRED):
            if self.t.select('You have a saved setup. What do you want to do?', [
                    ('Review the saved setup', 'review', 'Go straight to the review; change only the steps you want.'),
                    ('Walk through every step', 'edit', None)], default='review', back=False) == 'review':
                index = len(steps)
        while True:
            try:
                if index < len(steps):
                    if steps[index]() is False:
                        continue
                    index += 1
                    continue
                result = self.review()
                if type(result) is int:
                    index = result
                    continue
                if result == 'cancel':
                    raise KeyboardInterrupt()
                if self.c.exposed(self.c.normalized(self.config, Path(self.args.config).absolute().parent)):
                    note('This setup makes DevHarbour or its MCP server reachable beyond this computer, or gives DevHarbour control of host Tailscale.')
                    if self.t.select('Do you approve these network access settings?', [('No, return to the review', False), ('Yes, I approve them', True)], default=False) is not True:
                        continue
                    self.args.allow_exposure = True
                self.args.plan_approved = True
                self.args.env_plan = self.env_plan if self.env_plan and self.env_plan['path'] in self.settings.get('env-file', []) else None
                if result == 'save':
                    self.args.command = 'configure'
                return self.config, self.pending
            except Back:
                index = max(0, index - 1)


def wizard(core, config, args):
    """Show the banner, then run the menu wizard without touching the saved config."""
    import devharbour_banner
    installed = (core.ROOT / 'VERSION').read_text().strip()[:12] if (core.ROOT / 'VERSION').is_file() else 'checkout'
    devharbour_banner.show(sys.stdout, 'v' + core.VERSION + ' · ' + installed)
    with Terminal() as terminal:
        return Setup(core, config, args, terminal).run()


def approve(message):
    """Use a safe default-no menu for a later exact-resource replacement decision."""
    with Terminal() as terminal:
        try:
            return terminal.select(message, [('No, cancel', False), ('Yes, approve', True)], default=False, back=False)
        except Back:
            return False

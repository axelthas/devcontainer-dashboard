"""Menu-based DevHarbour setup. Collect choices in memory; never deploy from a prompt.

The UI follows devbootstrap: numbered steps, explanatory context, highlighted
saved/default choices, Escape/back navigation and an editable review page.
"""
import copy
import json
import os
from pathlib import Path
import pwd
import sys


class Back(Exception):
    """Return to the previous step without saving or applying anything."""


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
        self.style = questionary.Style([('qmark', 'fg:cyan bold'), ('pointer', 'fg:cyan bold'), ('highlighted', 'fg:cyan bold'), ('question', 'bold')])
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
        result = question.unsafe_ask()
        if result is None:
            raise Back()
        return result

    def select(self, title, choices, default=None, back=True):
        """Select semantic values using arrows; include a visible previous-step action."""
        options = [self.q.Choice(label, value=value) for label, value in choices]
        if back:
            options.append(self.q.Choice('Go back', value='__back__'))
        result = self.question(self.q.select(title, choices=options, default=default,
                                            style=self.style, instruction='Arrows: choose | Enter: select | Esc: back | Ctrl+C: cancel',
                                            input=self.input, output=self.output))
        if result == '__back__':
            raise Back()
        return result

    def text(self, title, default='', secret=False):
        """Read a text value, with hidden input for credentials."""
        function = self.q.password if secret else self.q.text
        return self.question(function(title, default=str(default or ''), style=self.style, input=self.input, output=self.output))

    def check(self, title, choices, selected):
        """Choose optional capabilities with Space, keeping current selections visible."""
        options = [self.q.Choice(label, value=value, checked=value in selected) for label, value in choices]
        return self.question(self.q.checkbox(title, choices=options, style=self.style,
                                             instruction='Space: toggle | Enter: continue | Esc: back', input=self.input, output=self.output))


def heading(number, title, purpose):
    """Explain the purpose of a numbered step before asking anything."""
    print('\n[Step ' + str(number) + '/6] ' + title)
    print(purpose + '\n')


class Setup:
    """In-memory editable setup state with an injectable terminal boundary for tests."""

    def __init__(self, core, config, args, terminal):
        """Keep original settings for saved-choice defaults and cancellation safety."""
        self.c, self.args, self.t = core, args, terminal
        self.config = copy.deepcopy(config)
        self.pending = None
        self.local = True
        self.selected_features = None
        self.original = copy.deepcopy(config)
        self.config['settings'].setdefault('ai-state-volume', core.resource_names(config)[2])

    @property
    def settings(self):
        """Return editable settings, never the caller's live dictionary before approval."""
        return self.config['settings']

    def field(self, key, default=None, required=False):
        """Explain one requested override; preserve explicit arguments and retry invalid input."""
        label, guidance = self.c.FIELD_GUIDANCE.get(key, (key, 'Enter the value on the Docker host.'))
        print(guidance)
        current = self.settings.get(key, default if default is not None else self.c.WIZARD_DEFAULTS.get(key))
        if key.replace('-', '_') in vars(self.args):
            print(label + ':', current, '(explicit command argument)')
            return current
        while True:
            display = json.dumps(current) if key == 'env-file' else str(current) if current is not None else 'not set'
            choices = [('Keep ' + display, 'keep'), ('Change value', 'change')]
            if not required:
                choices.append(('Leave unset / use application default', 'unset'))
            action = self.t.select(label, choices)
            if action == 'unset':
                self.settings.pop(key, None)
                return None
            value = current if action == 'keep' else self.t.text(label, json.dumps(current) if key == 'env-file' and current is not None else current or '')
            try:
                if value is None:
                    if required:
                        raise ValueError('Required value')
                    self.settings.pop(key, None)
                    return None
                value = int(value) if key in self.c.NUMBERS else json.loads(value) if key == 'env-file' and isinstance(value, str) else value
                self.c.validate_types({key: value})
                if key in self.c.NUMBERS and not 1 <= value <= (86400 if key == 'health-timeout' else 65535):
                    raise ValueError('Value out of range')
                if key == 'brain-funnel-port' and value not in {443, 8443, 10000}:
                    raise ValueError('Choose 443, 8443 or 10000')
                self.settings[key] = value
                return value
            except (ValueError, TypeError, self.c.CliError):
                print('Invalid value. ' + guidance)

    def source(self):
        """Choose published-image use or a pinned managed local build."""
        from devharbour_source import installed_source
        heading(1, 'Choose how to run DevHarbour',
                'Use a published image for the quickest start. Build locally to use source changes or a version not yet published. Both modes manage the same retained instance.')
        source = self.config.get('source', {'mode': 'published'})
        mode = self.args.image_source if hasattr(self.args, 'image_source') else 'build' if hasattr(self.args, 'source_ref') else self.t.select('Image source', [
            ('Published image (recommended): no host Node.js or compiler needed', 'published'),
            ('Build locally: clone/use source and build with Docker Buildx', 'build')], default=source['mode'], back=False)
        if hasattr(self.args, 'source_ref'):
            mode = 'build'
        if mode == 'published':
            if source['mode'] == 'build' and not hasattr(self.args, 'image'):
                self.settings['image'] = self.c.DEFAULTS['image']
            self.config['source'] = {'mode': 'published'}
            self.field('image', required=True)
            return
        info = installed_source(self.c.ROOT)
        default_ref = source.get('ref', info.get('revision', 'main'))
        print('Source stays in a separate revision-pinned checkout. Modified checkouts are never reset. Building can take several minutes; host Node.js is not needed.')
        choice = 'explicit' if hasattr(self.args, 'source_ref') else self.t.select('Source version', [('Use selected/installed revision (' + default_ref + ')', 'saved'), ('Use latest main when applied', 'main'), ('Enter branch, tag or commit', 'custom')])
        ref = self.args.source_ref if hasattr(self.args, 'source_ref') else self.t.text('Branch, tag or commit', default_ref) if choice == 'custom' else 'main' if choice == 'main' else default_ref
        self.config['source'] = {'mode': 'build', 'ref': ref}
        if hasattr(self.args, 'source_checkout'):
            self.config['source']['checkout'] = self.args.source_checkout
        elif choice == 'saved' and info.get('checkout') and ref == info.get('revision') and not source.get('checkout'):
            self.config['source'].update({'checkout': info['checkout'], 'revision': ref})
        elif choice == 'saved' and source.get('checkout'):
            self.config['source'].update({key: source[key] for key in ('checkout', 'revision') if key in source})
        if choice != 'saved' or mode != source['mode']:
            self.settings.pop('source-checkout', None)
        print('Build ref:', ref, '| Docker image will be built only after final approval.')

    def host(self):
        """Confirm a detected host profile and explicitly select a host-owned SSH agent."""
        heading(2, 'Host, workspace and SSH authentication',
                'DevHarbour manages Docker and writes repositories in your workspace. These paths and numeric IDs must belong to the actual Docker host, not an unrelated container.')
        self.local = self.t.select('Where is Docker running?', [('On this Linux machine (recommended)', True), ('Another host / I am inside a container', False)], default=self.local)
        account = pwd.getpwuid(os.getuid()) if self.local else None
        suggested = {'host-user': account.pw_name, 'host-uid': account.pw_uid, 'host-gid': account.pw_gid, 'host-home': account.pw_dir} if account else {}
        for key in ('host-user', 'host-uid', 'host-gid', 'host-home'):
            if key not in self.settings and key in suggested:
                self.settings[key] = suggested[key]
        print('Host account:', self.settings.get('host-user', 'not set'), '| UID:', self.settings.get('host-uid', 'not set'), '| GID:', self.settings.get('host-gid', 'not set'), '| home:', self.settings.get('host-home', 'not set'))
        complete = all(key in self.settings for key in ('host-user', 'host-uid', 'host-gid', 'host-home'))
        action = self.t.select('Host identity', [('Use these host identity values', 'keep'), ('Change host identity', 'change')]) if complete else 'change'
        if action == 'change':
            for key in ('host-user', 'host-uid', 'host-gid', 'host-home'):
                if key.replace('-', '_') in vars(self.args):
                    continue
                while True:
                    answer = self.t.text('Docker-host ' + key, self.settings.get(key, ''))
                    try:
                        value = int(answer) if key in self.c.NUMBERS else answer
                        if not value or (key in self.c.NUMBERS and not 1 <= value <= 2147483647):
                            raise ValueError('Non-root identity required')
                        self.settings[key] = value
                        break
                    except ValueError:
                        print('Enter a non-root positive numeric ID.' if key in self.c.NUMBERS else 'This host identity value is required.')
        workspace = self.settings.get('workspace', self.settings['host-home'] + '/ddash-workspace')
        if not hasattr(self.args, 'workspace'):
            action = self.t.select('Workspace directory', [('Use ' + workspace, 'keep'), ('Choose another directory', 'change')])
            self.settings['workspace'] = workspace if action == 'keep' else self.t.text('Absolute Docker-host workspace directory', workspace)
        if not self.local:
            self.settings.setdefault('no-create-workspace', True)
        print('SSH: authenticate through an existing host agent, without copying private keys. SSH_AUTH_SOCK is ignored because an SSH login can forward another machine\'s agent.')
        if not hasattr(self.args, 'ssh_agent_socket'):
            agents, reason = self.c.discover_host_agents(self.settings['host-uid'], self.settings['host-home']) if self.local else ([], 'Remote-host paths cannot be discovered locally.')
            if reason:
                print(reason)
            options = [(a['path'] + ' (' + a['provider'] + ', ' + str(a['identities']) + ' keys)', a['path']) for a in agents]
            saved = self.settings.get('ssh-agent-socket')
            if saved and saved not in {a['path'] for a in agents}:
                options.append(('Use saved explicit socket: ' + saved + ' (not auto-verified)', saved))
            options.append(('Enter another Docker-host agent path', '__manual__'))
            selected = self.t.select('Host SSH agent', options, default=agents[0]['path'] if len(agents) == 1 else saved if saved else None)
            self.settings['ssh-agent-socket'] = self.t.text('Absolute host-agent socket path', saved or '/run/user/' + str(self.settings['host-uid']) + '/gcr/ssh') if selected == '__manual__' else selected
        self.settings.setdefault('ai-state-volume', self.c.resource_names(self.config)[2])
        print('Retained AI state:', self.settings['ai-state-volume'], '(Docker volume, not a host folder).')

    def access(self):
        """Choose the audience first, then collect only that access mode's details."""
        heading(3, 'Access and login',
                'Choose who can reach the dashboard. Local-only is the safest default. Tailscale provides private HTTPS access but needs an existing configured tailscaled. The shared login grants full operator access.')
        mode = self.t.select('Dashboard access', [
            ('Local only (recommended): this host at http://127.0.0.1', 'local'),
            ('Private Tailscale HTTPS: use an existing tailnet node', 'tailscale'),
            ('Custom network: choose binding and external origin', 'custom')],
            default='tailscale' if self.settings.get('tailscale-socket') else 'custom' if self.settings.get('bind-address', '127.0.0.1') not in {'127.0.0.1', '::1'} or self.settings.get('origin') else 'local')
        if mode == 'tailscale':
            if hasattr(self.args, 'gateway'):
                raise self.c.CliError('Explicit --gateway cannot be combined with Tailscale HTTPS.')
            self.settings['gateway'] = False
            self.settings.pop('gateway-host', None)
            if not hasattr(self.args, 'bind_address'):
                self.settings['bind-address'] = '127.0.0.1'
            self.field('tailscale-socket', required=True)
            self.field('origin', required=True)
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
        if hasattr(self.args, 'password_file'):
            print('Login uses the explicitly supplied private password file.')
            return
        have_password = bool(self.pending is not None or self.settings.get('password-file'))
        action = self.t.select('Dashboard login password', [('Keep the existing private password', 'keep'), ('Set a new shared password', 'new')]) if have_password else 'new'
        if action == 'new':
            while True:
                first = self.t.text('New shared dashboard password (hidden)', secret=True)
                if first and first == self.t.text('Repeat password (hidden)', secret=True):
                    self.pending = first
                    break
                print('Passwords must be nonempty and match. Nothing has been saved.')

    def features(self):
        """Explain optional capabilities before a checkbox menu; configure only selections."""
        heading(4, 'Optional capabilities',
                'Leave these unchecked for a basic dashboard. Space toggles a capability; Enter continues. Each selected capability gets its own short configuration section.')
        print('Development bootstrap: runs the bundled dev-bootstrap hook for development tools. Needs Git access and trusted SSH host keys where required.')
        print('ClickUp Brain: a private token-protected MCP listener. You grant individual containers separately; enabling the listener grants none.')
        print('Public Brain Funnel: makes only that MCP listener internet-accessible through Tailscale Funnel. Requires existing HTTPS, MagicDNS and Funnel permission; never publishes the dashboard.')
        defaults = {key for key in ('bootstrap', 'brain', 'brain-funnel') if self.settings.get(key)}
        if 'brain-port' in self.settings or 'brain-token-file' in self.settings:
            defaults.add('brain')
        if self.selected_features is not None:
            defaults = self.selected_features
        selected = set(self.t.check('Enable optional capabilities', [('Development bootstrap', 'bootstrap'), ('ClickUp Brain container access', 'brain'), ('Public Brain Funnel (requires Brain + Tailscale)', 'brain-funnel')], defaults))
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
                print('Public Brain Funnel needs Tailscale HTTPS. Go back to Access and login to configure it, or leave Funnel off.')
                return False
        for key in ('bootstrap', 'brain', 'brain-funnel'):
            self.settings[key] = key in selected
            if key not in selected:
                self.c.disable_dependents(self.settings, self.args, key)
        if 'bootstrap' in selected:
            print('\nDevelopment bootstrap: SSH trust')
            self.field('ssh-known-hosts')
        if 'brain' in selected:
            print('\nClickUp Brain: separate MCP listener, not the dashboard port')
            self.field('brain-port', required=True)
            self.field('brain-token-file')
        if 'brain-funnel' in selected:
            print('\nPublic Brain Funnel: HTTPS endpoint on the public internet')
            self.field('brain-funnel-port', required=True)
        while True:
            print('\nRecommended ports: dashboard 3000, AI 3002. Retained AI state:', self.settings['ai-state-volume'])
            action = self.t.select('Other deployment settings', [('Keep current/recommended defaults and continue', 'done'), ('Change a specific advanced setting', 'advanced')], default='done')
            if action == 'done':
                return True
            keys = ['port', 'ai-port', 'ai-state-volume', 'socket', 'host-name', 'vscode-ssh-host', 'env-file', 'health-timeout']
            if self.settings.get('tailscale-socket'):
                keys += ['tailscale-ports', 'tailscale-gateway-port']
            key = self.t.select('Advanced setting', [(self.c.FIELD_GUIDANCE[key][0], key) for key in keys])
            self.field(key)

    def validation_errors(self):
        """Validate the plan without Docker calls, cloning, secret writes or source builds."""
        from devharbour_source import validate_source, SourceError
        candidate = copy.deepcopy(self.config)
        if self.pending is not None:
            candidate['settings']['password-file'] = str(Path(self.args.config).absolute().parent / '.pending-password')
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
                return ['Readiness timeout must be from 1 to 86400 seconds.']
            settings.pop('health-timeout', None)
            result = self.c.run(self.c.launch_argv(candidate, settings, '0' * 64, '0' * 64) + ['--validate-only'], capture=True, check=False)
            return [result.stderr.strip() or 'Launcher rejected the plan. Review ports, host paths and feature requirements.'] if result.returncode else []
        except (self.c.CliError, SourceError, ValueError, OSError) as error:
            return [str(error)]

    def review(self):
        """Show a grouped, non-secret plan and offer direct edits or save-only action."""
        heading(5, 'Review your setup', 'Nothing below has been applied yet. Edit any step, save only, or approve source preparation and startup. Container replacement still needs its own exact-resource approval.')
        source = self.config.get('source', {'mode': 'published'})
        settings = self.c.normalized(self.config, Path(self.args.config).absolute().parent)
        print('RUN MODE:', 'Build locally from ' + source.get('ref', 'main') if source['mode'] == 'build' else 'Published image ' + settings['image'])
        print('HOST:', settings.get('host-user'), '| UID/GID:', settings.get('host-uid'), '/', settings.get('host-gid'))
        print('WORKSPACE:', settings.get('workspace'))
        print('SSH AGENT:', settings.get('ssh-agent-socket'))
        print('ACCESS:', settings.get('origin') or str(settings['bind-address']) + ':' + str(settings['port']))
        print('PASSWORD:', 'new hidden password (private file after approval)' if self.pending is not None else 'existing private password file')
        print('RETAINED VOLUMES:', ', '.join(self.c.resource_names(self.config)[:2] + (settings['ai-state-volume'],)))
        print('OPTIONAL:', ', '.join(key for key in ('bootstrap', 'brain', 'brain-funnel') if settings.get(key)) or 'none')
        if settings.get('brain'):
            print('BRAIN PORT:', settings.get('brain-port', 3100), '| FUNNEL:', settings.get('brain-funnel-port', 10000) if settings.get('brain-funnel') else 'off')
        print('AFTER APPROVAL:', 'clone/verify source, build image, then start/check instance' if source['mode'] == 'build' else 'use/pull selected image, then start/check instance')
        errors = self.validation_errors()
        if errors:
            print('This setup needs attention before it can be saved:')
            for error in errors:
                print(' -', error)
        choices = [('Save configuration only (do not clone, build or start)', 'save')] if self.args.command == 'configure' else [('Save and start DevHarbour', 'apply'), ('Save configuration only (do not clone, build or start)', 'save')]
        if errors:
            choices = []
        choices += [('Change step ' + str(index + 1) + ': ' + name, index) for index, name in enumerate(('Run mode', 'Host and workspace', 'Access and login', 'Optional capabilities'))]
        choices += [('Cancel without saving', 'cancel')]
        return self.t.select('What would you like to do?', choices)

    def run(self):
        """Drive back/edit navigation and commit in-memory choices only at final approval."""
        steps = [self.source, self.host, self.access, self.features]
        index = 0
        if self.settings and all(key in self.settings for key in self.c.REQUIRED):
            print('Saved settings found. You can reuse them or edit any step before applying.')
            if self.t.select('Existing configuration', [('Review saved settings', 'review'), ('Walk through setup', 'edit')], default='review', back=False) == 'review':
                index = 4
        while True:
            try:
                if index < 4:
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
                    print('This setup includes remote access and/or host Tailscale control. Review those trust boundaries before proceeding.')
                    if self.t.select('Approve the displayed access settings?', [('No, return to review', False), ('Yes, approve these access settings', True)], default=False) is not True:
                        continue
                    self.args.allow_exposure = True
                self.args.plan_approved = True
                if result == 'save':
                    self.args.command = 'configure'
                return self.config, self.pending
            except Back:
                index = max(0, index - 1)


def wizard(core, config, args):
    """Run the menu wizard, preserving the original config until review is approved."""
    with Terminal() as terminal:
        return Setup(core, config, args, terminal).run()


def approve(message):
    """Use a safe default-no menu for a later exact-resource replacement decision."""
    with Terminal() as terminal:
        try:
            return terminal.select(message, [('No, cancel', False), ('Yes, approve', True)], default=False, back=False)
        except Back:
            return False

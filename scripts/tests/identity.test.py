"""Run isolated namespace-identity regressions without Docker or a host deployment."""
import json
import subprocess
import unittest
from unittest.mock import patch
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import devharbour_identity as identity


class IdentityChecks(unittest.TestCase):
    """Cover default/custom hostnames, shared namespaces and safe failure output."""

    def setUp(self):
        """Use deterministic namespace links and an immutable Docker ID."""
        self.caller = {'pid': 'pid:[101]', 'mnt': 'mnt:[202]'}
        self.ns = patch.object(identity, 'process_namespaces', return_value=self.caller)
        self.ns.start()
        self.addCleanup(self.ns.stop)

    def probe(self, target=None, **kwargs):
        """Stub only Docker exec, retaining the actual identity comparison."""
        return patch.object(identity.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(target or self.caller), ''), **kwargs)

    def test_custom_hostname(self):
        """A human-readable hostname must not disable self recreation."""
        with patch('socket.gethostname', return_value='axel-devharbour'), self.probe() as run:
            identity.verify_self('c' * 64)
            self.assertEqual(run.call_args.args[0][4], 'c' * 64)
            self.assertEqual(run.call_args.kwargs['timeout'], 5)

    def test_non_hex_hostname_host_network(self):
        """The host-network use case still uses private PID/mount identities."""
        with patch('socket.gethostname', return_value='myhost.tailnet.ts.net'), self.probe():
            identity.verify_self('c' * 64)

    def test_default_hostname(self):
        """Default Docker hostnames continue to work."""
        with patch('socket.gethostname', return_value='c' * 12), self.probe():
            identity.verify_self('c' * 64)

    def test_development_container(self):
        """A different development container cannot replace the operator instance."""
        with self.probe({'pid': 'pid:[303]', 'mnt': 'mnt:[404]'}), self.assertRaisesRegex(identity.ApplyIdentityError, 'development server'):
            identity.verify_self('c' * 64)

    def test_shared_pid_namespace(self):
        """Sharing the target PID namespace alone does not prove self identity."""
        with self.probe({'pid': 'pid:[101]', 'mnt': 'mnt:[404]'}), self.assertRaises(identity.ApplyIdentityError):
            identity.verify_self('c' * 64)

    def test_matching_hostname_is_not_proof(self):
        """Spoofing a Docker-ID-looking hostname never bypasses the comparison."""
        with patch('socket.gethostname', return_value='c' * 12), self.probe({'pid': 'pid:[303]', 'mnt': 'mnt:[404]'}), self.assertRaises(identity.ApplyIdentityError):
            identity.verify_self('c' * 64)

    def test_failure_hides_stderr(self):
        """Docker diagnostics may contain details not intended for the browser."""
        with patch.object(identity.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'fixture-secret')):
            with self.assertRaises(identity.ApplyIdentityError) as raised:
                identity.verify_self('c' * 64)
            self.assertNotIn('fixture-secret', str(raised.exception))

    def test_timeout(self):
        """A stalled Docker probe fails closed with a useful bounded diagnostic."""
        with patch.object(identity.subprocess, 'run', side_effect=subprocess.TimeoutExpired('docker', 5)), self.assertRaisesRegex(identity.ApplyIdentityError, 'timed out'):
            identity.verify_self('c' * 64)

    def test_invalid_json(self):
        """Unexpected probe output is not displayed as an error message."""
        with patch.object(identity.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'fixture-secret', '')):
            with self.assertRaises(identity.ApplyIdentityError) as raised:
                identity.verify_self('c' * 64)
            self.assertNotIn('fixture-secret', str(raised.exception))

    def test_invalid_container_id(self):
        """Refuse malformed identities before invoking Docker."""
        with patch.object(identity.subprocess, 'run') as run, self.assertRaises(identity.ApplyIdentityError):
            identity.verify_self('--flag')
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()

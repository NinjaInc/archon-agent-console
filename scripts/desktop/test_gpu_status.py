"""Tests for gpu-status.py: parsers over sample command output, and the HTTP surface over a stub collector.
Run with:  python3 -m unittest discover -s scripts/desktop -p "test_*.py"
Author: Josh Neufield (Archon Tech)
"""
import http.client
import importlib.util
import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("gpu_status", os.path.join(HERE, "gpu-status.py"))
gs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gs)

TYPEPERF = (
    '"(PDH-CSV 4.0)","\\\\PC\\GPU Process Memory(pid_1234_luid_0x00000000_0x0000A1B2_phys_0)\\Dedicated Usage",'
    '"\\\\PC\\GPU Process Memory(pid_5678_luid_0x00000000_0x0000A1B2_phys_0)\\Dedicated Usage",'
    '"\\\\PC\\GPU Process Memory(pid_1234_luid_0x00000000_0x0000A1B2_phys_1)\\Dedicated Usage"\n'
    '"11/21/2026 10:00:00.123","1073741824","268435456","1048576"\n\nThe command completed successfully.\n'
)
TASKLIST = '"ollama.exe","1234","Console","1","50,000 K"\n"eldenring.exe","5678","Console","1","3,000,000 K"\n"Steam.exe","99","Console","1","80,000 K"\n'


class ParserTests(unittest.TestCase):
    def test_nvidia_smi(self):
        parsed = gs.parse_nvidia_smi("NVIDIA GeForce RTX 3070, 12, 6340, 8192, 54\n")
        self.assertEqual(parsed, {"name": "NVIDIA GeForce RTX 3070", "utilization_percent": 12, "vram_used_mb": 6340, "vram_total_mb": 8192, "temperature_c": 54})
        self.assertIsNone(gs.parse_nvidia_smi(""))
        self.assertIsNone(gs.parse_nvidia_smi("garbage"))
        self.assertIsNone(gs.parse_nvidia_smi("a, [N/A], 1, 2, 3"))

    def test_tasklist_lowercases_names_and_ignores_noise(self):
        self.assertEqual(gs.parse_tasklist(TASKLIST), {1234: "ollama.exe", 5678: "eldenring.exe", 99: "steam.exe"})
        self.assertEqual(gs.parse_tasklist("INFO: No tasks are running"), {})

    def test_typeperf_sums_adapters_per_pid(self):
        self.assertEqual(gs.parse_typeperf_vram(TYPEPERF), {1234: 1073741824 + 1048576, 5678: 268435456})
        self.assertEqual(gs.parse_typeperf_vram("no counters here"), {})

    def test_non_ours_vram_excludes_the_ai_tools_and_never_exposes_pids(self):
        summary = gs.summarise_processes(gs.parse_typeperf_vram(TYPEPERF), gs.parse_tasklist(TASKLIST), {"ollama.exe"})
        self.assertEqual(summary["non_ours_vram_mb"], 256)  # only eldenring's 256 MB
        names = {p["name"] for p in summary["top_vram_processes"]}
        self.assertEqual(names, {"ollama.exe", "eldenring.exe"})
        self.assertNotIn("1234", json.dumps(summary))
        self.assertNotIn("pid", json.dumps(summary).lower())

    def test_a_launcher_alone_is_reported_separately_from_a_game(self):
        config = {"game_processes": ["EldenRing.exe"], "launcher_processes": ["steam.exe"]}
        self.assertEqual(gs.classify_processes({"steam.exe", "chrome.exe"}, config), {"games_running": [], "launchers_running": ["steam.exe"]})
        self.assertEqual(gs.classify_processes({"steam.exe", "eldenring.exe"}, config)["games_running"], ["eldenring.exe"])


class CollectTests(unittest.TestCase):
    def test_every_command_is_run_without_a_shell_and_failures_become_nulls_not_crashes(self):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append((argv, kwargs))
            raise OSError("not installed")

        with mock.patch.object(gs.subprocess, "run", fake_run):
            result = gs.collect(gs.DEFAULT_CONFIG)
        self.assertEqual({argv[0] for argv, _ in calls}, {"nvidia-smi", "tasklist", "typeperf"})
        self.assertTrue(all(isinstance(argv, list) and kwargs.get("shell") is False for argv, kwargs in calls))
        self.assertFalse(result["ok"])
        self.assertEqual(sorted(result["errors"]), ["nvidia-smi", "tasklist", "typeperf"])
        self.assertIsNone(result["gpu"])
        self.assertIsNone(result["non_ours_vram_mb"])


class BindTests(unittest.TestCase):
    def test_only_one_specific_private_address_is_accepted(self):
        self.assertEqual(gs.validate_bind("192.168.1.50"), "192.168.1.50")
        self.assertEqual(gs.validate_bind("127.0.0.1"), "127.0.0.1")
        for bad in ("0.0.0.0", "::", "", "my-pc", "8.8.8.8", "224.0.0.1"):
            with self.assertRaises(SystemExit, msg=bad):
                gs.validate_bind(bad)


class HttpTests(unittest.TestCase):
    def serve(self, allow, collector, now=None):
        handler = gs.make_handler(allow, collector, now or __import__("time").monotonic)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        return server.server_address[1]

    def request(self, port, method, path):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request(method, path)
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, dict(response.getheaders()), body

    def test_allowed_client_gets_status_and_health_and_nothing_is_cached_by_browsers(self):
        port = self.serve({"127.0.0.1"}, lambda: {"ok": True, "gpu": {"utilization_percent": 3}})
        status, headers, body = self.request(port, "GET", "/gpu?ignored=1")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["gpu"]["utilization_percent"], 3)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request(port, "GET", "/healthz")[0], 200)
        self.assertEqual(self.request(port, "GET", "/etc/passwd")[0], 404)
        self.assertEqual(self.request(port, "GET", "/gpu/../..")[0], 404)

    def test_a_client_not_on_the_allow_list_is_refused_everywhere(self):
        port = self.serve({"10.9.9.9"}, lambda: {"secret": "never"})
        for path in ("/gpu", "/healthz", "/anything"):
            status, _, body = self.request(port, "GET", path)
            self.assertEqual(status, 403)
            self.assertNotIn(b"secret", body)

    def test_no_method_but_get_does_anything(self):
        called = []
        port = self.serve({"127.0.0.1"}, lambda: called.append(1) or {"ok": True})
        for method in ("POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"):
            status, headers, _ = self.request(port, method, "/gpu")
            self.assertEqual(status, 405, method)
            self.assertEqual(headers.get("Allow"), "GET")
        self.assertEqual(called, [], "a refused method must never trigger a collection")

    def test_results_are_cached_for_two_seconds_so_a_busy_client_cannot_hammer_the_gpu_tools(self):
        clock = {"t": 100.0}
        calls = []
        port = self.serve({"127.0.0.1"}, lambda: calls.append(1) or {"n": len(calls)}, now=lambda: clock["t"])
        self.request(port, "GET", "/gpu")
        self.request(port, "GET", "/gpu")
        self.assertEqual(len(calls), 1)
        clock["t"] += 3
        self.request(port, "GET", "/gpu")
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()

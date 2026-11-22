#!/usr/bin/env python3
"""gpu-status - a tiny, read-only GPU status service for the desktop that shares its GPU with the dev server.
Author: Josh Neufield (Archon Tech)

It tells the Archon console whether the GPU is free, so nightly local-AI jobs never compete with a game.
Run it yourself on the desktop (Windows, Python 3.9+, standard library only, nvidia-smi from the NVIDIA driver):

    python gpu-status.py --bind <desktop-LAN-IP> --allow <dev-server-IP>

What it is, and what it is not:
  * Read-only. It answers GET /gpu and GET /healthz and nothing else (every other method is 405).
  * LAN only. It binds to ONE address you give it (never 0.0.0.0 or ::) and answers only the addresses in --allow.
  * No shell. It runs three fixed programs (nvidia-smi, typeperf, tasklist) with fixed argument lists. Nothing from a
    request ever reaches a command, a path or a file.
  * Minimal disclosure. It reports process *names* from your own config (games, launchers, the AI tools) and totals.
    No command lines, user names, window titles or file paths.

What it reports (JSON): GPU utilisation %, VRAM used/total, VRAM used by processes that are not on your "ours" list,
which listed games and launchers are running, and how long the user has been idle. The console decides what "busy"
means from those facts (a launcher alone does not count; a launcher with GPU activity does).

Config (gpu-status.json next to this file, or --config): see gpu-status.example.json.
"""
from __future__ import annotations

import argparse
import csv
import io
import ipaddress
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 9199
CACHE_SECONDS = 2.0
COMMAND_TIMEOUT = 12
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

DEFAULT_CONFIG = {
    "ours": ["ollama.exe", "ollama app.exe", "ollama_llama_server.exe", "llama-server.exe"],
    "ours_python_note": "ComfyUI runs under python.exe; add it to 'ours' only if nothing else on this PC uses Python on the GPU.",
    "game_processes": [],
    "launcher_processes": ["steam.exe", "steamwebhelper.exe", "epicgameslauncher.exe", "battle.net.exe", "galaxyclient.exe", "origin.exe", "eadesktop.exe", "upc.exe"],
}


# ---------------------------------------------------------------------------------------------------------------
# Parsers: pure functions over command output, so they can be tested without a GPU.
# ---------------------------------------------------------------------------------------------------------------

def parse_nvidia_smi(text: str) -> dict | None:
    """One line of: name, utilization.gpu, memory.used, memory.total, temperature.gpu (csv, no header, no units)."""
    for line in text.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            return {
                "name": parts[0][:80],
                "utilization_percent": int(float(parts[1])),
                "vram_used_mb": int(float(parts[2])),
                "vram_total_mb": int(float(parts[3])),
                "temperature_c": int(float(parts[4])),
            }
        except ValueError:
            continue
    return None


def parse_tasklist(text: str) -> dict[int, str]:
    """`tasklist /FO CSV /NH` -> {pid: lowercase image name}."""
    result: dict[int, str] = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) >= 2 and row[1].strip().isdigit():
            result[int(row[1])] = row[0].strip().lower()
    return result


_PID = re.compile(r"pid_(\d+)_", re.IGNORECASE)


def parse_typeperf_vram(text: str) -> dict[int, int]:
    """`typeperf "\\GPU Process Memory(*)\\Dedicated Usage" -sc 1` -> {pid: bytes}. Several adapters add up per pid."""
    rows = list(csv.reader(io.StringIO(text)))
    header = next((r for r in rows if r and any("GPU Process Memory" in c for c in r)), None)
    if header is None:
        return {}
    values = rows[rows.index(header) + 1] if rows.index(header) + 1 < len(rows) else []
    out: dict[int, int] = {}
    for column, cell in zip(header, values):
        match = _PID.search(column)
        if not match:
            continue
        try:
            out[int(match.group(1))] = out.get(int(match.group(1)), 0) + int(float(cell))
        except ValueError:
            continue
    return out


def summarise_processes(vram_by_pid: dict[int, int], names_by_pid: dict[int, str], ours: set[str]) -> dict:
    """Totals by image name. Process ids never leave this function."""
    by_name: dict[str, int] = {}
    for pid, used in vram_by_pid.items():
        name = names_by_pid.get(pid, "unknown")
        by_name[name] = by_name.get(name, 0) + used
    top = sorted(by_name.items(), key=lambda item: item[1], reverse=True)[:8]
    others = sum(used for name, used in by_name.items() if name not in ours)
    return {
        "non_ours_vram_mb": round(others / 1_048_576),
        "top_vram_processes": [{"name": name, "vram_mb": round(used / 1_048_576)} for name, used in top if used > 0],
    }


def classify_processes(running: set[str], config: dict) -> dict:
    games = {n.lower() for n in config.get("game_processes", [])}
    launchers = {n.lower() for n in config.get("launcher_processes", [])}
    return {
        "games_running": sorted(running & games),
        "launchers_running": sorted(running & launchers),
    }


# ---------------------------------------------------------------------------------------------------------------
# Collection: fixed commands, argument lists only, every failure becomes a field-level null plus a short error code.
# ---------------------------------------------------------------------------------------------------------------

def _run(argv: list[str]) -> str | None:
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=COMMAND_TIMEOUT, creationflags=NO_WINDOW, check=False, shell=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def user_idle_seconds() -> int | None:
    """Seconds since the last keyboard or mouse input in this session (Windows only)."""
    if os.name != "nt":
        return None
    try:
        import ctypes

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):  # type: ignore[attr-defined]
            return None
        return max(0, int((ctypes.windll.kernel32.GetTickCount() - info.dwTime) / 1000))  # type: ignore[attr-defined]
    except Exception:
        return None


def collect(config: dict) -> dict:
    errors: list[str] = []
    gpu = None
    smi = _run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"])
    if smi is not None:
        gpu = parse_nvidia_smi(smi)
    if gpu is None:
        errors.append("nvidia-smi")

    tasks = _run(["tasklist", "/FO", "CSV", "/NH"])
    names = parse_tasklist(tasks) if tasks is not None else {}
    if tasks is None:
        errors.append("tasklist")

    perf = _run(["typeperf", r"\GPU Process Memory(*)\Dedicated Usage", "-sc", "1"])
    vram = parse_typeperf_vram(perf) if perf is not None else {}
    if perf is None:
        errors.append("typeperf")

    ours = {n.lower() for n in config.get("ours", [])}
    result = {
        "ok": not errors,
        "errors": errors,
        "sampled_at": int(time.time()),
        "gpu": gpu,
        "user_idle_seconds": user_idle_seconds(),
        **classify_processes(set(names.values()), config),
    }
    result.update(summarise_processes(vram, names, ours) if perf is not None else {"non_ours_vram_mb": None, "top_vram_processes": []})
    return result


# ---------------------------------------------------------------------------------------------------------------
# HTTP: read-only, one address, an allow list, and a two-second cache so a busy client cannot hammer the GPU tools.
# ---------------------------------------------------------------------------------------------------------------

def make_handler(allow: set[str], collector, now=time.monotonic):
    cache = {"at": -1e9, "body": b""}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "gpu-status"
        sys_version = ""

        def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _refuse_method(self) -> None:
            self.send_response(405)
            self.send_header("Allow", "GET")
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = _refuse_method

        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            if self.client_address[0] not in allow:
                self._send(403, b'{"error":"forbidden"}')
                return
            path = self.path.split("?", 1)[0]
            if path == "/healthz":
                self._send(200, b'{"ok":true}')
            elif path == "/gpu":
                with lock:
                    if now() - cache["at"] > CACHE_SECONDS:
                        cache["body"] = json.dumps(collector()).encode()
                        cache["at"] = now()
                    body = cache["body"]
                self._send(200, body)
            else:
                self._send(404, b'{"error":"not found"}')

        def log_message(self, fmt: str, *args) -> None:  # one line per request, path only, no query string
            sys.stdout.write("%s %s\n" % (self.client_address[0], (fmt % args).split("?")[0]))

    return Handler


def validate_bind(host: str) -> str:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as error:
        raise SystemExit(f"--bind must be one IP address, not a name: {host}") from error
    if address.is_unspecified or address.is_multicast:
        raise SystemExit("--bind must be a specific LAN address, never 0.0.0.0 or ::")
    if not (address.is_private or address.is_loopback):
        raise SystemExit("--bind must be a private LAN or loopback address")
    return str(address)


def load_config(path: str | None) -> dict:
    config = dict(DEFAULT_CONFIG)
    candidate = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "gpu-status.json")
    if os.path.exists(candidate):
        with open(candidate, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        for key in ("ours", "game_processes", "launcher_processes"):
            if isinstance(loaded.get(key), list):
                config[key] = [str(item) for item in loaded[key]]
    return config


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Read-only GPU status for the Archon console.")
    parser.add_argument("--bind", required=True, help="this PC's LAN IP address (one address, never 0.0.0.0)")
    parser.add_argument("--allow", required=True, action="append", help="IP address allowed to ask (the dev server); repeat for more")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--config", help="path to gpu-status.json")
    args = parser.parse_args(argv)

    bind = validate_bind(args.bind)
    allow = {str(ipaddress.ip_address(item)) for item in args.allow}
    config = load_config(args.config)
    server = ThreadingHTTPServer((bind, args.port), make_handler(allow, lambda: collect(config)))
    print(f"gpu-status listening on http://{bind}:{args.port}/gpu for {', '.join(sorted(allow))} only (read-only).")
    print("If Windows Firewall asks, or to restrict it properly, run this once in an administrator PowerShell:")
    print(f'  New-NetFirewallRule -DisplayName "gpu-status" -Direction Inbound -Protocol TCP -LocalPort {args.port} -LocalAddress {bind} -RemoteAddress {",".join(sorted(allow))} -Action Allow')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()

# Desktop GPU status (`gpu-status.py`)

A small, read-only service you run on the **desktop that shares its GPU** (Ollama, ComfyUI and games). The Archon console asks it
whether the GPU is free, so background local-AI work never competes with a game. A running game always wins.

It is Python standard library only, runs three fixed programs (`nvidia-smi`, `typeperf`, `tasklist`) with fixed arguments, answers
only `GET /gpu` and `GET /healthz`, binds to **one** LAN address you choose, and answers **only** the addresses you allow. It
reports process names from your own config and totals, never command lines, user names or paths.

## Run it (Windows)

1. Install Python 3.9 or newer (tick *Add python.exe to PATH*). `nvidia-smi` comes with the NVIDIA driver.
2. Copy `gpu-status.py` to a folder on the desktop. Optionally copy `gpu-status.example.json` next to it as `gpu-status.json` and list
   the games you care about (`game_processes`). Launchers (Steam, Epic, Battle.net) only count when the GPU is also busy.
3. In PowerShell, in that folder:

   ```powershell
   python gpu-status.py --bind <desktop-LAN-IP> --allow <dev-server-IP>
   ```

4. It prints a firewall command. Run it once in an **administrator** PowerShell so only the dev server can reach the port:

   ```powershell
   New-NetFirewallRule -DisplayName "gpu-status" -Direction Inbound -Protocol TCP -LocalPort 9199 -LocalAddress <desktop-LAN-IP> -RemoteAddress <dev-server-IP> -Action Allow
   ```

5. From the dev server, check it:

   ```bash
   curl -s http://<desktop-LAN-IP>:9199/gpu
   ```

To start it automatically, create a Task Scheduler task that runs `python gpu-status.py --bind ... --allow ...` **At log on** for your own
user. It must run in your desktop session, not as a service, so it can read how long you have been idle.

## What you get back

`gpu` (name, utilisation %, VRAM used and total, temperature), `non_ours_vram_mb` (VRAM used by anything not on the `ours` list, so a game
left open at its menu still counts), `games_running`, `launchers_running`, `top_vram_processes` (names and MB only) and `user_idle_seconds`.
If a source fails, that field is `null` and `errors` names it; the console treats an unreachable or failing service as "busy" for unattended
jobs.

## ComfyUI

ComfyUI usually shows up as `python.exe`, so it is on the example `ours` list; otherwise its VRAM would count as "something else". If you
run other Python GPU work on the desktop, it will count as ours too.

On the console, set `GPU_STATUS_URL=http://<desktop>:9199/gpu` and `COMFYUI_BASE_URL=http://<desktop>:8188` (private addresses only).

## Tests

```bash
python3 -m unittest discover -s scripts/desktop -p "test_*.py"
```

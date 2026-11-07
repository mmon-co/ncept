"""Public pi RPC encounter driver; Python 3 standard library, no model replaced by default.
Run from the repository root:
  python3 packages/pi/scripts/drive-first-use.py /absolute/profile '/missions'
MMON_MODEL=release-scripted/tutor selects the checked no-paid transport provider.
MMON_SESSION=<absolute-jsonl> resumes exactly that transcript; MMON_CONTINUE=1 resumes latest.
MMON_RECORD captures live model requests with record-first-use.ts; MMON_EVENTS captures RPC.
Confirmations are automatically accepted: use only your disposable encounter Profile/account.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
profile = Path(sys.argv[1]).resolve()
env = dict(os.environ)
env.pop("PI_CODING_AGENT_SESSION_DIR", None)
command = ["pi", "--mode", "rpc", "--approve", "--offline", "--no-mcp",
           "--model", env.get("MMON_MODEL", "openrouter/openai/gpt-6-luna"), "--thinking", "low"]
if env.get("MMON_MODEL") == "release-scripted/tutor":
    command += ["-e", str(root / "packages/pi/scripts/encounter-provider.ts")]
if env.get("MMON_SESSION"):
    command += ["--session", env["MMON_SESSION"]]
elif env.get("MMON_CONTINUE"):
    command += ["--continue"]
if env.get("MMON_RECORD"):
    command += ["-e", str(root / "packages/pi/scripts/record-first-use.ts")]
process = subprocess.Popen(command, cwd=profile, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
events = open(env["MMON_EVENTS"], "a") if env.get("MMON_EVENTS") else None

def send(value):
    process.stdin.write((json.dumps(value) + "\n").encode())
    process.stdin.flush()

def receive():
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("pi exited " + str(process.poll()))
    if events:
        events.write(line.decode())
        events.flush()
    event = json.loads(line)
    kind = event.get("type")
    if kind == "extension_ui_request":
        method = event["method"]
        if method == "confirm":
            print(json.dumps(event), flush=True)
            send({"type": "extension_ui_response", "id": event["id"], "confirmed": True})
        elif method in ("input", "select", "editor"):
            raise RuntimeError("Needs a human choice: " + json.dumps(event))
        elif method in ("notify", "setWidget", "setStatus"):
            print(json.dumps(event), flush=True)
    if kind == "extension_error":
        raise RuntimeError(event)
    if kind in ("tool_execution_end", "response") or (
        kind == "message_end" and event.get("message", {}).get("role") == "assistant"
    ):
        print(json.dumps(event), flush=True)
    return event

try:
    send({"id": "ready", "type": "get_state"})
    while receive().get("id") != "ready":
        pass
    for index, turn in enumerate(sys.argv[2:]):
        identity = "turn-" + str(index)
        send({"id": identity, "type": "prompt", "message": turn})
        switching = False
        while True:
            event = receive()
            if event.get("type") == "response" and event.get("id") == identity:
                if not event.get("success"):
                    raise RuntimeError(event)
                if event.get("data", {}).get("disposition") == "handled" and not turn.startswith(("/learn ", "/author ")):
                    break
            if event.get("type") == "tool_execution_end" and event.get("result", {}).get("details", {}).get("switch"):
                switching = True
            if event.get("type") == "agent_settled":
                if switching:
                    switching = False
                    continue
                break
finally:
    process.stdin.close()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=10)
    if events:
        events.close()

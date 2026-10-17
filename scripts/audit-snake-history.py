#!/usr/bin/env python3
"""Audit selected local Snake histories without credentials, network calls or DB writes.

Only game fields are passed to the adjacent TypeScript auditor through stdin.
Historical diagnostics are explicitly excluded from harness experiment scoring.
"""

import argparse
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SESSIONS = [
    "arcade-0cf0bec0-304a-4c4b-9dbb-c10ab1b29456",
    "arcade-4a870cf4-3441-4e97-9763-da85d4eaf80d",
    "arcade-ca59827d-8311-4f70-9752-895f605373d8",
    "arcade-57a9f2c1-7e34-40b8-8694-c588fc8a7d0a",
]
KNOWN_MODELS = {"typesafe/jev-1.13", "typesafe/jev-1.14", "startlux-decision-27b-autothink"}
KNOWN_PROVIDERS = {"openrouter", "systemone", "custom-systemone", "bamboonode-systemone", "bamboonode-decisions"}


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-id", action="append", dest="sessions", help="Repeat to select exact game session IDs; defaults to the four documented natural-death samples.")
    parser.add_argument("--tail", type=int, default=6, help="Decision rows per run in output, 1..20 (default 6); full histories stay in memory.")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts/snake-history-audit", help="Directory for redacted audit.json and audit.md; never an experiment score file.")
    args = parser.parse_args()
    args.sessions = list(dict.fromkeys(args.sessions or DEFAULT_SESSIONS))
    if not 1 <= args.tail <= 20 or len(args.sessions) > 50:
        parser.error("Use tail 1..20 and at most 50 explicit session IDs.")
    if any(not re.fullmatch(r"arcade-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value) for value in args.sessions):
        parser.error("Each session ID must be an arcade UUID, not a path or authentication token.")
    return args


def game_fields(connection):
    """Explicit field whitelist: never SELECT a complete record, profile or event."""
    row = connection.execute("""
      SELECT json_extract(value,'$.seed'), json_extract(value,'$.input.config'),
             json_extract(value,'$.anchorWall'), json_extract(value,'$.anchorTick'),
             json_extract(value,'$.result.aborted')
      FROM arcade_meta WHERE id=1
    """).fetchone()
    seed, config, anchor_wall, anchor_tick, aborted = row
    fields = ["gameId", "tick", "status", "score", "held", "releaseTick", "body", "direction", "queued", "food", "rng", "reason"]
    expression = ",".join("'%s',json_extract(j.value,'$.state.%s')" % (field, field) for field in fields)
    final = [json.loads(row[0]) for row in connection.execute(
        "SELECT json_object(" + expression + ") FROM arcade_meta m,json_each(m.value,'$.runs') j ORDER BY j.key"
    )]
    fields = ["seq", "type", "tick", "at", "runId", "requestId", "observedTick", "appliedTick", "actionId", "outcome", "input", "release", "promptVersion"]
    expression = ",".join("'%s',json_extract(value,'$.%s')" % (field, field) for field in fields)
    expression += ",'elapsedMs',json_extract(value,'$.metrics.elapsedMs')"
    expression += ",'phase',CASE WHEN json_extract(value,'$.type')='status' AND json_extract(value,'$.message') IN ('start','resume','retry') THEN json_extract(value,'$.message') ELSE NULL END"
    events = [json.loads(row[0]) for row in connection.execute("SELECT json_object(" + expression + ") FROM arcade_events ORDER BY seq")]
    frames = [json.loads(row[0]) for row in connection.execute("SELECT json_object('tick',tick,'views',json_extract(value,'$.views')) FROM arcade_frames ORDER BY tick")]
    return {"seed": seed, "config": json.loads(config or "{}"), "final": final, "events": events, "frames": frames,
            "anchorWall": anchor_wall, "anchorTick": anchor_tick, "aborted": bool(aborted)}


def selected_histories(ids):
    selected = {}
    # The root is derived from this checked-in script, never from an arbitrary DB path.
    for directory in [ROOT / ".wrangler/state/v3/do", ROOT / ".wrangler/cloudflare-dev/state/v3/do"]:
        if not directory.resolve().is_relative_to(ROOT):
            raise ValueError("Refusing a state-directory symlink outside this project.")
        for path in directory.glob("*ArcadeSessionObject/*.sqlite"):
            if path.name == "metadata.sqlite":
                continue
            if not path.resolve().is_relative_to(ROOT):
                raise ValueError("Refusing a database symlink outside this project.")
            connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            try:
                connection.execute("PRAGMA query_only=ON")
                connection.execute("BEGIN")  # Consistent read snapshot; no mutation is possible.
                if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='arcade_meta'").fetchone():
                    continue
                row = connection.execute("""
                  SELECT json_extract(value,'$.id'), json_extract(value,'$.status'),
                         json_extract(value,'$.rulesVersion'), json_extract(value,'$.promptVersion'),
                         json_extract(value,'$.tick')
                  FROM arcade_meta WHERE id=1 AND json_extract(value,'$.input.gameId')='snake'
                """).fetchone()
                if not row or row[0] not in ids:
                    continue
                session_id, status, rules, prompt, tick = row
                if session_id in selected:
                    raise ValueError("A selected session appears in more than one local runtime; resolve the duplicate first.")
                if status != "finished" or rules != "snake-realtime-v2":
                    raise ValueError("Selected histories must be finished Snake v2 sessions; legacy v1 is never replayed with v2 rules.")
                runs = []
                for run in connection.execute("""
                  SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.controller.kind'),
                         json_extract(j.value,'$.controller.profile.provider'),json_extract(j.value,'$.controller.profile.model'),
                         json_extract(j.value,'$.calls')
                  FROM arcade_meta m,json_each(m.value,'$.runs') j ORDER BY j.key
                """):
                    run_id, kind, provider, model, calls = run
                    if not re.fullmatch(r"run-[01]", run_id):
                        raise ValueError("Unexpected run identifier in selected history.")
                    runs.append({"id": run_id, "kind": kind if kind in ("ai", "human") else "unknown",
                                 "provider": provider if provider in KNOWN_PROVIDERS else "other-provider",
                                 "model": model if model in KNOWN_MODELS else None, "calls": calls})
                meta = {"sessionId": session_id, "status": status, "rules": rules,
                        "prompt": prompt if isinstance(prompt, str) and re.fullmatch(r"decision-arena-arcade-v\d+", prompt) else None,
                        "tick": tick, "runs": runs}
                selected[session_id] = {"meta": meta, **game_fields(connection)}
            finally:
                connection.close()
    missing = [session_id for session_id in ids if session_id not in selected]
    if missing:
        raise ValueError("Selected local game histories were not found: " + ", ".join(missing) + ". A fresh clone contains no private histories; nothing was fetched.")
    return [selected[session_id] for session_id in ids]


def main():
    args = arguments()
    if json.loads((ROOT / "package.json").read_text())["name"] != "decision-arena":
        raise ValueError("Run the checked-in Decision Arena audit script from its own project.")
    data = selected_histories(args.sessions)
    output = args.output_dir.resolve()
    # All seed/state/frame data remains on this pipe and in process memory.
    result = subprocess.run(["node", "--import", "tsx", str(ROOT / "scripts/audit-snake-history.ts"),
                             "--output-dir", str(output), "--tail", str(args.tail)],
                            cwd=ROOT, input=json.dumps(data), text=True, check=False)
    return result.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ValueError as error:
        print("Historical audit stopped: " + str(error), file=sys.stderr)
        sys.exit(2)
    except (OSError, sqlite3.Error, KeyError, TypeError, json.JSONDecodeError):
        # Do not dump database rows, SQL bindings or in-memory replay data on failure.
        print("Historical audit stopped: local data or runtime could not be read safely.", file=sys.stderr)
        sys.exit(2)

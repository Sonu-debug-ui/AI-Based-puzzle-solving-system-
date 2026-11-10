"""Puzzle API for the AI-Based Puzzle Solving System MVP.

The API accepts puzzle state only. Image capture and preview stay in the browser.
The Sudoku solver is deterministic and deliberately independent of any LLM.
"""

from __future__ import annotations

from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from itertools import combinations
import json
import os
from pathlib import Path
import sqlite3
from threading import Lock
from time import monotonic, perf_counter
from typing import Annotated, Union
from uuid import UUID, uuid4

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import Field
from server.chess_engine import analyze as analyze_chess, is_reachable_by_legal_move, parse_fen
from server.explainer import explain_deduction
from server.schemas import (
    ChessAnalysisRequest, KenKenHint, KenKenState, KillerSudokuHint, KillerSudokuState,
    HintFeedbackRequest, HistoryRecordRequest, LogicGridHint, LogicGridState, LogicParseRequest,
    NonogramHint, NonogramState, RecognitionTelemetryRequest, SudokuHint, SudokuState,
)
from server.logic_grid import forced_assignments, solve_logic_grid, verify_logic_assignment
from server.logic_parser import parse_logic_clues
from server.llm_metrics import llm_metrics_snapshot
from server.variants import Cage, solve_killer_sudoku, solve_latin_cage_grid, solve_nonogram, solution_status


ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
HISTORY_DB = ROOT / ".data" / "history.sqlite3"
SYMBOLS = set("123456789")
CELLS = range(81)


SolveRequest = Annotated[Union[SudokuState, KenKenState, KillerSudokuState, NonogramState, LogicGridState], Field(discriminator="type")]
HintRequest = Annotated[Union[SudokuHint, KenKenHint, KillerSudokuHint, NonogramHint, LogicGridHint], Field(discriminator="type")]


def groups() -> list[list[int]]:
    rows = [[r * 9 + c for c in range(9)] for r in range(9)]
    cols = [[r * 9 + c for r in range(9)] for c in range(9)]
    boxes = [[(br + dr) * 9 + bc + dc for dr in range(3) for dc in range(3)]
             for br in (0, 3, 6) for bc in (0, 3, 6)]
    return rows + cols + boxes


GROUPS = groups()
CELL_GROUPS: dict[int, list[list[int]]] = {
    i: [g for g in GROUPS if i in g] for i in CELLS
}
CELL_PEERS: dict[int, set[int]] = {
    i: set().union(*CELL_GROUPS[i]) - {i} for i in CELLS
}


def conflicts(board: str) -> list[int]:
    bad: set[int] = set()
    for group in GROUPS:
        seen: dict[str, int] = {}
        for index in group:
            value = board[index]
            if value == "0":
                continue
            if value in seen:
                bad.add(index)
                bad.add(seen[value])
            else:
                seen[value] = index
    return sorted(bad)


def candidates(board: str, index: int) -> set[str]:
    used = {board[i] for group in CELL_GROUPS[index] for i in group if board[i] != "0"}
    return SYMBOLS - used


@dataclass
class SudokuSearchOutcome:
    solutions: list[str]
    timed_out: bool = False
    nodes: int = 0


def search_outcome(board: str, limit: int = 2, *, time_limit_seconds: float = 3.0,
                   max_nodes: int = 200_000) -> SudokuSearchOutcome:
    """Return up to `limit` solutions using MRV, with an explicit search budget."""
    if conflicts(board):
        return SudokuSearchOutcome([])
    found: list[str] = []
    started = monotonic()
    nodes = 0
    timed_out = False

    def visit(state: list[str]) -> None:
        nonlocal nodes, timed_out
        if len(found) >= limit or timed_out:
            return
        nodes += 1
        if nodes > max_nodes or monotonic() - started > time_limit_seconds:
            timed_out = True
            return
        best_index = -1
        best_values: set[str] | None = None
        for index, value in enumerate(state):
            if value != "0":
                continue
            options = candidates("".join(state), index)
            if not options:
                return
            if best_values is None or len(options) < len(best_values):
                best_index, best_values = index, options
                if len(options) == 1:
                    break
        if best_index == -1:
            found.append("".join(state))
            return
        for value in sorted(best_values or ()):
            state[best_index] = value
            visit(state)
            state[best_index] = "0"
            if len(found) >= limit:
                return

    visit(list(board))
    return SudokuSearchOutcome(found, timed_out, nodes)


def search(board: str, limit: int = 2) -> list[str]:
    """Compatibility helper for tests and callers that only need solution values."""
    return search_outcome(board, limit).solutions


def unique_solution(board: str) -> dict:
    bad = conflicts(board)
    if bad:
        return {"status": "invalid", "reason": "Two matching digits share a row, column, or box.", "conflicting_cells": bad}
    outcome = search_outcome(board, 2)
    if outcome.timed_out:
        return {"status": "too_hard", "message": "This Sudoku took too long to finish. Check its clues or try again with a simpler grid."}
    solutions = outcome.solutions
    if not solutions:
        return {"status": "invalid", "reason": "These clues cannot all be true at once.", "conflicting_cells": []}
    return {
        "status": "solved" if len(solutions) == 1 else "multiple",
        "solutions_found": len(solutions),
        "solution": solutions[0] if len(solutions) == 1 else None,
        "solutions": solutions,
    }


def cell_name(index: int) -> str:
    return f"row {index // 9 + 1}, column {index % 9 + 1}"


def _group_name(index: int) -> str:
    if index < 9:
        return f"row {index + 1}"
    if index < 18:
        return f"column {index - 8}"
    return f"box {index - 17}"


def _eliminations(options: dict[int, set[str]], cells: list[int], values: set[str]) -> list[dict]:
    return [{"cell": index, "candidates": sorted(options[index] & values)}
            for index in cells if index in options and options[index] & values]


def _hidden_pair_step(options: dict[int, set[str]]) -> dict | None:
    for group in GROUPS:
        locations = {digit: [index for index in group if index in options and digit in options[index]]
                     for digit in "123456789"}
        for left_index, left in enumerate("123456789"):
            if len(locations[left]) < 2:
                continue
            for right in "123456789"[left_index + 1:]:
                if len(locations[right]) < 2:
                    continue
                cells = sorted(set(locations[left]) | set(locations[right]))
                pair = {left, right}
                if len(cells) == 2 and any(options[index] - pair for index in cells):
                    return {"technique": "Hidden pair", "cells": cells,
                            "candidates": [left, right], "value": None,
                            "eliminations": [{"cell": index, "candidates": sorted(options[index] - pair)}
                                             for index in cells if options[index] - pair],
                            "explanation": f"Digits {left} and {right} can fit in only these two cells in the same row, column, or box. Remove other candidates from both cells."}
    return None


def _xy_wing_step(options: dict[int, set[str]]) -> dict | None:
    bivalue_cells = [i for i in sorted(options.keys()) if len(options[i]) == 2]
    for pivot in bivalue_cells:
        a, b = sorted(options[pivot])
        pivot_peers = [peer for peer in bivalue_cells if peer in CELL_PEERS[pivot]]
        for q in pivot_peers:
            q_opts = options[q]
            if a in q_opts and b not in q_opts:
                c = next(iter(q_opts - {a}))
                for r in pivot_peers:
                    if r != q and options[r] == {b, c}:
                        common_peers = sorted(s for s in (CELL_PEERS[q] & CELL_PEERS[r])
                                              if s != pivot and s in options and c in options[s])
                        if common_peers:
                            cells = sorted({pivot, q, r} | set(common_peers))
                            return {
                                "technique": "XY-wing",
                                "cells": cells,
                                "candidates": [c],
                                "value": None,
                                "eliminations": _eliminations(options, common_peers, {c}),
                                "explanation": f"Cell {cell_name(pivot)} ({a}, {b}) acts as a pivot with pincers {cell_name(q)} ({a}, {c}) and {cell_name(r)} ({b}, {c}). Remove candidate {c} from open cells that see both pincers.",
                            }
    return None


def _swordfish_step(options: dict[int, set[str]]) -> dict | None:
    for digit in sorted(SYMBOLS):
        for orientation in ("row", "column"):
            base_units = GROUPS[:9] if orientation == "row" else GROUPS[9:18]
            positions_by_unit: list[tuple[int, ...] | None] = []
            for unit in base_units:
                positions = tuple(sorted((index % 9 if orientation == "row" else index // 9)
                                         for index in unit if index in options and digit in options[index]))
                positions_by_unit.append(positions if 2 <= len(positions) <= 3 else None)
            eligible_units = [u for u, pos in enumerate(positions_by_unit) if pos is not None]
            for u1, u2, u3 in combinations(eligible_units, 3):
                cross_positions = tuple(sorted(set(positions_by_unit[u1]) | set(positions_by_unit[u2]) | set(positions_by_unit[u3])))
                if len(cross_positions) != 3:
                    continue
                pattern_cells = [
                    (u * 9 + c if orientation == "row" else c * 9 + u)
                    for u in (u1, u2, u3) for c in positions_by_unit[u]
                ]
                pattern_set = set(pattern_cells)
                removed_from = []
                for other_u, unit in enumerate(base_units):
                    if other_u in (u1, u2, u3):
                        continue
                    for cross_c in cross_positions:
                        cell = other_u * 9 + cross_c if orientation == "row" else cross_c * 9 + other_u
                        if cell in options and digit in options[cell]:
                            removed_from.append(cell)
                if removed_from:
                    cells = sorted(pattern_set | set(removed_from))
                    c1, c2, c3 = (c + 1 for c in cross_positions)
                    if orientation == "row":
                        detail = f"Rows {u1 + 1}, {u2 + 1}, and {u3 + 1} each have candidate {digit} confined to columns {c1}, {c2}, and {c3}"
                        action = f"Remove {digit} from the other open cells in those columns."
                    else:
                        detail = f"Columns {u1 + 1}, {u2 + 1}, and {u3 + 1} each have candidate {digit} confined to rows {c1}, {c2}, and {c3}"
                        action = f"Remove {digit} from the other open cells in those rows."
                    return {
                        "technique": "Swordfish",
                        "cells": cells,
                        "candidates": [digit],
                        "value": None,
                        "eliminations": _eliminations(options, removed_from, {digit}),
                        "explanation": f"{detail}. {action}",
                    }
    return None


def find_logical_step(board: str, candidate_options: dict[int, set[str]] | None = None,
                      *, prefer_easy: bool = False) -> dict | None:
    """Return the simplest supported placement or candidate elimination for a board."""
    opts = candidate_options if candidate_options is not None else {
        i: candidates(board, i) for i in CELLS if board[i] == "0"
    }
    # Naked singles.
    for index, values in opts.items():
        if len(values) == 1:
            value = next(iter(values))
            return {"technique": "Naked single", "cells": [index], "value": value,
                    "candidates": [value], "explanation": f"{value} is the only candidate for {cell_name(index)}."}
    # Hidden singles.
    for group_index, group in enumerate(GROUPS):
        for value in sorted(SYMBOLS):
            matches = [i for i in group if i in opts and value in opts[i]]
            if len(matches) == 1:
                index = matches[0]
                group_label = _group_name(group_index)
                return {"technique": "Hidden single", "cells": [index], "value": value,
                        "candidates": sorted(opts[index]),
                        "explanation": f"{value} can go in only one open cell in {group_label}: {cell_name(index)}."}

    if not prefer_easy:
        hidden_pair = _hidden_pair_step(opts)
        if hidden_pair:
            return hidden_pair

    # Locked candidates: pointing pairs/triples within a box.
    for box_index, box in enumerate(GROUPS[18:]):
        box_set = set(box)
        for value in sorted(SYMBOLS):
            positions = [index for index in box if index in opts and value in opts[index]]
            if len(positions) not in (2, 3):
                continue
            rows = {index // 9 for index in positions}
            if len(rows) == 1:
                row = next(iter(rows))
                removed_from = [index for index in GROUPS[row]
                                if index not in box_set and index in opts and value in opts[index]]
                if removed_from:
                    cells = sorted(set(positions + removed_from))
                    label = "Pointing pair" if len(positions) == 2 else "Pointing triple"
                    return {"technique": label, "cells": cells, "value": None, "candidates": [value],
                            "eliminations": _eliminations(opts, removed_from, {value}),
                            "explanation": f"In box {box_index + 1}, every possible {value} is in row {row + 1}. Remove {value} from the other open cells in that row."}
            columns = {index % 9 for index in positions}
            if len(columns) == 1:
                column = next(iter(columns))
                removed_from = [index for index in GROUPS[9 + column]
                                if index not in box_set and index in opts and value in opts[index]]
                if removed_from:
                    cells = sorted(set(positions + removed_from))
                    label = "Pointing pair" if len(positions) == 2 else "Pointing triple"
                    return {"technique": label, "cells": cells, "value": None, "candidates": [value],
                            "eliminations": _eliminations(opts, removed_from, {value}),
                            "explanation": f"In box {box_index + 1}, every possible {value} is in column {column + 1}. Remove {value} from the other open cells in that column."}

    # Locked candidates: claiming pairs/triples within a row or column.
    for group_index, group in enumerate(GROUPS[:18]):
        for value in sorted(SYMBOLS):
            positions = [index for index in group if index in opts and value in opts[index]]
            if len(positions) not in (2, 3):
                continue
            boxes = {((index // 9) // 3) * 3 + (index % 9) // 3 for index in positions}
            if len(boxes) != 1:
                continue
            box_index = next(iter(boxes))
            box = GROUPS[18 + box_index]
            removed_from = [index for index in box if index not in positions and index in opts and value in opts[index]]
            if removed_from:
                cells = sorted(set(positions + removed_from))
                label = "Claiming pair" if len(positions) == 2 else "Claiming triple"
                return {"technique": label, "cells": cells, "value": None, "candidates": [value],
                        "eliminations": _eliminations(opts, removed_from, {value}),
                        "explanation": f"Every possible {value} in {_group_name(group_index)} is inside box {box_index + 1}. Remove {value} from the other open cells in that box."}

    # Naked pairs.
    for group in GROUPS:
        pairs: dict[tuple[str, str], list[int]] = defaultdict(list)
        for index in group:
            if index in opts and len(opts[index]) == 2:
                pairs[tuple(sorted(opts[index]))].append(index)
        for pair, cells in pairs.items():
            if len(cells) == 2:
                peers = [index for index in group if index not in cells and index in opts and opts[index].intersection(pair)]
                if peers:
                    return {"technique": "Naked pair", "cells": cells,
                            "candidates": list(pair), "value": None,
                            "eliminations": _eliminations(opts, peers, set(pair)),
                            "explanation": f"These two cells in the same row, column, or box must contain {pair[0]} and {pair[1]}. Remove them from the other open cells in that group."}

    if prefer_easy:
        hidden_pair = _hidden_pair_step(opts)
        if hidden_pair:
            return hidden_pair

    # Naked triples.
    for group in GROUPS:
        eligible = [index for index in group if index in opts and 2 <= len(opts[index]) <= 3]
        for cells_tuple in combinations(eligible, 3):
            cells = list(cells_tuple)
            triple = set().union(*(opts[index] for index in cells))
            if len(triple) != 3:
                continue
            peers = [index for index in group if index not in cells and index in opts and opts[index] & triple]
            if peers:
                return {"technique": "Naked triple", "cells": cells, "candidates": sorted(triple), "value": None,
                        "eliminations": _eliminations(opts, peers, triple),
                        "explanation": f"These three cells in the same row, column, or box must contain {', '.join(sorted(triple))}. Remove those candidates from the other open cells in that group."}

    # Hidden triples.
    for group in GROUPS:
        for triple_tuple in combinations("123456789", 3):
            triple = set(triple_tuple)
            locations = {digit: [index for index in group if index in opts and digit in opts[index]]
                         for digit in triple}
            if any(not indices for indices in locations.values()):
                continue
            cells = sorted({index for digit in triple for index in group if index in opts and digit in opts[index]})
            if len(cells) == 3 and any(opts[index] - triple for index in cells):
                return {"technique": "Hidden triple", "cells": cells, "candidates": sorted(triple), "value": None,
                        "eliminations": [{"cell": index, "candidates": sorted(opts[index] - triple)}
                                         for index in cells if opts[index] - triple],
                        "explanation": f"Digits {', '.join(sorted(triple))} can fit in only these three cells in the same row, column, or box. Remove other candidates from those cells."}

    # X-wing in rows and columns.
    for digit in sorted(SYMBOLS):
        for orientation in ("row", "column"):
            base_units = GROUPS[:9] if orientation == "row" else GROUPS[9:18]
            positions_by_unit: list[tuple[int, ...] | None] = []
            for unit in base_units:
                positions = tuple(sorted((index % 9 if orientation == "row" else index // 9)
                                         for index in unit if index in opts and digit in opts[index]))
                positions_by_unit.append(positions if len(positions) == 2 else None)
            patterns: dict[tuple[int, int], list[int]] = defaultdict(list)
            for unit_index, positions in enumerate(positions_by_unit):
                if positions is not None:
                    patterns[positions].append(unit_index)
            for cross_positions, base_indices in patterns.items():
                if len(base_indices) != 2:
                    continue
                pattern_cells = [base_units[base_index][cross_index]
                                 for base_index in base_indices for cross_index in cross_positions]
                pattern_set = set(pattern_cells)
                removed_from = []
                for base_index, unit in enumerate(base_units):
                    if base_index in base_indices:
                        continue
                    for cross_index in cross_positions:
                        cell = base_index * 9 + cross_index if orientation == "row" else cross_index * 9 + base_index
                        if cell in opts and digit in opts[cell]:
                            removed_from.append(cell)
                if removed_from:
                    cells = sorted(pattern_set | set(removed_from))
                    first, second = base_indices
                    if orientation == "row":
                        detail = f"Rows {first + 1} and {second + 1} each have {digit} in the same two columns ({cross_positions[0] + 1} and {cross_positions[1] + 1})"
                    else:
                        detail = f"Columns {first + 1} and {second + 1} each have {digit} in the same two rows ({cross_positions[0] + 1} and {cross_positions[1] + 1})"
                    return {"technique": "X-wing", "cells": cells, "candidates": [digit], "value": None,
                            "eliminations": _eliminations(opts, removed_from, {digit}),
                            "explanation": f"{detail}, so those columns are reserved for these rows. Remove {digit} from the matching positions in the other rows." if orientation == "row" else f"{detail}, so those rows are reserved for these columns. Remove {digit} from the matching positions in the other columns."}

    xy_wing = _xy_wing_step(opts)
    if xy_wing:
        return xy_wing
    swordfish = _swordfish_step(opts)
    if swordfish:
        return swordfish
    return None





app = FastAPI(title="Puzzle Solver API", version="1.0.0", docs_url=None, redoc_url=None)
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; "
        "font-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; "
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), display-capture=(self), microphone=()",
}
METRICS_LOCK = Lock()
METRIC_SAMPLES: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=2000))
METRIC_STATUS: dict[str, Counter[int]] = defaultdict(Counter)
RATE_LIMIT_LOCK = Lock()
PARSE_REQUESTS: dict[str, deque[float]] = defaultdict(deque)
EXPLANATION_REQUESTS: dict[str, deque[float]] = defaultdict(deque)
API_REQUESTS: dict[str, deque[float]] = defaultdict(deque)


def _record_request_metric(endpoint: str, status: int, elapsed_ms: float) -> None:
    with METRICS_LOCK:
        METRIC_SAMPLES[endpoint].append(elapsed_ms)
        METRIC_STATUS[endpoint][status] += 1


def _record_recognition_metrics(telemetry: RecognitionTelemetryRequest) -> None:
    connection = _history_connection()
    try:
        for stage, duration in telemetry.stages_ms.items():
            connection.execute(
                "INSERT INTO recognition_stage_samples(source,stage,duration_ms,created_at) VALUES(?,?,?,?)",
                (telemetry.source, stage, duration, datetime.now(timezone.utc).isoformat()),
            )
            connection.execute("""
                DELETE FROM recognition_stage_samples
                WHERE source=? AND stage=? AND id NOT IN (
                    SELECT id FROM recognition_stage_samples WHERE source=? AND stage=? ORDER BY id DESC LIMIT 2000
                )
            """, (telemetry.source, stage, telemetry.source, stage))
        connection.execute("""
            INSERT INTO recognition_quality(
                source,attempts,reviewed,no_digits,errors,recognized_cells,changed_recognized_cells,added_cells
            ) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(source) DO UPDATE SET
                attempts=attempts+excluded.attempts,
                reviewed=reviewed+excluded.reviewed,
                no_digits=no_digits+excluded.no_digits,
                errors=errors+excluded.errors,
                recognized_cells=recognized_cells+excluded.recognized_cells,
                changed_recognized_cells=changed_recognized_cells+excluded.changed_recognized_cells,
                added_cells=added_cells+excluded.added_cells
        """, (telemetry.source, 1, int(telemetry.outcome == "reviewed"), int(telemetry.outcome == "no_digits"),
              int(telemetry.outcome == "error"), telemetry.recognized_cells,
              telemetry.changed_recognized_cells, telemetry.added_cells))
        connection.commit()
    finally:
        connection.close()


def _check_parse_rate_limit(owner: str, client_ip: str, *, limit: int = 10, window_seconds: int = 3600) -> None:
    now = monotonic()
    keys = (f"session:{owner}", f"ip:{sha256(client_ip.encode('utf-8')).hexdigest()}")
    with RATE_LIMIT_LOCK:
        for key in keys:
            timestamps = PARSE_REQUESTS[key]
            while timestamps and now - timestamps[0] >= window_seconds:
                timestamps.popleft()
            if len(timestamps) >= limit:
                raise HTTPException(status_code=429, detail="Clue parsing is limited to 10 requests per hour for this browser session or network address.")
        for key in keys:
            PARSE_REQUESTS[key].append(now)


def _check_explanation_rate_limit(owner: str, client_ip: str, *, limit: int = 30, window_seconds: int = 3600) -> None:
    now = monotonic()
    keys = (f"session:{owner}", f"ip:{sha256(client_ip.encode('utf-8')).hexdigest()}")
    with RATE_LIMIT_LOCK:
        for key in keys:
            timestamps = EXPLANATION_REQUESTS[key]
            while timestamps and now - timestamps[0] >= window_seconds:
                timestamps.popleft()
            if len(timestamps) >= limit:
                raise HTTPException(status_code=429, detail="AI hint phrasing is limited to 30 requests per hour for this browser session or network address.")
        for key in keys:
            EXPLANATION_REQUESTS[key].append(now)


def _take_api_request_quota(request: Request, *, limit: int = 120, window_seconds: int = 60) -> bool:
    if not request.url.path.startswith("/v1/"):
        return True
    now = monotonic()
    client_ip = request.client.host if request.client else "unknown"
    session_id = request.headers.get("X-Session-Id", "") or client_ip
    session_key = sha256(session_id.encode("utf-8")).hexdigest()
    keys = (f"session:{session_key}", f"ip:{sha256(client_ip.encode('utf-8')).hexdigest()}")
    with RATE_LIMIT_LOCK:
        for key in keys:
            timestamps = API_REQUESTS[key]
            while timestamps and now - timestamps[0] >= window_seconds:
                timestamps.popleft()
            if len(timestamps) >= limit:
                return False
        for key in keys:
            API_REQUESTS[key].append(now)
    return True


@app.middleware("http")
async def security_headers(request, call_next):
    started = perf_counter()
    request_id = uuid4().hex
    try:
        if _take_api_request_quota(request):
            response = await call_next(request)
        else:
            response = JSONResponse(status_code=429, content={"detail": "API request limit reached. Wait one minute and try again."}, headers={"Retry-After": "60"})
    except Exception:
        route = request.scope.get("route")
        endpoint = getattr(route, "path", request.url.path)
        _record_request_metric(endpoint, 500, (perf_counter() - started) * 1000)
        raise
    route = request.scope.get("route")
    endpoint = getattr(route, "path", request.url.path)
    elapsed_ms = (perf_counter() - started) * 1000
    _record_request_metric(endpoint, response.status_code, elapsed_ms)
    for name, value in SECURITY_HEADERS.items():
        response.headers[name] = value
    response.headers["X-Request-ID"] = request_id
    response.headers["Server-Timing"] = f"app;dur={elapsed_ms:.2f}"
    return response


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "puzzle-solver",
            "ai_explanations_available": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip() or os.environ.get("OPENROUTER_API_KEY", "").strip())}


@app.get("/metrics")
def metrics() -> dict:
    with METRICS_LOCK:
        endpoints = {name: (list(samples), dict(METRIC_STATUS[name])) for name, samples in METRIC_SAMPLES.items()}
    latency: dict[str, dict] = {}
    for endpoint, (samples, statuses) in endpoints.items():
        ordered = sorted(samples)
        if ordered:
            latency[endpoint] = {
                "recent_count": len(ordered),
                "p50_ms": round(ordered[int((len(ordered) - 1) * 0.50)], 2),
                "p95_ms": round(ordered[int((len(ordered) - 1) * 0.95)], 2),
                "status_counts": {str(code): count for code, count in statuses.items()},
            }
    connection = _history_connection()
    try:
        feedback = connection.execute("SELECT puzzle_type,helpful,COUNT(*) AS count FROM hint_feedback GROUP BY puzzle_type,helpful").fetchall()
        stage_rows = connection.execute("SELECT source,stage,duration_ms FROM recognition_stage_samples ORDER BY id DESC").fetchall()
        quality_rows = connection.execute("""
            SELECT source,attempts,reviewed,no_digits,errors,recognized_cells,changed_recognized_cells,added_cells
            FROM recognition_quality
        """).fetchall()
    finally:
        connection.close()
    on_device_samples: dict[str, list[float]] = defaultdict(list)
    for row in stage_rows:
        on_device_samples[f"{row['source']}.{row['stage']}"].append(row["duration_ms"])
    on_device_stages = {}
    for stage, samples in on_device_samples.items():
        ordered = sorted(samples)
        if ordered:
            on_device_stages[stage] = {
                "recent_count": len(ordered),
                "p50_ms": round(ordered[int((len(ordered) - 1) * 0.50)], 2),
                "p95_ms": round(ordered[int((len(ordered) - 1) * 0.95)], 2),
            }
    recognition_quality = {row["source"]: {key: row[key] for key in row.keys() if key != "source"}
                           for row in quality_rows}
    for values in recognition_quality.values():
        recognized = values.get("recognized_cells", 0)
        values["recognized_cell_correction_rate_percent"] = round(
            values.get("changed_recognized_cells", 0) * 100 / recognized, 2
        ) if recognized else None
    return {"latency": latency, "on_device_stages": on_device_stages,
            "recognition_quality": recognition_quality, "hint_feedback": [dict(row) for row in feedback],
            "llm_usage": llm_metrics_snapshot()}


@app.post("/v1/metrics/recognition")
def submit_recognition_metrics(telemetry: RecognitionTelemetryRequest) -> dict:
    """Accept opt-in timing and correction counts only; never retain puzzle values or images."""
    _record_recognition_metrics(telemetry)
    return {"recorded": True}


@app.post("/v1/logic/parse")
def parse_logic(request: LogicParseRequest, http_request: Request, x_session_id: str = Header(alias="X-Session-Id")) -> dict:
    client_ip = http_request.client.host if http_request.client else "unknown"
    _check_parse_rate_limit(_history_owner(x_session_id), client_ip)
    try:
        parsed, state = parse_logic_clues(request)
    except RuntimeError as error:
        status_code = 503 if any(k in str(error) for k in ("ANTHROPIC_API_KEY", "OPENROUTER_API_KEY")) else 502
        raise HTTPException(status_code=status_code, detail=str(error)) from error
    return {"state": state.model_dump(), "constraints": [item.model_dump() for item in parsed.constraints],
            "warnings": parsed.warnings}


@app.post("/v1/chess/analyze")
def analyze_chess_position(request: ChessAnalysisRequest) -> dict:
    if not request.fair_play_confirmed:
        raise HTTPException(status_code=403, detail="Confirm that you are analyzing a puzzle, a finished game, or a bot game before requesting a chess suggestion.")
    current_pos = parse_fen(request.fen)
    is_continuous = True
    if request.previous_fen:
        prev_pos = parse_fen(request.previous_fen)
        is_continuous = is_reachable_by_legal_move(prev_pos, current_pos)
    result = analyze_chess(current_pos)
    result["mode"] = request.mode
    result["policy"] = "For puzzles, finished games, and bot games only. Never use suggestions against a live opponent."
    result["is_continuous"] = is_continuous
    if not is_continuous:
        result["continuity_warning"] = "The position is not reachable by one legal move from the previous position. Check for a misread square."
    return result


def _history_owner(session_id: str) -> str:
    try:
        canonical = str(UUID(session_id))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="X-Session-Id must be a UUID.") from error
    return sha256(canonical.encode("ascii")).hexdigest()


def _history_connection() -> sqlite3.Connection:
    HISTORY_DB.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(HISTORY_DB, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("""
        CREATE TABLE IF NOT EXISTS puzzle_history (
            record_id TEXT PRIMARY KEY,
            owner_hash TEXT NOT NULL,
            puzzle_type TEXT NOT NULL,
            title TEXT NOT NULL,
            state_json TEXT NOT NULL,
            difficulty TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    connection.execute("CREATE INDEX IF NOT EXISTS history_owner_updated ON puzzle_history(owner_hash, updated_at DESC)")
    connection.execute("""
        CREATE TABLE IF NOT EXISTS hint_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_hash TEXT NOT NULL,
            puzzle_type TEXT NOT NULL,
            technique TEXT NOT NULL,
            helpful INTEGER NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS recognition_stage_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            stage TEXT NOT NULL,
            duration_ms REAL NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    connection.execute("CREATE INDEX IF NOT EXISTS recognition_stage_recent ON recognition_stage_samples(source,stage,id DESC)")
    connection.execute("""
        CREATE TABLE IF NOT EXISTS recognition_quality (
            source TEXT PRIMARY KEY,
            attempts INTEGER NOT NULL,
            reviewed INTEGER NOT NULL,
            no_digits INTEGER NOT NULL,
            errors INTEGER NOT NULL,
            recognized_cells INTEGER NOT NULL,
            changed_recognized_cells INTEGER NOT NULL,
            added_cells INTEGER NOT NULL
        )
    """)
    connection.commit()
    return connection


def _estimate_difficulty(record: HistoryRecordRequest) -> str:
    if record.puzzle_type != "sudoku":
        return {"kenken": "Arithmetic constraints", "killer_sudoku": "Cage arithmetic",
                "nonogram": "Line overlap", "logic_grid": "Structured clue reasoning",
                "chess": "Bounded move search", "cube": "Two-phase cube solution"}[record.puzzle_type]
    board = record.state.get("cells", "")
    if not isinstance(board, str) or len(board) != 81:
        return "Unknown"
    validation = search_outcome(board, 2)
    if validation.timed_out:
        return "Unrated (search limit)"
    if conflicts(board) or len(validation.solutions) != 1:
        return "Invalid or ambiguous"
    current = list(board)
    options = {index: candidates(board, index) for index in CELLS if board[index] == "0"}
    hardest = "Single candidates"
    difficulty_rank = 0
    technique_ranks = {
        "Naked single": (1, "Single candidates"),
        "Hidden single": (2, "Hidden singles"),
        "Pointing pair": (3, "Locked candidates"),
        "Pointing triple": (3, "Locked candidates"),
        "Claiming pair": (3, "Locked candidates"),
        "Claiming triple": (3, "Locked candidates"),
        "Naked pair": (3, "Naked pairs"),
        "Hidden pair": (4, "Hidden pairs"),
        "Naked triple": (5, "Triples"),
        "Hidden triple": (5, "Triples"),
        "X-wing": (6, "X-wing"),
        "XY-wing": (7, "XY-wing"),
        "Swordfish": (8, "Swordfish"),
    }
    for _ in range(100):
        if not options:
            return hardest
        step = find_logical_step("".join(current), options, prefer_easy=True)
        if not step:
            return "Advanced technique or search"
        rank, label = technique_ranks.get(step["technique"], (0, hardest))
        if rank > difficulty_rank:
            difficulty_rank, hardest = rank, label
        if step["value"] is not None:
            index = step["cells"][0]
            value = step["value"]
            if value not in options.get(index, set()):
                return "Invalid or ambiguous"
            current[index] = value
            options.pop(index, None)
            for group in CELL_GROUPS[index]:
                for peer in group:
                    if peer in options:
                        options[peer].discard(value)
            if any(not values for values in options.values()):
                return "Invalid or ambiguous"
            continue
        changed = False
        for removal in step.get("eliminations", []):
            values = options.get(removal["cell"])
            if values is not None:
                before = len(values)
                values.difference_update(removal["candidates"])
                changed = changed or len(values) < before
        if not changed:
            return "Advanced technique or search"
        if any(not values for values in options.values()):
            return "Invalid or ambiguous"
    return "Advanced technique or search"


@app.get("/v1/history")
def list_history(x_session_id: str = Header(alias="X-Session-Id")) -> dict:
    owner = _history_owner(x_session_id)
    connection = _history_connection()
    try:
        rows = connection.execute(
            "SELECT record_id,puzzle_type,title,difficulty,created_at,updated_at FROM puzzle_history WHERE owner_hash=? ORDER BY updated_at DESC LIMIT 100",
            (owner,),
        ).fetchall()
        return {"items": [dict(row) for row in rows]}
    finally:
        connection.close()


@app.post("/v1/history")
def save_history(record: HistoryRecordRequest, x_session_id: str = Header(alias="X-Session-Id")) -> dict:
    owner = _history_owner(x_session_id)
    connection = _history_connection()
    record_id = str(record.record_id or uuid4())
    now = datetime.now(timezone.utc).isoformat()
    difficulty = _estimate_difficulty(record)
    state_json = json.dumps(record.state, separators=(",", ":"), ensure_ascii=False)
    try:
        existing = connection.execute("SELECT owner_hash,created_at FROM puzzle_history WHERE record_id=?", (record_id,)).fetchone()
        if existing and existing["owner_hash"] != owner:
            raise HTTPException(status_code=404, detail="History item not found.")
        created = existing["created_at"] if existing else now
        connection.execute("""
            INSERT INTO puzzle_history(record_id,owner_hash,puzzle_type,title,state_json,difficulty,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(record_id) DO UPDATE SET puzzle_type=excluded.puzzle_type,title=excluded.title,
                state_json=excluded.state_json,difficulty=excluded.difficulty,updated_at=excluded.updated_at
        """, (record_id, owner, record.puzzle_type, record.title, state_json, difficulty, created, now))
        connection.execute("""
            DELETE FROM puzzle_history WHERE owner_hash=? AND record_id NOT IN
                (SELECT record_id FROM puzzle_history WHERE owner_hash=? ORDER BY updated_at DESC LIMIT 100)
        """, (owner, owner))
        connection.commit()
        return {"record_id": record_id, "puzzle_type": record.puzzle_type, "title": record.title,
                "difficulty": difficulty, "created_at": created, "updated_at": now}
    finally:
        connection.close()


@app.get("/v1/history/{record_id}")
def get_history(record_id: UUID, x_session_id: str = Header(alias="X-Session-Id")) -> dict:
    owner = _history_owner(x_session_id)
    connection = _history_connection()
    try:
        row = connection.execute("SELECT * FROM puzzle_history WHERE record_id=? AND owner_hash=?", (str(record_id), owner)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="History item not found.")
        return {**dict(row), "state": json.loads(row["state_json"])}
    finally:
        connection.close()


@app.delete("/v1/history/{record_id}")
def delete_history(record_id: UUID, x_session_id: str = Header(alias="X-Session-Id")) -> dict:
    owner = _history_owner(x_session_id)
    connection = _history_connection()
    try:
        cursor = connection.execute("DELETE FROM puzzle_history WHERE record_id=? AND owner_hash=?", (str(record_id), owner))
        connection.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="History item not found.")
        return {"deleted": True}
    finally:
        connection.close()


@app.delete("/v1/history")
def clear_history(x_session_id: str = Header(alias="X-Session-Id")) -> dict:
    owner = _history_owner(x_session_id)
    connection = _history_connection()
    try:
        cursor = connection.execute("DELETE FROM puzzle_history WHERE owner_hash=?", (owner,))
        connection.commit()
        return {"deleted": cursor.rowcount}
    finally:
        connection.close()


@app.post("/v1/feedback")
def submit_feedback(feedback: HintFeedbackRequest, x_session_id: str = Header(alias="X-Session-Id")) -> dict:
    owner = _history_owner(x_session_id)
    connection = _history_connection()
    try:
        connection.execute(
            "INSERT INTO hint_feedback(owner_hash,puzzle_type,technique,helpful,created_at) VALUES(?,?,?,?,?)",
            (owner, feedback.puzzle_type, feedback.technique, int(feedback.helpful), datetime.now(timezone.utc).isoformat()),
        )
        connection.commit()
        return {"recorded": True}
    finally:
        connection.close()


def _kenken_cages(state: KenKenState) -> list[Cage]:
    return [Cage(tuple(cage.cells), cage.target, cage.operation) for cage in state.cages]


def _killer_cages(state: KillerSudokuState) -> list[Cage]:
    return [Cage(tuple(cage.cells), cage.target, "+") for cage in state.cages]


def _logic_solution(state: LogicGridState, assignment: dict[tuple[str, str], int]) -> list[dict]:
    return [
        {"position": position + 1,
         "values": {category: next(value for (entity_category, value), assigned in assignment.items()
                                   if entity_category == category and assigned == position)
                    for category in state.categories}}
        for position in range(state.positions)
    ]


def _logic_mapping_review(state: LogicGridState) -> dict | None:
    """Require reviewable source mappings when a puzzle includes natural-language clues."""
    if not state.original_clues:
        return None



    mapped = {
        constraint.clue_index
        for constraint in state.constraints
        if constraint.clue_index is not None and 0 <= constraint.clue_index < len(state.original_clues)
    }
    missing = [index + 1 for index in range(len(state.original_clues)) if index not in mapped]
    unlinked = any(
        constraint.clue_index is None or not 0 <= constraint.clue_index < len(state.original_clues)
        for constraint in state.constraints
    )
    if not missing and not unlinked:
        return None



    details = []
    if missing:
        details.append("Map source clue" + ("s " if len(missing) > 1 else " ") + ", ".join(map(str, missing)))
    if unlinked:
        details.append("map or remove every relationship without a source clue")
    reason = "; ".join(details) + " in the visual relationship builder, then load the logic grid again."
    return {"status": "needs_review", "reason": reason}


def _logic_relevant_source_clues(state: LogicGridState, category: str, entity: str) -> str:
    clue_indices = []
    for constraint in state.constraints:
        involves_entity = (
            constraint.left.category == category and constraint.left.value == entity
        ) or (
            constraint.right is not None and constraint.right.category == category and constraint.right.value == entity
        )
        index = constraint.clue_index
        if involves_entity and index is not None and 0 <= index < len(state.original_clues) and index not in clue_indices:
            clue_indices.append(index)
    if not clue_indices:
        return ""
    shown = [f"Clue {index + 1}: {state.original_clues[index]}" for index in clue_indices[:3]]
    if len(clue_indices) > len(shown):
        shown.append(f"{len(clue_indices) - len(shown)} additional mapped source clues")
    return " Relevant source clues: " + "; ".join(shown) + "."


def _logic_contradiction_detail(state: LogicGridState) -> str:
    """Find one clue whose removal restores a solution, within a small extra budget."""
    deadline = monotonic() + 0.25
    for index, constraint in enumerate(state.constraints):
        remaining = deadline - monotonic()
        if remaining <= 0:
            break
        reduced = state.model_copy(update={"constraints": state.constraints[:index] + state.constraints[index + 1:]})
        outcome = solve_logic_grid(reduced, max_solutions=1, time_limit_seconds=min(0.04, remaining), max_nodes=5000)
        if outcome.solutions:
            if constraint.clue_index is not None and constraint.clue_index < len(state.original_clues):
                source = f"source clue {constraint.clue_index + 1}: {state.original_clues[constraint.clue_index]}"
            else:
                source = f"structured constraint {index + 1}: {constraint.explanation or constraint.kind}"
            return f"This puzzle becomes solvable when {source} is removed; review it with the other constraints."
    return "The structured constraints cannot all be true at once. Review the clue mappings and entries."


def _logic_verification_error(state: LogicGridState, assignment: dict[tuple[str, str], int]) -> str | None:
    failed = verify_logic_assignment(state, assignment)
    if not failed:
        return None



    clue_indices = sorted({state.constraints[index].clue_index for index in failed
                           if state.constraints[index].clue_index is not None and
                           state.constraints[index].clue_index < len(state.original_clues)})
    if clue_indices:
        labels = ", ".join(f"clue {index + 1}" for index in clue_indices)
        return f"A completed arrangement failed the replay check for mapped {labels}. No solution was shown."
    labels = ", ".join(str(index + 1) for index in failed)
    return f"A completed arrangement failed structured relationship check(s) {labels}. No solution was shown."


def _cage_contradiction_detail(state: KenKenState | KillerSudokuState) -> tuple[str, list[int]]:
    """Use bounded leave-one-out solves to identify one cage or given behind a contradiction."""
    deadline = monotonic() + 0.4
    killer = isinstance(state, KillerSudokuState)
    cages = _killer_cages(state) if killer else _kenken_cages(state)

    def run(cells: str, ignored_cages: set[int] | None = None):
        remaining = deadline - monotonic()
        if remaining <= 0:
            return None



        timeout = min(0.005, remaining)
        if killer:
            return solve_killer_sudoku(cells, cages, limit=1, timeout_seconds=timeout,
                                       ignored_cages=ignored_cages)
        return solve_latin_cage_grid(state.size, cells, cages, limit=1, timeout_seconds=timeout,
                                     ignored_cages=ignored_cages)

    given_indices = [index for index, value in enumerate(state.cells) if value not in {"0", "."}]
    if len(given_indices) > 40:
        given_indices = [given_indices[round(sample * (len(given_indices) - 1) / 39)] for sample in range(40)]
    for index in given_indices:
        reduced_cells = state.cells[:index] + "0" + state.cells[index + 1:]
        outcome = run(reduced_cells)
        if outcome and outcome.solutions:
            row, column = divmod(index, state.size)
            return (f"The puzzle has a valid completion when the given at row {row + 1}, column {column + 1} is removed. Review that entry with its cage clues.", [index])
        if monotonic() >= deadline:
            break

    cage_indices = list(range(len(cages)))
    if len(cage_indices) > 40:
        cage_indices = [cage_indices[round(sample * (len(cage_indices) - 1) / 39)] for sample in range(40)]
    for cage_index in cage_indices:
        cage = cages[cage_index]
        outcome = run(state.cells, {cage_index})
        if outcome and outcome.solutions:
            row_cells = ", ".join(f"r{cell // state.size + 1}c{cell % state.size + 1}" for cell in cage.cells)
            kind = "Killer Sudoku sum cage" if killer else f"KenKen {cage.target}{cage.operation} cage"
            return (f"The puzzle has a valid completion when {kind} {cage_index + 1} ({row_cells}) is ignored. Review its cells and target.", list(cage.cells))
        if monotonic() >= deadline:
            break
    return ("The cage and given clues cannot all be true at once. Check the entries and cage targets; no single clue was isolated within the diagnosis budget.", [])


def _nonogram_contradiction_detail(outcome) -> str:
    if not outcome.conflict_lines:
        return "The row and column runs cannot all describe the same picture. Review the crossing clues."
    labels = [f"{kind} {index + 1}" for kind, index in outcome.conflict_lines]
    lines = ", ".join(labels)
    return f"The solver repeatedly eliminated every pattern from {lines} while combining the row and column runs. Review those clues and their crossing cells."


@app.post("/v1/solve")
def solve(state: SolveRequest) -> dict:
    if isinstance(state, SudokuState):
        return unique_solution(state.cells)
    if isinstance(state, KenKenState):
        outcome = solve_latin_cage_grid(state.size, state.cells, _kenken_cages(state))
        status = "too_hard" if outcome.timed_out else solution_status(outcome.solutions)
        if status == "invalid":
            reason, cells = _cage_contradiction_detail(state)
            return {"status": status, "solutions_found": 0, "reason": reason, "conflicting_cells": cells}
        return {"status": status, "solutions_found": len(outcome.solutions),
                "solution": outcome.solutions[0] if status == "solved" else None,
                "solutions": outcome.solutions[:2]}
    if isinstance(state, KillerSudokuState):
        outcome = solve_killer_sudoku(state.cells, _killer_cages(state))
        status = "too_hard" if outcome.timed_out else solution_status(outcome.solutions)
        if status == "invalid":
            reason, cells = _cage_contradiction_detail(state)
            return {"status": status, "solutions_found": 0, "reason": reason, "conflicting_cells": cells}
        return {"status": status, "solutions_found": len(outcome.solutions),
                "solution": outcome.solutions[0] if status == "solved" else None,
                "solutions": outcome.solutions[:2]}
    if isinstance(state, LogicGridState):
        review = _logic_mapping_review(state)
        if review:
            return review
        outcome = solve_logic_grid(state)
        for assignment in outcome.solutions:
            verification_error = _logic_verification_error(state, assignment)
            if verification_error:
                return {"status": "invalid", "solutions_found": 0, "reason": verification_error,
                        "solution": None, "solutions": []}
        status = solution_status(outcome.solutions, outcome.timed_out)
        reason = _logic_contradiction_detail(state) if status == "invalid" else None
        return {"status": status, "solutions_found": len(outcome.solutions),
                **({"reason": reason} if reason else {}),
                "solution": _logic_solution(state, outcome.solutions[0]) if status == "solved" else None,
                "solutions": [_logic_solution(state, solution) for solution in outcome.solutions[:2]],
                "nodes": outcome.nodes}
    outcome = solve_nonogram(state.rows, state.columns)
    status = solution_status(outcome.solutions, outcome.timed_out)
    if status == "invalid":
        return {"status": status, "solutions_found": 0, "reason": _nonogram_contradiction_detail(outcome),
                "solution": None, "solutions": []}
    return {"status": status, "solutions_found": len(outcome.solutions),
            "solution": outcome.solutions[0] if status == "solved" else None,
            "solutions": outcome.solutions[:2]}


@app.post("/v1/hint")
def hint(request: HintRequest) -> dict:
    if isinstance(request, SudokuHint):
        return sudoku_hint(request)
    if isinstance(request, KillerSudokuHint):
        outcome = solve_killer_sudoku(request.cells, _killer_cages(request))
        if outcome.timed_out:
            return {"status": "too_hard", "message": "This grid took too long to finish. Check the clues or try a simpler grid."}
        if not outcome.solutions:
            reason, cells = _cage_contradiction_detail(request)
            return {"status": "invalid", "reason": reason, "conflicting_cells": cells}
        step = find_logical_step(request.cells)
        if request.help_level == "nudge" and step:
            return {"status": "hint", "technique": step["technique"], "cells": step["cells"], "value": None,
                    "explanation": f"Look for a {step['technique'].lower()} in {cell_name(step['cells'][0])}."}
        if step and request.help_level == "hint":
            return {"status": "hint", **step}
        if len(outcome.solutions) > 1:
            return {"status": "multiple", "message": "This grid has more than one solution. Add or correct clues before asking for a solver value."}
        solution = outcome.solutions[0]
        index = next((i for i in CELLS if request.cells[i] == "0"), None)
        if index is None:
            return {"status": "complete", "message": "This grid is already complete."}
        if request.help_level == "nudge":
            return {"status": "hint", "technique": "Cage arithmetic", "cells": [index], "value": None,
                    "explanation": f"Compare the cage sum that reaches {cell_name(index)} with its remaining row, column, and box digits."}
        return {"status": "hint", "technique": "Verified solver value", "cells": [index], "value": solution[index],
                "explanation": f"The exact solver checked the Sudoku and cage constraints. The value for {cell_name(index)} is {solution[index]}."}
    if isinstance(request, KenKenHint):
        outcome = solve_latin_cage_grid(request.size, request.cells, _kenken_cages(request))
        if outcome.timed_out:
            return {"status": "too_hard", "message": "This grid took too long to finish. Check its cages or try a smaller grid."}
        if not outcome.solutions:
            reason, cells = _cage_contradiction_detail(request)
            return {"status": "invalid", "reason": reason, "conflicting_cells": cells}
        if len(outcome.solutions) > 1 and request.help_level != "nudge":
            return {"status": "multiple", "message": "This grid has more than one solution. Add or correct a cage before asking for a value."}
        index = next((i for i in range(request.size * request.size) if request.cells[i] == "0"), None)
        if index is None:
            return {"status": "complete", "message": "This grid is already complete."}
        if request.help_level == "nudge":
            cage = next(cage for cage in request.cages if index in cage.cells)
            return {"status": "hint", "technique": "Cage arithmetic", "cells": cage.cells, "value": None,
                    "explanation": f"Look at the {cage.target} {cage.operation} cage and the row and column that meet at row {index // request.size + 1}, column {index % request.size + 1}."}
        solution = outcome.solutions[0]
        return {"status": "hint", "technique": "Cage constraint", "cells": [index], "value": solution[index],
                "explanation": f"The row, column, and cage arithmetic verify {solution[index]} in row {index // request.size + 1}, column {index % request.size + 1}."}
    if isinstance(request, LogicGridHint):
        review = _logic_mapping_review(request)
        if review:
            return review
        outcome = solve_logic_grid(request)
        for assignment in outcome.solutions:
            verification_error = _logic_verification_error(request, assignment)
            if verification_error:
                return {"status": "invalid", "reason": verification_error}
        if outcome.timed_out:
            return {"status": "too_hard", "message": "This logic grid took too long to finish. Check the clue entries or use a smaller puzzle."}
        if not outcome.solutions:
            return {"status": "invalid", "reason": _logic_contradiction_detail(request)}
        if request.help_level == "answer":
            if len(outcome.solutions) > 1:
                return {"status": "multiple", "message": "These clues allow multiple solutions. Add or correct a clue before asking for a full answer."}
            return {"status": "hint", "technique": "Verified full solution", "value": _logic_solution(request, outcome.solutions[0]),
                    "explanation": "This arrangement satisfies every structured clue."}
        forced = forced_assignments(request)
        if not forced:
            return {"status": "multiple", "message": "No single entity position is forced across the remaining solutions. Add another clue."}
        (category, entity), position = sorted(forced.items())[0]
        source_context = _logic_relevant_source_clues(request, category, entity)
        if request.help_level == "nudge":
            return {"status": "hint", "technique": "Constraint deduction", "value": None,
                    "explanation": f"Compare the clues involving {entity} with the other entries in {category}.{source_context}"}
        return {"status": "hint", "technique": "Constraint deduction",
                "value": {"category": category, "entity": entity, "position": position + 1},
                "explanation": f"Every arrangement that satisfies the structured clues puts {entity} in {category} at position {position + 1}.{source_context}"}
    outcome = solve_nonogram(request.rows, request.columns)
    status = solution_status(outcome.solutions, outcome.timed_out)
    if status == "too_hard":
        return {"status": status, "message": "This puzzle has too many possible line patterns to finish quickly. Reduce its size or add clearer clues."}
    if status == "invalid":
        return {"status": status, "reason": _nonogram_contradiction_detail(outcome)}
    if request.help_level == "answer" and len(outcome.solutions) == 1:
        for row, line in enumerate(outcome.solutions[0]):
            for column, value in enumerate(line):
                return {"status": "hint", "technique": "Verified line solution", "cells": [row * len(request.columns) + column],
                        "value": value, "explanation": f"The verified picture has this cell {'filled' if value == '#' else 'empty'}."}
    if outcome.forced:
        row, column, filled = outcome.forced[0]
        value = "#" if filled else "."
        if request.help_level == "nudge":
            return {"status": "hint", "technique": "Line overlap", "cells": [row * len(request.columns) + column], "value": None,
                    "explanation": f"Compare the run clues crossing row {row + 1} and column {column + 1}."}
        return {"status": "hint", "technique": "Line overlap", "cells": [row * len(request.columns) + column], "value": value,
                "explanation": f"The row and column runs force this cell to be {'filled' if filled else 'empty'}."}
    if len(outcome.solutions) > 1:
        return {"status": "multiple", "message": "The clues allow multiple pictures. Add another clue before asking for a specific cell."}
    solution = outcome.solutions[0]
    index = next((r * len(request.columns) + c for r, line in enumerate(solution) for c, value in enumerate(line)), 0)
    value = solution[index // len(request.columns)][index % len(request.columns)]
    return {"status": "hint", "technique": "Verified line solution", "cells": [index], "value": value,
            "explanation": f"The verified picture has this cell {'filled' if value == '#' else 'empty'}."}


@app.post("/v1/explain")
def explain(request: HintRequest, http_request: Request = None,
            x_session_id: str = Header(default="", alias="X-Session-Id")) -> dict:
    """Return the solver-verified reasoning step in the standard hint shape."""
    if request.help_level == "nudge":
        request.help_level = "hint"
    result = hint(request)
    if not request.use_ai_explanation or result.get("status") != "hint":
        return result
    if http_request is None or not isinstance(x_session_id, str) or not x_session_id:
        result["explanation_source"] = "local"
        result["explanation_notice"] = "AI phrasing needs a valid browser session; showing the verified local explanation."
        return result
    client_ip = http_request.client.host if http_request.client else "unknown"
    try:
        _check_explanation_rate_limit(_history_owner(x_session_id), client_ip)
    except HTTPException:
        result["explanation_source"] = "local"
        result["explanation_notice"] = "AI phrasing is rate limited; showing the verified local explanation."
        return result
    cells = result.get("cells", [])
    if isinstance(request, KenKenHint):
        grid_width = request.size
    elif isinstance(request, NonogramHint):
        grid_width = len(request.columns)
    elif isinstance(request, (SudokuHint, KillerSudokuHint)):
        grid_width = 9
    else:
        grid_width = None
    displayed_cells = ([f"row {index // grid_width + 1}, column {index % grid_width + 1}"
                        for index in cells if isinstance(index, int) and index >= 0]
                       if grid_width else [])
    deduction = {
        "puzzle_type": request.type,
        "technique": result.get("technique"),
        "cells": displayed_cells,
        "value": result.get("value"),
        "verified_explanation": result.get("explanation", ""),
    }
    paraphrase = explain_deduction(deduction)
    if paraphrase:
        result["verified_explanation"] = result.get("explanation", "")
        result["ai_explanation"] = paraphrase
        result["explanation_source"] = "ai"
    else:
        result["explanation_source"] = "local"
        result["explanation_notice"] = "AI phrasing was unavailable or did not pass checks; showing the verified local explanation."
    return result


def sudoku_hint(request: SudokuHint) -> dict:
    board = request.cells
    bad = conflicts(board)
    if bad:
        return {"status": "invalid", "reason": "Two matching digits share a row, column, or box.", "conflicting_cells": bad}
    outcome = search_outcome(board, 2)
    if outcome.timed_out:
        return {"status": "too_hard", "message": "This Sudoku took too long to finish. Check the clues or try again with a simpler grid."}
    solutions = outcome.solutions
    if not solutions:
        return {"status": "invalid", "reason": "These clues cannot all be true at once.", "conflicting_cells": []}
    if request.help_level == "answer":
        if len(solutions) > 1:
            return {"status": "multiple", "message": "This grid has more than one solution. Add another clue before asking for a specific value."}
        solution = solutions[0]
        index = next((i for i in CELLS if board[i] == "0"), None)
        if index is None:
            return {"status": "complete", "message": "This grid is already complete."}
        return {"status": "hint", "technique": "Solver value", "cells": [index], "value": solution[index],
                "explanation": f"The verified value for {cell_name(index)} is {solution[index]}."}
    step = find_logical_step(board)
    if step:
        if request.help_level == "nudge":
            return {"status": "hint", "technique": step["technique"], "cells": step["cells"],
                    "value": None, "explanation": f"Look for a {step['technique'].lower()} in {cell_name(step['cells'][0])}."}
        return {"status": "hint", **step}
    if len(solutions) > 1:
        return {"status": "multiple", "message": "This grid has more than one solution. Add another clue for a solver fallback."}
    solution = solutions[0]
    index = next((i for i in CELLS if board[i] == "0"), None)
    if index is None:
        return {"status": "complete", "message": "This grid is already complete."}
    if request.help_level == "nudge":
        return {"status": "hint", "technique": "Solver fallback", "cells": [index], "value": None,
                "explanation": f"No supported logical technique applies yet. Look at {cell_name(index)} and compare the remaining row, column, and box digits."}
    return {"status": "hint", "technique": "Solver fallback", "cells": [index], "value": solution[index],
            "explanation": f"The exact solver checked this grid. Its verified value for {cell_name(index)} is {solution[index]}."}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")

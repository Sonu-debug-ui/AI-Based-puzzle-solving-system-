import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
from unittest.mock import patch

from server import main
from server.main import explain, hint as hint_request, search_outcome, solve as solve_request, unique_solution
from server.schemas import (ArithmeticCage, KenKenState, KillerCage, KillerSudokuState,
                            ChessAnalysisRequest, HintFeedbackRequest, HistoryRecordRequest, LogicConstraint, LogicEntity, LogicGridHint, LogicGridState,
                            LogicParseRequest, NonogramState, RecognitionTelemetryRequest, CubeState)
from server.logic_parser import parse_logic_clues
from server.chess_engine import analyze as analyze_chess, legal_moves as chess_legal_moves, parse_fen, perft
from server.logic_grid import forced_assignments, solve_logic_grid, verify_logic_assignment
from server.variants import Cage, solve_killer_sudoku, solve_latin_cage_grid, solve_nonogram


SUDOKU_PUZZLE = "530070000600195000098000060800060003400803001700020006060000280000419005000080079"
SUDOKU_SOLUTION = "534678912672195348198342567859761423426853791713924856961537284287419635345286179"


class SudokuTests(unittest.TestCase):
    def test_unique_solution_is_verified(self):
        result = unique_solution(SUDOKU_PUZZLE)
        self.assertEqual(result["status"], "solved")
        self.assertEqual(result["solution"], SUDOKU_SOLUTION)

    def test_conflicting_givens_are_invalid(self):
        puzzle = SUDOKU_PUZZLE[:2] + "5" + SUDOKU_PUZZLE[3:]
        result = unique_solution(puzzle)
        self.assertEqual(result["status"], "invalid")
        self.assertIn(0, result["conflicting_cells"])

    def test_non_unique_grid_reports_many_without_choosing_one(self):
        result = unique_solution("0" * 81)
        self.assertEqual(result["status"], "multiple")
        self.assertIsNone(result["solution"])
        self.assertEqual(result["solutions_found"], 2)

    def test_search_budget_reports_timeout_instead_of_claiming_a_result(self):
        outcome = search_outcome(SUDOKU_PUZZLE, max_nodes=0)
        self.assertTrue(outcome.timed_out)
        self.assertEqual(outcome.solutions, [])

    def test_hidden_pair_is_reported_as_a_candidate_elimination(self):
        from server.main import find_logical_step

        def mocked_candidates(_board, index):
            if index in (0, 1):
                return set("123456789")
            if 2 <= index < 9:
                return set("3456789")
            return set("123456789")

        with patch("server.main.candidates", side_effect=mocked_candidates):
            step = find_logical_step("0" * 81)
        self.assertEqual(step["technique"], "Hidden pair")
        self.assertEqual(step["cells"], [0, 1])
        self.assertEqual(step["candidates"], ["1", "2"])

    def test_xy_wing_elimination(self):
        from server.main import _xy_wing_step
        # Pivot: cell 0 candidates {1, 2}
        # Pincer 1: cell 1 candidates {1, 3} (shares row with cell 0)
        # Pincer 2: cell 9 candidates {2, 3} (shares col with cell 0)
        # Target: cell 10 candidates {3, 4} (sees cell 1 via col 2, sees cell 9 via row 2)
        opts = {
            0: {"1", "2"},
            1: {"1", "3"},
            9: {"2", "3"},
            10: {"3", "4"},
            20: {"5", "6", "7"},
        }
        step = _xy_wing_step(opts)
        self.assertIsNotNone(step)
        self.assertEqual(step["technique"], "XY-wing")
        self.assertEqual(step["candidates"], ["3"])
        self.assertEqual(step["eliminations"], [{"cell": 10, "candidates": ["3"]}])

    def test_swordfish_elimination(self):
        from server.main import _swordfish_step
        # Digit "1" in rows 0, 1, 2 restricted to cols 0, 1, 2
        # Target: row 3, col 0 has candidate 1, which should be eliminated
        opts = {
            # Row 0: cols 0, 1
            0: {"1", "8"}, 1: {"1", "9"},
            # Row 1: cols 1, 2
            10: {"1", "8"}, 11: {"1", "9"},
            # Row 2: cols 0, 2
            18: {"1", "8"}, 20: {"1", "9"},
            # Row 3: col 0 has candidate 1
            27: {"1", "4", "5"},
        }
        step = _swordfish_step(opts)
        self.assertIsNotNone(step)
        self.assertEqual(step["technique"], "Swordfish")
        self.assertEqual(step["candidates"], ["1"])
        self.assertEqual(step["eliminations"], [{"cell": 27, "candidates": ["1"]}])

    def test_frozen_5000_puzzle_corpus(self):
        corpus = Path(__file__).parent / "data" / "sudoku_5000.jsonl"
        with corpus.open(encoding="utf-8") as cases:
            count = 0
            for count, line in enumerate(cases, 1):
                case = json.loads(line)
                self.assertEqual(len(case["puzzle"]), 81)
                self.assertEqual(len(case["solution"]), 81)
                result = unique_solution(case["puzzle"])
                self.assertEqual(result["status"], "solved", f"case {count}")
                self.assertEqual(result["solutions_found"], 1, f"case {count}")
                self.assertEqual(result["solution"], case["solution"], f"case {count}")
        self.assertEqual(count, 5000)


class VariantTests(unittest.TestCase):
    def test_kenken_latin_square(self):
        expected = "123231312"
        cages = [Cage((index,), int(value), "=") for index, value in enumerate(expected)]
        state = KenKenState(type="kenken", size=3, cells="0" * 9,
                            cages=[ArithmeticCage(cells=list(cage.cells), target=cage.target, operation=cage.operation) for cage in cages])
        result = solve_latin_cage_grid(state.size, state.cells, cages)
        self.assertFalse(result.timed_out)
        self.assertEqual(result.solutions, [expected])

    def test_killer_sudoku_cages_and_sudoku_rules(self):
        cages = [Cage((index,), int(value), "+") for index, value in enumerate(SUDOKU_SOLUTION)]
        state = KillerSudokuState(type="killer_sudoku", size=9, cells=SUDOKU_PUZZLE,
                                  cages=[KillerCage(cells=list(cage.cells), target=cage.target) for cage in cages])
        result = solve_killer_sudoku(state.cells, cages)
        self.assertFalse(result.timed_out)
        self.assertEqual(result.solutions, [SUDOKU_SOLUTION])

    def test_nonogram_line_propagation_solves_diamond(self):
        rows = [[1], [3], [5], [3], [1]]
        result = solve_nonogram(rows, rows)
        expected = ["..#..", ".###.", "#####", ".###.", "..#.."]
        self.assertFalse(result.timed_out)
        self.assertEqual(result.solutions, [expected])

    def test_nonogram_impossible_clues_are_invalid(self):
        result = solve_nonogram([[3]], [[1], [1]])
        self.assertEqual(result.solutions, [])
        self.assertFalse(result.timed_out)


class LogicGridTests(unittest.TestCase):
    def setUp(self):
        self.categories = {"Person": ["Alice", "Bob"], "Drink": ["Tea", "Coffee"], "Pet": ["Cat", "Dog"]}

    def test_logic_grid_solves_intersecting_constraints(self):
        constraints = [
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"), position=1),
            LogicConstraint(kind="same", left=LogicEntity(category="Person", value="Alice"),
                            right=LogicEntity(category="Drink", value="Tea")),
            LogicConstraint(kind="same", left=LogicEntity(category="Person", value="Alice"),
                            right=LogicEntity(category="Pet", value="Cat")),
        ]
        state = LogicGridState(positions=2, categories=self.categories, constraints=constraints)
        result = solve_logic_grid(state)
        self.assertFalse(result.timed_out)
        self.assertEqual(len(result.solutions), 1)
        self.assertEqual(result.solutions[0][("Drink", "Tea")], 0)
        self.assertEqual(result.solutions[0][("Pet", "Dog")], 1)

    def test_logic_grid_api_returns_complete_unique_solution(self):
        constraints = [
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"), position=1),
            LogicConstraint(kind="same", left=LogicEntity(category="Person", value="Alice"),
                            right=LogicEntity(category="Drink", value="Tea")),
            LogicConstraint(kind="same", left=LogicEntity(category="Person", value="Alice"),
                            right=LogicEntity(category="Pet", value="Cat")),
        ]
        state = LogicGridState(positions=2, categories=self.categories, constraints=constraints)
        result = solve_request(state)
        self.assertEqual(result["status"], "solved")
        self.assertEqual(result["solution"][0]["values"], {"Person": "Alice", "Drink": "Tea", "Pet": "Cat"})
        answer = hint_request(LogicGridHint(**state.model_dump(), help_level="answer"))
        self.assertEqual(answer["status"], "hint")
        self.assertEqual(len(answer["value"]), 2)

    def test_logic_grid_solve_and_hint_block_until_every_source_clue_is_mapped(self):
        state = LogicGridState(positions=2, categories=self.categories, constraints=[
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"),
                            position=1, clue_index=0),
        ], original_clues=["Alice is first.", "Alice drinks tea."])
        solved = solve_request(state)
        hinted = hint_request(LogicGridHint(**state.model_dump(), help_level="hint"))
        self.assertEqual(solved["status"], "needs_review")
        self.assertEqual(hinted["status"], "needs_review")
        self.assertIn("clue 2", solved["reason"])

    def test_logic_grid_replays_mapped_constraints_against_assignment(self):
        state = LogicGridState(positions=2, categories=self.categories, constraints=[
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"),
                            position=1, clue_index=0),
            LogicConstraint(kind="same", left=LogicEntity(category="Person", value="Alice"),
                            right=LogicEntity(category="Drink", value="Tea"), clue_index=1),
        ], original_clues=["Alice is first.", "Alice drinks tea."])
        assignment = solve_logic_grid(state).solutions[0]
        self.assertEqual(verify_logic_assignment(state, assignment), [])
        invalid = dict(assignment)
        invalid[("Person", "Bob")] = invalid[("Person", "Alice")]
        self.assertTrue(verify_logic_assignment(state, invalid))
        self.assertIn("Alice drinks tea", main._logic_relevant_source_clues(state, "Person", "Alice"))

    def test_logic_grid_reports_ambiguity(self):
        state = LogicGridState(positions=2, categories=self.categories, constraints=[
            LogicConstraint(kind="not_position", left=LogicEntity(category="Person", value="Alice"), position=1),
        ])
        result = solve_logic_grid(state)
        self.assertEqual(len(result.solutions), 2)

    def test_logic_hint_does_not_treat_first_two_solutions_as_exhaustive(self):
        state = LogicGridState(positions=2, categories=self.categories, constraints=[
            LogicConstraint(kind="same", left=LogicEntity(category="Person", value="Alice"),
                            right=LogicEntity(category="Drink", value="Tea")),
        ])
        result = solve_logic_grid(state)
        self.assertEqual(len(result.solutions), 2)
        self.assertEqual(forced_assignments(state), {})

    def test_logic_grid_contradictions_are_invalid(self):
        state = LogicGridState(positions=2, categories=self.categories, constraints=[
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"), position=1),
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"), position=2),
        ])
        result = solve_logic_grid(state)
        self.assertEqual(result.solutions, [])

    def test_logic_grid_api_names_a_clue_that_conflicts_with_the_others(self):
        state = LogicGridState(positions=2, categories=self.categories, constraints=[
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"), position=1, clue_index=0),
            LogicConstraint(kind="at_position", left=LogicEntity(category="Person", value="Alice"), position=2, clue_index=1),
        ], original_clues=["Alice is first.", "Alice is second."])
        result = solve_request(state)
        self.assertEqual(result["status"], "invalid")
        self.assertIn("source clue", result["reason"])
        self.assertIn("Alice is first", result["reason"])


class VariantValidationTests(unittest.TestCase):
    def test_logic_unary_constraint_accepts_missing_right_entity(self):
        constraint = LogicConstraint(kind="not_position", left=LogicEntity(category="Person", value="Alice"), position=2)
        state = LogicGridState(positions=2, categories={"Person": ["Alice", "Bob"], "Drink": ["Tea", "Coffee"]}, constraints=[constraint])
        self.assertEqual(state.constraints[0].right, None)


class ParserTests(unittest.TestCase):
    def test_parser_retries_after_local_entity_validation_failure(self):
        from server.llm_metrics import llm_metrics_snapshot
        source = LogicParseRequest(positions=2, categories={"Person": ["Alice", "Bob"], "Drink": ["Tea", "Coffee"]}, clues=["Alice drinks tea."])
        good_constraint = {"kind": "same", "left": {"category": "Person", "value": "Alice"},
                           "right": {"category": "Drink", "value": "Tea"}, "position": None,
                           "clue_index": 0, "explanation": "Alice drinks tea."}
        bad_constraint = {**good_constraint, "right": {"category": "Drink", "value": "Water"}}
        before = llm_metrics_snapshot().get("parser", {}).copy()
        with patch("server.logic_parser._request_claude", side_effect=[
            {"constraints": [bad_constraint], "warnings": []},
            {"constraints": [good_constraint], "warnings": []},
        ]) as request:
            parsed, state = parse_logic_clues(source)
        self.assertEqual(len(parsed.constraints), 1)
        self.assertEqual(state.constraints[0].right.value, "Tea")
        self.assertEqual(request.call_count, 2)
        after = llm_metrics_snapshot()["parser"]
        self.assertEqual(after["validation_retries"], before.get("validation_retries", 0) + 1)
        self.assertEqual(after["schema_violations"], before.get("schema_violations", 0) + 1)

    def test_explainer_records_provider_tokens_and_cache_hits(self):
        from server.explainer import explain_deduction
        from server.llm_metrics import llm_metrics_snapshot

        from server.explainer import EXPLANATION_CACHE
        EXPLANATION_CACHE.clear()
        deduction = {"technique": "OpenRouter test step", "cells": [83], "value": "3",
                     "verified_explanation": "The supplied deduction confirms this step."}
        wording = "This follows from the verified candidates and introduces no new value."
        response_body = {"content": [{"type": "text", "text": json.dumps({"explanation": wording})}],
                         "usage": {"input_tokens": 20, "output_tokens": 12}}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(response_body).encode("utf-8")

        before = llm_metrics_snapshot().get("explainer", {}).copy()
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}), \
                patch("server.explainer.urlopen", return_value=FakeResponse()) as provider:
            self.assertEqual(explain_deduction(deduction), wording)
            self.assertEqual(explain_deduction(deduction), wording)
        after = llm_metrics_snapshot()["explainer"]
        self.assertEqual(provider.call_count, 1)
        self.assertEqual(after["provider_requests"], before.get("provider_requests", 0) + 1)
        self.assertEqual(after["cache_hits"], before.get("cache_hits", 0) + 1)
        self.assertEqual(after["input_tokens"], before.get("input_tokens", 0) + 20)
        self.assertEqual(after["output_tokens"], before.get("output_tokens", 0) + 12)

    def test_parser_warns_when_a_source_clue_has_no_constraint_mapping(self):
        source = LogicParseRequest(positions=2, categories={"Person": ["Alice", "Bob"], "Drink": ["Tea", "Coffee"]},
                                   clues=["Alice drinks tea.", "Bob drinks coffee."])
        constraint = {"kind": "same", "left": {"category": "Person", "value": "Alice"},
                      "right": {"category": "Drink", "value": "Tea"}, "position": None,
                      "clue_index": 0, "explanation": "Alice drinks tea."}
        with patch("server.logic_parser._request_claude", return_value={"constraints": [constraint], "warnings": []}):
            parsed, _state = parse_logic_clues(source)
        self.assertTrue(any("clue 2" in warning for warning in parsed.warnings))

    def test_openrouter_parser_and_explainer_support(self):
        from server.logic_parser import _request_claude
        from server.explainer import explain_deduction

        source = LogicParseRequest(positions=2, categories={"Person": ["Alice", "Bob"], "Drink": ["Tea", "Coffee"]},
                                   clues=["Alice drinks tea."])
        or_clue_payload = {
            "choices": [{"message": {"content": json.dumps({"constraints": [{
                "kind": "same", "left": {"category": "Person", "value": "Alice"},
                "right": {"category": "Drink", "value": "Tea"}, "position": None,
                "clue_index": 0, "explanation": "Alice drinks tea."
            }], "warnings": []})}}],
            "usage": {"prompt_tokens": 35, "completion_tokens": 15}
        }
        captured_requests = []

        class FakeResponse:
            def __init__(self, data):
                self.data = data
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return json.dumps(self.data).encode("utf-8")

        def fake_urlopen(req, timeout=None):
            captured_requests.append(req)
            return FakeResponse(or_clue_payload)

        with patch.dict("os.environ", {"OPENROUTER_API_KEY": "sk-or-v1-fake-key"}), \
                patch("server.logic_parser.urlopen", side_effect=fake_urlopen):
            res = _request_claude(source)
            self.assertEqual(len(res["constraints"]), 1)
            self.assertEqual(captured_requests[0].full_url, "https://openrouter.ai/api/v1/chat/completions")
            self.assertEqual(captured_requests[0].headers.get("Authorization"), "Bearer sk-or-v1-fake-key")

        deduction = {"technique": "Test step", "cells": [83], "value": "3",
                     "verified_explanation": "The supplied deduction confirms this step."}
        wording = "This follows from the verified candidates and introduces no new value."
        or_explain_payload = {
            "choices": [{"message": {"content": f"```json\n{{\"explanation\": \"{wording}\"}}\n```"}}],
            "usage": {"prompt_tokens": 18, "completion_tokens": 8}
        }

        def fake_explain_urlopen(req, timeout=None):
            captured_requests.append(req)
            return FakeResponse(or_explain_payload)

        with patch.dict("os.environ", {"OPENROUTER_API_KEY": "sk-or-v1-fake-key"}), \
                patch("server.explainer.urlopen", side_effect=fake_explain_urlopen):
            result = explain_deduction(deduction)
            self.assertEqual(result, wording)
            self.assertEqual(captured_requests[1].full_url, "https://openrouter.ai/api/v1/chat/completions")
            self.assertEqual(captured_requests[1].headers.get("Authorization"), "Bearer sk-or-v1-fake-key")

    def test_explain_route_uses_verified_solver_reasoning(self):
        from server.schemas import SudokuHint
        request = SudokuHint(cells=SUDOKU_PUZZLE, help_level="hint")
        result = explain(request)
        self.assertEqual(result["status"], "hint")
        self.assertTrue(result["explanation"])

    def test_ai_hint_phrase_receives_only_the_verified_deduction_and_keeps_local_text(self):
        from starlette.requests import Request
        from server.schemas import SudokuHint
        request = SudokuHint(cells=SUDOKU_PUZZLE, help_level="hint", use_ai_explanation=True)
        scope = {"type": "http", "method": "POST", "scheme": "http", "path": "/v1/explain",
                 "raw_path": b"/v1/explain", "query_string": b"", "headers": [],
                 "client": ("127.0.0.1", 8000), "server": ("127.0.0.1", 8000), "http_version": "1.1"}
        with patch("server.main._check_explanation_rate_limit"), \
                patch("server.main.explain_deduction", return_value="Compare the row and column to verify this step.") as call:
            result = explain(request, Request(scope), str(uuid4()))
        self.assertEqual(result["explanation_source"], "ai")
        self.assertEqual(result["ai_explanation"], "Compare the row and column to verify this step.")
        self.assertEqual(result["explanation"], result["verified_explanation"])
        self.assertEqual(set(call.call_args.args[0]), {"puzzle_type", "technique", "cells", "value", "verified_explanation"})


class SecurityTests(unittest.TestCase):
    def test_logic_parse_limit_applies_to_session_and_ip(self):
        from fastapi import HTTPException
        owner = uuid4().hex
        ip = f"198.51.100.{uuid4().int % 200 + 1}"
        main._check_parse_rate_limit(owner, ip, limit=1)
        with self.assertRaises(HTTPException):
            main._check_parse_rate_limit(owner, f"203.0.113.{uuid4().int % 200 + 1}", limit=1)
        with self.assertRaises(HTTPException):
            main._check_parse_rate_limit(uuid4().hex, ip, limit=1)

    def test_security_headers_cover_local_media_and_dynamic_sticker_colors(self):
        policy = main.SECURITY_HEADERS
        self.assertIn("style-src-attr 'unsafe-inline'", policy["Content-Security-Policy"])
        self.assertIn("worker-src 'self'", policy["Content-Security-Policy"])
        self.assertIn("camera=(self)", policy["Permissions-Policy"])
        self.assertEqual(policy["X-Content-Type-Options"], "nosniff")


class HistoryTests(unittest.TestCase):
    def test_history_is_session_scoped_and_deletable(self):
        session = str(uuid4())
        other_session = str(uuid4())
        record = HistoryRecordRequest(puzzle_type="sudoku", title="Sample", state={"type": "sudoku", "size": 9, "cells": SUDOKU_PUZZLE})
        with TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as directory, patch.object(main, "HISTORY_DB", Path(directory) / "history.sqlite3"):
            saved = main.save_history(record, session)
            self.assertEqual(main.list_history(session)["items"][0]["record_id"], saved["record_id"])
            self.assertEqual(main.list_history(other_session)["items"], [])
            loaded = main.get_history(saved["record_id"], session)
            self.assertEqual(loaded["state"]["cells"], SUDOKU_PUZZLE)
            self.assertEqual(main.delete_history(saved["record_id"], session), {"deleted": True})
            self.assertEqual(main.list_history(session)["items"], [])

    def test_feedback_stores_only_rating_and_technique_aggregates(self):
        session = str(uuid4())
        feedback = HintFeedbackRequest(puzzle_type="sudoku", technique="Naked single", helpful=True)
        with TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as directory, patch.object(main, "HISTORY_DB", Path(directory) / "history.sqlite3"):
            self.assertEqual(main.submit_feedback(feedback, session), {"recorded": True})
            result = main.metrics()
            self.assertEqual(result["hint_feedback"], [{"puzzle_type": "sudoku", "helpful": 1, "count": 1}])

    def test_opt_in_recognition_metrics_aggregate_durations_and_correction_counts(self):
        telemetry = RecognitionTelemetryRequest(
            source="photo", outcome="reviewed",
            stages_ms={"crop_normalization": 8.5, "grid_detection": 3.2, "total_to_review": 15.0},
            recognized_cells=12, changed_recognized_cells=2, added_cells=1,
        )
        stage_key = "photo.crop_normalization"
        with TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as directory, patch.object(main, "HISTORY_DB", Path(directory) / "history.sqlite3"):
            self.assertEqual(main.submit_recognition_metrics(telemetry), {"recorded": True})
            summary = main.metrics()
        self.assertEqual(summary["on_device_stages"][stage_key], {"recent_count": 1, "p50_ms": 8.5, "p95_ms": 8.5})
        self.assertEqual(summary["recognition_quality"]["photo"]["attempts"], 1)
        self.assertEqual(summary["recognition_quality"]["photo"]["recognized_cells"], 12)
        self.assertEqual(summary["recognition_quality"]["photo"]["changed_recognized_cells"], 2)
        self.assertEqual(summary["recognition_quality"]["photo"]["added_cells"], 1)
        self.assertEqual(summary["recognition_quality"]["photo"]["recognized_cell_correction_rate_percent"], 16.67)
        with self.assertRaises(ValueError):
            RecognitionTelemetryRequest(source="photo", outcome="reviewed", stages_ms={"puzzle": 2}, recognized_cells=1)
        with self.assertRaises(ValueError):
            RecognitionTelemetryRequest(source="photo", outcome="no_digits", stages_ms={"grid_detection": 2}, recognized_cells=1)

    def test_history_requires_a_valid_puzzle_state(self):
        with self.assertRaises(ValueError):
            HistoryRecordRequest(puzzle_type="sudoku", title="Bad", state={"type": "sudoku", "size": 9, "cells": "invalid"})


class ChessEngineTests(unittest.TestCase):
    START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"

    def test_start_position_legal_move_counts(self):
        position = parse_fen(self.START)
        self.assertEqual(len(chess_legal_moves(position)), 20)
        self.assertEqual(perft(position, 2), 400)
        self.assertEqual(perft(parse_fen(self.KIWIPETE), 2), 2039)

    def test_castling_and_en_passant_are_generated_and_applied(self):
        castle = parse_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
        castle_moves = {move.uci() for move in chess_legal_moves(castle)}
        self.assertIn("e1g1", castle_moves)
        self.assertIn("e1c1", castle_moves)
        ep = parse_fen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1")
        move = next(move for move in chess_legal_moves(ep) if move.uci() == "e5d6")
        self.assertTrue(move.en_passant)
        self.assertEqual(parse_fen(ep.fen()).fen(), ep.fen())

    def test_mate_and_bounded_move_suggestion(self):
        mate = parse_fen("7k/6Q1/5K2/8/8/8/8/8 b - - 0 1")
        self.assertEqual(analyze_chess(mate)["status"], "checkmate")
        position = parse_fen(self.START)
        result = analyze_chess(position, max_depth=2)
        self.assertEqual(result["status"], "suggestion")
        self.assertEqual(len(result["best_move"]), 4)
        self.assertGreater(result["depth"], 0)

    def test_chess_api_requires_fair_play_attestation(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as blocked:
            main.analyze_chess_position(ChessAnalysisRequest(fen=self.START))
        self.assertEqual(blocked.exception.status_code, 403)
        allowed = main.analyze_chess_position(ChessAnalysisRequest(fen=self.START, mode="puzzle", fair_play_confirmed=True))
        self.assertEqual(allowed["status"], "suggestion")
        self.assertIn("Never use suggestions against a live opponent", allowed["policy"])


    def test_chess_move_continuity_guard(self):
        from server.chess_engine import is_reachable_by_legal_move, apply_move
        start = parse_fen(self.START)
        moves = chess_legal_moves(start)
        first_child = apply_move(start, moves[0])
        self.assertTrue(is_reachable_by_legal_move(start, first_child))
        # Illegal jump:
        illegal = parse_fen("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2")
        self.assertFalse(is_reachable_by_legal_move(start, illegal))
        # Test API continuity flag
        req = ChessAnalysisRequest(fen=first_child.fen(), previous_fen=self.START, fair_play_confirmed=True)
        resp = main.analyze_chess_position(req)
        self.assertTrue(resp["is_continuous"])
        req_bad = ChessAnalysisRequest(fen=illegal.fen(), previous_fen=self.START, fair_play_confirmed=True)
        resp_bad = main.analyze_chess_position(req_bad)
        self.assertFalse(resp_bad["is_continuous"])
        self.assertIn("continuity_warning", resp_bad)


class CubeSchemaTests(unittest.TestCase):
    SOLVED = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB"

    def test_valid_cube_can_be_saved_to_history(self):
        record = HistoryRecordRequest(puzzle_type="cube", title="Cube", state={"type": "cube", "facelets": self.SOLVED})
        self.assertEqual(record.state["facelets"], self.SOLVED)

    def test_wrong_color_counts_are_rejected(self):
        with self.assertRaises(ValueError):
            CubeState(facelets="U" * 54)


if __name__ == "__main__":
    unittest.main()

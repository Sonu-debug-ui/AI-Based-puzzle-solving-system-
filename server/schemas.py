"""Validated request shapes for all grid puzzle types."""

from __future__ import annotations

import json
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from server.chess_engine import ChessPositionError, parse_fen


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def cells_are_connected(cells: list[int], size: int) -> bool:
    remaining = set(cells)
    if not remaining:
        return False
    seen = {remaining.pop()}
    frontier = list(seen)
    while frontier:
        index = frontier.pop()
        row, column = divmod(index, size)
        neighbors = []
        if row:
            neighbors.append(index - size)
        if row + 1 < size:
            neighbors.append(index + size)
        if column:
            neighbors.append(index - 1)
        if column + 1 < size:
            neighbors.append(index + 1)
        for neighbor in neighbors:
            if neighbor in remaining:
                remaining.remove(neighbor)
                seen.add(neighbor)
                frontier.append(neighbor)
    return not remaining


class SudokuState(StrictModel):
    type: Literal["sudoku"] = "sudoku"
    size: Literal[9] = 9
    cells: str = Field(min_length=81, max_length=81)

    @field_validator("cells")
    @classmethod
    def validate_cells(cls, value: str) -> str:
        if any(char not in "0123456789." for char in value):
            raise ValueError("Use digits 1–9 for clues and 0 or . for empty cells.")
        return value.replace(".", "0")


class SudokuHint(SudokuState):
    help_level: Literal["nudge", "hint", "answer"] = "nudge"
    use_ai_explanation: bool = False


class ArithmeticCage(StrictModel):
    cells: list[int] = Field(min_length=1, max_length=9)
    target: int = Field(ge=1, le=1_000_000_000)
    operation: Literal["+", "×", "*", "−", "-", "÷", "/", "="]

    @field_validator("operation")
    @classmethod
    def normalize_operation(cls, value: str) -> str:
        return {"*": "×", "-": "−", "/": "÷"}.get(value, value)


class KenKenState(StrictModel):
    type: Literal["kenken"] = "kenken"
    size: int = Field(ge=3, le=9)
    cells: str
    cages: list[ArithmeticCage] = Field(min_length=1, max_length=81)

    @model_validator(mode="after")
    def validate_puzzle(self) -> "KenKenState":
        if len(self.cells) != self.size * self.size or any(char not in "0123456789" or (char != "0" and int(char) > self.size) for char in self.cells):
            raise ValueError("The grid must contain size × size characters, using 0 for empty cells and 1–size for clues.")
        flattened = [cell for cage in self.cages for cell in cage.cells]
        if len(flattened) != len(set(flattened)) or set(flattened) != set(range(self.size * self.size)):
            raise ValueError("Cages must partition the grid: every cell appears exactly once.")
        for cage in self.cages:
            if any(cell < 0 or cell >= self.size * self.size for cell in cage.cells):
                raise ValueError("Cage cell indexes must be within the grid.")
            if cage.operation == "=" and len(cage.cells) != 1:
                raise ValueError("An equality cage must contain one cell.")
            if cage.operation == "=" and cage.target > self.size:
                raise ValueError("An equality target must be within the grid values.")
            if cage.operation in {"−", "÷"} and len(cage.cells) != 2:
                raise ValueError("Subtraction and division cages must contain two cells.")
            if not cells_are_connected(cage.cells, self.size):
                raise ValueError("Each KenKen cage must be a connected group of cells.")
            if cage.operation == "+" and not len(cage.cells) <= cage.target <= len(cage.cells) * self.size:
                raise ValueError("A sum cage target is outside the possible total for its size.")
            if cage.operation == "×" and cage.target > self.size ** len(cage.cells):
                raise ValueError("A product cage target is larger than its maximum possible product.")
            if cage.operation == "−" and cage.target >= self.size:
                raise ValueError("A subtraction target must be smaller than the grid size.")
            if cage.operation == "÷" and cage.target > self.size:
                raise ValueError("A division target cannot be larger than the grid size.")
        return self


class KenKenHint(KenKenState):
    help_level: Literal["nudge", "hint", "answer"] = "nudge"
    use_ai_explanation: bool = False


class KillerCage(StrictModel):
    cells: list[int] = Field(min_length=1, max_length=9)
    target: int = Field(ge=1, le=45)


class KillerSudokuState(StrictModel):
    type: Literal["killer_sudoku"] = "killer_sudoku"
    size: Literal[9] = 9
    cells: str = Field(min_length=81, max_length=81)
    cages: list[KillerCage] = Field(min_length=1, max_length=81)

    @field_validator("cells")
    @classmethod
    def validate_cells(cls, value: str) -> str:
        if any(char not in "0123456789." for char in value):
            raise ValueError("Use digits 1–9 for clues and 0 or . for empty cells.")
        return value.replace(".", "0")

    @model_validator(mode="after")
    def validate_cages(self) -> "KillerSudokuState":
        flattened = [cell for cage in self.cages for cell in cage.cells]
        if len(flattened) != len(set(flattened)) or set(flattened) != set(range(81)):
            raise ValueError("Cages must partition the grid: every cell appears exactly once.")
        if any(cell < 0 or cell > 80 for cell in flattened):
            raise ValueError("Cage cell indexes must be between 0 and 80.")
        for cage in self.cages:
            if not cells_are_connected(cage.cells, 9):
                raise ValueError("Each Killer Sudoku cage must be a connected group of cells.")
            if cage.target > sum(range(10 - len(cage.cells), 10)):
                raise ValueError("A cage sum is larger than its maximum possible total.")
            if cage.target < sum(range(1, len(cage.cells) + 1)):
                raise ValueError("A cage sum is smaller than its minimum possible total.")
        return self


class KillerSudokuHint(KillerSudokuState):
    help_level: Literal["nudge", "hint", "answer"] = "nudge"
    use_ai_explanation: bool = False


class NonogramState(StrictModel):
    type: Literal["nonogram"] = "nonogram"
    rows: list[list[int]] = Field(min_length=1, max_length=25)
    columns: list[list[int]] = Field(min_length=1, max_length=25)

    @model_validator(mode="after")
    def validate_clues(self) -> "NonogramState":
        width, height = len(self.columns), len(self.rows)
        for clues, line_length in [(items, width) for items in self.rows] + [(items, height) for items in self.columns]:
            if any(run < 1 or run > 25 for run in clues):
                raise ValueError("Nonogram run lengths must be positive and no greater than 25.")
            if sum(clues) + max(0, len(clues) - 1) > line_length:
                raise ValueError("A line's clues cannot fit within its grid length.")
        return self


class NonogramHint(NonogramState):
    help_level: Literal["nudge", "hint", "answer"] = "nudge"
    use_ai_explanation: bool = False


class LogicEntity(StrictModel):
    category: str = Field(min_length=1, max_length=64)
    value: str = Field(min_length=1, max_length=96)


class LogicConstraint(StrictModel):
    kind: Literal["same", "different", "left_of", "next_to", "immediately_left", "at_position", "not_position"]
    left: LogicEntity
    right: LogicEntity | None = None
    position: int | None = Field(default=None, ge=1, le=7)
    clue_index: int | None = Field(default=None, ge=0)
    explanation: str = Field(default="", max_length=240)

    @model_validator(mode="after")
    def validate_shape(self) -> "LogicConstraint":
        position_constraint = self.kind in {"at_position", "not_position"}
        if position_constraint != (self.position is not None):
            raise ValueError("Position constraints need a position; other constraints must not include one.")
        if (self.kind in {"same", "different", "left_of", "next_to", "immediately_left"}) != (self.right is not None):
            raise ValueError("Binary relations need both left and right entities.")
        return self


class LogicGridState(StrictModel):
    type: Literal["logic_grid"] = "logic_grid"
    positions: int = Field(ge=2, le=7)
    categories: dict[str, list[str]] = Field(min_length=2, max_length=8)
    constraints: list[LogicConstraint] = Field(min_length=1, max_length=100)
    original_clues: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_grid(self) -> "LogicGridState":
        normalized_names = [name.strip().casefold() for name in self.categories]
        if any(not name for name in normalized_names) or len(normalized_names) != len(set(normalized_names)):
            raise ValueError("Category names must be non-empty and unique.")
        for category, values in self.categories.items():
            normalized_values = [value.strip().casefold() for value in values]
            if len(values) != self.positions or len(normalized_values) != len(set(normalized_values)):
                raise ValueError(f"Category {category} must have exactly {self.positions} unique values.")
        for constraint in self.constraints:
            for entity in [constraint.left, constraint.right] if constraint.right else [constraint.left]:
                if entity.category not in self.categories or entity.value not in self.categories[entity.category]:
                    raise ValueError(f"Unknown logic-grid entity: {entity.category} / {entity.value}.")
            if constraint.position is not None and constraint.position > self.positions:
                raise ValueError("A clue position cannot exceed the grid size.")
            if constraint.right and constraint.left.category == constraint.right.category and constraint.kind == "same" and constraint.left.value != constraint.right.value:
                raise ValueError("Different values in one category cannot occupy the same position.")
        if self.original_clues and any(not clue.strip() for clue in self.original_clues):
            raise ValueError("Original clue text cannot contain empty entries.")
        return self


class LogicGridHint(LogicGridState):
    help_level: Literal["nudge", "hint", "answer"] = "nudge"
    use_ai_explanation: bool = False


class LogicParseRequest(StrictModel):
    positions: int = Field(ge=2, le=7)
    categories: dict[str, list[str]] = Field(min_length=2, max_length=8)
    clues: list[str] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_input(self) -> "LogicParseRequest":
        if any(len(values) != self.positions for values in self.categories.values()):
            raise ValueError("Every category must list exactly one value per position.")
        if any(not clue.strip() for clue in self.clues):
            raise ValueError("Clues cannot be empty.")
        if sum(len(clue) for clue in self.clues) > 12000:
            raise ValueError("Keep the total clue text under 12,000 characters.")
        return self


class LogicParseResult(StrictModel):
    constraints: list[LogicConstraint] = Field(max_length=200)
    warnings: list[str] = Field(max_length=100)


class HistoryRecordRequest(StrictModel):
    record_id: UUID | None = None
    puzzle_type: Literal["sudoku", "kenken", "killer_sudoku", "nonogram", "logic_grid", "chess", "cube"]
    title: str = Field(min_length=1, max_length=120)
    state: dict[str, Any]
    difficulty: str | None = Field(default=None, max_length=32)

    @model_validator(mode="after")
    def validate_record(self) -> "HistoryRecordRequest":
        if self.state.get("type") != self.puzzle_type:
            raise ValueError("The saved state type must match puzzle_type.")
        if len(json.dumps(self.state, ensure_ascii=False).encode("utf-8")) > 65_536:
            raise ValueError("A saved puzzle state cannot exceed 64 KiB.")
        model_type = {
            "sudoku": SudokuState,
            "kenken": KenKenState,
            "killer_sudoku": KillerSudokuState,
            "nonogram": NonogramState,
            "logic_grid": LogicGridState,
            "chess": ChessState,
            "cube": CubeState,
        }[self.puzzle_type]
        validated_state = model_type.model_validate(self.state)
        self.state = validated_state.model_dump()
        return self


class HintFeedbackRequest(StrictModel):
    puzzle_type: Literal["sudoku", "kenken", "killer_sudoku", "nonogram", "logic_grid", "chess", "cube"]
    technique: Literal["Naked single", "Hidden single", "Naked pair", "Hidden pair", "Solver fallback",
                       "Cage arithmetic", "Cage constraint", "Verified solver value",
                       "Line overlap", "Verified line solution", "Constraint deduction",
                       "Verified full solution", "Bounded chess search", "Kociemba cube solver",
                       "Pointing pair", "Pointing triple", "Claiming pair", "Claiming triple",
                       "Naked triple", "Hidden triple", "X-wing", "XY-wing", "Swordfish"]
    helpful: bool


class RecognitionTelemetryRequest(StrictModel):
    source: Literal["photo", "screen"]
    outcome: Literal["reviewed", "no_digits", "error"]
    stages_ms: dict[str, float] = Field(min_length=1, max_length=4)
    recognized_cells: int = Field(ge=0, le=81)
    changed_recognized_cells: int = Field(default=0, ge=0, le=81)
    added_cells: int = Field(default=0, ge=0, le=81)

    @model_validator(mode="after")
    def validate_recognition_metrics(self) -> "RecognitionTelemetryRequest":
        allowed_stages = {"crop_normalization", "grid_detection", "cell_classification", "total_to_review"}
        if not set(self.stages_ms).issubset(allowed_stages):
            raise ValueError("Recognition stage names are not supported.")
        if any(value < 0 or value > 120_000 for value in self.stages_ms.values()):
            raise ValueError("Recognition stage times must be between 0 and 120,000 milliseconds.")
        if self.changed_recognized_cells > self.recognized_cells:
            raise ValueError("Changed recognized cells cannot exceed the number of recognized cells.")
        if self.outcome != "reviewed" and (self.recognized_cells or self.changed_recognized_cells or self.added_cells):
            raise ValueError("An unsuccessful recognition cannot include recognized or edited cells.")
        if self.outcome == "reviewed" and self.recognized_cells < 1:
            raise ValueError("A reviewed result must contain at least one recognized cell.")
        return self


class ChessState(StrictModel):
    type: Literal["chess"] = "chess"
    fen: str = Field(min_length=10, max_length=100)

    @field_validator("fen")
    @classmethod
    def validate_fen(cls, value: str) -> str:
        try:
            return parse_fen(value).fen()
        except ChessPositionError as error:
            raise ValueError(str(error)) from error


class ChessAnalysisRequest(ChessState):
    mode: Literal["puzzle", "finished_game", "bot_game"] = "puzzle"
    fair_play_confirmed: bool = False
    use_ai_explanation: bool = False
    previous_fen: str | None = None


class CubeState(StrictModel):
    type: Literal["cube"] = "cube"
    facelets: str = Field(min_length=54, max_length=54)

    @field_validator("facelets")
    @classmethod
    def validate_facelets(cls, value: str) -> str:
        if any(face not in "URFDLB" for face in value):
            raise ValueError("Cube facelets use only U, R, F, D, L, and B.")
        if any(value.count(face) != 9 for face in "URFDLB"):
            raise ValueError("A cube state needs exactly nine stickers of each face color.")
        if value[4::9] != "URFDLB":
            raise ValueError("The six center stickers must follow URFDLB face order.")
        return value

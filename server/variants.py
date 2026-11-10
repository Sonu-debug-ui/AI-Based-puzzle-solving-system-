"""Exact backtracking solvers for the v1 non-Sudoku grid puzzle models."""

from __future__ import annotations

from dataclasses import dataclass, field
from math import prod
from time import monotonic


@dataclass(frozen=True)
class Cage:
    cells: tuple[int, ...]
    target: int
    operation: str


@dataclass
class GridSearchOutcome:
    solutions: list[str]
    timed_out: bool = False


def _latin_cages_valid(values: list[int], n: int, cages: list[Cage], ignored_cages: set[int] | None = None) -> bool:
    """Check every cage whose cells have values; also prune partial sums/products."""
    ignored_cages = ignored_cages or set()
    for cage_index, cage in enumerate(cages):
        if cage_index in ignored_cages:
            continue
        assigned = [values[i] for i in cage.cells if values[i]]
        remaining = len(cage.cells) - len(assigned)
        if cage.operation == "=":
            if assigned and assigned[0] != cage.target:
                return False
        elif cage.operation == "+":
            total = sum(assigned)
            if total > cage.target or total + remaining * n < cage.target:
                return False
            if not remaining and total != cage.target:
                return False
        elif cage.operation == "×":
            value = prod(assigned) if assigned else 1
            if value > cage.target or cage.target % value:
                return False
            if value * (n ** remaining) < cage.target:
                return False
            if not remaining and value != cage.target:
                return False
        elif not remaining:
            if len(assigned) != 2:
                return False
            a, b = assigned
            if cage.operation == "−" and abs(a - b) != cage.target:
                return False
            if cage.operation == "÷" and (max(a, b) % min(a, b) or max(a, b) // min(a, b) != cage.target):
                return False
    return True


def solve_latin_cage_grid(size: int, cells: str, cages: list[Cage], limit: int = 2,
                          timeout_seconds: float = 2.0,
                          ignored_cages: set[int] | None = None) -> GridSearchOutcome:
    """Solve a KenKen-style Latin square with arithmetic cages."""
    if len(cells) != size * size or any(ch not in "0123456789" or (ch != "0" and int(ch) > size) for ch in cells):
        return GridSearchOutcome([])
    state = [int(ch) for ch in cells]
    ignored_cages = ignored_cages or set()
    if not _cages_well_formed(cages, size, require_cover=True):
        return GridSearchOutcome([])
    latin_groups = [[r * size + c for c in range(size)] for r in range(size)]
    latin_groups += [[r * size + c for r in range(size)] for c in range(size)]
    if any(len([state[i] for i in group if state[i]]) != len({state[i] for i in group if state[i]}) for group in latin_groups):
        return GridSearchOutcome([])
    found: list[str] = []
    deadline = monotonic() + timeout_seconds
    timed_out = False

    def valid_value(index: int, value: int) -> bool:
        row, column = divmod(index, size)
        if any(state[row * size + c] == value for c in range(size)):
            return False
        if any(state[r * size + column] == value for r in range(size)):
            return False
        state[index] = value
        okay = _latin_cages_valid(state, size, cages, ignored_cages)
        state[index] = 0
        return okay

    def visit() -> None:
        nonlocal timed_out
        if len(found) >= limit:
            return
        if monotonic() > deadline:
            timed_out = True
            return
        best = -1
        choices: list[int] | None = None
        for index, current in enumerate(state):
            if current:
                continue
            row, column = divmod(index, size)
            used = {state[row * size + c] for c in range(size)} | {state[r * size + column] for r in range(size)}
            possible = [value for value in range(1, size + 1) if value not in used and valid_value(index, value)]
            if not possible:
                return
            if choices is None or len(possible) < len(choices):
                best, choices = index, possible
                if len(choices) == 1:
                    break
        if best < 0:
            found.append("".join(str(value) for value in state))
            return
        for value in choices or []:
            state[best] = value
            visit()
            state[best] = 0
            if len(found) >= limit or timed_out:
                return

    if not _latin_cages_valid(state, size, cages, ignored_cages):
        return GridSearchOutcome([])
    visit()
    return GridSearchOutcome(found, timed_out)


def _cages_well_formed(cages: list[Cage], size: int, require_cover: bool) -> bool:
    all_cells = [cell for cage in cages for cell in cage.cells]
    return (
        bool(cages)
        and len(all_cells) == len(set(all_cells))
        and all(0 <= cell < size * size for cell in all_cells)
        and (not require_cover or set(all_cells) == set(range(size * size)))
    )


def solve_killer_sudoku(cells: str, cages: list[Cage], limit: int = 2,
                        timeout_seconds: float = 2.0,
                        ignored_cages: set[int] | None = None) -> GridSearchOutcome:
    """Solve Sudoku with disjoint, no-repeat sum cages."""
    if len(cells) != 81 or any(ch not in "0123456789" for ch in cells):
        return GridSearchOutcome([])
    if not _cages_well_formed(cages, 9, require_cover=True):
        return GridSearchOutcome([])
    ignored_cages = ignored_cages or set()
    cage_for: dict[int, tuple[int, Cage]] = {cell: (cage_index, cage) for cage_index, cage in enumerate(cages) for cell in cage.cells}
    state = [int(ch) for ch in cells]
    groups = [[r * 9 + c for c in range(9)] for r in range(9)]
    groups += [[r * 9 + c for r in range(9)] for c in range(9)]
    groups += [[(br + dr) * 9 + bc + dc for dr in range(3) for dc in range(3)]
               for br in (0, 3, 6) for bc in (0, 3, 6)]
    cell_groups = {i: [group for group in groups if i in group] for i in range(81)}
    found: list[str] = []
    deadline = monotonic() + timeout_seconds
    timed_out = False

    def cage_possible(cage: Cage, candidate_index: int | None = None, candidate_value: int | None = None,
                      ignored: bool = False) -> bool:
        if ignored:
            return True
        assigned = [state[i] for i in cage.cells if state[i]]
        if candidate_index is not None and candidate_value is not None:
            assigned.append(candidate_value)
        if len(assigned) != len(set(assigned)):
            return False
        total = sum(assigned)
        remaining = len(cage.cells) - len(assigned)
        if total > cage.target:
            return False
        available = [digit for digit in range(1, 10) if digit not in assigned]
        if remaining > len(available):
            return False
        if remaining:
            if total + sum(available[:remaining]) > cage.target:
                return False
            if total + sum(available[-remaining:]) < cage.target:
                return False
            return True
        return total == cage.target

    def possible(index: int) -> list[int]:
        used = {state[i] for group in cell_groups[index] for i in group if state[i]}
        cage_index, cage = cage_for[index]
        return [digit for digit in range(1, 10) if digit not in used and
                cage_possible(cage, index, digit, cage_index in ignored_cages)]

    def visit() -> None:
        nonlocal timed_out
        if len(found) >= limit:
            return
        if monotonic() > deadline:
            timed_out = True
            return
        best = -1
        choices: list[int] | None = None
        for index, value in enumerate(state):
            if value:
                continue
            options = possible(index)
            if not options:
                return
            if choices is None or len(options) < len(choices):
                best, choices = index, options
                if len(choices) == 1:
                    break
        if best < 0:
            found.append("".join(map(str, state)))
            return
        for value in choices or []:
            state[best] = value
            visit()
            state[best] = 0
            if len(found) >= limit or timed_out:
                return

    for group in groups:
        assigned = [state[i] for i in group if state[i]]
        if len(assigned) != len(set(assigned)):
            return GridSearchOutcome([])
    if any(not cage_possible(cage, ignored=index in ignored_cages) for index, cage in enumerate(cages)):
        return GridSearchOutcome([])
    visit()
    return GridSearchOutcome(found, timed_out)


def nonogram_patterns(length: int, clues: list[int], cap: int = 100_000) -> list[int]:
    """Generate bit masks satisfying one row or column clue sequence."""
    if not clues:
        return [0]
    if any(run < 1 for run in clues) or sum(clues) + len(clues) - 1 > length:
        return []
    masks: list[int] = []

    def place(clue_index: int, start_at: int, mask: int) -> None:
        if len(masks) >= cap:
            return
        run = clues[clue_index]
        remaining = sum(clues[clue_index + 1:]) + max(0, len(clues) - clue_index - 1)
        last_start = length - run - remaining
        for start in range(start_at, last_start + 1):
            run_mask = ((1 << run) - 1) << start
            if clue_index == len(clues) - 1:
                masks.append(mask | run_mask)
            else:
                place(clue_index + 1, start + run + 1, mask | run_mask)

    place(0, 0, 0)
    return masks


@dataclass
class NonogramResult:
    solutions: list[list[str]]
    forced: list[tuple[int, int, bool]]
    timed_out: bool = False
    conflict_lines: list[tuple[str, int]] = field(default_factory=list)


def solve_nonogram(rows: list[list[int]], columns: list[list[int]], limit: int = 2,
                   timeout_seconds: float = 2.0, pattern_cap: int = 100_000) -> NonogramResult:
    """Propagate line patterns and branch on the tightest remaining line."""
    height, width = len(rows), len(columns)
    if not (1 <= height <= 25 and 1 <= width <= 25):
        return NonogramResult([], [])
    row_domains = [nonogram_patterns(width, clues, pattern_cap) for clues in rows]
    column_domains = [nonogram_patterns(height, clues, pattern_cap) for clues in columns]
    if any(len(domain) >= pattern_cap for domain in row_domains + column_domains):
        return NonogramResult([], [], timed_out=True)
    if any(not domain for domain in row_domains + column_domains):
        return NonogramResult([], [])
    started = monotonic()
    timed_out = False
    solutions: list[list[str]] = []
    initial_grid = [[-1] * width for _ in range(height)]
    forced: list[tuple[int, int, bool]] = []
    conflict_counts: dict[tuple[str, int], int] = {}

    def note_conflict(kind: str, line: int) -> None:
        key = (kind, line)
        conflict_counts[key] = conflict_counts.get(key, 0) + 1

    def ranked_conflicts() -> list[tuple[str, int]]:
        return sorted(conflict_counts, key=lambda key: (-conflict_counts[key], key[0], key[1]))[:3]

    def propagate(grid: list[list[int]], rd: list[list[int]], cd: list[list[int]]) -> bool:
        changed = True
        while changed:
            changed = False
            for r in range(height):
                if not rd[r]:
                    note_conflict("row", r)
                    return False
                for c in range(width):
                    values = {(mask >> c) & 1 for mask in rd[r]}
                    if len(values) == 1:
                        value = values.pop()
                        if grid[r][c] in (-1, value):
                            if grid[r][c] == -1:
                                grid[r][c] = value
                                changed = True
                        else:
                            note_conflict("row", r)
                            note_conflict("column", c)
                            return False
            for c in range(width):
                if not cd[c]:
                    note_conflict("column", c)
                    return False
                for r in range(height):
                    values = {(mask >> r) & 1 for mask in cd[c]}
                    if len(values) == 1:
                        value = values.pop()
                        if grid[r][c] in (-1, value):
                            if grid[r][c] == -1:
                                grid[r][c] = value
                                changed = True
                        else:
                            note_conflict("column", c)
                            note_conflict("row", r)
                            return False
            for r in range(height):
                previous = len(rd[r])
                rd[r] = [mask for mask in rd[r] if all(grid[r][c] == -1 or grid[r][c] == ((mask >> c) & 1) for c in range(width))]
                if not rd[r]:
                    note_conflict("row", r)
                    return False
                changed = changed or len(rd[r]) != previous
            for c in range(width):
                previous = len(cd[c])
                cd[c] = [mask for mask in cd[c] if all(grid[r][c] == -1 or grid[r][c] == ((mask >> r) & 1) for r in range(height))]
                if not cd[c]:
                    note_conflict("column", c)
                    return False
                changed = changed or len(cd[c]) != previous
        return True

    # Record direct line overlaps before search, for the hint endpoint.
    base_grid = [row[:] for row in initial_grid]
    if not propagate(base_grid, [domain[:] for domain in row_domains], [domain[:] for domain in column_domains]):
        return NonogramResult([], [], conflict_lines=ranked_conflicts())
    forced = [(r, c, bool(base_grid[r][c])) for r in range(height) for c in range(width) if base_grid[r][c] != -1]

    def visit(grid: list[list[int]], rd: list[list[int]], cd: list[list[int]]) -> None:
        nonlocal timed_out
        if len(solutions) >= limit:
            return
        if monotonic() - started > timeout_seconds:
            timed_out = True
            return
        if not propagate(grid, rd, cd):
            return
        unknown = sum(value < 0 for row in grid for value in row)
        if not unknown:
            solutions.append(["".join("#" if value else "." for value in row) for row in grid])
            return
        choices: list[tuple[str, int, int]] = []
        choices.extend(("row", r, len(domain)) for r, domain in enumerate(rd) if len(domain) > 1)
        choices.extend(("column", c, len(domain)) for c, domain in enumerate(cd) if len(domain) > 1)
        if not choices:
            return
        kind, line, _ = min(choices, key=lambda item: item[2])
        for mask in (rd[line] if kind == "row" else cd[line]):
            next_grid = [row[:] for row in grid]
            next_rd = [domain[:] for domain in rd]
            next_cd = [domain[:] for domain in cd]
            if kind == "row":
                for c in range(width):
                    next_grid[line][c] = (mask >> c) & 1
                next_rd[line] = [mask]
            else:
                for r in range(height):
                    next_grid[r][line] = (mask >> r) & 1
                next_cd[line] = [mask]
            visit(next_grid, next_rd, next_cd)
            if len(solutions) >= limit or timed_out:
                return

    visit(initial_grid, row_domains, column_domains)
    return NonogramResult(solutions, forced, timed_out, ranked_conflicts())


def solution_status(solutions: list[object], timed_out: bool = False) -> str:
    if timed_out:
        return "too_hard"
    if not solutions:
        return "invalid"
    return "solved" if len(solutions) == 1 else "multiple"

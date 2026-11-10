"""Regenerate the deterministic, known-solution 5,000-case Sudoku corpus."""

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent))
from server.main import unique_solution


OUTPUT = ROOT / "data" / "sudoku_5000.jsonl"
BASE = "".join(str((row * 3 + row // 3 + column) % 9 + 1) for row in range(9) for column in range(9))


def transformed_solution(rng: random.Random) -> str:
    digits = list("123456789")
    rng.shuffle(digits)
    bands = rng.sample(range(3), 3)
    rows = [band * 3 + inner for band in bands for inner in rng.sample(range(3), 3)]
    stacks = rng.sample(range(3), 3)
    columns = [stack * 3 + inner for stack in stacks for inner in rng.sample(range(3), 3)]
    transposed = rng.choice((False, True))
    result = []
    for row in range(9):
        for column in range(9):
            source_row, source_column = rows[row], columns[column]
            if transposed:
                source_row, source_column = source_column, source_row
            result.append(digits[int(BASE[source_row * 9 + source_column]) - 1])
    return "".join(result)


def main() -> None:
    rng = random.Random(20261030)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    seen = set()
    cases = []
    attempts = 0
    while len(cases) < 5000:
        attempts += 1
        solution = transformed_solution(rng)
        puzzle = list(solution)
        for index in rng.sample(range(81), rng.randint(18, 36)):
            puzzle[index] = "0"
        puzzle = "".join(puzzle)
        if puzzle in seen:
            continue
        solved = unique_solution(puzzle)
        if solved.get("status") != "solved" or solved.get("solution") != solution:
            continue
        seen.add(puzzle)
        cases.append({"puzzle": puzzle, "solution": solution})
    OUTPUT.write_text("".join(json.dumps(case, separators=(",", ":")) + "\n" for case in cases), encoding="utf-8")
    print(f"Wrote {len(cases):,} unique, verified cases to {OUTPUT} after {attempts:,} candidates.")


if __name__ == "__main__":
    main()

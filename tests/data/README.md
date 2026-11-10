# Sudoku regression corpus

`sudoku_5000.jsonl` contains 5,000 deterministic, unique Sudoku puzzles and their known solutions. The cases are generated from valid completed grids using digit relabeling, band/row and stack/column permutations, optional transposition, and 18–36 removed clues. The generator keeps a case only after the project solver reports that exact solution as unique.

Regenerate it with `.venv\Scripts\python.exe tests\generate_sudoku_corpus.py`. The test verifies every stored solution and repeats uniqueness solving for all 5,000 puzzles. This synthetic solver corpus does not replace the separate labeled photo set needed to measure recognition accuracy.

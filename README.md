# Puzzl — AI-Powered, Local-First Puzzle Solving System

<p align="center">
  <img src="web/assets/icon.svg" alt="Puzzl Logo" width="96" height="96" />
</p>

<p align="center">
  <strong>A deterministic, privacy-first puzzle companion for Sudoku, KenKen, Killer Sudoku, Nonograms, Logic Grids, Chess, and Rubik's Cube.</strong>
</p>

<p align="center">
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/Python-3.10%2B-blue.svg?style=flat-square" alt="Python 3.10+" /></a>
  <a href="https://fastapi.tiangolo.com/"><img src="https://img.shields.io/badge/FastAPI-0.115%2B-009688.svg?style=flat-square" alt="FastAPI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="MIT License" /></a>
  <a href="#verification--test-suite"><img src="https://img.shields.io/badge/Tests-40%20Passed%20(5%2C000%20Corpus)-brightgreen.svg?style=flat-square" alt="Tests" /></a>
  <a href="#core-architecture--privacy-guarantee"><img src="https://img.shields.io/badge/Privacy-Zero--Knowledge%20Vision-blueviolet.svg?style=flat-square" alt="Local-First Privacy" /></a>
</p>

---

## Overview

**Puzzl** is an intelligent, local-first web application engineered to solve, verify, and guide users through complex combinatorial puzzles without spoiling the answer. 

Unlike generic LLM wrappers that guess grid solutions, **Puzzl enforces strict mathematical guarantees**:
1. **Deterministic Exact Solvers:** Every solution and hint is computed with exact constraint algorithms (MRV backtracking, line propagation, alpha-beta minimax, or two-phase Kociemba). The LLM is **never** permitted to hallucinate answers.
2. **Pedagogical, Progressive Hinting:** Offers 3 tiers of help — a subtle *Nudge*, a structured *Logical Step*, or a verified *Full Walkthrough*.
3. **Zero-Knowledge Privacy:** Camera streams, photo uploads, and screen capture frames remain **strictly on your local browser canvas**. Image pixels are never uploaded or retained on the server.
4. **Bounded Natural-Language Interpretation:** Natural-language clues (e.g. Zebra/Einstein puzzles) are parsed by Claude via Anthropic or OpenRouter into a strict, validated constraint schema that must be mapped to source clues before the solver accepts them.

---

## Architecture

```mermaid
flowchart TD
    subgraph Client ["Client Browser (Local Canvas & Web Worker)"]
        UI["Web UI / PWA Shell"]
        CV["Local Canvas CV (Homography, Warping, Projection)"]
        Worker["Cube Solver Worker (Kociemba Two-Phase IDA*)"]
        Camera["Webcam / Screen Share / Photo Upload"]
        Camera -->|Raw Pixels Remain Local| CV
        CV -->|Extracted Numeric Grid / FEN| UI
        UI -->|Cube Facelets| Worker
    end

    subgraph Backend ["FastAPI Local Core (Loopback Binding)"]
        Router["FastAPI Application (Port 8000)"]
        SudokuEngine["Sudoku Engine (MRV Backtracking + 8-Level Hint Hierarchy)"]
        VariantEngine["Variant Solver (KenKen, Killer Sudoku, Nonogram Line Propagation)"]
        LogicEngine["Logic Grid Solver (Permutation Permitter + Deduction Intersection)"]
        ChessEngine["Chess Alpha-Beta Engine (Quiescence + Move Continuity Guard)"]
        HistoryDB[("Local SQLite (.data/history.sqlite3)")]
        
        Router --> SudokuEngine
        Router --> VariantEngine
        Router --> LogicEngine
        Router --> ChessEngine
        Router --> HistoryDB
    end

    subgraph AI ["Optional AI Clue Parser & Paraphraser"]
        LLMAdapter["OpenRouter / Anthropic Messages Gateway"]
        CloudClaude["Claude 3.5 Sonnet / Haiku"]
        LLMAdapter <--> CloudClaude
    end

    UI -->|JSON State Only (No Images)| Router
    LogicEngine -.->|Typed Clues Only (Opt-in)| LLMAdapter
```

---

## Supported Puzzles & Solver Algorithms

| Puzzle | Solver Engine / Algorithm | Key Capabilities |
| :--- | :--- | :--- |
| **Sudoku (9×9)** | Minimum Remaining Values (MRV) Backtracking with exact 2-solution counting limit | 8-level human deduction hierarchy (Singles, Locked Candidates, Pairs, Triples, X-Wing, XY-Wing, Swordfish), conflict detection, candidate elimination, cell walkthrough. |
| **KenKen** | Latin Square Constraint Propagation + Arithmetic Partition Search | Interactive cage builder (`+`, `-`, `*`, `/`, `=`), minimal contradiction diagnosis. |
| **Killer Sudoku** | Sudoku Constraints + Cage Sum Partitions with Uniqueness | Full 9×9 cage arithmetic verification, active row walkthrough. |
| **Nonograms (Picross)** | Line-Pattern Constraint Propagation + Depth-First Search | Dynamic programming line intersection, symmetric pattern solver, row-by-row walkthrough. |
| **Logic Grid (Zebra)** | Permutation CSP & Domain Intersection Analysis | Relational builder (`same`, `different`, `left_of`, `next_to`, `immediately_left`, `at_position`), provable deduction discovery, optional AI clue parsing. |
| **Chess** | Minimax with Alpha-Beta Pruning, Quiescence Search & Move Ordering | 64-square photo/screen recognition, FEN editing, fair-play attestation, Principal Variation (PV) replay, move continuity guard. |
| **Rubik's Cube (3×3)** | Herbert Kociemba's Two-Phase Algorithm (Web Worker) | 2D net editor, guided 6-face camera scan, instant optimal move sequence generation, 3D animated playback. |

---

## Quickstart

### Prerequisites
- **Python 3.10+** (Python 3.11, 3.12, 3.13, 3.14 tested)
- Modern web browser (Chrome, Edge, Firefox, Safari)

### 1. Clone & Set Up Virtual Environment

```bash
# Clone the repository
git clone https://github.com/your-username/puzzl.git
cd puzzl

# Create and activate virtual environment
# Windows (PowerShell):
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Linux / macOS:
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Configure Environment (Optional for AI Clues)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` to configure your API key (see [AI Configuration](#ai-configuration)):
```env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

### 3. Run the Application

```powershell
python run.py
```

Open your browser to:
- **Web App:** [http://127.0.0.1:8000](http://127.0.0.1:8000)
- **Interactive OpenAPI Docs:** [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- **Health Check:** [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)

---

## AI Configuration

AI clue interpretation and hint paraphrasing are completely optional. The exact deterministic solvers work fully offline without any API keys.

To enable **natural language clue interpretation** and **AI-phrased hints**, configure `.env` using either **OpenRouter** or direct **Anthropic**:

### Option A: OpenRouter (Recommended)
```env
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-key
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
OPENROUTER_EXPLAINER_MODEL=anthropic/claude-3.5-haiku
```

### Option B: Direct Anthropic API
```env
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
ANTHROPIC_EXPLAINER_MODEL=claude-3-5-haiku-20241022
```

### Privacy & Guardrail Principles
- **No Images Transmitted:** Photo crops and screen pixels are processed on the local HTML5 Canvas. Only typed clue text strings are ever sent to the LLM.
- **Strict JSON Schema Validation:** The LLM's response must conform to a closed JSON schema (`server/schemas.py`).
- **Human Review Gate:** Parsed relations must be mapped back to every source clue and reviewed before the solver accepts them.
- **Rate-Limited:** Provider parsing is capped to prevent unintentional usage spikes.

---

## API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Service status and whether AI explanations are enabled. |
| `POST` | `/v1/solve` | Solves Sudoku/variants; guarantees uniqueness by bounding solutions to at most 2. |
| `POST` | `/v1/hint` | Returns a hierarchical hint (*Nudge*, *Logical Step*, or *Answer*). |
| `POST` | `/v1/explain` | Returns mathematical reasoning; optionally requests verified AI phrasing. |
| `POST` | `/v1/logic/parse` | Converts unstructured natural language clues into a structured constraint schema. |
| `POST` | `/v1/chess/analyze` | Generates best move, evaluation, and PV line under fair-play attestation. |
| `GET/POST`| `/v1/history` | Saves and retrieves session-isolated puzzle history via `X-Session-Id`. |
| `GET` | `/metrics` | Process-local latency percentiles (p50/p95), recognition quality, and token telemetry. |

---

## Verification & Test Suite

The project includes an extensive test suite verifying mathematical correctness, regression avoidance, and security boundaries.

```powershell
# Run the complete test suite (40 tests including 5,000 synthetic Sudoku regression cases)
.\.venv\Scripts\python.exe -m unittest discover -s tests -v

# Verify frontend JavaScript syntax
node --check web\app.js

# Test client-side Rubik's Cube solver
node tests\test_cube_engine.js
```

### Test Coverage Highlights:
- **Sudoku 5,000-Puzzle Frozen Corpus:** Evaluates exact uniqueness and MRV correctness across 5,000 synthetic puzzles without timeouts or false positives.
- **Advanced Logic Techniques:** Unit tests for Naked/Hidden Singles, Pairs, Triples, X-Wing, XY-Wing, and Swordfish candidate eliminations.
- **OpenRouter & Anthropic Adapters:** Mocked and verified schema validation, token accounting, cache hits, and markdown fence sanitization.
- **Fair Play & Security Headers:** Verifies session isolation, strict Content Security Policy (CSP), and chess anti-cheating protections.

---

## Repository Structure

```text
AI-Based PSS/
├── .env.example              # Environment variables template
├── .gitignore                 # Comprehensive git exclusions
├── LICENSE                    # MIT License
├── PRD AI-Based Puzzle...md   # Product Requirements Document
├── TRD AI-Based Puzzle...md   # Technical Requirements Document
├── README.md                  # Project documentation
├── requirements.txt           # Python dependencies
├── run.py                     # Server launcher
├── server/
│   ├── chess_engine.py        # Minimax, Alpha-Beta, PST, legal move generator
│   ├── explainer.py           # Bounded AI paraphrasing adapter
│   ├── llm_metrics.py         # Thread-safe LLM token & cost accounting
│   ├── logic_grid.py          # Relational constraint satisfaction solver
│   ├── logic_parser.py        # Natural language clue schema parser (Claude/OpenRouter)
│   ├── main.py                # FastAPI routes, MRV Sudoku solver, history DB
│   ├── schemas.py             # Strict Pydantic request/response validation
│   └── variants.py            # KenKen, Killer Sudoku & Nonogram engines
├── tests/
│   ├── data/sudoku_5000.jsonl # 5,000-case frozen regression corpus
│   ├── test_cube_engine.js    # Node.js two-phase cube solver check
│   └── test_solvers.py        # 40-case comprehensive test suite
└── web/
    ├── app.js                 # PWA frontend, local canvas CV & UI logic
    ├── cube-worker.js         # Dedicated Web Worker for 3D cube solving
    ├── index.html             # Accessible, responsive interface
    ├── styles.css             # High-contrast, clean UI styling
    └── vendor/cubejs/         # Local Two-Phase Kociemba solver
```

---

## Fair Play Policy (Chess)

The Chess analysis module is designed exclusively for:
- Solving chess puzzles and tactical studies.
- Post-game review and analysis of finished games.
- Studying against local bots or training engines.

Using this tool during live, rated competitive games against human opponents is strictly prohibited. The UI enforces a mandatory fair-play confirmation modal, and the backend tracks move continuity to detect and deter illegal position injections.

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
All bundled third-party libraries (including `cubejs`) are MIT-compatible.

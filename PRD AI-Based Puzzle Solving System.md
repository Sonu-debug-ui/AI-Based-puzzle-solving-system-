# PRD: AI-Based Puzzle Solving System

Oct 14, 2026 · @Sonu

## Overview

The system takes a puzzle as a photo, screenshot,  or typed text, solves it exactly, and explains the solution in human-followable steps. The AI handles reading the puzzle and teaching the answer; a deterministic solver does the solving.

**Scope assumption (confirm or change):** v1 covers grid-constraint puzzles (Sudoku and variants, KenKen, Nonograms) and text-described logic grid puzzles ("zebra" puzzles). Crosswords and jigsaws are out of scope for v1. Live screen and camera solving for chess and the Rubik's Cube is an advanced mode added after v1 (see Advanced live modes).

**Problem.** People get stuck mid-puzzle and want a hint, not a spoiler. Existing solvers either dump the full answer with no reasoning, or need the grid retyped by hand. Pure-LLM solvers fail often on constraint puzzles because they guess instead of checking every constraint \[Likely\].

**Product thesis.** Use a vision model to read the puzzle, an LLM to translate rules into formal constraints, a constraint solver to guarantee correctness, and an LLM again to turn the solver's deductions into plain-language hints.

## Goals, non-goals and metrics

The v1 goal is a solver users trust: correct on every solvable puzzle, and able to teach rather than just answer.

**Goals**

- Solve supported puzzle types with 100% correctness on valid inputs (solver-verified, not model-guessed)
- Read a puzzle from a photo with at least 97% cell-level accuracy on clean prints and screenshots
- Offer three help levels: nudge, targeted hint, full solution with reasoning
- Return a first hint in under 5 seconds for a standard 9×9 puzzle

**Non-goals (v1)**

- Crosswords and other knowledge-retrieval puzzles
- Jigsaws and physical puzzles other than the Rubik's Cube
- Generating new puzzles
- Competitive or timed play modes

**Success metrics**

| Metric | Target | How measured |
| --- | --- | --- |
| Solution correctness | 100% on valid puzzles | Automated check against solver output on a 5,000-puzzle test set |
| Photo-to-grid accuracy | ≥ 97% cells correct | Labeled test set, clean and noisy photos separately |
| Time to first hint (9×9) | < 5 s at p95 | Server-side latency logging |
| Hint helpfulness | ≥ 80% rated helpful | In-app thumbs up/down |
| Week-4 retention | ≥ 25% | Product analytics |

Targets are initial proposals \[Guessing\]; calibrate after a prototype run on real photos.

## Target users

Three personas drive the design, with the stuck hobbyist as the primary one.

| Persona | Need | What they must not get |
| --- | --- | --- |
| Stuck hobbyist (primary) | One hint to get unstuck on a newspaper or app puzzle | A full spoiler by default |
| Learner | Understand techniques like naked pairs or X-wing | A bare answer with no reasoning |
| Puzzle creator or editor | Check that a puzzle has exactly one solution | A solver that silently picks one of several answers |

## User stories

- As a hobbyist, I photograph my newspaper Sudoku and get the next logical move highlighted.
- As a hobbyist, I ask for a nudge first ("look at box 5"), then a specific hint, then the answer.
- As a learner, I see which technique a hint uses, with a short explanation.
- As a creator, I paste a puzzle and learn whether it has zero, one, or several solutions.
- As any user, I correct a misread cell before solving, so a bad photo does not give a wrong answer.
- As a logic-puzzle fan, I paste the clues of a zebra puzzle in plain text and get the filled grid with the order of deductions.

## Functional requirements

P0 is the minimum for a launchable MVP; P1 follows within v1; P2 is post-v1.

| ID | Requirement | Priority |
| --- | --- | --- |
| F1 | Input via photo upload, screenshot, or typed/pasted grid | P0 |
| F2 | Vision pipeline detects the grid and reads given digits, with per-cell confidence | P0 |
| F3 | Editable grid so users fix misread cells before solving; low-confidence cells highlighted | P0 |
| F4 | Exact solver for Sudoku with uniqueness check (0, 1, or many solutions) | P0 |
| F5 | Three help levels: nudge, hint, full solution | P0 |
| F6 | Hints name the technique used (e.g. naked single, hidden pair) and highlight the cells involved | P1 |
| F7 | Variants: KenKen, Nonograms, Killer Sudoku | P1 |
| F8 | Text logic puzzles: LLM converts clues to constraints; solver fills the grid | P1 |
| F9 | Step-by-step replay of the full solution | P1 |
| F10 | Detect invalid puzzles and explain the contradiction | P1 |
| F11 | Save history and resume unfinished puzzles | P2 |
| F12 | Difficulty rating based on the hardest technique required | P2 |

## Non-functional requirements

- **Correctness:** every displayed solution is verified by the solver against the puzzle's rules before it reaches the user; an LLM output is never shown as a solution unverified.
- **Latency:** first hint under 5 s at p95 for 9×9; photo-to-grid under 4 s at p95.
- **Cost:** under $0.01 per solved puzzle at launch volume. The solver is cheap; the cost sits in vision and explanation calls \[Likely\].
- **Reliability:** if the vision or LLM service is down, typed-grid input and the solver still work.
- **Privacy:** uploaded photos are processed and deleted within 24 hours unless the user saves history; no photos used for model training without opt-in.
- **Accessibility:** keyboard-only grid editing, screen-reader labels per cell, high-contrast highlights.

## Advanced live modes

Live modes add a capture stage in front of the same solver pipeline. Chess on a screen is the cheapest to ship; a live camera on a cube or a physical board is the hardest and ships last. These land after v1; the roadmap below places them as v1.5 and v2.

| Mode | Input | Engine | Difficulty | Phase |
| --- | --- | --- | --- | --- |
| Screen reader: Sudoku, logic grids | Screen share of a tab, window or screen | Existing solver | Medium | v1.5 |
| Screen chess (chess.com, lichess, apps) | Screen share, board region | Chess engine | Medium: digital pieces render cleanly, but every theme differs | v1.5 |
| Live camera: Rubik's Cube | Camera, six faces scanned in turn | Cube solver (two-phase algorithm) | High: sticker colors shift with lighting | v2 |
| Live camera: physical chess board | Camera over the board | Chess engine | Highest: angle, glare, hands blocking pieces | v2 |

| ID | Requirement | Priority |
| --- | --- | --- |
| L1 | Browser screen capture: user picks a tab, window or screen; a visible indicator shows while capturing | P1 |
| L2 | Drag-select the puzzle region; remember it per site | P1 |
| L3 | Sample a few frames per second and run recognition only when the board changes | P1 |
| L4 | Chess: recognize board and pieces into a position (FEN), return the best move with a short reason, draw arrows on the board | P1 |
| L5 | Cube: guided scan of six faces with an overlay, a color confirmation grid, a legality check before solving, then a move list with 3D replay | P2 |
| L6 | Physical chess: board corner detection, piece classification, move tracking from video | P2 |
| L7 | Desktop app with an always-on overlay above other windows | P2 |
| L8 | Privacy: frames processed on-device where possible, never stored, capture indicator always visible | P0 for any live mode |

**Feasibility notes**

- The browser can capture a tab, window or screen after the user grants permission each session \[Certain\]. A persistent overlay above other apps needs a desktop app \[Likely\].
- Run recognition on changed frames only, and run the chess engine on-device (WebAssembly build) to keep latency low \[Likely\]. A first suggestion in under 2 s is the proposed target \[Guessing\].
- Cube solving is solved math: a two-phase algorithm returns a short solution once the state is read correctly, so accuracy depends on color reading, not the solver \[Certain\]. Check that the scanned state is a legal cube before solving; an illegal state means a misread sticker.
- Recognizing pieces from a rendered screen is far easier than from a camera; train on several board and piece themes \[Likely\].

**Fair-play risk (decision needed).** Suggesting moves during a live rated game breaks the rules of chess.com and lichess, and users can be banned \[Certain\]. A screen reader cannot reliably tell a rated game from an analysis board \[Li kely\]. I recommend positioning chess as analysis and learning (finished games, puzzles, bot games, reviewing your own board), with a clear policy notice, and not marketing it for use against live opponents. Decide this before building L4.

## System architecture and AI approach

The LLM never produces a solution: it reads the puzzle, translates text rules, and explains deductions, while an exact solver decides every answer.

&#91;embedded content: system pipeline · 8 stages\]

Input passes through a user-confirmed grid into the solver; the solver's verified result goes to the explainer, which writes each hint.

**Design decisions**

- **Vision:** start with an off-the-shelf vision-language model; train a dedicated digit classifier only if accuracy stays under the 97% target \[Guessing\].
- **Solver:** a constraint or SAT solver guarantees correctness and counts solutions \[Certain\]. It finds answers, not human-style steps, so hints also need a technique-based logic engine (naked singles, pairs, and so on) \[Likely\].
- **Explainer:** the LLM receives only deductions the logic engine already produced, so it cannot invent a move \[Likely\].
- **Fallback:** if the logic engine finds no technique that makes progress, the hint says so and offers the solver's answer for one cell.

## UX flow

The core loop is capture, confirm, help. The confirm step is deliberate: a misread digit is the most likely cause of a wrong answer.

1. **Capture:** camera, upload, or paste; puzzle type auto-detected, with a manual override.
2. **Confirm:** the recognized grid appears as an editable board; cells under the confidence threshold are highlighted.
3. **Choose help:** nudge, hint, or full solution; the default is nudge.
4. **Hint view:** highlighted cells on the board, the technique name, and a two-sentence explanation.
5. **Finish:** full solution replay, or return to the user's own solving.

## Risks, assumptions and open questions

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Vision misreads digits on curved, shadowed, or handwritten pages | High | High | Confirm step; per-cell confidence; handwriting out of v1 |
| LLM mistranslates text clues into wrong constraints | Medium | High | Show parsed constraints to the user; solver checks that the result satisfies every original clue |
| Hints are correct but unhelpful or too advanced | Medium | Medium | Technique tagging; start with the weakest technique that makes progress |
| Users want spoilers but resent being gated | Low | Low | One-tap "show answer" always available |
| Per-request model cost grows with usage | Medium | Medium | Cache by puzzle hash; small vision model first, escalate on low confidence |
| Chess suggestions used to cheat in live rated games | High | High | Position as analysis and learning; show a policy notice; do not market against live opponents; decide before building L4 |
| Cube sticker colors misread under uneven lighting | High | High | Guided scan with an overlay; color confirmation grid; legality check before solving |
| Hands, glare and camera angle break physical-board piece detection | High | Medium | Defer to v2; start with a fixed top-down view |
| Screen capture feels invasive | Medium | High | Visible capture indicator; user picks the region; on-device processing; nothing stored |
| Live frame processing is too slow or too costly | Medium | Medium | Recognize only on changed frames; run the chess engine on-device |

**Assumptions:** the primary platform is a mobile-first web app \[Guessing\]; users accept an edit step after scanning \[Likely\].

**Open questions**

- Which platform first: web, Android, or both?
- Free tier limits, and is there a paid plan?
- Is handwritten input in or out of v1? (This document assumes out.)

## Milestones and release plan

Release in five phases; each gate is a target from the success metrics, and a phase starts only after the gate before it passes.

&#91;embedded content: release roadmap · 5 phases, 4 gates\]

The MVP is launchable once all P0 requirements are in; add dates when the team and the first platform are confirmed.

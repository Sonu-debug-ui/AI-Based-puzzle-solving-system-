# TRD: AI-Based Puzzle Solving System

Oct 26, 2026 · @Sonu

## Purpose, scope and platform decision

This TRD turns the PRD into a buildable design: a hybrid system where on-device recognizers read the puzzle, exact solvers and engines decide every answer, and an LLM only translates rules and explains verified deductions.

**In scope:** grid puzzles (Sudoku, KenKen, Nonograms, Killer Sudoku), text logic puzzles, and the live modes (screen share, camera) for Sudoku, chess and the Rubik's Cube, phased as in the PRD roadmap: MVP, v1, v1.5, v2.

**Platform decision (needs your confirmation).** Web-first progressive web app (PWA) for photo and camera input on every device, plus screen sharing on desktop browsers. Screen sharing from a browser is a desktop feature; mobile browsers generally do not offer it \[Likely\], so a phone screen reader needs a native app, and an always-on overlay needs a desktop app. This TRD plans a PWA for v1, desktop browser screen share for v1.5, and a native desktop app (overlay) for v2. Phone screen reading is out of scope until a native app is funded.

**Assumptions**

- Frames from camera and screen stay on the device; only recognized puzzle state is sent to the server \[Likely feasible with WebAssembly models\].
- The solver, never the LLM, produces answers; every LLM output is validated before display.
- The product never controls the user's mouse or keyboard and never enters moves into a game.

## System architecture

Recognition and the live engines run on the device; the server holds the exact solvers, the LLM gateway and the data stores, and receives state, not images.

&#91;embedded content: architecture · device and server\]

The confirmed state goes to the API gateway; the solver service answers, and the LLM gateway turns its verified deductions into text.

**Data flow**

1. Capture a photo, camera frame or screen frame.
2. Recognize on-device, with per-cell confidence; the user confirms uncertain cells.
3. Send the confirmed state to the API, never the image.
4. For text puzzles, the LLM gateway first converts clues to constraints; the solver service then solves and checks them.
5. The explainer turns verified deductions into a hint, and the client draws arrows and text.

Chess and cube live modes run their engines on-device; the server is called only for written explanations.

## Technology stack and decisions

Choices favor exact, open-source solvers and on-device recognition. Two licensing flags need a decision before launch: the chess engine and the cube-solver library.

| Layer | Choice | Why | Alternative or flag |
| --- | --- | --- | --- |
| Client | React + TypeScript PWA | One codebase for photo, camera and desktop screen share | Native apps later for phone screen reading and the overlay |
| Screen capture | Browser screen-capture API | No install; works on desktop browsers \[Likely\] | Desktop app (v2) for an always-on overlay |
| Camera | Browser camera API | Supported on current browsers \[Certain\] | Limited exposure and focus control on the web \[Likely\] |
| Image processing | OpenCV.js | Grid contours, perspective warp, board homography | Hand-written warp if bundle size hurts |
| On-device ML | ONNX Runtime Web (WASM, GPU where available) | Small models run offline, so frames stay local \[Likely\] | TensorFlow.js |
| Constraint solver | OR-Tools CP-SAT (Apache-2.0) | Exact, and can count solutions for the uniqueness check \[Certain\] | SAT solver |
| Sudoku logic engine | Own code: naked/hidden singles, pairs, and so on | CP solvers find answers but cannot explain them; hints need human techniques \[Likely\] | None; this is core IP |
| Chess engine | Stockfish (WebAssembly build) | Strongest open engine; runs on-device \[Certain\] | **Flag:** GPL-3.0, so shipping it in the client carries copyleft duties; get legal review or run it server-side |
| Cube solver | Two-phase (Kociemba) algorithm | Short solutions fast once the state is correct \[Certain\] | **Flag:** check each library's license; some are GPL. Writing our own is feasible \[Likely\] |
| Backend | Python (FastAPI) | First-class OR-Tools support; async APIs \[Likely\] | Node for the gateway only |
| LLM | Claude API behind our own gateway | Structured JSON output; prompt caching | Faster, cheaper model for explanations; stronger model for clue parsing \[Likely\] |
| Data | PostgreSQL, Redis, object storage | History and accounts; cache by puzzle hash; photos kept 24 h only if the user opts in | Anonymous sessions until history ships (P2) |
| Hosting | Static client on a CDN; stateless API containers with autoscaling | Cheap to scale; solver calls are short \[Likely\] | Serverless functions |

## Component design

Each component has one job and a check that catches its most likely failure, because a misread or a wrong rule is more likely than a wrong solve.

**Capture and sampling**

- Photos are resized to a fixed working size before processing.
- Camera and screen modes sample a few frames per second, compare the board region against the previous sample, and recognize only after the region has been stable across consecutive samples. This skips animations, moving pieces and hands.

**Grid recognizer (Sudoku, KenKen, Nonograms)**

- Find the largest quadrilateral outline, warp it to a square, split it into cells, and classify each cell's digit with a small on-device model that returns a confidence per cell.
- Cells under a confidence threshold are highlighted in the confirm step. The threshold is set on a validation set, not guessed.
- Cage borders for KenKen and Killer Sudoku are harder than digits and are why those variants sit in v1, not the MVP \[Likely\].

**Chess recognizer**

- Screen: locate the board, normalize it, classify each of the 64 squares as one of 12 pieces or empty, detect which side is at the bottom, and output a position string (FEN).
- Camera: detect the four board corners, warp to a top-down view, then reuse the square classifier, trained with perspective and glare augmentation; skip frames where a hand covers the board.
- Guard: a new position must be reachable from the previous one by one legal move; otherwise treat it as a misread and wait for the next stable frame \[Likely effective\].

**Cube recognizer**

- Guided scan: an overlay frames each face in turn. The six center stickers fix the six color references, and the other 48 stickers are assigned to the nearest reference in a perceptual color space \[Likely\].
- The user confirms the 54-sticker grid. Before solving, check that each color appears nine times and that edge and corner pieces and parity are legal \[Certain\]. A failed check points at a misread sticker.

**Solvers and engines**

- Grid puzzles: one constraint model per puzzle type; ask for up to two solutions to get zero, one or many.
- Text logic puzzles: the LLM emits constraints in a fixed schema; the solver enforces them; a verifier replays every original clue against the result.
- Chess: on-device engine with a fixed time budget, returning the best move, its score and the main line.
- Cube: two-phase search with a move and time cap.

**Hint engine (Sudoku and grid puzzles)**

- Try techniques from simplest to hardest and return the first that makes progress, with the cells and candidates it uses.
- Help levels: nudge names the region; hint names the technique and cells; answer gives the value.
- If no technique applies, say so and offer the solver's value for one cell.

**LLM gateway**

- Clue parsing: strict schema validation, one retry on a violation, and the parsed constraints shown to the user.
- Explanations: the input is a structured deduction or engine line, never the raw puzzle image or page. The prompt forbids new moves, and a cheap check confirms the text names only cells and values from the input \[Likely\].
- Text read from a screenshot is treated as data, never as instructions.
- Results are cached by a hash of the deduction.

## Data models and API

Every puzzle is a small typed state object. Only these objects cross the privacy boundary, which keeps requests tiny and keeps images off the server.

**State examples**

```json
{"type": "sudoku", "size": 9, "cells": "530070000600195000098000060800060003400803001700020006060000280000419005000080079"}
{"type": "chess", "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}
{"type": "cube", "facelets": "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB"}
```

The Sudoku string lists 81 cells row by row with 0 for empty. The cube string lists 54 stickers in the order up, right, front, down, left, back, which is the input format the two-phase solver expects \[Certain\]. Text logic puzzles carry the categories, their values and the clue sentences; KenKen and Killer Sudoku add a list of cages with a target and an operation.

**Endpoints**

| Endpoint | Input | Output |
| --- | --- | --- |
| POST /v1/solve | State, option to count solutions | Status (solved, invalid, multiple), solutions found, the solution when unique |
| POST /v1/hint | State, help level (nudge, hint, answer) | Technique name, cells involved, short explanation |
| POST /v1/logic/parse | Clue text | Constraints in the fixed schema, plus warnings for clues it could not parse |
| POST /v1/explain | Chess position and engine line | Short written idea for the move |
| POST /v1/recognize | Image, only after opt-in | State plus per-cell confidence |
| GET /v1/history | Session or account | Saved puzzles (P2) |

**Conventions**

- Invalid puzzles return the reason and the conflicting cells, not a bare error, so the client can highlight them.
- Requests carry an anonymous session token until accounts ship; the gateway rate-limits per token and per IP.
- Responses never echo input images; recognition confidences are returned as numbers per cell.

## Performance, latency and cost budgets

The budgets come from the PRD targets; stage splits are proposals to be replaced with measurements from the first prototype \[Guessing\].

**End-to-end targets (from the PRD)**

- Photo to editable grid: under 4 s at p95
- First hint for a 9×9 puzzle: under 5 s at p95
- Live chess suggestion: under 2 s (proposed target)
- Cost: under $0.01 per solved puzzle

**Live path budget (proposed)**

| Stage | Budget | Note |
| --- | --- | --- |
| Sample and wait for a stable board | 300 ms | Skip frames with motion or hands |
| Recognize board and pieces | 300 ms | On-device model |
| Engine search | 800 ms | Fixed time budget, best line so far |
| Draw the arrow | 100 ms | Shown before any text |
| Written explanation | Streams after | Requested on demand; never blocks the arrow |

The stages above total 1.5 s, which leaves 0.5 s of margin inside the 2 s target.

**Scaling and cost controls**

- Solver calls for 9×9 grids are short; give every call a time cap and return a clear "too hard" status instead of hanging \[Likely\].
- LLM calls happen only for text-puzzle parsing and for explanations; results are cached by a hash of the input, and live-mode explanations run only when the user asks.
- On-device models load lazily per puzzle type and are cached by a service worker, so a returning user downloads nothing \[Likely\].
- API containers are stateless and autoscale on request rate and solver queue depth.

## Security, privacy and fair-play controls

The strongest privacy control is architectural: frames never leave the device, so there is nothing to leak, subpoena or train on.

**Privacy**

- Camera and screen frames are processed in the browser; only recognized state is sent to the server.
- Server-side vision is an explicit opt-in per image; those images are deleted within 24 hours, matching the PRD.
- Screen capture always shows a visible indicator, lets the user pick the tab, window or region, and stops when the user stops sharing.
- Corrections users make in the confirm step are useful training labels. Store them only with separate opt-in consent and strip any image data.
- Which data-protection laws apply (for example India's DPDP Act or the GDPR) depends on where users are; get legal review before launch \[Likely needed\].

**Application security**

- Validate every request against its state schema; reject oversized strings and unknown fields.
- Rate-limit per session token and IP; cap solver time per call.
- Keep API keys for the LLM on the server only; the client never calls the model directly.
- Prompt-injection defense: text recognized from screens or photos is data. It goes into prompts inside delimiters, outputs must match a strict schema, and the solver checks the result, so injected text cannot change an answer.
- Serve the client with a strict content security policy and pinned, integrity-checked model files.

**Fair-play controls (chess)**

- Read-only by design: the product never moves the mouse, types, or enters moves into any game or site.
- Live suggestions are off by default and turn on only after the user confirms they are analyzing a finished game, a puzzle or a bot game; show the policy notice at that point. This implements the PRD's fair-play decision \[Guessing that attestation is enough; legal and trust review should confirm\].
- The system cannot reliably detect a rated live game from pixels alone \[Likely\], so the control rests on product positioning and attestation, not detection.
- Keep this feature behind a flag so it can be narrowed or removed without a release.

## Testing and evaluation plan

Solvers are tested for exactness; recognizers and hints are tested on data, against the PRD targets.

| Area | Test | Pass condition |
| --- | --- | --- |
| Solvers | Property tests: every returned solution satisfies all rules; uniqueness count matches a reference solver | 100% on the 5,000-puzzle test set |
| Grid recognizer | Labeled photos and screenshots, clean and noisy reported separately, plus synthetic photos with perspective, shadow and blur | 97% or better cell accuracy on clean inputs |
| Chess recognizer | Positions rendered in many board and piece themes from public game archives; separate camera set with glare and hands | Report accuracy per theme; no theme below the clean-input target \[Guessing on the exact bar\] |
| Cube recognizer | Scrambles photographed under several lighting conditions | Legality check catches every misread; measure how often the user must fix a sticker |
| Hint engine | Compare named techniques against a reference solver on graded puzzles; human review of a sample | Every hint's claim is valid; 80% or more rated helpful in-app |
| LLM parsing | Set of text logic puzzles with known solutions | Solver result matches the known answer; every parse error is surfaced to the user, never silent |
| Latency | Load and device tests on mid-range laptop and phone | Meets the budgets in the performance section |

**Process**

- Run solver and schema tests on every commit; run recognizer accuracy reports nightly and block releases that drop below target.
- Keep a frozen test set that is never used for training, and refresh a separate validation set as real corrections arrive (with consent).
- Test fair-play behavior directly: with the attestation unset, live chess suggestions must not appear.

## Deployment, observability and operations

Ship small, flag every live mode, and measure accuracy in production without storing images.

**Deployment**

- The client is a static build on a CDN; model files are versioned and served with integrity hashes.
- The API runs as stateless containers behind an autoscaler, with separate pools for the solver service (CPU-heavy) and the gateway.
- Feature flags control each live mode: screen reader, screen chess, cube camera, board camera, overlay. Any of them can be turned off without a release.
- Staging mirrors production and replays the test sets before every release.

**Observability**

- Metrics: p50 and p95 latency per endpoint and per on-device stage, solver timeouts, LLM schema-violation rate, cache hit rate, cost per solved puzzle.
- Quality signals without images: the share of cells or stickers users correct in the confirm step, hint thumbs up or down, and the rate of illegal-position rejections.
- Alerts: p95 latency above target, schema-violation rate rising, solver timeout rate rising, cost per puzzle above the PRD ceiling.
- Logs carry request IDs and puzzle hashes, never images or free text from the screen.

**Operations**

- LLM provider outage: typed-grid input and the solver keep working; explanations fall back to the technique name and highlighted cells.
- Model rollout: ship a new recognizer to a small share of users first and compare correction rates before widening.

## Technical risks and open questions

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Browsers lack screen sharing on phones | High | High | Desktop browser for v1.5; native apps only if phone screen reading is funded |
| Stockfish and some cube libraries are GPL | High | Medium | Legal review before shipping them in the client; run server-side, choose permissive libraries, or write our own cube solver |
| On-device models too large or slow on low-end phones | Medium | Medium | Small quantized models; lazy loading; fall back to opt-in server vision |
| Recognizer accuracy drops on unseen themes or lighting | High | High | Per-theme and per-lighting test sets; confirm step; legality and move-continuity checks |
| LLM misparses clues in text logic puzzles | Medium | High | Fixed schema; user sees parsed constraints; solver replays original clues |
| Hint engine misses techniques, so hints stall | Medium | Medium | Fall back to a solver value for one cell; log stalls to add techniques |
| Always-on overlay needs OS permissions and a desktop app | Medium | Medium | Defer to v2; scope as a separate packaging effort |

**Open questions**

- Is a native desktop app in scope for v2, or does v2 stay browser-only and drop the overlay?
- Ship Stockfish in the client (accepting GPL duties) or run it on our servers (adding cost and latency)?
- Is the fair-play attestation enough, or should live chess suggestions be limited to analysis boards, bot games and finished games only?
- Do users need accounts at launch, or do anonymous sessions suffice until history ships?
- Which languages and puzzle-book layouts must the grid recognizer support at launch?

## Implementation plan by phase

Build the exact parts first and the perception parts second, so every later error can be traced to the recognizer, not the solver. Phases and exit gates match the PRD roadmap; no dates are set.

| Phase | Technical deliverables | Exit gate |
| --- | --- | --- |
| Prototype | Typed-grid input, Sudoku constraint model with uniqueness check, solve endpoint, test harness and the 5,000-puzzle set | 100% solver accuracy on the test set |
| MVP (P0) | Photo-to-grid recognizer, editable confirm step, basic hint engine with three help levels, LLM explainer with checks, privacy rules, PWA shell | 97% cell accuracy on clean inputs; first hint under 5 s at p95 |
| v1 (P1) | Technique tagging, KenKen, Nonograms and Killer Sudoku models, text logic parsing with solver replay, invalid-puzzle explanations | 80% of hints rated helpful; fair-play policy set |
| v1.5 (live) | Screen capture and region select, change detection, on-device chess recognizer and engine with arrows, screen Sudoku, engine license decision | Live suggestion under 2 s (proposed target) |
| v2 (P2) | Cube scan, solver and 3D replay, physical-board camera, desktop app with overlay, history, difficulty rating | Set after v1.5 measurements |

**First technical steps**

- Decide the platform question (web first, desktop browser for screen share, native only later).
- Decide the Stockfish license route before any chess work starts.
- Build the test sets alongside the solver, since every later gate depends on them.

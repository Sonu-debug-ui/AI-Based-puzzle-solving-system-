const SAMPLE = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const VISUAL_MATCH_REVIEW_THRESHOLD = 0.55;
const VISUAL_MATCH_MARGIN_THRESHOLD = 0.08;
const boardElement = document.querySelector("#sudokuBoard");
const statusCard = document.querySelector("#statusCard");
const hintButton = document.querySelector("#hintButton");
const solveButton = document.querySelector("#solveButton");
let board = "0".repeat(81);
let original = board;
let selectedLevel = "nudge";
let aiExplanationAvailable = false;
let highlighted = [];
let eliminationHighlights = [];
let conflicting = [];
let uncertain = [];
let confidenceScores = [];
let confidenceMargins = [];
let solutionView = false;
let walk = null;
let installPrompt = null;
let photoReviewPending = false;
let photoRecognition = null;
let photoImage = null;
let photoRectangle = null;
let photoCorners = [];
let photoCornerMode = false;
let dragStart = null;
let photoUrl = null;
let screenStream = null;
let screenVideo = null;
let screenFrameHandle = null;
let screenMonitorCanvas = null;
let screenSnapshot = null;
let screenSampleTime = 0;
let screenChangeTime = 0;
let screenStableSamples = 0;
let currentHistoryId = null;
let currentHistoryTitle = null;
let puzzleType = "sudoku";
let activeStructuredState = null;
let cubeWorker = null;
let cubeSolutionMoves = [];
let cubeStates = [];
let cubeStep = 0;
let cubeCameraStream = null;
let cubeCameraFaces = [];
let cubeCenterColors = {};
let cageEditorType = "";
let cageEditorSize = 3;
let cageEditorGivens = "000000000";
let cageEditorCages = [];
let cageEditorDraft = [];
let cageEditorConflictCells = [];
let logicEditorCategories = {};
let logicEditorConstraints = [];
let logicEditorOriginalClues = [];
let chessPvLine = [];
let chessPvHistory = [];
let chessPvIndex = 0;
let chessUncertainSquares = [];
let chessPhotoSource = false;
const PIECE_CYCLE = [".", "P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k"];
const CUBE_FACE_OFFSETS = { U: 0, R: 9, F: 18, D: 27, L: 36, B: 45 };
const CUBE_SCAN_GUIDE = {
  U: "Keep the B center at the top and the R center on the right.",
  R: "Keep the U center at the top and the B center on the right.",
  F: "Keep the U center at the top and the R center on the right.",
  D: "Keep the F center at the top and the R center on the right.",
  L: "Keep the U center at the top and the F center on the right.",
  B: "Keep the U center at the top and the L center on the right.",
};
const sessionId = (() => {
  const key = "puzzl.sessionId";
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  return value;
})();

const cells = [];

function buildBoard() {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 81; index += 1) {
    const input = document.createElement("input");
    input.className = "sudoku-cell";
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 1;
    input.dataset.index = String(index);
    input.setAttribute("aria-label", `Row ${Math.floor(index / 9) + 1}, column ${(index % 9) + 1}`);
    input.addEventListener("input", () => onCellInput(index, input.value));
    input.addEventListener("keydown", (event) => onCellKeydown(event, index));
    input.addEventListener("focus", () => {
      cells.forEach((cell) => cell.classList.remove("selected", "related"));
      input.classList.add("selected");
      const row = Math.floor(index / 9);
      const column = index % 9;
      cells.forEach((cell, other) => {
        if (other !== index && (Math.floor(other / 9) === row || other % 9 === column ||
          (Math.floor(Math.floor(other / 9) / 3) === Math.floor(row / 3) && Math.floor((other % 9) / 3) === Math.floor(column / 3)))) {
          cell.classList.add("related");
        }
      });
      input.setAttribute("aria-label", `Row ${row + 1}, column ${column + 1}${board[index] !== "0" ? `, ${board[index]}` : ", empty"}`);
    });
    cells.push(input);
    fragment.appendChild(input);
  }
  boardElement.appendChild(fragment);
  paintBoard();
}

function onCellInput(index, raw) {
  const value = raw.replace(/[^1-9]/g, "").slice(-1);
  const next = board.split("");
  next[index] = value || "0";
  board = next.join("");
  uncertain = uncertain.filter((cellIndex) => cellIndex !== index);
  confidenceScores[index] = null;
  if (solutionView) {
    solutionView = false;
    walk = null;
  }
  conflicting = [];
  highlighted = [];
  eliminationHighlights = [];
  if (photoReviewPending) promptPhotoConfirmation();
  else renderEmptyStatus();
  paintBoard();
  if (value && index < 80) cells[index + 1].focus();
}

function onCellKeydown(event, index) {
  const offsets = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
  if (offsets[event.key] !== undefined) {
    event.preventDefault();
    const row = Math.floor(index / 9);
    const column = index % 9;
    let next = index + offsets[event.key];
    if (event.key === "ArrowLeft" && column === 0) next = index;
    if (event.key === "ArrowRight" && column === 8) next = index;
    if (event.key === "ArrowUp" && row === 0) next = index;
    if (event.key === "ArrowDown" && row === 8) next = index;
    cells[next].focus();
  } else if ((event.key === "Backspace" || event.key === "Delete") && board[index] !== "0") {
    event.preventDefault();
    onCellInput(index, "");
    cells[index].focus();
  }
}

function paintBoard() {
  document.querySelector("#eliminationLegend").hidden = eliminationHighlights.length === 0;
  cells.forEach((cell, index) => {
    const value = board[index] === "0" ? "" : board[index];
    cell.value = value;
    cell.classList.toggle("given", original[index] !== "0" && !solutionView);
    cell.classList.toggle("answer", solutionView && original[index] === "0" && value !== "");
    cell.classList.toggle("highlight", highlighted.includes(index));
    cell.classList.toggle("elimination", eliminationHighlights.includes(index));
    cell.classList.toggle("conflict", conflicting.includes(index));
    cell.classList.toggle("uncertain", uncertain.includes(index));
    const titleParts = [];
    if (confidenceScores[index] != null) titleParts.push(`Local visual similarity estimate: ${Math.round(confidenceScores[index] * 100)}%; gap to next digit match: ${Math.round((confidenceMargins[index] || 0) * 100)} points. These scores are not calibrated; check against the photo.`);
    if (eliminationHighlights.includes(index)) titleParts.push("This cell has candidates removed by the highlighted technique.");
    cell.title = titleParts.join(" ");
    if (!cell.matches(":focus")) cell.classList.remove("selected", "related");
    const row = Math.floor(index / 9) + 1;
    const column = (index % 9) + 1;
    const visualCheck = confidenceScores[index] == null ? "" : `, visual match estimate ${Math.round(confidenceScores[index] * 100)} percent, next-match gap ${Math.round((confidenceMargins[index] || 0) * 100)} points; verify against photo`;
    const weakMatch = uncertain.includes(index) ? ", weak or ambiguous visual match; check this cell" : "";
    const eliminationNote = eliminationHighlights.includes(index) ? ", candidate removal target" : "";
    cell.setAttribute("aria-label", `Row ${row}, column ${column}${value ? `, ${value}${original[index] !== "0" && !solutionView ? ", clue" : ""}` : ", empty"}${visualCheck}${weakMatch}${eliminationNote}`);
  });
}

function setBoard(value) {
  board = value;
  original = value;
  solutionView = false;
  walk = null;
  highlighted = [];
  eliminationHighlights = [];
  conflicting = [];
  uncertain = [];
  confidenceScores = [];
  confidenceMargins = [];
  photoRecognition = null;
  photoReviewPending = false;
  currentHistoryId = null;
  currentHistoryTitle = null;
  paintBoard();
  renderEmptyStatus();
  setBusy(false);
}

function renderEmptyStatus(message = "Your next step will show up here.") {
  statusCard.innerHTML = `<div class="status-empty"><span class="status-sparkle" aria-hidden="true">✳</span><span>${message}</span></div>`;
}

function renderStatus(title, detail, options = {}) {
  const result = document.createElement("div");
  result.className = "status-result";
  const strong = document.createElement("strong");
  strong.textContent = title;
  result.appendChild(strong);
  const paragraph = document.createElement("span");
  paragraph.className = options.error ? "result-detail status-error" : "result-detail";
  paragraph.textContent = detail;
  result.appendChild(paragraph);
  const actions = options.actions || (options.action ? [options.action] : []);
  actions.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "solution-line";
    button.textContent = item.label;
    button.addEventListener("click", item.onClick);
    result.appendChild(button);
  });
  if (options.feedback) {
    const feedback = document.createElement("div");
    feedback.className = "hint-feedback";
    const prompt = document.createElement("span");
    prompt.textContent = "Was this helpful?";
    feedback.appendChild(prompt);
    [[true, "Yes"], [false, "Not yet"]].forEach(([helpful, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await historyRequest("/v1/feedback", "POST", { puzzle_type: puzzleType, technique: options.feedback, helpful });
          feedback.textContent = "Thanks for the feedback.";
        } catch {
          feedback.textContent = "Feedback could not be saved.";
        }
      });
      feedback.appendChild(button);
    });
    result.appendChild(feedback);
  }
  statusCard.replaceChildren(result);
}

function checkLocalConflicts() {
  const bad = new Set();
  const groups = [];
  for (let row = 0; row < 9; row += 1) groups.push(Array.from({ length: 9 }, (_, column) => row * 9 + column));
  for (let column = 0; column < 9; column += 1) groups.push(Array.from({ length: 9 }, (_, row) => row * 9 + column));
  for (let boxRow = 0; boxRow < 3; boxRow += 1) for (let boxColumn = 0; boxColumn < 3; boxColumn += 1) {
    groups.push(Array.from({ length: 9 }, (_, offset) => (boxRow * 3 + Math.floor(offset / 3)) * 9 + boxColumn * 3 + offset % 3));
  }
  groups.forEach((group) => {
    const seen = new Map();
    group.forEach((index) => {
      const value = board[index];
      if (value === "0") return;
      if (seen.has(value)) {
        bad.add(index);
        bad.add(seen.get(value));
      } else seen.set(value, index);
    });
  });
  return [...bad].sort((a, b) => a - b);
}

async function request(path, payload) {
  const state = puzzleType === "sudoku"
    ? { type: "sudoku", size: 9, cells: board }
    : activeStructuredState;
  if (!state) throw new Error("Load a valid structured puzzle first.");
  const chessPolicy = puzzleType === "chess" ? {
    mode: document.querySelector("#chessMode").value,
    fair_play_confirmed: document.querySelector("#fairPlayConfirmed").checked,
  } : {};
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
    body: JSON.stringify({ ...state, ...chessPolicy, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((issue) => issue.msg).join("; ") : data.detail;
    throw new Error(detail || "The solver could not read that grid.");
  }
  return data;
}

function sendRecognitionTelemetry(payload) {
  if (!document.querySelector("#collectRecognitionMetrics").checked) return;
  fetch("/v1/metrics/recognition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function exampleState(type) {
  if (type === "chess") return { type, fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" };
  if (type === "cube") return { type, facelets: "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB" };
  if (type === "nonogram") return { type, rows: [[1], [3], [5], [3], [1]], columns: [[1], [3], [5], [3], [1]] };
  if (type === "logic_grid") return {
    type, positions: 2,
    categories: { Person: ["Ada", "Ben"], Drink: ["Tea", "Coffee"], Pet: ["Cat", "Dog"] },
    constraints: [
      { kind: "at_position", left: { category: "Person", value: "Ada" }, position: 1, explanation: "Ada is first." },
      { kind: "same", left: { category: "Person", value: "Ada" }, right: { category: "Drink", value: "Tea" }, explanation: "Ada drinks tea." },
      { kind: "same", left: { category: "Person", value: "Ada" }, right: { category: "Pet", value: "Cat" }, explanation: "Ada has the cat." },
    ], original_clues: [],
  };
  if (type === "kenken") {
    const values = "123231312";
    return { type, size: 3, cells: "000000000", cages: [...values].map((value, cell) => ({ cells: [cell], target: Number(value), operation: "=" })) };
  }
  const solution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";
  const cells = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
  return { type, size: 9, cells, cages: [...solution].map((value, cell) => ({ cells: [cell], target: Number(value) })) };
}

function parseLogicCategoryLines(text, positions) {
  const categories = {};
  const seenNames = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`Category line ${index + 1} needs the format “Name: value 1, value 2”.`);
    const name = line.slice(0, colon).trim();
    const values = line.slice(colon + 1).split(",").map((value) => value.trim()).filter(Boolean);
    const normalizedName = name.toLocaleLowerCase();
    if (!name || name.length > 64 || seenNames.has(normalizedName)) throw new Error(`Category line ${index + 1} needs a unique name of at most 64 characters.`);
    if (values.length !== positions) throw new Error(`${name} needs exactly ${positions} values, one for each position.`);
    if (values.some((value) => value.length > 96) || new Set(values.map((value) => value.toLocaleLowerCase())).size !== values.length) {
      throw new Error(`${name} values must be unique and no longer than 96 characters.`);
    }
    seenNames.add(normalizedName);
    categories[name] = values;
  }
  if (Object.keys(categories).length < 2 || Object.keys(categories).length > 8) throw new Error("Add between two and eight categories.");
  return categories;
}

function populateLogicEntityPicker(prefix) {
  const categorySelect = document.querySelector(`#logic${prefix}Category`);
  const valueSelect = document.querySelector(`#logic${prefix}Value`);
  const categoryNames = Object.keys(logicEditorCategories);
  const previousCategory = categorySelect.value;
  categorySelect.replaceChildren(...categoryNames.map((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    return option;
  }));
  if (categoryNames.includes(previousCategory)) categorySelect.value = previousCategory;
  const values = logicEditorCategories[categorySelect.value] || [];
  const previousValue = valueSelect.value;
  valueSelect.replaceChildren(...values.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  if (values.includes(previousValue)) valueSelect.value = previousValue;
}

function logicEntity(prefix) {
  return {
    category: document.querySelector(`#logic${prefix}Category`).value,
    value: document.querySelector(`#logic${prefix}Value`).value,
  };
}

function logicEntityLabel(entity) {
  return `${entity.value} (${entity.category})`;
}

function populateLogicSourceClueSelect() {
  const block = document.querySelector("#logicSourceClueBlock");
  const select = document.querySelector("#logicRelationSourceClue");
  select.replaceChildren();
  if (!logicEditorOriginalClues.length) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a source clue";
  select.appendChild(placeholder);
  logicEditorOriginalClues.forEach((clue, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `Clue ${index + 1}: ${clue}`;
    select.appendChild(option);
  });
}

function logicConstraintLabel(constraint) {
  const relation = {
    same: "is matched with", different: "is not matched with", left_of: "is somewhere before",
    next_to: "is next to", immediately_left: "is immediately before",
  };
  const left = logicEntityLabel(constraint.left);
  if (constraint.right) return `${left} ${relation[constraint.kind]} ${logicEntityLabel(constraint.right)}`;
  return `${left} is ${constraint.kind === "not_position" ? "not at" : "at"} position ${constraint.position}`;
}

function renderLogicConstraints() {
  const list = document.querySelector("#logicConstraintList");
  list.replaceChildren();
  logicEditorConstraints.forEach((constraint, index) => {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "constraint-row";
    const description = document.createElement("span");
    const source = constraint.clue_index == null
      ? (logicEditorOriginalClues.length ? "Unmapped relationship: " : "")
      : `Clue ${constraint.clue_index + 1}: `;
    const explanation = constraint.explanation ? ` · ${constraint.explanation}` : "";
    description.textContent = `${source}${logicConstraintLabel(constraint)}${explanation}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove relationship ${index + 1}`);
    remove.addEventListener("click", () => {
      logicEditorConstraints.splice(index, 1);
      markStructuredDirty();
      renderLogicConstraints();
    });
    row.append(description, remove);
    item.appendChild(row);
    list.appendChild(item);
  });
  list.hidden = logicEditorConstraints.length === 0;
}

function updateLogicRelationControls() {
  const kind = document.querySelector("#logicRelationKind").value;
  const binary = ["same", "different", "left_of", "next_to", "immediately_left"].includes(kind);
  document.querySelector("#logicRightEntity").hidden = !binary;
  document.querySelector("#logicPositionBlock").hidden = binary;
  document.querySelector("#logicRelationPosition").max = String(Number(document.querySelector("#logicPositions").value) || 7);
}

function initializeLogicEditor(state) {
  if (!state || state.type !== "logic_grid") return;
  document.querySelector("#logicPositions").value = String(state.positions || 2);
  logicEditorCategories = state.categories && typeof state.categories === "object" ? state.categories : {};
  logicEditorConstraints = Array.isArray(state.constraints) ? state.constraints.map((constraint) => ({ ...constraint })) : [];
  logicEditorOriginalClues = Array.isArray(state.original_clues) ? [...state.original_clues] : [];
  document.querySelector("#logicClues").value = logicEditorOriginalClues.join("\n");
  document.querySelector("#logicCategoryLines").value = Object.entries(logicEditorCategories)
    .map(([category, values]) => `${category}: ${Array.isArray(values) ? values.join(", ") : ""}`).join("\n");
  document.querySelector("#logicCategories").value = JSON.stringify(logicEditorCategories, null, 2);
  const hasCategories = Object.keys(logicEditorCategories).length >= 2;
  document.querySelector("#logicRelationBuilder").hidden = !hasCategories;
  if (hasCategories) {
    populateLogicEntityPicker("Left");
    populateLogicEntityPicker("Right");
    updateLogicRelationControls();
  }
  populateLogicSourceClueSelect();
  renderLogicConstraints();
}

function prepareLogicRelationBuilder() {
  const positions = Number(document.querySelector("#logicPositions").value);
  if (!Number.isInteger(positions) || positions < 2 || positions > 7) throw new Error("Positions must be a whole number from 2 to 7.");
  const originalClues = document.querySelector("#logicClues").value.split(/\r?\n/).map((clue) => clue.trim()).filter(Boolean);
  if (originalClues.length > 100 || originalClues.reduce((total, clue) => total + clue.length, 0) > 12000) {
    throw new Error("Use at most 100 source clues and keep their total text under 12,000 characters.");
  }
  logicEditorCategories = parseLogicCategoryLines(document.querySelector("#logicCategoryLines").value, positions);
  logicEditorConstraints = [];
  logicEditorOriginalClues = originalClues;
  populateLogicSourceClueSelect();
  populateLogicEntityPicker("Left");
  populateLogicEntityPicker("Right");
  document.querySelector("#logicRelationBuilder").hidden = false;
  updateLogicRelationControls();
  renderLogicConstraints();
  markStructuredDirty();
  renderStatus("Categories ready.", "Add one or more relationships, then load the logic grid.");
}

function addLogicRelation() {
  if (!Object.keys(logicEditorCategories).length) throw new Error("Prepare the categories before adding relationships.");
  if (logicEditorConstraints.length >= 100) throw new Error("A logic grid can contain at most 100 relationships.");
  const kind = document.querySelector("#logicRelationKind").value;
  const constraint = { kind, left: logicEntity("Left") };
  if (["same", "different", "left_of", "next_to", "immediately_left"].includes(kind)) constraint.right = logicEntity("Right");
  else {
    const position = Number(document.querySelector("#logicRelationPosition").value);
    const positions = Number(document.querySelector("#logicPositions").value);
    if (!Number.isInteger(position) || position < 1 || position > positions) throw new Error(`Choose a position from 1 to ${positions}.`);
    constraint.position = position;
  }
  if (logicEditorOriginalClues.length) {
    const sourceIndex = document.querySelector("#logicRelationSourceClue").value;
    if (sourceIndex === "") throw new Error("Choose the source clue this relationship represents.");
    constraint.clue_index = Number(sourceIndex);
  }
  constraint.explanation = document.querySelector("#logicRelationExplanation").value.trim() || logicConstraintLabel(constraint);
  logicEditorConstraints.push(constraint);
  document.querySelector("#logicRelationExplanation").value = "";
  markStructuredDirty();
  renderLogicConstraints();
}

function loadLogicRelationBuilder() {
  const positions = Number(document.querySelector("#logicPositions").value);
  if (!Number.isInteger(positions) || positions < 2 || positions > 7) throw new Error("Positions must be a whole number from 2 to 7.");
  if (logicEditorConstraints.length === 0) throw new Error("Add at least one relationship before loading this logic grid.");
  if (logicEditorOriginalClues.length) {
    const mapped = new Set(logicEditorConstraints.map((constraint) => constraint.clue_index)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < logicEditorOriginalClues.length));
    const missing = logicEditorOriginalClues.map((_, index) => index).filter((index) => !mapped.has(index));
    const unlinked = logicEditorConstraints.some((constraint) => !Number.isInteger(constraint.clue_index) ||
      constraint.clue_index < 0 || constraint.clue_index >= logicEditorOriginalClues.length);
    if (missing.length || unlinked) {
      const clueList = missing.map((index) => index + 1).join(", ");
      throw new Error(`${missing.length ? `Map source clue${missing.length === 1 ? "" : "s"} ${clueList}` : "Map every relationship to a source clue"}${unlinked ? `${missing.length ? " and remove or remap any unlinked relationship" : " before loading"}` : " before loading"}.`);
    }
  }
  loadStructuredState({
    type: "logic_grid", positions, categories: logicEditorCategories,
    constraints: logicEditorConstraints, original_clues: logicEditorOriginalClues,
  });
}

function initializeCageEditor(state) {
  const type = state.type;
  if (type !== "kenken" && type !== "killer_sudoku") return;
  cageEditorType = type;
  cageEditorSize = type === "killer_sudoku" ? 9 : state.size;
  cageEditorGivens = state.cells;
  cageEditorCages = state.cages.map((cage) => ({ ...cage, cells: [...cage.cells] }));
  cageEditorDraft = [];
  cageEditorConflictCells = [];
  const sizeSelect = document.querySelector("#cageEditorSize");
  if (!sizeSelect.options.length) {
    for (let size = 3; size <= 9; size += 1) {
      const option = document.createElement("option");
      option.value = String(size);
      option.textContent = `${size} × ${size}`;
      sizeSelect.appendChild(option);
    }
  }
  sizeSelect.value = String(cageEditorSize);
  sizeSelect.disabled = type === "killer_sudoku";
  document.querySelector("#cageEditorGivens").value = cageEditorGivens;
  document.querySelector("#cageEditorIntro").textContent = type === "kenken"
    ? "Select neighboring cells to form a connected cage, then set its target and operation. Every cell must belong to one cage."
    : "Select neighboring cells to form a connected sum cage. Killer Sudoku cages partition the 9 × 9 grid and cannot repeat a digit.";
  document.querySelector("#cageOperationLabel").hidden = type === "killer_sudoku";
  document.querySelector("#cageOperation").hidden = type === "killer_sudoku";
  document.querySelector("#cageTarget").max = type === "killer_sudoku" ? "45" : "1000000000";
  renderCageEditor();
}

function cageCellsConnected(cells, size) {
  if (!cells.length) return true;
  const remaining = new Set(cells);
  const seen = new Set([cells[0]]);
  const queue = [cells[0]];
  remaining.delete(cells[0]);
  while (queue.length) {
    const current = queue.shift();
    const row = Math.floor(current / size), column = current % size;
    const neighbors = [row ? current - size : -1, row + 1 < size ? current + size : -1,
      column ? current - 1 : -1, column + 1 < size ? current + 1 : -1];
    neighbors.forEach((neighbor) => {
      if (remaining.has(neighbor)) { remaining.delete(neighbor); seen.add(neighbor); queue.push(neighbor); }
    });
  }
  return remaining.size === 0;
}

function renderCageEditor() {
  const grid = document.querySelector("#cageEditorGrid");
  if (!grid || !cageEditorType) return;
  grid.replaceChildren();
  grid.style.gridTemplateColumns = `repeat(${cageEditorSize}, minmax(0, 1fr))`;
  const cageForCell = new Map();
  cageEditorCages.forEach((cage, cageIndex) => cage.cells.forEach((cell) => cageForCell.set(cell, cageIndex)));
  const cageLabelCell = new Map(cageEditorCages.map((cage, cageIndex) => [Math.min(...cage.cells), cageIndex]));
  for (let cell = 0; cell < cageEditorSize * cageEditorSize; cell += 1) {
    const row = Math.floor(cell / cageEditorSize), column = cell % cageEditorSize;
    const cageIndex = cageForCell.get(cell);
    const givenValue = cageEditorGivens[cell] || "0";
    const item = document.createElement("button");
    item.type = "button";
    item.className = `cage-editor-cell${cageIndex === undefined ? "" : ` cage-color-${cageIndex % 8}`}${cageEditorDraft.includes(cell) ? " draft" : ""}${cageEditorConflictCells.includes(cell) ? " cage-conflict" : ""}`;
    item.setAttribute("aria-pressed", String(cageEditorDraft.includes(cell)));
    item.setAttribute("aria-label", `Row ${row + 1}, column ${column + 1}${givenValue !== "0" ? `, given ${givenValue}` : ""}${cageIndex === undefined ? ", unassigned" : `, cage ${cageIndex + 1}`}${cageEditorConflictCells.includes(cell) ? ", implicated in the contradiction" : ""}`);
    item.disabled = cageIndex !== undefined;
    const given = document.createElement("span");
    given.className = "cage-given-value";
    given.textContent = givenValue === "0" ? "" : givenValue;
    item.appendChild(given);
    if (cageLabelCell.has(cell)) {
      const cage = cageEditorCages[cageLabelCell.get(cell)];
      const target = document.createElement("small");
      target.textContent = cageEditorType === "kenken" ? `${cage.target}${cage.operation}` : String(cage.target);
      item.appendChild(target);
    }
    item.addEventListener("click", () => {
      const previousDraft = [...cageEditorDraft];
      if (cageEditorDraft.includes(cell)) {
        const reduced = cageEditorDraft.filter((selected) => selected !== cell);
        if (cageCellsConnected(reduced, cageEditorSize)) cageEditorDraft = reduced;
        else renderStatus("Keep the selected cage connected.", "Remove the other selected cells first so the remaining cells still share edges.", { error: true });
      }
      else if (!cageEditorDraft.length || cageEditorDraft.some((selected) => {
        const dr = Math.abs(Math.floor(selected / cageEditorSize) - row);
        const dc = Math.abs(selected % cageEditorSize - column);
        return dr + dc === 1;
      })) cageEditorDraft.push(cell);
      else {
        renderStatus("Cages must be connected.", "Select a cell sharing an edge with the current cage, or remove a selected cell and continue.", { error: true });
      }
      if (previousDraft.join(",") !== cageEditorDraft.join(",")) markStructuredDirty();
      renderCageEditor();
    });
    grid.appendChild(item);
  }
  const assigned = cageForCell.size;
  const remaining = cageEditorSize * cageEditorSize - assigned;
  document.querySelector("#cageEditorStatus").textContent = `${remaining} cells still need cages · ${cageEditorDraft.length} cells selected`;
  document.querySelector("#undoCage").disabled = cageEditorCages.length === 0;
  document.querySelector("#clearCages").disabled = cageEditorCages.length === 0 && cageEditorDraft.length === 0;
}

function addCageFromSelection() {
  if (!cageEditorDraft.length) throw new Error("Select one or more neighboring cells first.");
  const target = Number(document.querySelector("#cageTarget").value);
  const operation = cageEditorType === "kenken" ? document.querySelector("#cageOperation").value : "+";
  if (!Number.isInteger(target) || target < 1) throw new Error("Enter a positive whole-number cage target.");
  if (operation === "=" && cageEditorDraft.length !== 1) throw new Error("An exact-value cage contains one cell.");
  if (["−", "÷"].includes(operation) && cageEditorDraft.length !== 2) throw new Error("Subtraction and division cages contain two cells.");
  if (cageEditorType === "kenken") {
    const size = cageEditorSize, count = cageEditorDraft.length;
    if (operation === "=" && target > size) throw new Error("An exact-value cage target must fit the grid values.");
    if (operation === "+" && (target < count || target > count * size)) throw new Error("The sum target is outside the possible range for this cage.");
    if (operation === "×" && target > size ** count) throw new Error("The product target is larger than this cage can reach.");
    if (operation === "−" && target >= size) throw new Error("The difference target must be smaller than the grid size.");
    if (operation === "÷" && target > size) throw new Error("The quotient target cannot exceed the grid size.");
  } else {
    const count = cageEditorDraft.length;
    const minimum = count * (count + 1) / 2;
    const maximum = count * (19 - count) / 2;
    if (target < minimum || target > maximum) throw new Error(`A ${count}-cell Killer Sudoku cage sum must be between ${minimum} and ${maximum}.`);
  }
  cageEditorCages.push({ cells: [...cageEditorDraft].sort((a, b) => a - b), target, ...(cageEditorType === "kenken" ? { operation } : {}) });
  cageEditorDraft = [];
  markStructuredDirty();
  renderCageEditor();
}

function loadCageEditorState() {
  const cells = document.querySelector("#cageEditorGivens").value.trim();
  const expectedLength = cageEditorSize * cageEditorSize;
  if (cells.length !== expectedLength || [...cells].some((value) => !/[0-9]/.test(value) || (value !== "0" && Number(value) > cageEditorSize))) {
    throw new Error(`Given values must contain ${expectedLength} digits from 0 to ${cageEditorSize}.`);
  }
  const assigned = cageEditorCages.reduce((total, cage) => total + cage.cells.length, 0);
  if (cageEditorDraft.length || assigned !== expectedLength) throw new Error(`${expectedLength - assigned} cells still need to be assigned to cages.`);
  const state = { type: cageEditorType, size: cageEditorSize, cells, cages: cageEditorCages };
  loadStructuredState(state);
}

function formatNonogramClues(lines) {
  return lines.map((clue) => clue.join(" ")).join("\n");
}

function parseNonogramClues(text, label) {
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines.length > 25) throw new Error(`${label} must contain 1–25 lines.`);
  return lines.map((line, index) => {
    const clue = line.trim() ? line.trim().split(/[\s,]+/).map(Number) : [];
    if (clue.some((run) => !Number.isInteger(run) || run < 1 || run > 25)) {
      throw new Error(`${label} line ${index + 1} must use positive run lengths from 1 to 25.`);
    }
    return clue;
  });
}

function validateNonogramClues(rows, columns) {
  if (!Array.isArray(rows) || !Array.isArray(columns) || !rows.length || !columns.length || rows.length > 25 || columns.length > 25) {
    throw new Error("Nonogram puzzles need between 1 and 25 rows and columns.");
  }
  for (const [lines, length, label] of [[rows, columns.length, "Row"], [columns, rows.length, "Column"]]) {
    lines.forEach((clue, index) => {
      if (clue.some((run) => !Number.isInteger(run) || run < 1 || run > 25) ||
          clue.reduce((sum, run) => sum + run, 0) + Math.max(0, clue.length - 1) > length) {
        throw new Error(`${label} ${index + 1} has runs that cannot fit in the grid.`);
      }
    });
  }
}

function renderNonogramSolution(solution) {
  const grid = document.querySelector("#nonogramResultGrid");
  const width = activeStructuredState.columns.length;
  grid.replaceChildren();
  grid.style.gridTemplateColumns = `repeat(${width}, minmax(0, 1fr))`;
  solution.forEach((line, row) => [...line].forEach((cell, column) => {
    const item = document.createElement("div");
    item.className = `nonogram-cell${cell === "#" ? " filled" : ""}`;
    item.dataset.row = String(row);
    item.setAttribute("role", "gridcell");
    item.setAttribute("aria-label", `Row ${row + 1}, column ${column + 1}, ${cell === "#" ? "filled" : "empty"}`);
    grid.appendChild(item);
  }));
  grid.hidden = false;
}

function squaresToFen(squares, activeColor = "w") {
  const ranks = [];
  for (let row = 0; row < 8; row += 1) {
    let rank = "";
    let empty = 0;
    for (let col = 0; col < 8; col += 1) {
      const piece = squares[row * 8 + col];
      if (!piece || piece === ".") {
        empty += 1;
      } else {
        if (empty > 0) { rank += empty; empty = 0; }
        rank += piece;
      }
    }
    if (empty > 0) rank += empty;
    ranks.push(rank);
  }
  let castling = "";
  if (squares[60] === "K" && squares[63] === "R") castling += "K";
  if (squares[60] === "K" && squares[56] === "R") castling += "Q";
  if (squares[4] === "k" && squares[7] === "r") castling += "k";
  if (squares[4] === "k" && squares[0] === "r") castling += "q";
  if (!castling) castling = "-";
  return `${ranks.join("/")} ${activeColor} ${castling} - 0 1`;
}

function parseFenToSquares(fen) {
  const placement = String(fen || "").split(/\s+/)[0].split("/");
  const squares = [];
  for (let row = 0; row < 8; row += 1) {
    let col = 0;
    for (const token of placement[row] || "") {
      if (/^[1-8]$/.test(token)) {
        for (let i = 0; i < Number(token); i += 1) squares.push(".");
        col += Number(token);
      } else {
        squares.push(token);
        col += 1;
      }
    }
    while (col < 8) { squares.push("."); col += 1; }
  }
  while (squares.length < 64) squares.push(".");
  return squares;
}

function setChessFen(fen) {
  const fenInput = document.querySelector("#chessFenInput");
  if (fenInput) fenInput.value = fen;
  if (!activeStructuredState || activeStructuredState.type !== "chess") {
    activeStructuredState = { type: "chess", fen };
  } else {
    activeStructuredState.fen = fen;
  }
  const structInput = document.querySelector("#structuredInput");
  if (structInput) structInput.value = JSON.stringify(activeStructuredState, null, 2);
  renderChessBoard(fen);
}

function onChessSquareClick(index) {
  const currentFen = activeStructuredState?.fen || document.querySelector("#chessFenInput")?.value || "8/8/8/8/8/8/8/8 w - - 0 1";
  const squares = parseFenToSquares(currentFen);
  const currentPiece = squares[index] || ".";
  const nextPiece = PIECE_CYCLE[(PIECE_CYCLE.indexOf(currentPiece) + 1) % PIECE_CYCLE.length];
  squares[index] = nextPiece;
  const activeSide = currentFen.split(/\s+/)[1] || "w";
  const newFen = squaresToFen(squares, activeSide);
  chessUncertainSquares = chessUncertainSquares.filter(s => s !== index);
  setChessFen(newFen);
}

function applyUciMoveToFen(fen, uciMove) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uciMove)) return fen;
  const fromCol = uciMove.charCodeAt(0) - 97;
  const fromRow = 8 - Number(uciMove[1]);
  const toCol = uciMove.charCodeAt(2) - 97;
  const toRow = 8 - Number(uciMove[3]);
  const promo = uciMove[4];
  const squares = parseFenToSquares(fen);
  const fromIndex = fromRow * 8 + fromCol;
  const toIndex = toRow * 8 + toCol;
  let piece = squares[fromIndex];
  if (promo) {
    piece = piece === piece.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();
  }
  squares[fromIndex] = ".";
  squares[toIndex] = piece;
  if (piece === "K" && fromIndex === 60) {
    if (toIndex === 62) { squares[63] = "."; squares[61] = "R"; }
    else if (toIndex === 58) { squares[56] = "."; squares[59] = "R"; }
  } else if (piece === "k" && fromIndex === 4) {
    if (toIndex === 6) { squares[7] = "."; squares[5] = "r"; }
    else if (toIndex === 2) { squares[0] = "."; squares[3] = "r"; }
  }
  const currentSide = fen.split(/\s+/)[1] || "w";
  const nextSide = currentSide === "w" ? "b" : "w";
  return squaresToFen(squares, nextSide);
}

function updateChessPvControls() {
  const panel = document.querySelector("#chessPvControls");
  if (!panel) return;
  if (!chessPvLine.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  document.querySelector("#chessPvText").textContent = chessPvLine.map((m, i) => `${i + 1}. ${m}`).join("  ");
  document.querySelector("#chessPvPrev").disabled = chessPvIndex <= 0;
  document.querySelector("#chessPvNext").disabled = chessPvIndex >= chessPvLine.length;
}

function renderChessBoard(fen, bestMove = "") {
  const boardElement = document.querySelector("#chessBoardPreview");
  if (!boardElement) return;
  boardElement.replaceChildren();
  const placement = String(fen || "").split(/\s+/)[0].split("/");
  if (placement.length !== 8) {
    boardElement.setAttribute("aria-label", "Chess position preview unavailable. Enter a valid FEN.");
    return;
  }
  const glyphs = { P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔", p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
  const squares = [];
  for (let row = 0; row < 8; row += 1) {
    let column = 0;
    for (const token of placement[row]) {
      if (/^[1-8]$/.test(token)) column += Number(token);
      else if (glyphs[token] && column < 8) {
        squares[row * 8 + column] = token;
        column += 1;
      } else {
        boardElement.setAttribute("aria-label", "Chess position preview unavailable. Enter a valid FEN.");
        return;
      }
    }
    if (column !== 8) {
      boardElement.setAttribute("aria-label", "Chess position preview unavailable. Enter a valid FEN.");
      return;
    }
  }
  const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestMove) ? bestMove : "";
  const from = move ? (8 - Number(move[1])) * 8 + move.charCodeAt(0) - 97 : -1;
  const to = move ? (8 - Number(move[3])) * 8 + move.charCodeAt(2) - 97 : -1;
  for (let index = 0; index < 64; index += 1) {
    const row = Math.floor(index / 8), column = index % 8;
    const square = document.createElement("button");
    square.type = "button";
    square.className = `chess-square ${(row + column) % 2 ? "dark" : "light"}${index === from ? " move-from" : ""}${index === to ? " move-to" : ""}`;
    square.dataset.squareIndex = String(index);
    square.setAttribute("role", "gridcell");
    square.tabIndex = index === 0 ? 0 : -1;
    const file = String.fromCharCode(97 + column), rank = String(8 - row), piece = squares[index];
    const color = piece ? (piece === piece.toUpperCase() ? "White" : "Black") : "Empty";
    const name = piece ? ({ p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" })[piece.toLowerCase()] : "square";
    square.setAttribute("aria-label", `${color} ${name}, ${file}${rank}${index === from ? ", suggested move starts here" : ""}${index === to ? ", suggested move ends here" : ""}`);
    square.textContent = piece ? glyphs[piece] : "";
    if (chessUncertainSquares.includes(index)) square.classList.add("uncertain");
    square.addEventListener("click", () => onChessSquareClick(index));
    square.addEventListener("keydown", (event) => {
      if (/^[PNBRQKpnbrqk]$/.test(event.key)) {
        event.preventDefault();
        const curFen = activeStructuredState?.fen || document.querySelector("#chessFenInput")?.value || "8/8/8/8/8/8/8/8 w - - 0 1";
        const sqs = parseFenToSquares(curFen);
        sqs[index] = event.key;
        chessUncertainSquares = chessUncertainSquares.filter(s => s !== index);
        setChessFen(squaresToFen(sqs, curFen.split(/\s+/)[1] || "w"));
        return;
      }
      if (event.key === "0" || event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        const curFen = activeStructuredState?.fen || document.querySelector("#chessFenInput")?.value || "8/8/8/8/8/8/8/8 w - - 0 1";
        const sqs = parseFenToSquares(curFen);
        sqs[index] = ".";
        chessUncertainSquares = chessUncertainSquares.filter(s => s !== index);
        setChessFen(squaresToFen(sqs, curFen.split(/\s+/)[1] || "w"));
        return;
      }
      const delta = { ArrowUp: -8, ArrowDown: 8, ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (delta === undefined) return;
      const next = index + delta;
      if (next < 0 || next >= 64 || (event.key === "ArrowLeft" && column === 0) || (event.key === "ArrowRight" && column === 7)) return;
      event.preventDefault();
      const target = boardElement.querySelector(`[data-square-index="${next}"]`);
      boardElement.querySelectorAll(".chess-square").forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
      target.focus();
    });
    boardElement.appendChild(square);
  }
  if (move) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "chess-move-arrow");
    svg.setAttribute("viewBox", "0 0 8 8");
    svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "chessArrowHead"); marker.setAttribute("markerWidth", "5"); marker.setAttribute("markerHeight", "5");
    marker.setAttribute("refX", "3.6"); marker.setAttribute("refY", "2.5"); marker.setAttribute("orient", "auto");
    const head = document.createElementNS("http://www.w3.org/2000/svg", "path");
    head.setAttribute("d", "M0,0 L5,2.5 L0,5 Z"); head.setAttribute("fill", "#f4a83a");
    marker.appendChild(head); defs.appendChild(marker); svg.appendChild(defs);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String((from % 8) + 0.5)); line.setAttribute("y1", String(Math.floor(from / 8) + 0.5));
    line.setAttribute("x2", String((to % 8) + 0.5)); line.setAttribute("y2", String(Math.floor(to / 8) + 0.5));
    line.setAttribute("marker-end", "url(#chessArrowHead)"); svg.appendChild(line); boardElement.appendChild(svg);
  }
  boardElement.setAttribute("aria-label", move ? `Chess position preview. Suggested move ${move}.` : "Chess position preview from the entered FEN.");
}

function setPuzzleType(type, preserveState = false) {
  if (type !== puzzleType) document.querySelector("#useAiExplanation").checked = false;
  if (type !== "cube") stopCubeCameraScan();
  if (type !== "cube" && cubeWorker) {
    cubeWorker.terminate();
    cubeWorker = null;
    setBusy(false);
  }
  if (!preserveState) {
    currentHistoryId = null;
    currentHistoryTitle = null;
  }
  if (type === "cube" && !preserveState) {
    cubeSolutionMoves = [];
    cubeStates = [];
    cubeStep = 0;
  }
  puzzleType = type;
  document.querySelector("#puzzleType").value = type;
  if (type === "chess") document.querySelector("#fairPlayConfirmed").checked = false;
  const sudoku = type === "sudoku";
  if (!sudoku && screenStream) closePhoto();
  document.querySelector("#sudokuControls").hidden = !sudoku;
  document.querySelector("#sudokuDisplay").hidden = !sudoku;
  document.querySelector("#structuredMode").hidden = sudoku;
  document.querySelector("#logicParsePanel").hidden = type !== "logic_grid";
  document.querySelector("#nonogramEditor").hidden = type !== "nonogram";
  document.querySelector("#nonogramResultGrid").hidden = true;
  document.querySelector("#cageEditor").hidden = !["kenken", "killer_sudoku"].includes(type);
  const hasVisualEditor = ["nonogram", "kenken", "killer_sudoku"].includes(type);
  document.querySelector("#structuredJsonTools").hidden = hasVisualEditor;
  document.querySelector("#toggleStructuredJson").hidden = !hasVisualEditor;
  document.querySelector("#toggleStructuredJson").textContent = "Show advanced JSON";
  document.querySelector("#chessPanel").hidden = type !== "chess";
  document.querySelector("#cubePanel").hidden = type !== "cube";
  document.querySelector("#cubeReplay").hidden = type !== "cube" || cubeStates.length === 0;
  document.querySelector(".help-levels").hidden = type === "chess" || type === "cube";
  updateAiExplanationControl();
  solveButton.hidden = type === "chess" || type === "cube";
  document.querySelector("#photoPanel").hidden = sudoku ? document.querySelector("#photoPanel").hidden : true;
  document.querySelector("#boardTypeLabel").textContent = ({ sudoku: "Sudoku", kenken: "KenKen", killer_sudoku: "Killer Sudoku", nonogram: "Nonogram", logic_grid: "Logic grid", chess: "Chess analysis", cube: "Rubik’s Cube" })[type];
  const state = preserveState && activeStructuredState?.type === type ? activeStructuredState : exampleState(type);
  if (!sudoku) {
    activeStructuredState = preserveState && activeStructuredState?.type === type ? state : null;
    document.querySelector("#structuredInput").value = JSON.stringify(state, null, 2);
    const size = type === "nonogram" ? `${state.columns.length} × ${state.rows.length}`
      : type === "logic_grid" ? `${state.positions} positions` : type === "chess" ? "FEN position" : type === "cube" ? "3 × 3 × 3" : `${state.size} × ${state.size}`;
    document.querySelector("#boardSizeLabel").textContent = size;
    document.querySelector("#structuredHelp").textContent = type === "logic_grid"
      ? "Enter a structured logic grid or interpret typed clues below. Review the constraints and load them before solving."
      : type === "chess" ? "Enter a FEN position. Suggestions use a bounded in-app search and require a fair-play confirmation below."
        : type === "cube" ? "Enter the 54 stickers in URFDLB order. The cube solver and replay run locally in your browser."
          : type === "nonogram" ? "Enter row and column runs below. The solved picture is verified and shown as a grid with a row-by-row walkthrough."
        : type === "kenken" || type === "killer_sudoku" ? "Build connected cages with the visual editor below, or enter the same state as JSON. Every grid cell must belong to exactly one cage."
        : "Edit the example or enter a puzzle state as JSON. Load it to validate its clues, then ask for a hint or solution.";
    document.querySelector("#cubeFacelets").value = state.facelets || "";
    if (type === "nonogram") {
      document.querySelector("#nonogramRows").value = formatNonogramClues(state.rows);
      document.querySelector("#nonogramColumns").value = formatNonogramClues(state.columns);
    }
    if (type === "kenken" || type === "killer_sudoku") initializeCageEditor(state);
    if (type === "logic_grid") initializeLogicEditor(state);
    if (type === "chess") {
      document.querySelector("#chessBoardPreview").hidden = false;
      const fenInput = document.querySelector("#chessFenInput");
      if (fenInput) fenInput.value = state.fen;
      const pvPanel = document.querySelector("#chessPvControls");
      if (pvPanel) pvPanel.hidden = true;
      renderChessBoard(state.fen);
    }
  } else {
    activeStructuredState = null;
  }
  highlighted = [];
  eliminationHighlights = [];
  conflicting = [];
  renderEmptyStatus();
  setBusy(false);
}

function updateAiExplanationControl() {
  const control = document.querySelector("#aiExplanationControl");
  const enabled = aiExplanationAvailable && selectedLevel === "hint" && !["chess", "cube"].includes(puzzleType);
  control.hidden = !enabled;
  if (!enabled) document.querySelector("#useAiExplanation").checked = false;
}

function loadStructuredState(state, fromHistory = false) {
  if (!state || state.type !== puzzleType) throw new Error(`Choose a ${puzzleType.replaceAll("_", " ")} state with the matching type.`);
  if (puzzleType === "cube" && !validCubeFormat(state.facelets)) throw new Error("A cube needs 54 URFDLB stickers, nine of each color, with URFDLB centers in that order.");
  if (puzzleType === "nonogram") validateNonogramClues(state.rows, state.columns);
  if (puzzleType === "cube" && cubeStates.length && cubeStates[0] !== state.facelets) {
    cubeSolutionMoves = [];
    cubeStates = [];
    cubeStep = 0;
    document.querySelector("#cubeReplay").hidden = true;
  }
  activeStructuredState = state;
  document.querySelector("#structuredInput").value = JSON.stringify(state, null, 2);
  const size = puzzleType === "nonogram" ? `${state.columns.length} × ${state.rows.length}`
    : puzzleType === "logic_grid" ? `${state.positions} positions` : puzzleType === "chess" ? "FEN position" : puzzleType === "cube" ? "3 × 3 × 3" : `${state.size} × ${state.size}`;
  if (puzzleType === "cube") document.querySelector("#cubeFacelets").value = state.facelets;
  if (puzzleType === "nonogram") {
    document.querySelector("#nonogramRows").value = formatNonogramClues(state.rows);
    document.querySelector("#nonogramColumns").value = formatNonogramClues(state.columns);
    document.querySelector("#nonogramResultGrid").hidden = true;
  }
  if (puzzleType === "kenken" || puzzleType === "killer_sudoku") initializeCageEditor(state);
  if (puzzleType === "logic_grid") initializeLogicEditor(state);
  if (puzzleType === "chess") {
    document.querySelector("#chessBoardPreview").hidden = false;
    renderChessBoard(state.fen);
  }
  document.querySelector("#boardSizeLabel").textContent = size;
  if (!fromHistory) {
    currentHistoryId = null;
    currentHistoryTitle = null;
  }
  renderStatus("Puzzle loaded.", "The solver will check every answer against this structured state.");
}

function markStructuredDirty() {
  if (puzzleType === "sudoku" || !activeStructuredState) return;
  activeStructuredState = null;
  cageEditorConflictCells = [];
  currentHistoryId = null;
  currentHistoryTitle = null;
  if (puzzleType === "cube") {
    cubeSolutionMoves = [];
    cubeStates = [];
    cubeStep = 0;
    document.querySelector("#cubeReplay").hidden = true;
  }
  if (puzzleType === "nonogram") document.querySelector("#nonogramResultGrid").hidden = true;
  if (puzzleType === "chess") document.querySelector("#chessBoardPreview").hidden = true;
  renderEmptyStatus("Load this puzzle to apply your edits.");
}

async function historyRequest(path, method = "GET", payload) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Saved puzzle history could not be loaded.");
  return data;
}

function renderHistory(items) {
  const list = document.querySelector("#historyList");
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "No saved puzzles yet.";
    list.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("li");
    row.className = "history-item";
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "history-resume";
    resume.textContent = `${item.title} · ${item.difficulty || "Unrated"}`;
    resume.addEventListener("click", async () => {
      try {
        const saved = await historyRequest(`/v1/history/${item.record_id}`);
        setPuzzleType(saved.puzzle_type);
        if (saved.puzzle_type === "sudoku") setBoard(saved.state.cells);
        else loadStructuredState(saved.state, true);
        currentHistoryId = item.record_id;
        currentHistoryTitle = saved.title;
        renderStatus("Puzzle resumed.", `${saved.title} · ${saved.difficulty || "Difficulty not estimated"}`);
        document.querySelector("#sudokuBoard").scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (error) {
        renderStatus("Couldn’t resume this puzzle.", error.message, { error: true });
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${item.title}`);
    remove.addEventListener("click", async () => {
      try {
        await historyRequest(`/v1/history/${item.record_id}`, "DELETE");
        if (currentHistoryId === item.record_id) currentHistoryId = null;
        await loadHistory();
      } catch (error) {
        renderStatus("Couldn’t delete this saved puzzle.", error.message, { error: true });
      }
    });
    row.append(resume, remove);
    list.appendChild(row);
  });
}

async function loadHistory() {
  try {
    const data = await historyRequest("/v1/history");
    renderHistory(data.items || []);
  } catch {
    const list = document.querySelector("#historyList");
    list.replaceChildren();
    const message = document.createElement("li");
    message.className = "history-empty";
    message.textContent = "Start the local app to use saved puzzles.";
    list.appendChild(message);
  }
}

async function saveCurrentPuzzle() {
  const state = puzzleType === "sudoku"
    ? { type: "sudoku", size: 9, cells: solutionView ? original : board }
    : activeStructuredState;
  if (!state || (puzzleType === "sudoku" && !/[1-9]/.test(state.cells))) {
    renderStatus("Load a puzzle first.", "Only a valid puzzle with at least one clue can be saved.");
    return;
  }
  const name = ({ sudoku: "Sudoku", kenken: "KenKen", killer_sudoku: "Killer Sudoku", nonogram: "Nonogram", logic_grid: "Logic grid", chess: "Chess analysis", cube: "Rubik’s Cube" })[puzzleType];
  const title = currentHistoryTitle || `${name} · ${new Date().toLocaleDateString()}`;
  try {
    const saved = await historyRequest("/v1/history", "POST", {
      ...(currentHistoryId ? { record_id: currentHistoryId } : {}),
      puzzle_type: puzzleType,
      title,
      state,
    });
    currentHistoryId = saved.record_id;
    currentHistoryTitle = saved.title;
    await loadHistory();
    renderStatus("Puzzle saved on this device.", `${saved.title} · ${saved.difficulty}`);
  } catch (error) {
    renderStatus("Couldn’t save this puzzle.", error.message, { error: true });
  }
}

function setBusy(busy, label) {
  hintButton.disabled = busy || photoReviewPending;
  solveButton.disabled = busy || photoReviewPending;
  hintButton.querySelector("span:first-child").textContent = busy ? label : puzzleType === "chess" ? "Analyze position" : puzzleType === "cube" ? "Solve cube" : `Get ${selectedLevel === "nudge" ? "a nudge" : selectedLevel === "hint" ? "a hint" : "the answer"}`;
}

function validCubeFormat(facelets) {
  return typeof facelets === "string" && facelets.length === 54 && [...facelets].every((face) => "URFDLB".includes(face)) &&
    [..."URFDLB"].every((face) => [...facelets].filter((sticker) => sticker === face).length === 9) &&
    Array.from({ length: 6 }, (_, face) => facelets[face * 9 + 4]).join("") === "URFDLB";
}

function rgbToLab([red, green, blue]) {
  const linear = (value) => {
    value /= 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(red), g = linear(green), b = linear(blue);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function sampleCubeVideoFace() {
  const video = document.querySelector("#cubeCameraVideo");
  if (!video.videoWidth || !video.videoHeight) throw new Error("Wait for the camera image, then capture the face again.");
  const side = Math.min(video.videoWidth, video.videoHeight);
  const sourceX = (video.videoWidth - side) / 2;
  const sourceY = (video.videoHeight - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = 360;
  canvas.height = 360;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, sourceX, sourceY, side, side, 0, 0, 360, 360);
  const samples = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const centerX = column * 120 + 60;
      const centerY = row * 120 + 60;
      const pixels = context.getImageData(centerX - 8, centerY - 8, 16, 16).data;
      const rgb = [0, 0, 0];
      for (let offset = 0; offset < pixels.length; offset += 4) {
        rgb[0] += pixels[offset]; rgb[1] += pixels[offset + 1]; rgb[2] += pixels[offset + 2];
      }
      samples.push(rgb.map((value) => Math.round(value / (pixels.length / 4))));
    }
  }
  return samples;
}

function showCubeScanStep() {
  const face = ["U", "R", "F", "D", "L", "B"][cubeCameraFaces.length];
  if (!face) return;
  document.querySelector("#cubeScanInstruction").textContent = `Face ${face} · ${CUBE_SCAN_GUIDE[face]} Center the whole face in the guide (${cubeCameraFaces.length + 1} of 6).`;
  document.querySelector("#cubeCaptureFace").textContent = `Capture face ${face}`;
}

async function startCubeCameraScan() {
  if (!navigator.mediaDevices?.getUserMedia) {
    renderStatus("Camera access isn’t available here.", "Use a current browser on HTTPS or localhost, or enter the 54 stickers manually.", { error: true });
    return;
  }
  stopCubeCameraScan();
  try {
    cubeCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = document.querySelector("#cubeCameraVideo");
    video.srcObject = cubeCameraStream;
    await video.play();
    if (!video.videoWidth) await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
    cubeCameraFaces = [];
    cubeCenterColors = {};
    document.querySelector("#cubeColorConfirmation").hidden = true;
    document.querySelector("#cubeCameraPanel").hidden = false;
    document.querySelector("#cubeCameraStart").disabled = true;
    showCubeScanStep();
  } catch (error) {
    stopCubeCameraScan();
    renderStatus("Couldn’t start the cube camera.", error.name === "NotAllowedError" ? "Allow camera access in the browser, or enter the stickers manually." : error.message, { error: true });
  }
}

function stopCubeCameraScan() {
  if (cubeCameraStream) cubeCameraStream.getTracks().forEach((track) => track.stop());
  cubeCameraStream = null;
  cubeCameraFaces = [];
  const video = document.querySelector("#cubeCameraVideo");
  if (video) video.srcObject = null;
  const panel = document.querySelector("#cubeCameraPanel");
  if (panel) panel.hidden = true;
  const start = document.querySelector("#cubeCameraStart");
  if (start) start.disabled = false;
}

function captureCubeCameraFace() {
  try {
    cubeCameraFaces.push(sampleCubeVideoFace());
    if (cubeCameraFaces.length < 6) {
      showCubeScanStep();
      return;
    }
    finishCubeCameraScan();
  } catch (error) {
    renderStatus("Couldn’t sample that face.", error.message, { error: true });
  }
}

function finishCubeCameraScan() {
  const order = ["U", "R", "F", "D", "L", "B"];
  const centers = cubeCameraFaces.map((samples, index) => ({ face: order[index], lab: rgbToLab(samples[4]), rgb: samples[4] }));
  let closestCenters = Infinity;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = i + 1; j < centers.length; j += 1) {
      const distance = Math.hypot(...centers[i].lab.map((value, channel) => value - centers[j].lab[channel]));
      closestCenters = Math.min(closestCenters, distance);
    }
  }
  if (closestCenters < 8) {
    cubeCameraFaces = cubeCameraFaces.slice(0, 5);
    showCubeScanStep();
    renderStatus("Two face colors look too similar.", "Improve the lighting and recapture the last face. Keep stickers free of glare.", { error: true });
    return;
  }
  cubeCenterColors = Object.fromEntries(centers.map(({ face, rgb }) => [face, `rgb(${rgb.join(",")})`]));
  let facelets = "";
  cubeCameraFaces.forEach((samples, faceIndex) => {
    for (const rgb of samples) {
      const lab = rgbToLab(rgb);
      let nearest = centers[0];
      let nearestDistance = Infinity;
      centers.forEach((center) => {
        const distance = Math.hypot(...lab.map((value, channel) => value - center.lab[channel]));
        if (distance < nearestDistance) { nearestDistance = distance; nearest = center; }
      });
      facelets += nearest.face;
    }
  });
  stopCubeCameraScan();
  document.querySelector("#cubeFacelets").value = facelets;
  markStructuredDirty();
  renderCubeColorConfirmation(facelets);
  renderStatus("Review the scanned stickers.", "Check the six 3 × 3 color grids and tap any misread sticker to cycle its face label. Then load the sticker state.");
}

function renderCubeColorConfirmation(facelets) {
  const confirmation = document.querySelector("#cubeColorConfirmation");
  if (typeof facelets !== "string" || facelets.length !== 54 || [...facelets].some((face) => !"URFDLB".includes(face))) {
    confirmation.hidden = true;
    return;
  }
  confirmation.hidden = false;
  confirmation.replaceChildren();
  const labels = { U: "Up", R: "Right", F: "Front", D: "Down", L: "Left", B: "Back" };
  for (const face of "URFDLB") {
    const card = document.createElement("section");
    card.className = "cube-confirm-face";
    const heading = document.createElement("strong");
    heading.textContent = `${labels[face]} (${face})`;
    const grid = document.createElement("div");
    grid.className = "cube-confirm-stickers";
    for (let localIndex = 0; localIndex < 9; localIndex += 1) {
      const index = CUBE_FACE_OFFSETS[face] + localIndex;
      const colorFace = facelets[index];
      const sticker = document.createElement("button");
      sticker.type = "button";
      sticker.className = "cube-confirm-sticker";
      sticker.style.backgroundColor = cubeCenterColors[colorFace] || ({ U: "#eee", R: "#d94d43", F: "#65a75a", D: "#fff", L: "#f39a3b", B: "#4b75c2" })[colorFace];
      sticker.textContent = colorFace;
      sticker.setAttribute("aria-label", `${labels[face]} face row ${Math.floor(localIndex / 3) + 1}, column ${localIndex % 3 + 1}: ${labels[colorFace]} color. Tap to change.`);
      sticker.disabled = localIndex === 4;
      sticker.addEventListener("click", () => {
        const current = document.querySelector("#cubeFacelets").value.split("");
        current[index] = "URFDLB"[("URFDLB".indexOf(current[index]) + 1) % 6];
        const changed = current.join("");
        document.querySelector("#cubeFacelets").value = changed;
        markStructuredDirty();
        renderCubeColorConfirmation(changed);
      });
      grid.appendChild(sticker);
    }
    card.append(heading, grid);
    confirmation.appendChild(card);
  }
}

function renderCube(facelets) {
  const normalized = Cube.fromString(facelets).asString();
  const defaults = { U: "#f8f5e8", R: "#d94d43", F: "#65a75a", D: "#fefefe", L: "#f39a3b", B: "#4b75c2" };
  const colors = {};
  for (const face of "URFDLB") colors[face] = cubeCenterColors[face] || defaults[face];
  const faceOffsets = { U: 0, R: 9, F: 18, D: 27, L: 36, B: 45 };
  document.querySelectorAll(".cube-face").forEach((faceElement) => {
    const face = faceElement.dataset.face;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 9; index += 1) {
      const sticker = document.createElement("span");
      const color = normalized[faceOffsets[face] + index];
      sticker.className = "cube-sticker";
      sticker.style.backgroundColor = colors[color] || "#888";
      sticker.setAttribute("aria-label", `${face} face, sticker ${index + 1}, ${color}`);
      fragment.appendChild(sticker);
    }
    faceElement.replaceChildren(fragment);
  });
}

function renderCubeStep(step) {
  if (!cubeStates.length) return;
  cubeStep = Math.max(0, Math.min(step, cubeStates.length - 1));
  renderCube(cubeStates[cubeStep]);
  const moveCount = cubeSolutionMoves.length;
  const label = cubeStep === 0 ? "Starting position" : `Move ${cubeStep} of ${moveCount}: ${cubeSolutionMoves[cubeStep - 1]}`;
  document.querySelector("#cubeStepLabel").textContent = moveCount ? `${label} · ${moveCount} moves total` : "This cube is already solved.";
  document.querySelector("#cubePrevious").disabled = cubeStep === 0;
  document.querySelector("#cubeNext").disabled = cubeStep >= moveCount;
  document.querySelectorAll("#cubeMoveList button").forEach((button) => {
    button.classList.toggle("current", Number(button.dataset.step) === cubeStep);
    button.setAttribute("aria-current", Number(button.dataset.step) === cubeStep ? "step" : "false");
  });
}

function solveCubePuzzle() {
  if (!activeStructuredState || !validCubeFormat(activeStructuredState.facelets)) {
    renderStatus("Load a cube state first.", "Enter all 54 stickers in URFDLB order and choose “Load sticker state”.", { error: true });
    return;
  }
  if (!("Worker" in window)) {
    renderStatus("This browser can’t run the cube solver worker.", "Use a current browser with Web Worker support.", { error: true });
    return;
  }
  if (cubeWorker) cubeWorker.terminate();
  const worker = new Worker("/cube-worker.js");
  cubeWorker = worker;
  setBusy(true, "Checking legality and solving…");
  worker.addEventListener("message", (event) => {
    if (cubeWorker !== worker) return;
    worker.terminate();
    cubeWorker = null;
    setBusy(false);
    if (event.data.type === "error") {
      document.querySelector("#cubeReplay").hidden = true;
      renderStatus("This cube state isn’t legal.", event.data.message, { error: true });
      return;
    }
    try {
      cubeSolutionMoves = event.data.moves || [];
      const cube = Cube.fromString(activeStructuredState.facelets);
      cubeStates = [cube.asString()];
      cubeSolutionMoves.forEach((move) => {
        cube.move(move);
        cubeStates.push(cube.asString());
      });
      if (!cube.isSolved()) throw new Error("The returned moves did not solve the cube.");
      document.querySelector("#cubeReplay").hidden = false;
      const list = document.querySelector("#cubeMoveList");
      list.replaceChildren();
      cubeSolutionMoves.forEach((move, index) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.step = String(index + 1);
        button.textContent = `${index + 1}. ${move}`;
        button.addEventListener("click", () => renderCubeStep(index + 1));
        item.appendChild(button);
        list.appendChild(item);
      });
      renderCubeStep(0);
      const moveText = cubeSolutionMoves.length ? `A legal two-phase solution has ${cubeSolutionMoves.length} moves. Step through them below.` : "The entered stickers already form a solved cube.";
      renderStatus("Cube state verified.", moveText, { feedback: "Kociemba cube solver" });
    } catch (error) {
      renderStatus("The cube solution could not be replayed.", error.message, { error: true });
    }
  });
  worker.addEventListener("error", () => {
    if (cubeWorker !== worker) return;
    worker.terminate();
    cubeWorker = null;
    setBusy(false);
    renderStatus("The cube solver stopped unexpectedly.", "Try again after checking the sticker state.", { error: true });
  });
  worker.postMessage({ type: "solve", facelets: activeStructuredState.facelets });
}

async function getHint() {
  if (photoReviewPending) return;
  if (puzzleType === "cube") {
    solveCubePuzzle();
    return;
  }
  const bad = puzzleType === "sudoku" ? checkLocalConflicts() : [];
  if (bad.length) {
    conflicting = bad;
    highlighted = [];
    eliminationHighlights = [];
    paintBoard();
    renderStatus("A couple of clues disagree.", "Matching digits are marked in red. Change one and try again.", { error: true });
    return;
  }
  if (puzzleType === "sudoku" && !/[1-9]/.test(board)) {
    renderStatus("Add a few clues first.", "Select cells to enter the digits already shown in your puzzle.");
    return;
  }
  if (puzzleType !== "sudoku" && !activeStructuredState) {
    renderStatus("Load a puzzle first.", "Enter a structured puzzle state and choose “Load this puzzle”.");
    return;
  }
  setBusy(true, "Finding a useful step…");
  try {
    const hintPath = puzzleType === "chess" ? "/v1/chess/analyze" : selectedLevel === "hint" ? "/v1/explain" : "/v1/hint";
    const useAiExplanation = puzzleType !== "chess" && puzzleType !== "cube" && selectedLevel === "hint"
      && document.querySelector("#useAiExplanation").checked;
    const data = await request(hintPath, puzzleType === "chess" ? {} : {
      help_level: selectedLevel, use_ai_explanation: useAiExplanation,
    });
    if (data.status === "needs_review") {
      renderStatus("Map the source clues first.", data.reason || "Map every original clue and relationship in the visual relationship builder, then load the logic grid again.", { error: true });
      return;
    }
    if (data.status === "invalid") {
      conflicting = data.conflicting_cells || [];
      if (["kenken", "killer_sudoku"].includes(puzzleType)) {
        cageEditorConflictCells = conflicting;
        renderCageEditor();
      }
      highlighted = [];
      eliminationHighlights = [];
      paintBoard();
      renderStatus("These clues don’t fit together.", data.reason || "Review the grid and adjust a clue.", { error: true });
      return;
    }
    if (data.status === "complete") {
      renderStatus("You got it.", data.message);
      return;
    }
    if (data.status === "multiple") {
      renderStatus("More than one valid solution.", data.message || "Add another clue before asking for a specific value.");
      return;
    }
    if (data.status === "too_hard") {
      renderStatus("This puzzle needs a closer look.", data.message || "The solver reached its time limit. Check the clues or use a smaller puzzle.", { error: true });
      return;
    }
    if (puzzleType === "chess" && ["checkmate", "draw"].includes(data.status)) {
      renderStatus(data.status === "checkmate" ? "This position is checkmate." : "This position is a draw.", "There is no legal move to suggest.");
      return;
    }
    const aiPhrasing = data.ai_explanation ? `\nAI rephrasing: ${data.ai_explanation}` : "";
    const explanationNotice = data.explanation_notice ? `\n${data.explanation_notice}` : "";
    if (puzzleType !== "sudoku") {
      if (puzzleType === "chess" && data.status === "suggestion") {
        const line = (data.principal_variation || []).join(" ");
        chessPvLine = data.principal_variation || [data.best_move];
        chessPvHistory = [activeStructuredState.fen];
        chessPvIndex = 0;
        updateChessPvControls();
        renderChessBoard(activeStructuredState.fen, data.best_move);
        renderStatus(`Suggested move: ${data.best_move}`, `${data.reason}\nSearch depth ${data.depth} · ${data.score_cp} cp${line ? `\nLine: ${line}` : ""}`, { feedback: "Bounded chess search" });
        return;
      }
      const value = data.value == null ? "" : `\nSuggested value: ${JSON.stringify(data.value)}`;
      renderStatus(data.technique || "Verified hint", `${data.explanation || data.message || "The solver checked this step."}${value}${aiPhrasing}${explanationNotice}`, { feedback: data.technique });
      return;
    }
    highlighted = data.cells || [];
    eliminationHighlights = (data.eliminations || []).map((item) => item.cell);
    conflicting = [];
    paintBoard();
    if (selectedLevel === "answer" && data.value) {
      const index = data.cells[0];
      const next = board.split("");
      next[index] = data.value;
      board = next.join("");
      paintBoard();
      const cell = cells[index];
      cell.focus();
      renderStatus(`${data.technique}: ${data.value}`, `${data.explanation}${aiPhrasing}${explanationNotice}`, { feedback: data.technique });
    } else {
      renderStatus(data.technique, `${data.explanation}${aiPhrasing}${explanationNotice}`, { feedback: data.technique });
    }
  } catch (error) {
    renderStatus("Couldn’t complete this request.", `${error.message} Check the puzzle state and fair-play confirmation, then try again.`, { error: true });
  } finally {
    setBusy(false);
  }
}

function structuredSolutionChunks(type, solution) {
  if ((type === "kenken" || type === "killer_sudoku") && typeof solution === "string") {
    const size = activeStructuredState.size;
    return Array.from({ length: size }, (_, row) => ({ title: `Row ${row + 1}`, detail: [...solution.slice(row * size, (row + 1) * size)].join("  ") }));
  }
  if (type === "nonogram" && Array.isArray(solution)) {
    return solution.map((line, row) => ({ title: `Picture row ${row + 1}`, detail: typeof line === "string" ? [...line].join(" ") : line.join(" ") }));
  }
  if (type === "logic_grid" && Array.isArray(solution)) {
    return solution.map((position) => ({
      title: `Position ${position.position}`,
      detail: Object.entries(position.values).map(([category, value]) => `${category}: ${value}`).join(" · "),
    }));
  }
  return [{ title: "Verified solution", detail: JSON.stringify(solution, null, 2) }];
}

function showStructuredSolutionStep(solution, chunks, index) {
  const bounded = Math.max(0, Math.min(index, chunks.length - 1));
  if (puzzleType === "nonogram") {
    document.querySelectorAll("#nonogramResultGrid .nonogram-cell").forEach((cell) => {
      cell.classList.toggle("active-row", Number(cell.dataset.row) === bounded);
    });
  } else if ((puzzleType === "kenken" || puzzleType === "killer_sudoku") && typeof solution === "string") {
    const size = activeStructuredState?.size || cageEditorSize;
    const grid = document.querySelector("#cageEditorGrid");
    if (grid) {
      grid.querySelectorAll(".cage-editor-cell").forEach((cellBtn, cellIndex) => {
        const val = solution[cellIndex];
        const valSpan = cellBtn.querySelector(".cage-given-value");
        if (valSpan && val) {
          valSpan.textContent = val;
          cellBtn.classList.add("cage-solution-revealed");
        }
        const cellRow = Math.floor(cellIndex / size);
        cellBtn.style.outline = (cellRow === bounded) ? "2px solid #506c45" : "";
      });
    }
  }
  const actions = [];
  if (bounded > 0) actions.push({ label: "← Previous step", onClick: () => showStructuredSolutionStep(solution, chunks, bounded - 1) });
  if (bounded < chunks.length - 1) actions.push({ label: "Next step →", onClick: () => showStructuredSolutionStep(solution, chunks, bounded + 1) });
  if (bounded === chunks.length - 1) actions.push({ label: "Show full solution →", onClick: () => renderStatus("One solution, fully checked.", JSON.stringify(solution, null, 2), {
    action: { label: "Walk through again →", onClick: () => showStructuredSolutionStep(solution, chunks, 0) },
  }) });
  renderStatus(`Step ${bounded + 1} of ${chunks.length} · ${chunks[bounded].title}`, chunks[bounded].detail, { actions });
}

async function solvePuzzle() {
  if (photoReviewPending) return;
  if (puzzleType === "cube") {
    solveCubePuzzle();
    return;
  }
  const bad = puzzleType === "sudoku" ? checkLocalConflicts() : [];
  if (bad.length) {
    conflicting = bad;
    paintBoard();
    renderStatus("A couple of clues disagree.", "Matching digits are marked in red. Change one and try again.", { error: true });
    return;
  }
  if (puzzleType === "sudoku" && !/[1-9]/.test(board)) {
    renderStatus("Add a few clues first.", "Select cells to enter the digits already shown in your puzzle.");
    return;
  }
  if (puzzleType !== "sudoku" && !activeStructuredState) {
    renderStatus("Load a puzzle first.", "Enter a structured puzzle state and choose “Load this puzzle”.");
    return;
  }
  setBusy(true, "Checking every possibility…");
  try {
    const data = await request(puzzleType === "chess" ? "/v1/chess/analyze" : "/v1/solve", {});
    conflicting = data.conflicting_cells || [];
    if (data.status === "needs_review") {
      renderStatus("Map the source clues first.", data.reason || "Map every original clue and relationship in the visual relationship builder, then load the logic grid again.", { error: true });
    } else if (data.status === "invalid") {
      if (["kenken", "killer_sudoku"].includes(puzzleType)) {
        cageEditorConflictCells = conflicting;
        renderCageEditor();
      }
      paintBoard();
      renderStatus("These clues don’t fit together.", data.reason || "Review the grid and adjust a clue.", { error: true });
    } else if (data.status === "multiple") {
      renderStatus("More than one solution.", "This puzzle has multiple valid completions. Check that all its clues are entered, or edit the grid to add the missing clues.");
    } else if (data.status === "too_hard") {
      renderStatus("This puzzle needs a closer look.", data.message || "The solver reached its time limit. Check the clues or use a smaller puzzle.", { error: true });
    } else if (puzzleType === "chess" && ["checkmate", "draw"].includes(data.status)) {
      renderStatus(data.status === "checkmate" ? "This position is checkmate." : "This position is a draw.", "There is no legal move to suggest.");
    } else if (puzzleType === "chess" && data.status === "suggestion") {
      const line = (data.principal_variation || []).join(" ");
      chessPvLine = data.principal_variation || [data.best_move];
      chessPvHistory = [activeStructuredState.fen];
      chessPvIndex = 0;
      updateChessPvControls();
      renderChessBoard(activeStructuredState.fen, data.best_move);
      renderStatus(`Suggested move: ${data.best_move}`, `${data.reason}\nSearch depth ${data.depth} · ${data.score_cp} cp${line ? `\nLine: ${line}` : ""}`, { feedback: "Bounded chess search" });
    } else if (puzzleType !== "sudoku") {
      const chunks = structuredSolutionChunks(puzzleType, data.solution);
      if (puzzleType === "nonogram") renderNonogramSolution(data.solution);
      showStructuredSolutionStep(data.solution, chunks, 0);
    } else {
      const source = board;
      const solution = data.solution;
      const empty = Array.from({ length: 81 }, (_, index) => index).filter((index) => source[index] === "0");
      showSolution(source, solution);
      renderStatus("One solution, fully checked.", "Every row, column and 3 × 3 box satisfies the Sudoku rules.", {
        actions: [
          { label: "Walk through the solution →", onClick: () => beginWalkthrough(source, solution, empty) },
          { label: "Back to my puzzle →", onClick: () => setBoard(source) },
        ],
      });
    }
  } catch (error) {
    renderStatus("Couldn’t complete this request.", `${error.message} Check the puzzle state and fair-play confirmation, then try again.`, { error: true });
  } finally {
    setBusy(false);
  }
}

function showSolution(source, solution) {
  original = source;
  board = solution;
  solutionView = true;
  walk = null;
  highlighted = [];
  eliminationHighlights = [];
  conflicting = [];
  paintBoard();
  renderStatus("One solution, fully checked.", "Every row, column and 3 × 3 box satisfies the Sudoku rules.", {
    action: { label: "Back to my puzzle →", onClick: () => { setBoard(source); } },
  });
}

function beginWalkthrough(source, solution, empty) {
  walk = { source, solution, empty, step: 0 };
  original = source;
  solutionView = true;
  board = source;
  showWalkStep();
}

function showWalkStep() {
  if (!walk) return;
  if (walk.step >= walk.empty.length) {
    const source = walk.source;
    const solution = walk.solution;
    showSolution(source, solution);
    renderStatus("That’s the whole grid.", "Each revealed value is part of the exact, verified solution.", {
      action: { label: "Back to my puzzle →", onClick: () => setBoard(source) },
    });
    return;
  }
  const index = walk.empty[walk.step];
  const values = board.split("");
  values[index] = walk.solution[index];
  board = values.join("");
  highlighted = [index];
  eliminationHighlights = [];
  conflicting = [];
  paintBoard();
  const stepNumber = walk.step + 1;
  renderStatus(`Step ${stepNumber} of ${walk.empty.length}`, `The verified value in row ${Math.floor(index / 9) + 1}, column ${(index % 9) + 1} is ${walk.solution[index]}.`, {
    action: { label: stepNumber === walk.empty.length ? "Finish walkthrough →" : "Next step →", onClick: () => showWalkStep() },
  });
  walk.step = stepNumber;
}

document.querySelectorAll(".help-level").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".help-level").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
    selectedLevel = button.dataset.level;
    updateAiExplanationControl();
    setBusy(false);
  });
});
hintButton.addEventListener("click", getHint);
solveButton.addEventListener("click", solvePuzzle);
document.querySelector("#sampleButton").addEventListener("click", () => setBoard(SAMPLE));
document.querySelector("#clearButton").addEventListener("click", () => setBoard("0".repeat(81)));
document.querySelector("#savePuzzle").addEventListener("click", saveCurrentPuzzle);
document.querySelector("#puzzleType").addEventListener("change", (event) => setPuzzleType(event.target.value));
document.querySelector("#cubeCameraStart").addEventListener("click", startCubeCameraScan);
document.querySelector("#cubeCaptureFace").addEventListener("click", captureCubeCameraFace);
document.querySelector("#cubeCancelScan").addEventListener("click", () => {
  stopCubeCameraScan();
  cubeCameraFaces = [];
});
document.querySelector("#cubeFacelets").addEventListener("input", (event) => {
  markStructuredDirty();
  renderCubeColorConfirmation(event.target.value.trim());
});
document.querySelector("#loadCubeFacelets").addEventListener("click", () => {
  try {
    loadStructuredState({ type: "cube", facelets: document.querySelector("#cubeFacelets").value.trim() });
  } catch (error) {
    renderStatus("Couldn’t load this cube.", error.message, { error: true });
  }
});
document.querySelector("#cubePrevious").addEventListener("click", () => renderCubeStep(cubeStep - 1));
document.querySelector("#cubeNext").addEventListener("click", () => renderCubeStep(cubeStep + 1));
document.querySelector("#loadStructured").addEventListener("click", () => {
  try {
    loadStructuredState(JSON.parse(document.querySelector("#structuredInput").value));
  } catch (error) {
    renderStatus("Couldn’t load this puzzle.", error instanceof SyntaxError ? "Check the JSON punctuation and try again." : error.message, { error: true });
  }
});
document.querySelector("#structuredInput").addEventListener("input", markStructuredDirty);
document.querySelector("#toggleStructuredJson").addEventListener("click", () => {
  const tools = document.querySelector("#structuredJsonTools");
  tools.hidden = !tools.hidden;
  document.querySelector("#toggleStructuredJson").textContent = tools.hidden ? "Show advanced JSON" : "Hide advanced JSON";
});
document.querySelector("#loadNonogramClues").addEventListener("click", () => {
  try {
    const rows = parseNonogramClues(document.querySelector("#nonogramRows").value, "Row clues");
    const columns = parseNonogramClues(document.querySelector("#nonogramColumns").value, "Column clues");
    loadStructuredState({ type: "nonogram", rows, columns });
  } catch (error) {
    renderStatus("Couldn’t load these Nonogram clues.", error.message, { error: true });
  }
});
document.querySelector("#nonogramRows").addEventListener("input", markStructuredDirty);
document.querySelector("#nonogramColumns").addEventListener("input", markStructuredDirty);
document.querySelector("#cageEditorSize").addEventListener("change", (event) => {
  markStructuredDirty();
  cageEditorSize = Number(event.target.value);
  cageEditorGivens = "0".repeat(cageEditorSize * cageEditorSize);
  cageEditorCages = [];
  cageEditorDraft = [];
  document.querySelector("#cageEditorGivens").value = cageEditorGivens;
  renderCageEditor();
});
document.querySelector("#cageEditorGivens").addEventListener("input", (event) => {
  markStructuredDirty();
  cageEditorGivens = event.target.value;
  renderCageEditor();
});
document.querySelector("#addCage").addEventListener("click", () => {
  try {
    addCageFromSelection();
  } catch (error) {
    renderStatus("Couldn’t add this cage.", error.message, { error: true });
  }
});
document.querySelector("#undoCage").addEventListener("click", () => {
  markStructuredDirty();
  cageEditorCages.pop();
  renderCageEditor();
});
document.querySelector("#clearCages").addEventListener("click", () => {
  markStructuredDirty();
  cageEditorCages = [];
  cageEditorDraft = [];
  renderCageEditor();
});
document.querySelector("#loadCagePuzzle").addEventListener("click", () => {
  try {
    loadCageEditorState();
  } catch (error) {
    renderStatus("Couldn’t load this cage puzzle.", error.message, { error: true });
  }
});
document.querySelector("#logicCategoryLines").addEventListener("input", () => {
  markStructuredDirty();
  document.querySelector("#logicRelationBuilder").hidden = true;
});
document.querySelector("#logicPositions").addEventListener("input", () => {
  markStructuredDirty();
  document.querySelector("#logicRelationBuilder").hidden = true;
  updateLogicRelationControls();
});
document.querySelector("#prepareLogicRelations").addEventListener("click", () => {
  try {
    prepareLogicRelationBuilder();
  } catch (error) {
    renderStatus("Couldn’t prepare these categories.", error.message, { error: true });
  }
});
document.querySelector("#logicLeftCategory").addEventListener("change", () => populateLogicEntityPicker("Left"));
document.querySelector("#logicRightCategory").addEventListener("change", () => populateLogicEntityPicker("Right"));
document.querySelector("#logicRelationKind").addEventListener("change", updateLogicRelationControls);
document.querySelector("#addLogicRelation").addEventListener("click", () => {
  try {
    addLogicRelation();
  } catch (error) {
    renderStatus("Couldn’t add this relationship.", error.message, { error: true });
  }
});
document.querySelector("#loadLogicRelations").addEventListener("click", () => {
  try {
    loadLogicRelationBuilder();
  } catch (error) {
    renderStatus("Couldn’t load this logic grid.", error.message, { error: true });
  }
});
document.querySelector("#parseLogic").addEventListener("click", async () => {
  try {
    const categories = JSON.parse(document.querySelector("#logicCategories").value);
    const clues = document.querySelector("#logicClues").value.split(/\r?\n/).map((clue) => clue.trim()).filter(Boolean);
    setBusy(true, "Interpreting clues…");
    const response = await historyRequest("/v1/logic/parse", "POST", {
      positions: Number(document.querySelector("#logicPositions").value), categories, clues,
    });
    document.querySelector("#structuredInput").value = JSON.stringify(response.state, null, 2);
    markStructuredDirty();
    initializeLogicEditor(response.state);
    const relationNames = { same: "is matched with", different: "is not matched with", left_of: "is before", next_to: "is next to", immediately_left: "is immediately before" };
    const review = document.querySelector("#logicReview");
    review.replaceChildren();
    response.constraints.forEach((constraint) => {
      const left = `${constraint.left.value} (${constraint.left.category})`;
      const right = constraint.right ? `${relationNames[constraint.kind] || constraint.kind} ${constraint.right.value} (${constraint.right.category})`
        : `${constraint.kind === "not_position" ? "is not at" : "is at"} position ${constraint.position}`;
      const clueText = constraint.clue_index == null ? "Unmapped relationship" : `Clue ${constraint.clue_index + 1}: ${clues[constraint.clue_index]}`;
      const item = document.createElement("li");
      item.textContent = `${clueText} → ${left} ${right}.`;
      review.appendChild(item);
    });
    response.warnings.forEach((warning) => {
      const item = document.createElement("li");
      item.className = "logic-warning";
      item.textContent = `Needs review: ${warning}`;
      review.appendChild(item);
    });
    review.hidden = review.children.length === 0;
    renderStatus("Review the structured clues.", response.warnings.length ? `${response.constraints.length} constraints extracted. ${response.warnings.join(" ")} Load only after reviewing the mappings.` : `${response.constraints.length} constraints extracted. Load them before solving.`);
  } catch (error) {
    renderStatus("Couldn’t interpret these clues.", error.message, { error: true });
  } finally {
    setBusy(false);
  }
});
document.querySelector("#clearHighlights").addEventListener("click", () => {
  highlighted = [];
  eliminationHighlights = [];
  conflicting = [];
  paintBoard();
  if (photoReviewPending) promptPhotoConfirmation();
  else renderEmptyStatus();
});
document.querySelector("#loadPaste").addEventListener("click", () => {
  const pasted = document.querySelector("#pasteGrid").value.replace(/\s/g, "");
  if (pasted.length !== 81 || !/^[0-9.]{81}$/.test(pasted)) {
    renderStatus("That grid needs 81 cells.", "Use digits 1–9 for clues and 0 or . for empty cells, then load it again.", { error: true });
    return;
  }
  setBoard(pasted.replace(/\./g, "0"));
  document.querySelector("#pasteGrid").value = "";
  document.querySelector("#sudokuBoard").scrollIntoView({ behavior: "smooth", block: "center" });
});

const photoInput = document.querySelector("#photoInput");
const photoPanel = document.querySelector("#photoPanel");
const photoCanvas = document.querySelector("#photoCanvas");
const photoContext = photoCanvas.getContext("2d", { willReadFrequently: true });
const recognizeButton = document.querySelector("#recognizePhoto");
const suggestCornersButton = document.querySelector("#suggestPhotoCorners");
document.querySelector("#photoButton").addEventListener("click", () => photoInput.click());
document.querySelector("#screenButton").addEventListener("click", startScreenShare);
document.querySelector("#stopScreenShare").addEventListener("click", closePhoto);
photoInput.addEventListener("change", () => {
  const file = photoInput.files && photoInput.files[0];
  if (!file) return;
  photoInput.value = "";
  if (!file.type.startsWith("image/")) {
    renderStatus("Choose an image file.", "The photo preview accepts common image formats.", { error: true });
    return;
  }
  stopScreenShare();
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(file);
  const loadedImage = new Image();
  loadedImage.onload = () => {
    photoImage = loadedImage;
    const scale = Math.min(1, 1200 / Math.max(loadedImage.naturalWidth, loadedImage.naturalHeight));
    photoCanvas.width = Math.max(1, Math.round(loadedImage.naturalWidth * scale));
    photoCanvas.height = Math.max(1, Math.round(loadedImage.naturalHeight * scale));
    document.querySelector("#cropModeToggle").hidden = false;
    suggestCornersButton.hidden = false;
    setPhotoCornerMode(false);
    drawPhoto();
    photoPanel.hidden = false;
    photoPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    renderStatus("Photo ready on this device.", "Drag a square around the puzzle, or mark its four corners if the page is angled. The image pixels stay in this browser.");
  };
  loadedImage.onerror = () => renderStatus("This image couldn’t be opened.", "Choose another common image format and try again.", { error: true });
  loadedImage.src = photoUrl;
});
function drawPhoto() {
  if (!photoImage) return;
  if (screenVideo && photoImage === screenVideo && screenVideo.readyState < 2) return;
  photoContext.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
  photoContext.drawImage(photoImage, 0, 0, photoCanvas.width, photoCanvas.height);
  if (photoCornerMode && photoCorners.length) {
    photoContext.save();
    photoContext.lineWidth = Math.max(2, photoCanvas.width / 500);
    photoContext.strokeStyle = "#506c45";
    photoContext.fillStyle = "rgba(227, 238, 120, .18)";
    photoContext.beginPath();
    photoCorners.forEach((point, index) => {
      if (index === 0) photoContext.moveTo(point.x, point.y);
      else photoContext.lineTo(point.x, point.y);
    });
    if (photoCorners.length === 4) {
      photoContext.closePath();
      photoContext.fill();
    }
    photoContext.stroke();
    photoCorners.forEach((point, index) => {
      const radius = Math.max(12, photoCanvas.width / 70);
      photoContext.beginPath();
      photoContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
      photoContext.fillStyle = "#506c45";
      photoContext.fill();
      photoContext.fillStyle = "white";
      photoContext.font = `600 ${Math.max(12, radius)}px sans-serif`;
      photoContext.textAlign = "center";
      photoContext.textBaseline = "middle";
      photoContext.fillText(String(index + 1), point.x, point.y);
    });
    photoContext.restore();
  } else if (photoRectangle) {
    photoContext.save();
    photoContext.fillStyle = "rgba(227, 238, 120, .22)";
    photoContext.strokeStyle = "#506c45";
    photoContext.lineWidth = Math.max(2, photoCanvas.width / 500);
    photoContext.fillRect(photoRectangle.x, photoRectangle.y, photoRectangle.width, photoRectangle.height);
    photoContext.strokeRect(photoRectangle.x, photoRectangle.y, photoRectangle.width, photoRectangle.height);
    photoContext.restore();
  }
}

function setPhotoCornerMode(enabled) {
  photoCornerMode = enabled;
  photoCorners = [];
  photoRectangle = null;
  dragStart = null;
  recognizeButton.disabled = true;
  document.querySelector("#cropModeToggle").textContent = enabled ? "Use rectangle crop →" : "Use four-corner correction →";
  document.querySelector("#resetPhotoCorners").hidden = true;
  document.querySelector("#photoCornerInstructions").hidden = !enabled;
  document.querySelector("#photoCornerInstructions").textContent = enabled
    ? "Click the four grid corners clockwise: top-left, top-right, bottom-right, then bottom-left."
    : "";
  photoCanvas.setAttribute("aria-label", enabled
    ? "Photo perspective correction. Click the four Sudoku grid corners clockwise, starting at the top-left."
    : "Photo crop area. Drag to select the Sudoku grid.");
  drawPhoto();
}

function validatePhotoCorners(points) {
  if (points.length !== 4) return { valid: false, reason: "Mark all four corners first." };
  let twiceArea = 0;
  const turns = [];
  for (let index = 0; index < 4; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % 4];
    const after = points[(index + 2) % 4];
    const edge = Math.hypot(next.x - current.x, next.y - current.y);
    if (edge < 24) return { valid: false, reason: "The corners are too close. Reset and mark the outside grid edges." };
    twiceArea += current.x * next.y - next.x * current.y;
    turns.push((next.x - current.x) * (after.y - next.y) - (next.y - current.y) * (after.x - next.x));
  }
  if (Math.abs(twiceArea) < 3200 || turns.some((turn) => turn <= 0)) {
    return { valid: false, reason: "The corners must follow the grid clockwise without crossing. Start at the top-left and follow the outside edge." };
  }
  return { valid: true };
}

function suggestPhotoGridCorners() {
  if (!photoImage || !photoCanvas.width || !photoCanvas.height) return null;
  const analysisCanvas = document.createElement("canvas");
  const scale = Math.min(1, 360 / Math.max(photoCanvas.width, photoCanvas.height));
  analysisCanvas.width = Math.max(1, Math.round(photoCanvas.width * scale));
  analysisCanvas.height = Math.max(1, Math.round(photoCanvas.height * scale));
  const context = analysisCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(photoImage, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const { width, height } = analysisCanvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  const histogram = new Array(256).fill(0);
  const gray = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const value = Math.round(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114);
    gray[index] = value;
    histogram[value] += 1;
  }
  const threshold = Math.max(95, Math.min(180, otsuThreshold(histogram, gray.length)));
  const integralWidth = width + 1;
  const integral = new Uint32Array(integralWidth * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowTotal = 0;
    for (let x = 0; x < width; x += 1) {
      rowTotal += gray[y * width + x] < threshold ? 1 : 0;
      integral[(y + 1) * integralWidth + x + 1] = integral[y * integralWidth + x + 1] + rowTotal;
    }
  }
  const darkArea = (left, top, right, bottom) => {
    const x0 = Math.max(0, Math.min(width, left)), x1 = Math.max(0, Math.min(width, right));
    const y0 = Math.max(0, Math.min(height, top)), y1 = Math.max(0, Math.min(height, bottom));
    if (x1 <= x0 || y1 <= y0) return 0;
    return integral[y1 * integralWidth + x1] - integral[y0 * integralWidth + x1]
      - integral[y1 * integralWidth + x0] + integral[y0 * integralWidth + x0];
  };
  const axisLineScore = (axis, center, start, end, strip, radius) => {
    let best = 0;
    for (let delta = -radius; delta <= radius; delta += 1) {
      const left = axis === "vertical" ? Math.round(center + delta - strip / 2) : start;
      const right = axis === "vertical" ? left + strip : end;
      const top = axis === "horizontal" ? Math.round(center + delta - strip / 2) : start;
      const bottom = axis === "horizontal" ? top + strip : end;
      const area = (right - left) * (bottom - top);
      if (area > 0) best = Math.max(best, darkArea(left, top, right, bottom) / area);
    }
    return best;
  };
  const positions = (maximum, step) => {
    const result = [];
    for (let value = 0; value <= maximum; value += step) result.push(value);
    if (result[result.length - 1] !== maximum) result.push(maximum);
    return result;
  };
  const minimumSide = Math.min(Math.min(width, height), Math.max(110, Math.round(Math.min(width, height) * 0.3)));
  const maximumSide = Math.min(width, height);
  const sizeStep = Math.max(4, Math.round(maximumSide / 80));
  let best = null;
  for (let side = minimumSide; side <= maximumSide; side += sizeStep) {
    const inset = Math.max(1, Math.round(side * 0.008));
    const strip = Math.max(3, Math.round(side * 0.014));
    const radius = Math.max(2, Math.round(side * 0.012));
    const first = inset;
    const last = side - inset;
    const bandStart = Math.round(side * 0.07);
    const bandEnd = side - bandStart;
    const step = Math.max(4, Math.round(side / 55));
    const xStarts = positions(width - side, step);
    const yStarts = positions(height - side, step);
    for (const y of yStarts) for (const x of xStarts) {
      let verticalTotal = 0, horizontalTotal = 0, weakLines = 0;
      for (let line = 0; line <= 9; line += 1) {
        const point = first + (last - first) * line / 9;
        const vertical = axisLineScore("vertical", x + point, y + bandStart, y + bandEnd, strip, radius);
        const horizontal = axisLineScore("horizontal", y + point, x + bandStart, x + bandEnd, strip, radius);
        verticalTotal += vertical;
        horizontalTotal += horizontal;
        if (vertical < 0.035 || horizontal < 0.035) weakLines += 1;
      }
      const verticalAverage = verticalTotal / 10;
      const horizontalAverage = horizontalTotal / 10;
      if (weakLines > 3 || verticalAverage < 0.065 || horizontalAverage < 0.065) continue;
      const score = (verticalAverage + horizontalAverage) / 2 + Math.min(verticalAverage, horizontalAverage) * 0.35
        + side / maximumSide * 0.005;
      if (!best || score > best.score) best = { x, y, side, inset, score };
    }
  }
  if (!best || best.score < 0.09) return null;
  const factorX = photoCanvas.width / width;
  const factorY = photoCanvas.height / height;
  const left = (best.x + best.inset) * factorX;
  const top = (best.y + best.inset) * factorY;
  const right = (best.x + best.side - best.inset) * factorX;
  const bottom = (best.y + best.side - best.inset) * factorY;
  const corners = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  return validatePhotoCorners(corners).valid ? corners : null;
}

suggestCornersButton.addEventListener("click", async () => {
  suggestCornersButton.disabled = true;
  const originalLabel = suggestCornersButton.textContent;
  suggestCornersButton.textContent = "Looking for the grid…";
  renderStatus("Searching locally…", "The corner suggestion runs in this browser. Check the numbered corners before recognition.");
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    const corners = suggestPhotoGridCorners();
    if (!corners) {
      renderStatus("We couldn’t suggest the grid corners.", "Drag a square around the puzzle or mark its four corners manually.", { error: true });
      return;
    }
    photoCornerMode = true;
    photoCorners = corners;
    photoRectangle = { x: corners[0].x, y: corners[0].y, width: corners[1].x - corners[0].x, height: corners[3].y - corners[0].y };
    recognizeButton.disabled = false;
    document.querySelector("#cropModeToggle").textContent = "Use rectangle crop →";
    document.querySelector("#resetPhotoCorners").hidden = false;
    document.querySelector("#photoCornerInstructions").hidden = false;
    document.querySelector("#photoCornerInstructions").textContent = "Suggested corners: check the numbered grid edges. Reset to mark them manually if any corner is off.";
    photoCanvas.setAttribute("aria-label", "Suggested Sudoku grid corners. Review the four numbered corners before recognition.");
    drawPhoto();
    saveRememberedScreenCrop();
    renderStatus("Review the suggested corners.", "The local grid scan found a likely square. If the board is angled or a corner is off, reset and mark the four corners manually.");
  } catch (error) {
    renderStatus("We couldn’t suggest the grid corners.", `${error.message} Mark the four corners manually instead.`, { error: true });
  } finally {
    suggestCornersButton.textContent = originalLabel;
    suggestCornersButton.disabled = false;
  }
});

function solveLinearSystem(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) throw new Error("These corners do not form a usable quadrilateral.");
    [augmented[pivot], augmented[column]] = [augmented[column], augmented[pivot]];
    const scale = augmented[column][column];
    for (let entry = column; entry <= size; entry += 1) augmented[column][entry] /= scale;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= size; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row[size]);
}

function perspectiveMapper(points) {
  const destinations = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const matrix = [];
  const values = [];
  destinations.forEach(([u, v], index) => {
    const { x, y } = points[index];
    matrix.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    values.push(x);
    matrix.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    values.push(y);
  });
  const [a, b, c, d, e, f, g, h] = solveLinearSystem(matrix, values);
  return (u, v) => {
    const denominator = g * u + h * v + 1;
    if (Math.abs(denominator) < 1e-10) throw new Error("The selected perspective is too extreme to straighten.");
    return { x: (a * u + b * v + c) / denominator, y: (d * u + e * v + f) / denominator };
  };
}

function warpPhotoToSquare(size, sourceCanvas) {
  const validity = validatePhotoCorners(photoCorners);
  if (!validity.valid) throw new Error(validity.reason);
  const mapPoint = perspectiveMapper(photoCorners);
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const source = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const output = photoContext.createImageData(size, size);
  const maxX = sourceCanvas.width - 1, maxY = sourceCanvas.height - 1;
  for (let y = 0; y < size; y += 1) {
    const v = y / (size - 1);
    for (let x = 0; x < size; x += 1) {
      const mapped = mapPoint(x / (size - 1), v);
      const sourceX = Math.max(0, Math.min(maxX, mapped.x));
      const sourceY = Math.max(0, Math.min(maxY, mapped.y));
      const left = Math.floor(sourceX), top = Math.floor(sourceY);
      const right = Math.min(maxX, left + 1), bottom = Math.min(maxY, top + 1);
      const dx = sourceX - left, dy = sourceY - top;
      const targetOffset = (y * size + x) * 4;
      const offsets = [(top * sourceCanvas.width + left) * 4, (top * sourceCanvas.width + right) * 4,
        (bottom * sourceCanvas.width + left) * 4, (bottom * sourceCanvas.width + right) * 4];
      for (let channel = 0; channel < 4; channel += 1) {
        const upper = source.data[offsets[0] + channel] * (1 - dx) + source.data[offsets[1] + channel] * dx;
        const lower = source.data[offsets[2] + channel] * (1 - dx) + source.data[offsets[3] + channel] * dx;
        output.data[targetOffset + channel] = upper * (1 - dy) + lower * dy;
      }
    }
  }
  return output;
}
async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    renderStatus("Screen sharing isn’t available here.", "Use a current desktop browser or add a photo of the puzzle instead.", { error: true });
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 } }, audio: false });
    screenVideo = document.createElement("video");
    screenVideo.muted = true;
    screenVideo.playsInline = true;
    screenVideo.srcObject = screenStream;
    await screenVideo.play();
    if (!screenVideo.videoWidth) await new Promise((resolve) => screenVideo.addEventListener("loadedmetadata", resolve, { once: true }));
    photoImage = screenVideo;
    const width = screenVideo.videoWidth;
    const height = screenVideo.videoHeight;
    const scale = Math.min(1, 1200 / Math.max(width, height));
    photoCanvas.width = Math.max(1, Math.round(width * scale));
    photoCanvas.height = Math.max(1, Math.round(height * scale));
    setPhotoCornerMode(false);
    document.querySelector("#cropModeToggle").hidden = true;
    suggestCornersButton.hidden = false;
    document.querySelector("#stopScreenShare").hidden = false;
    document.querySelector("#screenCaptureIndicator").hidden = false;
    document.querySelector("#screenCropMemory").hidden = false;
    document.querySelector("#screenButton").disabled = true;
    photoPanel.hidden = false;
    photoPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    const track = screenStream.getVideoTracks()[0];
    track.addEventListener("ended", () => {
      if (!screenStream) return;
      stopScreenShare();
      photoPanel.hidden = true;
      renderStatus("Screen sharing ended.", "The screen capture stopped. No screen pixels were sent to the solver.");
    }, { once: true });
    const redraw = () => {
      if (!screenStream) return;
      drawPhoto();
      monitorScreenFrame(performance.now());
      screenFrameHandle = requestAnimationFrame(redraw);
    };
    redraw();
    const restored = restoreRememberedScreenCrop();
    renderStatus("Screen shared on this device.", restored ? "The saved crop is ready. The crop coordinates are stored locally; screen pixels stay in this browser." : "Drag a square around the visible Sudoku. You can optionally save its crop coordinates under a site label on this device.");
  } catch (error) {
    stopScreenShare();
    const message = error.name === "NotAllowedError" ? "Screen access was cancelled. You can choose a photo or allow sharing when prompted." : error.message;
    renderStatus("Couldn’t share this screen.", message, { error: true });
  }
}

function screenCropKey() {
  const label = document.querySelector("#screenSiteName").value.trim().toLowerCase()
    .replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0].replace(/[^a-z0-9.-]/g, "");
  return label ? `puzzl.screenCrop.${label}` : null;
}

function restoreRememberedScreenCrop() {
  const key = screenCropKey();
  if (!key || !screenStream) return false;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || saved.x < 0 || saved.y < 0 ||
        saved.width <= 0 || saved.height <= 0 || saved.x + saved.width > 1.01 || saved.y + saved.height > 1.01) return false;
    photoRectangle = { x: saved.x * photoCanvas.width, y: saved.y * photoCanvas.height,
      width: saved.width * photoCanvas.width, height: saved.height * photoCanvas.height };
    recognizeButton.disabled = photoRectangle.width < 40 || photoRectangle.height < 40;
    screenSnapshot = null;
    screenChangeTime = 0;
    screenStableSamples = 0;
    drawPhoto();
    return true;
  } catch {
    return false;
  }
}

function saveRememberedScreenCrop() {
  const key = screenCropKey();
  if (!key || !screenStream || !document.querySelector("#rememberScreenCrop").checked || !photoRectangle || !photoCanvas.width || !photoCanvas.height) return;
  try {
    localStorage.setItem(key, JSON.stringify({ x: photoRectangle.x / photoCanvas.width, y: photoRectangle.y / photoCanvas.height,
      width: photoRectangle.width / photoCanvas.width, height: photoRectangle.height / photoCanvas.height }));
  } catch {
    renderStatus("The crop could not be saved.", "Browser storage may be full or disabled; you can still use the selected region.", { error: true });
  }
}

function stopScreenShare() {
  const activeStream = screenStream;
  screenStream = null;
  if (screenFrameHandle != null) cancelAnimationFrame(screenFrameHandle);
  screenFrameHandle = null;
  screenSnapshot = null;
  screenChangeTime = 0;
  screenStableSamples = 0;
  if (activeStream) activeStream.getTracks().forEach((track) => track.stop());
  if (photoImage === screenVideo) photoImage = null;
  screenVideo = null;
  document.querySelector("#stopScreenShare").hidden = true;
  document.querySelector("#screenCaptureIndicator").hidden = true;
  document.querySelector("#screenCropMemory").hidden = true;
  document.querySelector("#screenButton").disabled = false;
}
function monitorScreenFrame(now) {
  if (!screenStream || photoReviewPending || !photoRectangle || now - screenSampleTime < 300) return;
  screenSampleTime = now;
  if (!screenMonitorCanvas) {
    screenMonitorCanvas = document.createElement("canvas");
    screenMonitorCanvas.width = 84;
    screenMonitorCanvas.height = 84;
  }
  const context = screenMonitorCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(photoCanvas, photoRectangle.x, photoRectangle.y, photoRectangle.width, photoRectangle.height,
    0, 0, screenMonitorCanvas.width, screenMonitorCanvas.height);
  const current = context.getImageData(0, 0, screenMonitorCanvas.width, screenMonitorCanvas.height).data;
  if (!screenSnapshot) {
    screenSnapshot = current;
    return;
  }
  let changedPixels = 0;
  const pixels = current.length / 4;
  for (let offset = 0; offset < current.length; offset += 4) {
    const difference = Math.abs(current[offset] - screenSnapshot[offset]) +
      Math.abs(current[offset + 1] - screenSnapshot[offset + 1]) + Math.abs(current[offset + 2] - screenSnapshot[offset + 2]);
    if (difference > 75) changedPixels += 1;
  }
  screenSnapshot = current;
  if (changedPixels / pixels > 0.06) {
    screenChangeTime = now;
    screenStableSamples = 0;
    return;
  }
  if (screenChangeTime && now - screenChangeTime > 600) {
    screenStableSamples += 1;
    if (screenStableSamples >= 2) {
      screenChangeTime = 0;
      screenStableSamples = 0;
      recognizeGrid();
    }
  }
}
function canvasPoint(event) {
  const bounds = photoCanvas.getBoundingClientRect();
  return {
    x: Math.min(photoCanvas.width, Math.max(0, (event.clientX - bounds.left) * photoCanvas.width / bounds.width)),
    y: Math.min(photoCanvas.height, Math.max(0, (event.clientY - bounds.top) * photoCanvas.height / bounds.height)),
  };
}
photoCanvas.addEventListener("pointerdown", (event) => {
  if (!photoImage) return;
  event.preventDefault();
  if (photoCornerMode) {
    if (photoCorners.length >= 4) return;
    photoCorners.push(canvasPoint(event));
    const validity = photoCorners.length === 4 ? validatePhotoCorners(photoCorners) : { valid: false };
    if (photoCorners.length === 4 && validity.valid) {
      const xs = photoCorners.map((point) => point.x), ys = photoCorners.map((point) => point.y);
      photoRectangle = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      recognizeButton.disabled = false;
      document.querySelector("#photoCornerInstructions").textContent = "Corners ready. Recognize the grid or reset them to start over.";
    } else if (photoCorners.length === 4) {
      photoRectangle = null;
      recognizeButton.disabled = true;
      document.querySelector("#photoCornerInstructions").textContent = `${validity.reason} Reset corners to try again.`;
      renderStatus("Those corners need another look.", validity.reason, { error: true });
    } else {
      document.querySelector("#photoCornerInstructions").textContent = `Corner ${photoCorners.length} of 4. Continue clockwise around the outside grid edge.`;
    }
    document.querySelector("#resetPhotoCorners").hidden = false;
    drawPhoto();
    return;
  }
  dragStart = canvasPoint(event);
  photoRectangle = { x: dragStart.x, y: dragStart.y, width: 0, height: 0 };
  photoCanvas.setPointerCapture(event.pointerId);
});
photoCanvas.addEventListener("pointermove", (event) => {
  if (!dragStart) return;
  const point = canvasPoint(event);
  photoRectangle = { x: Math.min(dragStart.x, point.x), y: Math.min(dragStart.y, point.y),
    width: Math.abs(point.x - dragStart.x), height: Math.abs(point.y - dragStart.y) };
  recognizeButton.disabled = photoRectangle.width < 40 || photoRectangle.height < 40;
  drawPhoto();
});
photoCanvas.addEventListener("pointerup", () => {
  dragStart = null;
  screenSnapshot = null;
  screenChangeTime = 0;
  screenStableSamples = 0;
  saveRememberedScreenCrop();
});
document.querySelector("#screenSiteName").addEventListener("change", () => {
  if (restoreRememberedScreenCrop()) renderStatus("Saved crop restored.", "The crop is scaled to this shared screen and can be adjusted by dragging on the preview.");
});
document.querySelector("#rememberScreenCrop").addEventListener("change", saveRememberedScreenCrop);
document.querySelector("#cropModeToggle").addEventListener("click", () => setPhotoCornerMode(!photoCornerMode));
document.querySelector("#resetPhotoCorners").addEventListener("click", () => setPhotoCornerMode(true));

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 150;
  for (let i = 0; i < 256; i += 1) {
    backgroundWeight += histogram[i];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += i * histogram[i];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = i;
    }
  }
  return Math.min(205, threshold);
}

function templateDigits() {
  const fonts = ["Arial", "Georgia", "Times New Roman", "Verdana"];
  const templates = [];
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 18;
  sampleCanvas.height = 24;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  for (const digit of "123456789") for (const font of fonts) {
    sampleContext.fillStyle = "white";
    sampleContext.fillRect(0, 0, 18, 24);
    sampleContext.fillStyle = "black";
    sampleContext.font = `bold 21px ${font}`;
    sampleContext.textAlign = "center";
    sampleContext.textBaseline = "middle";
    sampleContext.fillText(digit, 9, 12);
    const image = sampleContext.getImageData(0, 0, 18, 24).data;
    templates.push({ digit, mask: Array.from({ length: 18 * 24 }, (_, i) => image[i * 4] < 135) });
  }
  return templates;
}
const digitTemplates = templateDigits();

function normalizeInk(points, minX, minY, maxX, maxY) {
  const width = Math.max(1, maxX - minX + 1);
  const height = Math.max(1, maxY - minY + 1);
  const scale = Math.min(16 / width, 21 / height);
  const drawWidth = Math.max(1, Math.round(width * scale));
  const drawHeight = Math.max(1, Math.round(height * scale));
  const left = Math.floor((18 - drawWidth) / 2);
  const top = Math.floor((24 - drawHeight) / 2);
  const mask = Array(18 * 24).fill(false);
  points.forEach(([x, y]) => {
    const nx = left + Math.min(drawWidth - 1, Math.floor((x - minX) * scale));
    const ny = top + Math.min(drawHeight - 1, Math.floor((y - minY) * scale));
    mask[ny * 18 + nx] = true;
  });
  return mask;
}

function classifyCell(imageData, width, x0, y0, x1, y1) {
  const histogram = new Array(256).fill(0);
  const shades = [];
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const offset = (y * width + x) * 4;
    const gray = Math.round(imageData[offset] * .299 + imageData[offset + 1] * .587 + imageData[offset + 2] * .114);
    shades.push([x, y, gray]);
    histogram[gray] += 1;
  }
  const threshold = otsuThreshold(histogram, shades.length);
    const ink = shades.filter((point) => point[2] <= threshold && point[2] < 210);
  if (ink.length < 5) return { value: "0", score: 1, blank: true };
  const xs = ink.map((point) => point[0]);
  const ys = ink.map((point) => point[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < 2 || maxY - minY < 3) return { value: "0", score: 0, blank: true };
  const mask = normalizeInk(ink.map(([x, y]) => [x, y]), minX, minY, maxX, maxY);
  let bestDigit = "0", bestScore = 0, secondBestScore = 0;
  for (const template of digitTemplates) {
    let overlap = 0, actualCount = 0, templateCount = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i]) actualCount += 1;
      if (template.mask[i]) templateCount += 1;
      if (mask[i] && template.mask[i]) overlap += 1;
    }
    const score = (2 * overlap) / (actualCount + templateCount || 1);
    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestDigit = template.digit;
    } else if (score > secondBestScore) secondBestScore = score;
  }
  return { value: bestDigit, score: bestScore, margin: bestScore - secondBestScore, blank: false };
}

function detectGridLines(imageData, size, axis) {
  const scores = new Array(size).fill(0);
  for (let position = 0; position < size; position += 1) {
    let dark = 0;
    for (let cross = 0; cross < size; cross += 1) {
      const x = axis === "vertical" ? position : cross;
      const y = axis === "vertical" ? cross : position;
      const offset = (y * size + x) * 4;
      const gray = imageData[offset] * 0.299 + imageData[offset + 1] * 0.587 + imageData[offset + 2] * 0.114;
      if (gray < 185) dark += 1;
    }
    scores[position] = dark / size;
  }
  const smooth = scores.map((_, index) => (scores[Math.max(0, index - 1)] + scores[index] + scores[Math.min(size - 1, index + 1)]) / 3);
  const lines = [];
  for (let line = 0; line <= 9; line += 1) {
    const expected = Math.round(line * (size - 1) / 9);
    const start = Math.max(line === 0 ? 0 : (lines[line - 1] + 34), expected - 12);
    const end = Math.min(size - 1, expected + 12);
    let best = -1;
    for (let position = start; position <= end; position += 1) if (best < 0 || smooth[position] > smooth[best]) best = position;
    if (best < 0 || smooth[best] < 0.2 || (line > 0 && best - lines[line - 1] < 34)) return null;
    lines.push(best);
  }
  return lines;
}


function recognizeChessGrid() {
  if (!photoRectangle || !photoCanvas.width) return;
  const { x, y, width, height } = photoRectangle;
  const cropCanvas = document.createElement("canvas");
  const size = 320;
  cropCanvas.width = size;
  cropCanvas.height = size;
  const cropContext = cropCanvas.getContext("2d", { willReadFrequently: true });
  if (photoCornerMode && photoCorners.length === 4) {
    const warped = warpPhotoToSquare(size, photoCanvas);
    cropContext.putImageData(warped, 0, 0);
  } else {
    cropContext.drawImage(photoCanvas, x, y, width, height, 0, 0, size, size);
  }
  const imageData = cropContext.getImageData(0, 0, size, size).data;
  const squareSize = size / 8;
  const squares = [];
  chessUncertainSquares = [];

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const squareIndex = row * 8 + col;
      const x0 = Math.round(col * squareSize);
      const y0 = Math.round(row * squareSize);
      const x1 = Math.round((col + 1) * squareSize);
      const y1 = Math.round((row + 1) * squareSize);
      const squareW = x1 - x0;
      const squareH = y1 - y0;

      const bgMargin = Math.max(2, Math.round(squareSize * 0.12));
      let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
      for (const [cx, cy] of [
        [x0 + bgMargin, y0 + bgMargin], [x1 - bgMargin, y0 + bgMargin],
        [x0 + bgMargin, y1 - bgMargin], [x1 - bgMargin, y1 - bgMargin]
      ]) {
        const off = (cy * size + cx) * 4;
        bgR += imageData[off]; bgG += imageData[off + 1]; bgB += imageData[off + 2]; bgCount += 1;
      }
      bgR /= bgCount; bgG /= bgCount; bgB /= bgCount;

      const innerMargin = Math.round(squareSize * 0.12);
      const pieceInk = [];
      let totalLuma = 0;
      for (let sy = y0 + innerMargin; sy < y1 - innerMargin; sy += 1) {
        for (let sx = x0 + innerMargin; sx < x1 - innerMargin; sx += 1) {
          const off = (sy * size + sx) * 4;
          const r = imageData[off], g = imageData[off + 1], b = imageData[off + 2];
          const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
          if (dist > 32) {
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            pieceInk.push({ x: sx - x0, y: sy - y0, luma });
            totalLuma += luma;
          }
        }
      }

      const innerArea = (squareW - 2 * innerMargin) * (squareH - 2 * innerMargin);
      if (pieceInk.length / (innerArea || 1) < 0.05) {
        squares.push(".");
        continue;
      }

      const avgLuma = totalLuma / pieceInk.length;
      const isWhite = avgLuma > 145;

      const xs = pieceInk.map(p => p.x);
      const ys = pieceInk.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const inkW = maxX - minX + 1;
      const inkH = maxY - minY + 1;
      const centerX = (minX + maxX) / 2;

      let asymDiff = 0;
      const midY = (minY + maxY) / 2;
      for (const p of pieceInk) {
        if (p.y < midY) {
          const mirroredX = Math.round(2 * centerX - p.x);
          const hasMirror = pieceInk.some(m => Math.abs(m.x - mirroredX) <= 1 && Math.abs(m.y - p.y) <= 1);
          if (!hasMirror) asymDiff += 1;
        }
      }
      const asymRatio = asymDiff / (pieceInk.length || 1);

      const heightRatio = inkH / squareSize;
      const topQuarterY = minY + inkH * 0.25;
      const topInk = pieceInk.filter(p => p.y <= topQuarterY);
      const topWidth = topInk.length ? Math.max(...topInk.map(p => p.x)) - Math.min(...topInk.map(p => p.x)) + 1 : 0;
      const topWidthRatio = topWidth / (inkW || 1);

      let pieceType = "P";
      let confidence = 0.85;

      if (asymRatio > 0.18) {
        pieceType = "N";
        confidence = 0.90;
      } else if (heightRatio < 0.58) {
        pieceType = "P";
        confidence = 0.88;
      } else if (topWidthRatio > 0.65 && heightRatio > 0.68) {
        pieceType = "R";
        confidence = 0.85;
      } else if (heightRatio > 0.80) {
        pieceType = topWidthRatio > 0.55 ? "Q" : "K";
        confidence = 0.80;
      } else if (heightRatio > 0.65) {
        pieceType = "B";
        confidence = 0.82;
      } else {
        pieceType = (row === 1 || row === 6) ? "P" : "B";
        confidence = 0.65;
      }

      if (confidence < 0.70) {
        chessUncertainSquares.push(squareIndex);
      }

      squares.push(isWhite ? pieceType.toUpperCase() : pieceType.toLowerCase());
    }
  }

  const recognizedFen = squaresToFen(squares, "w");
  setChessFen(recognizedFen);
  photoPanel.hidden = true;
  chessPhotoSource = false;
  document.querySelector("#chessPanel").scrollIntoView({ behavior: "smooth", block: "center" });

  if (chessUncertainSquares.length > 0) {
    renderStatus("Chess board recognized.", `Read 64 squares; ${chessUncertainSquares.length} squares highlighted for review. Click any square on the board to fix it.`);
  } else {
    renderStatus("Chess board recognized.", "All 64 squares classified cleanly. Review the board and confirm fair play before analyzing.");
  }
}

function autoDetectPerspectiveCorners() {
  if (!photoImage || !photoCanvas.width || !photoCanvas.height) return null;
  const regular = suggestPhotoGridCorners();
  if (regular) return regular;

  const analysisCanvas = document.createElement("canvas");
  const scale = Math.min(1, 320 / Math.max(photoCanvas.width, photoCanvas.height));
  analysisCanvas.width = Math.max(1, Math.round(photoCanvas.width * scale));
  analysisCanvas.height = Math.max(1, Math.round(photoCanvas.height * scale));
  const context = analysisCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(photoImage, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const { width, height } = analysisCanvas;
  const pixels = context.getImageData(0, 0, width, height).data;

  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    const off = i * 4;
    gray[i] = Math.round(pixels[off] * 0.299 + pixels[off + 1] * 0.587 + pixels[off + 2] * 0.114);
  }

  const edges = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx = (-gray[(y - 1) * width + x - 1] + gray[(y - 1) * width + x + 1])
               + (-2 * gray[y * width + x - 1] + 2 * gray[y * width + x + 1])
               + (-gray[(y + 1) * width + x - 1] + gray[(y + 1) * width + x + 1]);
      const gy = (-gray[(y - 1) * width + x - 1] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + x + 1])
               + (gray[(y + 1) * width + x - 1] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + x + 1]);
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag > 120) edges.push({ x, y, mag });
    }
  }

  if (edges.length < 50) return null;

  let tl = edges[0], tr = edges[0], br = edges[0], bl = edges[0];
  let minSum = tl.x + tl.y, maxSum = br.x + br.y;
  let maxDiff = tr.x - tr.y, minDiff = bl.x - bl.y;

  for (const pt of edges) {
    const sum = pt.x + pt.y;
    const diff = pt.x - pt.y;
    if (sum < minSum) { minSum = sum; tl = pt; }
    if (sum > maxSum) { maxSum = sum; br = pt; }
    if (diff > maxDiff) { maxDiff = diff; tr = pt; }
    if (diff < minDiff) { minDiff = diff; bl = pt; }
  }

  const factorX = photoCanvas.width / width;
  const factorY = photoCanvas.height / height;
  const candidateCorners = [
    { x: tl.x * factorX, y: tl.y * factorY },
    { x: tr.x * factorX, y: tr.y * factorY },
    { x: br.x * factorX, y: br.y * factorY },
    { x: bl.x * factorX, y: bl.y * factorY },
  ];

  return validatePhotoCorners(candidateCorners).valid ? candidateCorners : null;
}

function recognizeGrid() {
  if (!photoRectangle || !photoCanvas.width) return;
  if (photoCornerMode && photoCorners.length !== 4) {
    renderStatus("Mark the four grid corners.", "Click the outside corners clockwise, starting at the top-left.", { error: true });
    return;
  }
  if (!photoCornerMode) {
    const { width, height } = photoRectangle;
    const ratio = width / height;
    if (ratio < .72 || ratio > 1.38) {
      renderStatus("Frame the whole square grid.", "Keep the crop close to a 1:1 square and include all four outside edges.", { error: true });
      return;
    }
  }
  const recognitionStarted = performance.now();
  const stagesMs = {};
  photoRecognition = null;
  let image;
  try {
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = photoCanvas.width;
    sourceCanvas.height = photoCanvas.height;
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    sourceContext.drawImage(photoImage, 0, 0, sourceCanvas.width, sourceCanvas.height);
    if (photoCornerMode) image = warpPhotoToSquare(450, sourceCanvas);
    else {
      const normalized = document.createElement("canvas");
      normalized.width = 450;
      normalized.height = 450;
      const context = normalized.getContext("2d", { willReadFrequently: true });
      const { x, y, width, height } = photoRectangle;
      context.drawImage(sourceCanvas, x, y, width, height, 0, 0, 450, 450);
      image = context.getImageData(0, 0, 450, 450);
    }
  } catch (error) {
    stagesMs.total_to_review = performance.now() - recognitionStarted;
    sendRecognitionTelemetry({ source: screenStream ? "screen" : "photo", outcome: "error",
      stages_ms: stagesMs, recognized_cells: 0 });
    renderStatus("Couldn’t straighten this crop.", `${error.message} Reset the corners or use a rectangle crop instead.`, { error: true });
    return;
  }
  stagesMs.crop_normalization = performance.now() - recognitionStarted;
  const detectionStarted = performance.now();
  const detectedColumns = detectGridLines(image.data, 450, "vertical");
  const detectedRows = detectGridLines(image.data, 450, "horizontal");
  const columns = detectedColumns || Array.from({ length: 10 }, (_, line) => Math.round(line * 450 / 9));
  const rows = detectedRows || Array.from({ length: 10 }, (_, line) => Math.round(line * 450 / 9));
  stagesMs.grid_detection = performance.now() - detectionStarted;
  const next = Array(81).fill("0");
  const scores = Array(81).fill(1);
  const margins = Array(81).fill(null);
  const classificationStarted = performance.now();
  for (let row = 0; row < 9; row += 1) for (let column = 0; column < 9; column += 1) {
    const index = row * 9 + column;
    const insetX = Math.max(4, Math.round((columns[column + 1] - columns[column]) * 0.18));
    const insetY = Math.max(4, Math.round((rows[row + 1] - rows[row]) * 0.18));
    const result = classifyCell(image.data, 450,
      columns[column] + insetX, rows[row] + insetY,
      columns[column + 1] - insetX, rows[row + 1] - insetY);
    next[index] = result.value;
    scores[index] = result.blank ? null : result.score;
    margins[index] = result.blank ? null : result.margin;
  }
  stagesMs.cell_classification = performance.now() - classificationStarted;
  const found = next.filter((digit) => digit !== "0").length;
  if (found < 1) {
    stagesMs.total_to_review = performance.now() - recognitionStarted;
    sendRecognitionTelemetry({ source: screenStream ? "screen" : "photo", outcome: "no_digits",
      stages_ms: stagesMs, recognized_cells: 0 });
    renderStatus("We couldn’t find any printed digits.", "Try a sharper crop, straighten an angled page with the four-corner tool, or enter the clues by hand.", { error: true });
    return;
  }
  if (screenStream && next.join("") === board && !photoReviewPending) {
    renderStatus("The puzzle is unchanged.", "The shared screen changed, but the recognized Sudoku clues are the same.");
    return;
  }
  const reviewCells = next.map((digit, index) => digit !== "0" ? index : -1).filter((index) => index >= 0);
  const weakMatches = reviewCells.filter((index) => scores[index] < VISUAL_MATCH_REVIEW_THRESHOLD ||
    margins[index] < VISUAL_MATCH_MARGIN_THRESHOLD);
  setBoard(next.join(""));
  photoRecognition = { source: screenStream ? "screen" : "photo", stages_ms: stagesMs,
    initial_board: next.join(""), recognized_cells: found };
  uncertain = weakMatches;
  confidenceScores = scores;
  confidenceMargins = margins;
  photoReviewPending = true;
  setBusy(false);
  paintBoard();
  recognizeButton.disabled = true;
  promptPhotoConfirmation(found, detectedRows && detectedColumns
    ? "Detected the row and column boundaries in the crop. "
    : "Some grid lines were faint, so the crop was split into evenly spaced cells. ");
  document.querySelector("#sudokuBoard").scrollIntoView({ behavior: "smooth", block: "center" });
  photoRecognition.stages_ms.total_to_review = performance.now() - recognitionStarted;
}
function promptPhotoConfirmation(found, boundaryNote = "") {
  const title = found ? `${found} clues recognized. Check every clue; shaded cells have weak or close visual matches.` : "Review the recognized clues.";
  const cue = uncertain.length ? `${uncertain.length} cell${uncertain.length === 1 ? " is" : "s are"} shaded for a weak or close template match. `
    : "No cell crossed the local shading threshold. ";
  renderStatus(title, `${boundaryNote}${cue}Scores are uncalibrated visual similarity estimates. Check every clue and correct any misread digit before confirming.`, {
    action: { label: "I’ve checked the clues →", onClick: confirmPhotoClues },
  });
}
function confirmPhotoClues() {
  if (photoRecognition) {
    let changedRecognized = 0;
    let added = 0;
    for (let index = 0; index < 81; index += 1) {
      const initial = photoRecognition.initial_board[index];
      if (initial !== "0" && board[index] !== initial) changedRecognized += 1;
      if (initial === "0" && board[index] !== "0") added += 1;
    }
    sendRecognitionTelemetry({ source: photoRecognition.source, outcome: "reviewed",
      stages_ms: photoRecognition.stages_ms, recognized_cells: photoRecognition.recognized_cells,
      changed_recognized_cells: changedRecognized, added_cells: added });
    photoRecognition = null;
  }
  uncertain = [];
  photoReviewPending = false;
  paintBoard();
  setBusy(false);
  if (screenStream) {
    screenSnapshot = null;
    screenChangeTime = 0;
    screenStableSamples = 0;
    recognizeButton.disabled = !photoRectangle || photoRectangle.width < 40 || photoRectangle.height < 40;
    renderStatus("Clues confirmed.", "The shared screen remains visible only in this browser. Select Recognize this grid after the puzzle changes.");
    return;
  }
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  photoImage = null;
  photoContext.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
  photoPanel.hidden = true;
  renderStatus("Clues confirmed.", "Choose a hint level or check the whole puzzle.");
}
recognizeButton.addEventListener("click", () => {
  if (puzzleType === "chess" || chessPhotoSource) {
    recognizeChessGrid();
  } else {
    recognizeGrid();
  }
});

// Chess controls
const chessFenBtn = document.querySelector("#loadChessFen");
if (chessFenBtn) {
  chessFenBtn.addEventListener("click", () => {
    const val = document.querySelector("#chessFenInput").value.trim();
    if (val) setChessFen(val);
  });
}
const resetChessBtn = document.querySelector("#resetChessStart");
if (resetChessBtn) {
  resetChessBtn.addEventListener("click", () => {
    setChessFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  });
}
const clearChessBtn = document.querySelector("#clearChessBoard");
if (clearChessBtn) {
  clearChessBtn.addEventListener("click", () => {
    setChessFen("8/8/8/8/8/8/8/8 w - - 0 1");
  });
}

// Chess PV replay listeners
const chessPvPrevBtn = document.querySelector("#chessPvPrev");
if (chessPvPrevBtn) {
  chessPvPrevBtn.addEventListener("click", () => {
    if (chessPvIndex > 0) {
      chessPvIndex -= 1;
      const fen = chessPvHistory[chessPvIndex];
      const nextMove = chessPvLine[chessPvIndex] || "";
      renderChessBoard(fen, nextMove);
      updateChessPvControls();
    }
  });
}
const chessPvNextBtn = document.querySelector("#chessPvNext");
if (chessPvNextBtn) {
  chessPvNextBtn.addEventListener("click", () => {
    if (chessPvIndex < chessPvLine.length) {
      const move = chessPvLine[chessPvIndex];
      const curFen = chessPvHistory[chessPvIndex];
      const nextFen = applyUciMoveToFen(curFen, move);
      chessPvIndex += 1;
      chessPvHistory[chessPvIndex] = nextFen;
      const nextMove = chessPvLine[chessPvIndex] || "";
      renderChessBoard(nextFen, nextMove);
      updateChessPvControls();
    }
  });
}
const chessPvResetBtn = document.querySelector("#chessPvReset");
if (chessPvResetBtn) {
  chessPvResetBtn.addEventListener("click", () => {
    chessPvIndex = 0;
    const initFen = chessPvHistory[0];
    const firstMove = chessPvLine[0] || "";
    renderChessBoard(initFen, firstMove);
    updateChessPvControls();
  });
}

// Chess photo/screen capture listeners
const chessPhotoInput = document.querySelector("#chessPhotoInput");
const chessPhotoBtn = document.querySelector("#chessPhotoButton");
if (chessPhotoBtn && chessPhotoInput) {
  chessPhotoBtn.addEventListener("click", () => {
    chessPhotoSource = true;
    chessPhotoInput.click();
  });
  chessPhotoInput.addEventListener("change", () => {
    const file = chessPhotoInput.files && chessPhotoInput.files[0];
    if (!file) return;
    chessPhotoInput.value = "";
    if (!file.type.startsWith("image/")) {
      renderStatus("Choose an image file.", "The chess board preview accepts common image formats.", { error: true });
      return;
    }
    stopScreenShare();
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(file);
    const loadedImage = new Image();
    loadedImage.onload = () => {
      photoImage = loadedImage;
      const scale = Math.min(1, 1200 / Math.max(loadedImage.naturalWidth, loadedImage.naturalHeight));
      photoCanvas.width = Math.max(1, Math.round(loadedImage.naturalWidth * scale));
      photoCanvas.height = Math.max(1, Math.round(loadedImage.naturalHeight * scale));
      document.querySelector("#cropModeToggle").hidden = false;
      suggestCornersButton.hidden = false;
      const autoBtn = document.querySelector("#autoDetectCorners");
      if (autoBtn) autoBtn.hidden = false;
      setPhotoCornerMode(false);
      drawPhoto();
      photoPanel.hidden = false;
      photoPanel.scrollIntoView({ behavior: "smooth", block: "center" });
      renderStatus("Chess board ready on this device.", "Drag a square around the 8 × 8 board or click 'Recognize this grid'. Image processing stays in this browser.");
    };
    loadedImage.src = photoUrl;
  });
}

const chessScreenBtn = document.querySelector("#chessScreenButton");
if (chessScreenBtn) {
  chessScreenBtn.addEventListener("click", () => {
    chessPhotoSource = true;
    startScreenShare();
  });
}

// Auto detect corners button listener
const autoDetectBtn = document.querySelector("#autoDetectCorners");
if (autoDetectBtn) {
  autoDetectBtn.addEventListener("click", () => {
    autoDetectBtn.disabled = true;
    const orig = autoDetectBtn.textContent;
    autoDetectBtn.textContent = "Detecting perspective grid…";
    setTimeout(() => {
      try {
        const corners = autoDetectPerspectiveCorners();
        if (corners) {
          photoCornerMode = true;
          photoCorners = corners;
          const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
          photoRectangle = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
          recognizeButton.disabled = false;
          document.querySelector("#cropModeToggle").textContent = "Use rectangle crop →";
          document.querySelector("#resetPhotoCorners").hidden = false;
          document.querySelector("#photoCornerInstructions").hidden = false;
          document.querySelector("#photoCornerInstructions").textContent = "Perspective grid detected. Review the 4 corners or adjust manually.";
          drawPhoto();
          renderStatus("Perspective grid found.", "The 4 corners were detected automatically. Straightening perspective for recognition.");
        } else {
          renderStatus("Automatic grid detection couldn't find a distinct border.", "Try 'Suggest grid corners' or mark the 4 corners manually.", { error: true });
        }
      } catch (err) {
        renderStatus("Detection error.", err.message, { error: true });
      } finally {
        autoDetectBtn.textContent = orig;
        autoDetectBtn.disabled = false;
      }
    }, 20);
  });
}
function closePhoto() {
  photoPanel.hidden = true;
  stopScreenShare();
  photoRecognition = null;
  photoReviewPending = false;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  photoImage = null;
  photoRectangle = null;
  suggestCornersButton.hidden = true;
  photoContext.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
  photoInput.value = "";
}
document.querySelector("#removePhoto").addEventListener("click", closePhoto);
document.querySelector("#dismissPhoto").addEventListener("click", closePhoto);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  document.querySelector("#installButton").hidden = false;
});
document.querySelector("#installButton").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.querySelector("#installButton").hidden = true;
});
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

fetch("/health").then((response) => response.ok ? response.json() : null).then((status) => {
  aiExplanationAvailable = Boolean(status && status.ai_explanations_available);
  updateAiExplanationControl();
}).catch(() => {});

buildBoard();
loadHistory();
const initialPuzzle = new URLSearchParams(window.location.search).get("puzzle");
if (initialPuzzle && ["sudoku", "kenken", "killer_sudoku", "nonogram", "logic_grid", "chess", "cube"].includes(initialPuzzle)) {
  setPuzzleType(initialPuzzle);
}

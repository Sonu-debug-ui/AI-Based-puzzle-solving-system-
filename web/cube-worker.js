importScripts("/vendor/cubejs/cube.js", "/vendor/cubejs/solve.js");

let initialized = false;

function permutationParity(values) {
  let parity = 0;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) if (values[i] > values[j]) parity ^= 1;
  }
  return parity;
}

function validateFacelets(facelets) {
  if (typeof facelets !== "string" || facelets.length !== 54 || [...facelets].some((face) => !"URFDLB".includes(face))) {
    throw new Error("Use a 54-sticker state with only U, R, F, D, L, and B.");
  }
  if ([..."URFDLB"].some((face) => [...facelets].filter((sticker) => sticker === face).length !== 9)) {
    throw new Error("Each face color must appear exactly nine times.");
  }
  if (Array.from({ length: 6 }, (_, face) => facelets[face * 9 + 4]).join("") !== "URFDLB") throw new Error("Center stickers must follow URFDLB face order.");
  const cube = Cube.fromString(facelets);
  const state = cube.toJSON();
  const unique = (items, expectedLength) => items.length === expectedLength && items.every(Number.isInteger) && new Set(items).size === expectedLength;
  if (!unique(state.cp, 8) || !unique(state.ep, 12) || state.co.some((value) => !Number.isInteger(value)) || state.eo.some((value) => !Number.isInteger(value))) {
    throw new Error("Those stickers describe an impossible corner or edge piece.");
  }
  if (state.co.reduce((sum, value) => sum + value, 0) % 3 !== 0) throw new Error("Corner twists do not add up to a legal cube state.");
  if (state.eo.reduce((sum, value) => sum + value, 0) % 2 !== 0) throw new Error("Edge flips do not add up to a legal cube state.");
  if (permutationParity(state.cp) !== permutationParity(state.ep)) throw new Error("The corner and edge permutations have mismatched parity.");
  return cube;
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "solve") return;
  try {
    const cube = validateFacelets(event.data.facelets);
    if (!initialized) {
      Cube.initSolver();
      initialized = true;
    }
    const algorithm = cube.solve(22).trim();
    const moves = algorithm ? algorithm.split(/\s+/) : [];
    const check = Cube.fromString(event.data.facelets);
    moves.forEach((move) => check.move(move));
    if (!check.isSolved()) throw new Error("The solver could not verify its move sequence.");
    self.postMessage({ type: "solution", moves });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || "This cube state could not be solved." });
  }
});

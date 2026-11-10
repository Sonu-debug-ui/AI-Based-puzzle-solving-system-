const assert = require("node:assert/strict");
const Cube = require("../web/vendor/cubejs/cube.js");
require("../web/vendor/cubejs/solve.js");

const solvedFacelets = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";
const cube = Cube.fromString(solvedFacelets);
assert.equal(cube.isSolved(), true);
cube.move("R U R' U' F2");
assert.equal(cube.isSolved(), false);
Cube.initSolver();
const solution = cube.solve(22).trim();
assert.ok(solution.length > 0, "a scramble should produce a move sequence");
solution.split(/\s+/).forEach((move) => cube.move(move));
assert.equal(cube.isSolved(), true, "the returned solution should replay to the solved state");
console.log(`Cube solve/replay passed (${solution.split(/\s+/).length} moves).`);

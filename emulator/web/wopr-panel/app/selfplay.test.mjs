import test from "node:test";
import assert from "node:assert/strict";
import { GAMES, boardAt, bestMove, gamesCompleted, openSquares, selfPlayGame, winner } from "./selfplay.ts";

test("winner: reads all eight lines, and nothing from an empty row", () => {
  assert.equal(winner(["X", "X", "X", " ", " ", " ", " ", " ", " "]), "X");
  assert.equal(winner(["O", " ", " ", "O", " ", " ", "O", " ", " "]), "O");
  assert.equal(winner(["X", " ", " ", " ", "X", " ", " ", " ", "X"]), "X");
  assert.equal(winner([" ", " ", " ", " ", " ", " ", " ", " ", " "]), null);
});

test("every self-played game is a draw — the scene's whole point", () => {
  for (const [opening, game] of GAMES.entries()) {
    const final = game[game.length - 1];
    assert.equal(winner(final), null, `opening ${opening} produced a winner`);
    assert.equal(openSquares(final).length, 0, `opening ${opening} stopped early`);
  }
});

test("a game is a legal alternating sequence from the forced opening", () => {
  for (const [opening, game] of GAMES.entries()) {
    assert.equal(game.length, 10, `opening ${opening}: expected 9 plies plus the empty board`);
    assert.equal(game[1][opening], "X");
    for (let ply = 1; ply < game.length; ply += 1) {
      const before = game[ply - 1];
      const after = game[ply];
      const changed = after.map((c, i) => (c !== before[i] ? i : -1)).filter((i) => i >= 0);
      assert.equal(changed.length, 1, `opening ${opening} ply ${ply} changed ${changed.length} squares`);
      assert.equal(before[changed[0]], " ", "played onto an occupied square");
      assert.equal(after[changed[0]], ply % 2 === 1 ? "X" : "O", "turn order broke");
    }
  }
});

test("bestMove: takes the win when one is there", () => {
  assert.equal(bestMove(["X", "X", " ", "O", "O", " ", " ", " ", " "], "X"), 2);
});

test("bestMove: blocks the opponent's win when it has none of its own", () => {
  assert.equal(bestMove(["O", "O", " ", "X", " ", " ", " ", " ", " "], "X"), 2);
});

test("selfPlayGame is deterministic — same opening, same game", () => {
  assert.deepEqual(selfPlayGame(4), selfPlayGame(4));
});

test("boardAt: cycles, holds the final position, and never runs off the end", () => {
  const game = GAMES[0];
  const hold = 4;
  for (let t = 0; t < (game.length + hold) * 3; t += 1) {
    const board = boardAt(0, t, hold);
    assert.ok(board, `tick ${t} produced no board`);
    assert.equal(board.length, 9);
  }
  // Offset by g*3, so game 0 at t=0 is the empty board and the hold window
  // parks on the finished game rather than wrapping straight to empty.
  assert.deepEqual(boardAt(0, 0, hold), game[0]);
  assert.deepEqual(boardAt(0, game.length + 1, hold), game[game.length - 1]);
});

test("boardAt: the nine boards are out of phase with each other", () => {
  const states = new Set(GAMES.map((_, g) => boardAt(g, 5).join("")));
  assert.ok(states.size > 1, "every board showed the same position");
});

test("gamesCompleted: starts at zero and only ever climbs", () => {
  assert.equal(gamesCompleted(0), 0);
  let previous = 0;
  for (let t = 0; t < 200; t += 1) {
    const n = gamesCompleted(t);
    assert.ok(n >= previous, `tally went backwards at tick ${t}`);
    previous = n;
  }
  assert.ok(previous > 0, "tally never advanced");
});

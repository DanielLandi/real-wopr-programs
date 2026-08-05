// S14 — the lesson, as the panel shows it (film-baseline S14).
//
// The machine forces tic-tac-toe into self play and every game ends the same
// way. These are REAL games, not decoration: both sides play minimax, so each
// of the nine openings produces one deterministic game, and every one of them
// is a draw. That is the whole point of the scene, and it is a fact about
// tic-tac-toe rather than something we assert on the machine's behalf.
//
// Pure module, no React: the panel renders it, `selfplay.test.mjs` proves it.

export type Cell = "X" | "O" | " ";
export type Board = Cell[];

/** What the bank prints once the machine has taught itself the lesson.
 *
 *  The teletype gets this in the film's three-line break (the router's own
 *  NOWIN_VERDICT). The wall panel does not, deliberately: that break exists to
 *  satisfy the teletype contract — at most 4 lines of at most 60 characters —
 *  which is a property of the teletype, not of the words. A wide wall display
 *  is bound by no such limit and carries the line whole (#44).
 *
 *  Duplicated rather than imported: `emulator/web` and `emulator/node` are
 *  separate modules of the federation and share specs, not code. */
export const NOWIN_VERDICT = "A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.";

export const EMPTY: Board = [" ", " ", " ", " ", " ", " ", " ", " ", " "];

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function winner(board: Board): "X" | "O" | null {
  for (const [a, b, c] of LINES) {
    if (board[a] !== " " && board[a] === board[b] && board[a] === board[c]) {
      return board[a] as "X" | "O";
    }
  }
  return null;
}

export function openSquares(board: Board): number[] {
  return board.map((cell, i) => (cell === " " ? i : -1)).filter((i) => i >= 0);
}

/** Score from X's point of view: +1 X wins, -1 O wins, 0 draw. Depth is
 *  subtracted so a forced win is taken sooner and a loss delayed — without it
 *  a solved position picks an arbitrary winning line and the games look
 *  aimless. */
function solve(board: Board, turn: "X" | "O", memo: Map<string, number>): number {
  const won = winner(board);
  if (won) return won === "X" ? 10 - board.filter((c) => c !== " ").length
                              : board.filter((c) => c !== " ").length - 10;
  const open = openSquares(board);
  if (open.length === 0) return 0;

  const key = board.join("") + turn;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const scores = open.map((i) => {
    const next = board.slice();
    next[i] = turn;
    return solve(next, turn === "X" ? "O" : "X", memo);
  });
  const score = turn === "X" ? Math.max(...scores) : Math.min(...scores);
  memo.set(key, score);
  return score;
}

/** The best move, ties broken by lowest square index so a game is reproducible. */
export function bestMove(board: Board, turn: "X" | "O", memo = new Map<string, number>()): number {
  const open = openSquares(board);
  let best = open[0];
  let bestScore = turn === "X" ? -Infinity : Infinity;
  for (const i of open) {
    const next = board.slice();
    next[i] = turn;
    const score = solve(next, turn === "X" ? "O" : "X", memo);
    if (turn === "X" ? score > bestScore : score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** One self-played game as its sequence of boards, opening move forced.
 *  Index 0 is the empty board; the last entry is the final position. */
export function selfPlayGame(opening: number): Board[] {
  const memo = new Map<string, number>();
  const board = EMPTY.slice();
  const states: Board[] = [board.slice()];

  board[opening] = "X";
  states.push(board.slice());

  let turn: "X" | "O" = "O";
  while (!winner(board) && openSquares(board).length > 0) {
    board[bestMove(board, turn, memo)] = turn;
    states.push(board.slice());
    turn = turn === "X" ? "O" : "X";
  }
  return states;
}

/** All nine games, one per opening square. Computed once at module load —
 *  ~200 ms of minimax the first time, then it is just data. */
export const GAMES: Board[][] = Array.from({ length: 9 }, (_, i) => selfPlayGame(i));

/** Where game `g` stands at panel tick `t`. Each board runs at its own offset
 *  so the nine of them cycle out of phase, and each holds its final position
 *  for a few ticks before restarting — the eye needs to land on the result. */
export function boardAt(g: number, t: number, hold = 4): Board {
  const game = GAMES[g % GAMES.length];
  const period = game.length + hold;
  const step = (((t + g * 3) % period) + period) % period;
  return game[Math.min(step, game.length - 1)];
}

/** Games completed across the whole bank since the routine started. Drives the
 *  panel's tally, which only ever counts draws. */
export function gamesCompleted(t: number, hold = 4): number {
  if (t < 0) return 0;
  return GAMES.reduce((total, game, g) => {
    const period = game.length + hold;
    // The board's own stagger offset is not a game it played — subtract what
    // floor() already counted at t=0, or the tally opens mid-scene.
    return total + Math.floor((t + g * 3) / period) - Math.floor((g * 3) / period);
  }, 0);
}

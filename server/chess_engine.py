"""Small, bounded legal-move chess search for analysis and puzzle positions."""

from __future__ import annotations

from dataclasses import dataclass
from time import monotonic


FILES = "abcdefgh"
PIECES = set("KQRBNPkqrbnp")
MATERIAL = {"p": 100, "n": 320, "b": 330, "r": 500, "q": 900, "k": 20_000}
MATE = 100_000


class ChessPositionError(ValueError):
    pass


@dataclass
class Position:
    board: list[str]
    side: str
    castling: str
    en_passant: int | None
    halfmove: int
    fullmove: int

    def copy(self) -> "Position":
        return Position(self.board[:], self.side, self.castling, self.en_passant, self.halfmove, self.fullmove)

    def fen(self) -> str:
        ranks: list[str] = []
        for row in range(8):
            output = ""
            empty = 0
            for column in range(8):
                piece = self.board[row * 8 + column]
                if piece == ".":
                    empty += 1
                else:
                    if empty:
                        output += str(empty)
                        empty = 0
                    output += piece
            if empty:
                output += str(empty)
            ranks.append(output)
        ep = "-" if self.en_passant is None else square_name(self.en_passant)
        return f"{'/'.join(ranks)} {self.side} {self.castling or '-'} {ep} {self.halfmove} {self.fullmove}"


@dataclass(frozen=True)
class Move:
    source: int
    target: int
    promotion: str | None = None
    en_passant: bool = False

    def uci(self) -> str:
        return square_name(self.source) + square_name(self.target) + (self.promotion or "")


def square_index(square: str) -> int:
    if len(square) != 2 or square[0] not in FILES or square[1] not in "12345678":
        raise ChessPositionError(f"Invalid square: {square}")
    return (8 - int(square[1])) * 8 + FILES.index(square[0])


def square_name(index: int) -> str:
    return FILES[index % 8] + str(8 - index // 8)


def parse_fen(fen: str) -> Position:
    fields = fen.split()
    if len(fields) != 6:
        raise ChessPositionError("A FEN must contain six fields.")
    ranks, side, castling, ep, halfmove_text, fullmove_text = fields
    rows = ranks.split("/")
    if len(rows) != 8:
        raise ChessPositionError("A FEN board must contain eight ranks.")
    board: list[str] = []
    for rank in rows:
        row: list[str] = []
        for item in rank:
            if item.isdigit() and item in "12345678":
                row.extend(["."] * int(item))
            elif item in PIECES:
                row.append(item)
            else:
                raise ChessPositionError("A FEN contains an unknown piece or rank width.")
        if len(row) != 8:
            raise ChessPositionError("Each FEN rank must describe exactly eight squares.")
        board.extend(row)
    if side not in {"w", "b"}:
        raise ChessPositionError("The FEN active color must be w or b.")
    if castling != "-" and (any(right not in "KQkq" for right in castling) or len(set(castling)) != len(castling)):
        raise ChessPositionError("The FEN castling field must use unique KQkq flags or '-'.")
    castling_home = {"K": (60, "K", 63, "R"), "Q": (60, "K", 56, "R"),
                     "k": (4, "k", 7, "r"), "q": (4, "k", 0, "r")}
    if any(right in castling and (board[king_square] != king or board[rook_square] != rook)
           for right, (king_square, king, rook_square, rook) in castling_home.items()):
        raise ChessPositionError("A castling right requires its king and rook on their original squares.")
    if ep == "-":
        en_passant = None
    else:
        en_passant = square_index(ep)
        expected_rank = "6" if side == "w" else "3"
        if ep[1] != expected_rank:
            raise ChessPositionError("The FEN en-passant square does not match the active color.")
        captured_square = en_passant + (8 if side == "w" else -8)
        origin_square = en_passant + (-8 if side == "w" else 8)
        expected_pawn = "p" if side == "w" else "P"
        if board[en_passant] != "." or board[captured_square] != expected_pawn or board[origin_square] != ".":
            raise ChessPositionError("The FEN en-passant square does not match the preceding two-square pawn move.")
    try:
        halfmove, fullmove = int(halfmove_text), int(fullmove_text)
    except ValueError as error:
        raise ChessPositionError("FEN move counters must be integers.") from error
    if halfmove < 0 or fullmove < 1:
        raise ChessPositionError("FEN move counters are out of range.")
    if board.count("K") != 1 or board.count("k") != 1:
        raise ChessPositionError("A legal chess position must contain one king of each color.")
    return Position(board, side, "" if castling == "-" else castling, en_passant, halfmove, fullmove)


def _same_side(piece: str, side: str) -> bool:
    return piece != "." and (piece.isupper() if side == "w" else piece.islower())


def _can_capture(piece: str, side: str) -> bool:
    return piece != "." and piece.lower() != "k" and not _same_side(piece, side)


def is_attacked(position: Position, target: int, by_side: str) -> bool:
    row, column = divmod(target, 8)
    pawn = "P" if by_side == "w" else "p"
    pawn_row = row + (1 if by_side == "w" else -1)
    for dc in (-1, 1):
        pc = column + dc
        if 0 <= pawn_row < 8 and 0 <= pc < 8 and position.board[pawn_row * 8 + pc] == pawn:
            return True
    knight = "N" if by_side == "w" else "n"
    for dr, dc in ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1)):
        rr, cc = row + dr, column + dc
        if 0 <= rr < 8 and 0 <= cc < 8 and position.board[rr * 8 + cc] == knight:
            return True
    king = "K" if by_side == "w" else "k"
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if not (dr or dc):
                continue
            rr, cc = row + dr, column + dc
            if 0 <= rr < 8 and 0 <= cc < 8 and position.board[rr * 8 + cc] == king:
                return True
    rays = [(-1, 0, "rq"), (1, 0, "rq"), (0, -1, "rq"), (0, 1, "rq"),
            (-1, -1, "bq"), (-1, 1, "bq"), (1, -1, "bq"), (1, 1, "bq")]
    for dr, dc, compatible in rays:
        rr, cc = row + dr, column + dc
        distance = 1
        while 0 <= rr < 8 and 0 <= cc < 8:
            piece = position.board[rr * 8 + cc]
            if piece != ".":
                if _same_side(piece, by_side) and piece.lower() in compatible and (distance == 1 or piece.lower() in "rq" and compatible == "rq" or piece.lower() in "bq" and compatible == "bq"):
                    return True
                break
            rr += dr
            cc += dc
            distance += 1
    return False


def _king_square(position: Position, side: str) -> int:
    king = "K" if side == "w" else "k"
    return position.board.index(king)


def in_check(position: Position, side: str) -> bool:
    return is_attacked(position, _king_square(position, side), "b" if side == "w" else "w")


def pseudo_legal_moves(position: Position) -> list[Move]:
    side = position.side
    moves: list[Move] = []
    for source, piece in enumerate(position.board):
        if not _same_side(piece, side):
            continue
        row, column = divmod(source, 8)
        kind = piece.lower()
        if kind == "p":
            direction = -1 if side == "w" else 1
            start_row, promotion_row = (6, 0) if side == "w" else (1, 7)
            one_row = row + direction
            if 0 <= one_row < 8 and position.board[one_row * 8 + column] == ".":
                target = one_row * 8 + column
                if one_row == promotion_row:
                    moves.extend(Move(source, target, promotion) for promotion in "qrbn")
                else:
                    moves.append(Move(source, target))
                    two_row = row + direction * 2
                    if row == start_row and position.board[two_row * 8 + column] == ".":
                        moves.append(Move(source, two_row * 8 + column))
            for dc in (-1, 1):
                cc = column + dc
                if 0 <= one_row < 8 and 0 <= cc < 8:
                    target = one_row * 8 + cc
                    occupant = position.board[target]
                    if _can_capture(occupant, side):
                        if one_row == promotion_row:
                            moves.extend(Move(source, target, promotion) for promotion in "qrbn")
                        else:
                            moves.append(Move(source, target))
                    elif position.en_passant == target:
                        moves.append(Move(source, target, en_passant=True))
        elif kind == "n":
            for dr, dc in ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1)):
                rr, cc = row + dr, column + dc
                if 0 <= rr < 8 and 0 <= cc < 8:
                    target = rr * 8 + cc
                    if position.board[target] == "." or _can_capture(position.board[target], side):
                        moves.append(Move(source, target))
        elif kind in "bqr":
            directions = []
            if kind in "qr": directions.extend([(-1, 0), (1, 0), (0, -1), (0, 1)])
            if kind in "qb": directions.extend([(-1, -1), (-1, 1), (1, -1), (1, 1)])
            for dr, dc in directions:
                rr, cc = row + dr, column + dc
                while 0 <= rr < 8 and 0 <= cc < 8:
                    target = rr * 8 + cc
                    if _same_side(position.board[target], side):
                        break
                    if position.board[target] == "." or _can_capture(position.board[target], side):
                        moves.append(Move(source, target))
                    if position.board[target] != ".":
                        break
                    rr += dr
                    cc += dc
        elif kind == "k":
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if not (dr or dc):
                        continue
                    rr, cc = row + dr, column + dc
                    if 0 <= rr < 8 and 0 <= cc < 8:
                        target = rr * 8 + cc
                        if position.board[target] == "." or _can_capture(position.board[target], side):
                            moves.append(Move(source, target))
            enemy = "b" if side == "w" else "w"
            if side == "w" and source == 60 and not in_check(position, side):
                if "K" in position.castling and position.board[63] == "R" and position.board[61] == position.board[62] == "." and not is_attacked(position, 61, enemy) and not is_attacked(position, 62, enemy):
                    moves.append(Move(60, 62))
                if "Q" in position.castling and position.board[56] == "R" and position.board[59] == position.board[58] == position.board[57] == "." and not is_attacked(position, 59, enemy) and not is_attacked(position, 58, enemy):
                    moves.append(Move(60, 58))
            elif side == "b" and source == 4 and not in_check(position, side):
                if "k" in position.castling and position.board[7] == "r" and position.board[5] == position.board[6] == "." and not is_attacked(position, 5, enemy) and not is_attacked(position, 6, enemy):
                    moves.append(Move(4, 6))
                if "q" in position.castling and position.board[0] == "r" and position.board[3] == position.board[2] == position.board[1] == "." and not is_attacked(position, 3, enemy) and not is_attacked(position, 2, enemy):
                    moves.append(Move(4, 2))
    return moves


def apply_move(position: Position, move: Move) -> Position:
    child = position.copy()
    piece = child.board[move.source]
    captured = child.board[move.target]
    child.board[move.source] = "."
    if move.en_passant:
        captured_row = move.target + (8 if position.side == "w" else -8)
        captured = child.board[captured_row]
        child.board[captured_row] = "."
    if piece.lower() == "k" and abs(move.target - move.source) == 2:
        if move.target > move.source:
            rook_source, rook_target = move.source + 3, move.source + 1
        else:
            rook_source, rook_target = move.source - 4, move.source - 1
        child.board[rook_target] = child.board[rook_source]
        child.board[rook_source] = "."
    placed = move.promotion.upper() if move.promotion and position.side == "w" else move.promotion.lower() if move.promotion else piece
    child.board[move.target] = placed
    rights = set(position.castling)
    if piece == "K": rights.discard("K"); rights.discard("Q")
    if piece == "k": rights.discard("k"); rights.discard("q")
    for square, right in ((63, "K"), (56, "Q"), (7, "k"), (0, "q")):
        if move.source == square or (move.target == square and captured.lower() == "r"):
            rights.discard(right)
    child.castling = "".join(right for right in "KQkq" if right in rights)
    child.en_passant = (move.source + move.target) // 2 if piece.lower() == "p" and abs(move.target - move.source) == 16 else None
    child.halfmove = 0 if piece.lower() == "p" or captured != "." else position.halfmove + 1
    child.fullmove = position.fullmove + (1 if position.side == "b" else 0)
    child.side = "b" if position.side == "w" else "w"
    return child


def legal_moves(position: Position) -> list[Move]:
    side = position.side
    result: list[Move] = []
    for move in pseudo_legal_moves(position):
        child = apply_move(position, move)
        if not in_check(child, side):
            result.append(move)
    return result


def is_reachable_by_legal_move(previous: Position, current: Position) -> bool:
    """Return True if current position board and side can be reached by one legal move from previous."""
    if previous.side == current.side:
        return False
    for move in legal_moves(previous):
        child = apply_move(previous, move)
        if child.board == current.board and child.side == current.side:
            return True
    return False


def perft(position: Position, depth: int) -> int:
    if depth == 0:
        return 1
    return sum(perft(apply_move(position, move), depth - 1) for move in legal_moves(position))


def _evaluate_white(position: Position) -> int:
    score = 0
    for index, piece in enumerate(position.board):
        if piece == ".":
            continue
        color = 1 if piece.isupper() else -1
        kind = piece.lower()
        row, column = divmod(index, 8)
        score += color * MATERIAL[kind]
        center = 7 - (abs(3.5 - row) + abs(3.5 - column))
        if kind == "p":
            score += color * ((6 - row) if color == 1 else (row - 1)) * 8
        elif kind in "nb":
            score += int(color * center * 4)
        elif kind == "k" and position.fullmove < 20:
            score -= int(color * center * 3)
    return score


def _move_order_score(position: Position, move: Move) -> int:
    attacker = position.board[move.source].lower()
    victim = position.board[move.target]
    victim_value = MATERIAL[victim.lower()] if victim != "." else MATERIAL["p"] if move.en_passant else 0
    promotion_value = MATERIAL[move.promotion] if move.promotion else 0
    return victim_value * 10 - MATERIAL[attacker] + promotion_value


class _SearchLimit(Exception):
    pass


def analyze(position: Position, *, max_depth: int = 3, time_limit_seconds: float = 1.5,
            max_nodes: int = 30_000) -> dict:
    started = monotonic()
    nodes = 0
    timed_out = False
    completed_depth = 0
    best_move: Move | None = None
    best_line: list[Move] = []
    best_score = 0

    def negamax(current: Position, depth: int, alpha: int, beta: int, ply: int) -> tuple[int, list[Move]]:
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes or monotonic() - started >= time_limit_seconds:
            raise _SearchLimit
        moves = legal_moves(current)
        if not moves:
            return (-MATE + ply if in_check(current, current.side) else 0), []
        if depth == 0:
            value = _evaluate_white(current) * (1 if current.side == "w" else -1)
            return value, []
        moves.sort(key=lambda move: _move_order_score(current, move), reverse=True)
        best = -MATE * 2
        line: list[Move] = []
        for move in moves:
            score, child_line = negamax(apply_move(current, move), depth - 1, -beta, -alpha, ply + 1)
            score = -score
            if score > best:
                best = score
                line = [move, *child_line]
            alpha = max(alpha, score)
            if alpha >= beta:
                break
        return best, line

    for depth in range(1, max_depth + 1):
        try:
            score, line = negamax(position, depth, -MATE * 2, MATE * 2, 0)
        except _SearchLimit:
            timed_out = True
            break
        completed_depth = depth
        best_score = score
        best_line = line
        best_move = line[0] if line else None
    if best_move is None:
        moves = legal_moves(position)
        if not moves:
            return {"status": "checkmate" if in_check(position, position.side) else "draw", "nodes": nodes}
        best_move = moves[0]
        best_line = [best_move]
        best_score = _evaluate_white(apply_move(position, best_move)) * (1 if position.side == "w" else -1)
    child = apply_move(position, best_move)
    if in_check(child, child.side):
        reason = "The move gives check."
    elif position.board[best_move.target] != "." or best_move.en_passant:
        reason = "The move captures material; the search line checks the resulting position."
    elif best_move.promotion:
        reason = "The move promotes a pawn."
    else:
        reason = "This move scored best in the bounded legal-move search."
    return {
        "status": "suggestion",
        "best_move": best_move.uci(),
        "score_cp": best_score,
        "principal_variation": [move.uci() for move in best_line],
        "depth": completed_depth,
        "nodes": nodes,
        "timed_out": timed_out,
        "reason": reason,
    }

"""Exact constraint solver for small, structured logic-grid puzzles."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from time import monotonic
from server.schemas import LogicConstraint, LogicGridState


Entity = tuple[str, str]


@dataclass
class LogicGridOutcome:
    solutions: list[dict[Entity, int]]
    timed_out: bool = False
    nodes: int = 0


def _relation_ok(kind: str, left: int, right: int) -> bool:
    if kind == "same":
        return left == right
    if kind == "different":
        return left != right
    if kind == "left_of":
        return left < right
    if kind == "next_to":
        return abs(left - right) == 1
    if kind == "immediately_left":
        return left + 1 == right
    raise ValueError(f"Unsupported binary logic relation: {kind}")


def _propagate(domains: dict[Entity, set[int]], state: LogicGridState) -> bool:
    """Apply unary, binary, and all-different propagation until stable."""
    n = state.positions
    constraints = state.constraints
    changed = True
    while changed:
        changed = False
        for constraint in constraints:
            left = (constraint.left.category, constraint.left.value)
            left_domain = domains[left]
            if constraint.kind == "at_position":
                allowed = {constraint.position - 1}
                reduced = left_domain & allowed
                if not reduced:
                    return False
                if reduced != left_domain:
                    domains[left] = reduced
                    changed = True
                continue
            if constraint.kind == "not_position":
                reduced = left_domain - {constraint.position - 1}
                if not reduced:
                    return False
                if reduced != left_domain:
                    domains[left] = reduced
                    changed = True
                continue

            right = (constraint.right.category, constraint.right.value)
            right_domain = domains[right]
            keep_left = {a for a in left_domain if any(_relation_ok(constraint.kind, a, b) for b in right_domain)}
            keep_right = {b for b in right_domain if any(_relation_ok(constraint.kind, a, b) for a in left_domain)}
            if not keep_left or not keep_right:
                return False
            if keep_left != left_domain:
                domains[left] = keep_left
                changed = True
            if keep_right != right_domain:
                domains[right] = keep_right
                changed = True

        # A small Hall-set check makes the all-different constraints much tighter
        # than only removing already-singleton values.
        for category, values in state.categories.items():
            category_entities = [(category, value) for value in values]
            for count in range(1, n + 1):
                for subset in combinations(category_entities, count):
                    union = set().union(*(domains[entity] for entity in subset))
                    if len(union) < count:
                        return False
                    if len(union) == count:
                        members = set(subset)
                        for entity in category_entities:
                            if entity not in members:
                                reduced = domains[entity] - union
                                if not reduced:
                                    return False
                                if reduced != domains[entity]:
                                    domains[entity] = reduced
                                    changed = True
    return True


def _constraint_valid(constraint: LogicConstraint, assignment: dict[Entity, int]) -> bool:
    left_entity = (constraint.left.category, constraint.left.value)
    left = assignment[left_entity]
    if constraint.kind == "at_position":
        return left == constraint.position - 1
    if constraint.kind == "not_position":
        return left != constraint.position - 1
    right_entity = (constraint.right.category, constraint.right.value)
    return _relation_ok(constraint.kind, left, assignment[right_entity])


def verify_logic_assignment(state: LogicGridState, assignment: dict[Entity, int]) -> list[int]:
    """Replay all structured clues and category permutations against a completed assignment."""
    entities = {(category, value) for category, values in state.categories.items() for value in values}
    if set(assignment) != entities:
        return list(range(len(state.constraints)))
    failed = {index for index, constraint in enumerate(state.constraints)
              if not _constraint_valid(constraint, assignment)}
    valid_positions = set(range(state.positions))
    for category, values in state.categories.items():
        positions = {assignment[(category, value)] for value in values}
        if positions != valid_positions:
            related = [index for index, constraint in enumerate(state.constraints)
                       if constraint.left.category == category or
                       (constraint.right is not None and constraint.right.category == category)]
            failed.update(related or range(len(state.constraints)))
    return sorted(failed)


def solve_logic_grid(state: LogicGridState, *, max_solutions: int = 2,
                     time_limit_seconds: float = 3.0, max_nodes: int = 200_000) -> LogicGridOutcome:
    """Return up to two complete assignments; timeout never claims uniqueness."""
    entities = [(category, value) for category, values in state.categories.items() for value in values]
    initial = {entity: set(range(state.positions)) for entity in entities}
    if not _propagate(initial, state):
        return LogicGridOutcome([])

    solutions: list[dict[Entity, int]] = []
    started = monotonic()
    nodes = 0
    timed_out = False

    def visit(current: dict[Entity, set[int]]) -> None:
        nonlocal nodes, timed_out
        if len(solutions) >= max_solutions or timed_out:
            return
        nodes += 1
        if nodes > max_nodes or monotonic() - started > time_limit_seconds:
            timed_out = True
            return
        unresolved = [entity for entity in entities if len(current[entity]) > 1]
        if not unresolved:
            assignment = {entity: next(iter(current[entity])) for entity in entities}
            if all(_constraint_valid(constraint, assignment) for constraint in state.constraints):
                solutions.append(assignment)
            return
        entity = min(unresolved, key=lambda candidate: (len(current[candidate]), candidate))
        for position in sorted(current[entity]):
            child = {key: set(options) for key, options in current.items()}
            child[entity] = {position}
            if _propagate(child, state):
                visit(child)
            if len(solutions) >= max_solutions or timed_out:
                return

    visit(initial)
    return LogicGridOutcome(solutions, timed_out, nodes)


def forced_assignments(state: LogicGridState) -> dict[Entity, int]:
    """Return only assignments proved by sound domain propagation."""
    entities = [(category, value) for category, values in state.categories.items() for value in values]
    domains = {entity: set(range(state.positions)) for entity in entities}
    if not _propagate(domains, state):
        return {}
    return {entity: next(iter(positions)) for entity, positions in domains.items() if len(positions) == 1}

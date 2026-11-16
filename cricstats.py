#!/usr/bin/env python3
"""
CricStats - ball-by-ball cricket scoring and analytics engine.

Design: event-driven. Every delivery is an immutable `Ball` event. All figures
(batting, bowling, extras, fall of wickets, partnerships, rates) are DERIVED by
applying events in order, so "undo" is simply: drop the last event and replay.

Run:   python cricstats.py          interactive scoring
       python cricstats.py --demo   scripted demo match
"""
from __future__ import annotations

import re
import sys
import textwrap
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

BOWLER_WICKETS = {"bowled", "caught", "lbw", "stumped", "hitwicket"}
ALL_WICKETS = BOWLER_WICKETS | {"runout"}


def fmt_overs(balls: int) -> str:
    return f"{balls // 6}.{balls % 6}"


def ordinal(n: int) -> str:
    return {1: "1st", 2: "2nd", 3: "3rd"}.get(n, f"{n}th")


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #
@dataclass
class Team:
    name: str
    players: List[str]  # in batting order

    def __post_init__(self):
        if not 2 <= len(self.players) <= 11:
            raise ValueError(f"{self.name}: a team needs 2 to 11 players")
        if len(set(self.players)) != len(self.players):
            raise ValueError(f"{self.name}: duplicate player names")


@dataclass(frozen=True)
class Ball:
    """One delivery. extra: None | 'wd' | 'nb' | 'b' | 'lb'.
    wd: extra_runs = runs run in addition to the 1-run penalty.
    nb: bat_runs = runs hit off the bat (plus 1-run penalty).
    b/lb: extra_runs = runs run."""
    bowler: str
    bat_runs: int = 0
    extra: Optional[str] = None
    extra_runs: int = 0
    wicket: Optional[str] = None
    out: str = "striker"  # or "non_striker" (run outs)
    fielder: Optional[str] = None


@dataclass
class BatFigures:
    runs: int = 0
    balls: int = 0
    fours: int = 0
    sixes: int = 0
    out: bool = False
    how: str = ""

    @property
    def strike_rate(self) -> float:
        return self.runs * 100 / self.balls if self.balls else 0.0


@dataclass
class BowlFigures:
    balls: int = 0
    runs: int = 0
    wkts: int = 0
    maidens: int = 0
    wides: int = 0
    noballs: int = 0

    @property
    def economy(self) -> float:
        return self.runs * 6 / self.balls if self.balls else 0.0


@dataclass
class Partnership:
    wicket: int
    a: str
    b: str
    runs: int = 0
    balls: int = 0
    extras: int = 0
    contrib: Dict[str, int] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Innings: the state machine
# --------------------------------------------------------------------------- #
class Innings:
    def __init__(self, batting: Team, bowling: Team, max_overs: int,
                 target: Optional[int] = None):
        self.batting, self.bowling = batting, bowling
        self.max_overs, self.max_balls = max_overs, max_overs * 6
        self.target = target
        self.events: List[Ball] = []
        self._reset()

    # ---- state ----------------------------------------------------------- #
    def _reset(self):
        p = self.batting.players
        self.runs = self.wickets = self.balls = 0
        self.extras = {"wd": 0, "nb": 0, "b": 0, "lb": 0}
        self.bat: Dict[str, BatFigures] = {p[0]: BatFigures(), p[1]: BatFigures()}
        self.bowl: Dict[str, BowlFigures] = {}
        self.fielding: Dict[str, int] = {}
        self.striker: Optional[str] = p[0]
        self.non_striker: Optional[str] = p[1]
        self.next_idx = 2
        self.fow: List[Tuple[int, int, str, int]] = []  # (wkt no, score, batter, balls)
        self.done_partnerships: List[Partnership] = []
        self.part = Partnership(1, p[0], p[1], contrib={p[0]: 0, p[1]: 0})
        self.over_bowler: Optional[str] = None
        self.last_bowler: Optional[str] = None
        self.over_runs = self.over_legal = 0
        self.finished = False
        self.end_reason = ""

    @property
    def all_out(self) -> bool:
        return self.wickets >= len(self.batting.players) - 1

    # ---- public API ------------------------------------------------------ #
    def record(self, ball: Ball):
        self._validate(ball)
        self._apply(ball)
        self.events.append(ball)

    def undo(self) -> bool:
        if not self.events:
            return False
        kept = self.events[:-1]
        self.events = []
        self._reset()
        for b in kept:           # replay: state is purely derived from events
            self._apply(b)
            self.events.append(b)
        return True

    # ---- validation ------------------------------------------------------ #
    def _validate(self, b: Ball):
        if self.finished:
            raise ValueError("Innings is already over")
        if b.bowler not in self.bowling.players:
            raise ValueError(f"{b.bowler} is not in {self.bowling.name}")
        if self.over_bowler is None and b.bowler == self.last_bowler:
            raise ValueError("A bowler cannot bowl two consecutive overs")
        if self.over_bowler is not None and b.bowler != self.over_bowler:
            raise ValueError(f"{self.over_bowler} must finish the over")
        if not 0 <= b.bat_runs <= 7:
            raise ValueError("Runs off the bat must be 0-7")
        if b.wicket:
            if b.wicket not in ALL_WICKETS:
                raise ValueError(f"Unknown wicket type; use {sorted(ALL_WICKETS)}")
            if b.wicket != "runout":
                if b.bat_runs or b.extra_runs or b.extra in ("b", "lb", "nb"):
                    raise ValueError(f"'{b.wicket}' cannot happen with runs/that extra")
                if b.extra == "wd" and b.wicket not in ("stumped", "hitwicket"):
                    raise ValueError("Only stumped/hit wicket/run out on a wide")
            if b.wicket in ("caught", "stumped") and not b.fielder:
                raise ValueError(f"'{b.wicket}' needs a fielder name")
            if b.fielder and b.fielder not in self.bowling.players:
                raise ValueError(f"Fielder {b.fielder} is not in {self.bowling.name}")

    # ---- the core transition -------------------------------------------- #
    def _apply(self, b: Ball):
        ex = b.extra
        legal = ex not in ("wd", "nb")
        bat = self.bat[self.striker]
        bowl = self.bowl.setdefault(b.bowler, BowlFigures())
        self.over_bowler = b.bowler

        bat_runs = extra_total = 0
        if ex == "wd":
            extra_total = 1 + b.extra_runs
            bowl.wides += extra_total
            cost, rotate = extra_total, b.extra_runs
        elif ex == "nb":
            bat_runs, extra_total = b.bat_runs, 1
            bowl.noballs += 1
            cost, rotate = 1 + bat_runs, bat_runs
        elif ex in ("b", "lb"):
            extra_total = b.extra_runs
            cost, rotate = 0, b.extra_runs      # byes are not charged to the bowler
        else:
            bat_runs = b.bat_runs
            cost, rotate = bat_runs, bat_runs
        if ex:
            self.extras[ex] += extra_total

        if ex != "wd":                           # a wide is not a ball faced
            bat.balls += 1
            bat.runs += bat_runs
            bat.fours += bat_runs == 4
            bat.sixes += bat_runs == 6

        total = bat_runs + extra_total
        self.runs += total
        bowl.runs += cost
        self.over_runs += cost
        self.part.runs += total
        self.part.extras += extra_total
        self.part.contrib[self.striker] += bat_runs
        if legal:
            self.balls += 1
            self.part.balls += 1
            bowl.balls += 1
            self.over_legal += 1

        out_name = None
        if b.wicket:
            out_name = self.striker if b.out == "striker" else self.non_striker
        if rotate % 2:
            self.striker, self.non_striker = self.non_striker, self.striker
        if out_name:
            self._wicket(b, out_name, bowl)

        if legal and self.over_legal == 6:       # end of over
            if self.over_runs == 0:
                bowl.maidens += 1
            self.striker, self.non_striker = self.non_striker, self.striker
            self.last_bowler, self.over_bowler = b.bowler, None
            self.over_legal = self.over_runs = 0

        if self.all_out:
            self.finished, self.end_reason = True, "all out"
        elif self.balls >= self.max_balls:
            self.finished, self.end_reason = True, "overs completed"
        elif self.target is not None and self.runs >= self.target:
            self.finished, self.end_reason = True, "target reached"

    def _wicket(self, b: Ball, out_name: str, bowl: BowlFigures):
        fig = self.bat[out_name]
        fig.out, fig.how = True, self._how_out(b)
        self.wickets += 1
        if b.wicket in BOWLER_WICKETS:
            bowl.wkts += 1
        if b.fielder:
            self.fielding[b.fielder] = self.fielding.get(b.fielder, 0) + 1
        self.fow.append((self.wickets, self.runs, out_name, self.balls))
        self.done_partnerships.append(self.part)
        survivor = self.non_striker if out_name == self.striker else self.striker
        if self.all_out:
            replacement = None
        else:
            replacement = self.batting.players[self.next_idx]
            self.next_idx += 1
            self.bat[replacement] = BatFigures()
            self.part = Partnership(self.wickets + 1, survivor, replacement,
                                    contrib={survivor: 0, replacement: 0})
        if out_name == self.striker:
            self.striker = replacement
        else:
            self.non_striker = replacement

    @staticmethod
    def _how_out(b: Ball) -> str:
        w, f = b.wicket, b.fielder
        if w == "bowled":
            return f"b {b.bowler}"
        if w == "lbw":
            return f"lbw b {b.bowler}"
        if w == "caught":
            return f"c & b {b.bowler}" if f == b.bowler else f"c {f} b {b.bowler}"
        if w == "stumped":
            return f"st {f} b {b.bowler}"
        if w == "hitwicket":
            return f"hit wicket b {b.bowler}"
        return f"run out ({f})" if f else "run out"

    # ---- derived statistics --------------------------------------------- #
    @property
    def run_rate(self) -> float:
        return self.runs * 6 / self.balls if self.balls else 0.0

    @property
    def required_rate(self) -> Optional[float]:
        left = self.max_balls - self.balls
        if self.target is None or left <= 0:
            return None
        return max(self.target - self.runs, 0) * 6 / left

    def partnerships(self) -> List[Partnership]:
        parts = list(self.done_partnerships)
        if not self.all_out and (self.part.balls or self.part.runs):
            parts.append(self.part)      # current / unbroken partnership
        return parts

    def status_line(self) -> str:
        s = (f"{self.batting.name} {self.runs}/{self.wickets} "
             f"({fmt_overs(self.balls)}/{self.max_overs} ov)  CRR {self.run_rate:.2f}")
        if self.target is not None:
            need, left = self.target - self.runs, self.max_balls - self.balls
            rrr = self.required_rate
            s += f"  | Target {self.target}"
            if need > 0 and left > 0:
                s += f", need {need} off {left} balls, RRR {rrr:.2f}"
        return s

    def batters_at_crease(self) -> str:
        parts = []
        for name, mark in ((self.striker, "*"), (self.non_striker, "")):
            if name:
                f = self.bat[name]
                parts.append(f"{name} {f.runs}({f.balls}){mark}")
        return "  ".join(parts)

    # ---- scorecard ------------------------------------------------------- #
    def scorecard(self, title: str) -> str:
        W = 74
        L = ["=" * W,
             f"{self.batting.name} - {title}: {self.runs}/{self.wickets} "
             f"({fmt_overs(self.balls)} ov)"
             + (f"   Target {self.target}" if self.target else ""),
             "=" * W,
             f"{'Batter':<16}{'Dismissal':<26}{'R':>4}{'B':>5}{'4s':>4}{'6s':>4}{'SR':>9}",
             "-" * W]
        for name, f in self.bat.items():
            how = f.how if f.out else "not out"
            L.append(f"{name:<16}{how:<26}{f.runs:>4}{f.balls:>5}{f.fours:>4}"
                     f"{f.sixes:>4}{f.strike_rate:>9.2f}")
        e = self.extras
        L.append("-" * W)
        L.append(f"{'Extras':<42}{sum(e.values()):>4}   "
                 f"(b {e['b']}, lb {e['lb']}, w {e['wd']}, nb {e['nb']})")
        L.append(f"{'Total':<42}{self.runs:>4}   ({self.wickets} wkts, "
                 f"{fmt_overs(self.balls)} ov, RR {self.run_rate:.2f})")
        dnb = self.batting.players[self.next_idx:]
        if dnb:
            L.append("Did not bat: " + ", ".join(dnb))
        L.append("")
        fow = ", ".join(f"{n}-{s} ({name}, {fmt_overs(b)} ov)"
                        for n, s, name, b in self.fow) or "-"
        L.append(textwrap.fill("Fall of wickets: " + fow, W,
                               subsequent_indent="    "))
        L.append("")
        L.append(f"{'Bowler':<16}{'O':>6}{'M':>4}{'R':>5}{'W':>4}{'Econ':>8}{'Wd':>5}{'Nb':>4}")
        L.append("-" * W)
        for name, f in self.bowl.items():
            L.append(f"{name:<16}{fmt_overs(f.balls):>6}{f.maidens:>4}{f.runs:>5}"
                     f"{f.wkts:>4}{f.economy:>8.2f}{f.wides:>5}{f.noballs:>4}")
        L.append("")
        L.append("Partnerships")
        L.append("-" * W)
        parts = self.partnerships()
        for p in parts:
            tag = "*" if p is self.part and not self.all_out else ""
            L.append(f"{ordinal(p.wicket)} wkt: {p.a} & {p.b}: {p.runs}{tag} "
                     f"({p.balls} b)  [{p.a} {p.contrib[p.a]}, {p.b} "
                     f"{p.contrib[p.b]}, extras {p.extras}]")
        if not parts:
            L.append("-")
        return "\n".join(L)


# --------------------------------------------------------------------------- #
# Match
# --------------------------------------------------------------------------- #
class Match:
    def __init__(self, team_a: Team, team_b: Team, overs: int):
        names = team_a.players + team_b.players
        if len(set(names)) != len(names):
            raise ValueError("Player names must be unique across both teams")
        self.teams = (team_a, team_b)
        self.overs = overs
        self.innings: List[Innings] = []

    def start_innings(self, batting: Team) -> Innings:
        bowling = self.teams[1] if batting is self.teams[0] else self.teams[0]
        target = self.innings[0].runs + 1 if self.innings else None
        inn = Innings(batting, bowling, self.overs, target)
        self.innings.append(inn)
        return inn

    def result(self) -> str:
        if len(self.innings) < 2 or not self.innings[1].finished:
            return "Match in progress"
        i1, i2 = self.innings
        if i2.runs > i1.runs:
            left = len(i2.batting.players) - 1 - i2.wickets
            return f"{i2.batting.name} won by {left} wicket{'s' * (left != 1)}"
        if i2.runs == i1.runs:
            return "Match tied"
        d = i1.runs - i2.runs
        return f"{i1.batting.name} won by {d} run{'s' * (d != 1)}"

    def player_of_the_match(self) -> List[Tuple[str, int, str]]:
        """Points: bat 1/run +1/four +2/six, +20 for 50, +40 for 100, -5 duck;
        bowl 25/wkt +10/maiden, +15 for 3 wkts, +30 for 5; field 10/dismissal."""
        pts: Dict[str, int] = {}
        notes: Dict[str, List[str]] = {}

        def add(name, n, why):
            pts[name] = pts.get(name, 0) + n
            notes.setdefault(name, []).append(f"{why} {n:+d}")

        for inn in self.innings:
            for name, f in inn.bat.items():
                add(name, f.runs + f.fours + 2 * f.sixes, f"bat {f.runs}({f.balls})")
                if f.runs >= 100:
                    add(name, 40, "century")
                elif f.runs >= 50:
                    add(name, 20, "fifty")
                if f.out and f.runs == 0:
                    add(name, -5, "duck")
            for name, f in inn.bowl.items():
                if f.wkts:
                    add(name, 25 * f.wkts, f"{f.wkts} wkt")
                if f.maidens:
                    add(name, 10 * f.maidens, f"{f.maidens} maiden")
                if f.wkts >= 5:
                    add(name, 30, "5-wkt haul")
                elif f.wkts >= 3:
                    add(name, 15, "3-wkt haul")
            for name, n in inn.fielding.items():
                add(name, 10 * n, f"{n} fielding")
        ranked = sorted(pts.items(), key=lambda kv: -kv[1])
        return [(n, p, ", ".join(notes[n])) for n, p in ranked]

    def full_report(self) -> str:
        out = []
        for i, inn in enumerate(self.innings, 1):
            out.append(inn.scorecard(f"{ordinal(i)} innings"))
            out.append("")
        out.append(f"RESULT: {self.result()}")
        if self.innings and all(i.finished for i in self.innings):
            top = self.player_of_the_match()[:3]
            out.append("")
            out.append(f"PLAYER OF THE MATCH: {top[0][0]} ({top[0][1]} pts)")
            for n, p, why in top:
                out.append(f"  {n:<14}{p:>4} pts  {why}")
        return "\n".join(out)


# --------------------------------------------------------------------------- #
# Input parsing:  <code> [W <kind> [fielder] [non]]
#   code: 0-7 | wd[n] | nb[n] | b<n> | lb<n> | w (wicket, no runs)
#   e.g.  "4"   "wd2"   "nb4"   "lb1"   "0 W bowled"   "1 W runout Ravi non"
# --------------------------------------------------------------------------- #
def parse_ball(line: str, bowler: str) -> Ball:
    t = line.split()
    if not t:
        raise ValueError("Empty input")
    if t[0].lower() == "w":
        t.insert(0, "0")
    m = re.fullmatch(r"(wd|nb|lb|b)?(\d*)", t[0].lower())
    if not m or (not m.group(1) and not m.group(2)):
        raise ValueError("Unrecognised ball. Type 'help' for the syntax")
    kind, n = m.group(1), int(m.group(2) or 0)
    if kind in ("b", "lb") and n < 1:
        raise ValueError("Byes/leg byes need a run count, e.g. b2")
    kw = dict(bowler=bowler, extra=kind)
    if kind in (None, "nb"):
        kw["bat_runs"] = n
    else:
        kw["extra_runs"] = n
    rest = t[1:]
    if rest:
        if rest[0].lower() != "w" or len(rest) < 2:
            raise ValueError("Wicket syntax: <runs> W <kind> [fielder] [non]")
        kw["wicket"] = rest[1].lower()
        for tok in rest[2:]:
            if tok.lower() in ("non", "nonstriker"):
                kw["out"] = "non_striker"
            else:
                kw["fielder"] = tok
    return Ball(**kw)


HELP = """Ball entry:  <code> [W <kind> [fielder] [non]]
  0-7        runs off the bat          wd / wd2   wide (+ extra runs run)
  nb / nb4   no ball (+ bat runs)      b2 / lb1   byes / leg byes
  0 W bowled | 0 W lbw | 0 W caught Fielder | 0 W stumped Keeper
  1 W runout [Fielder] [non]   ('non' = non-striker is out)
Commands: undo, score, card, help, quit"""


# --------------------------------------------------------------------------- #
# Interactive / demo drivers
# --------------------------------------------------------------------------- #
def ask(prompt: str) -> str:
    return input(prompt).strip()


def setup_team(label: str) -> Team:
    while True:
        try:
            name = ask(f"{label} name: ")
            players = [p.strip() for p in
                       ask(f"{name} players in batting order (comma separated): ").split(",")
                       if p.strip()]
            return Team(name, players)
        except ValueError as e:
            print("  !", e)


def play_innings(inn: Innings):
    print(f"\n--- {inn.batting.name} batting ({inn.max_overs} overs) ---")
    pending = None
    while not inn.finished:
        bowler = inn.over_bowler or pending
        if bowler is None:
            print("Bowling:", ", ".join(f"{i}.{p}" for i, p in
                                        enumerate(inn.bowling.players, 1)))
            pick = ask(f"Over {inn.balls // 6 + 1} bowler (name or number): ")
            if pick.isdigit() and 1 <= int(pick) <= len(inn.bowling.players):
                pick = inn.bowling.players[int(pick) - 1]
            if pick == inn.last_bowler or pick not in inn.bowling.players:
                print("  ! Invalid bowler (or same as previous over)")
                continue
            pending = bowler = pick
        line = ask(f"[{fmt_overs(inn.balls)}] {bowler} > ")
        cmd = line.lower()
        if cmd in ("quit", "exit"):
            sys.exit(0)
        if cmd == "help":
            print(HELP)
        elif cmd == "score":
            print(inn.status_line(), "|", inn.batters_at_crease())
        elif cmd == "card":
            print(inn.scorecard("in progress"))
        elif cmd == "undo":
            print("  undone" if inn.undo() else "  nothing to undo")
            pending = None
        else:
            try:
                inn.record(parse_ball(line, bowler))
                pending = None
            except ValueError as e:
                print("  !", e)
                continue
            print(" ", inn.status_line())
            if not inn.finished and inn.over_bowler is None:
                print("  End of over. ", inn.batters_at_crease())
    print(f"\nInnings over ({inn.end_reason}).")


def interactive():
    print("=== CricStats ===")
    a, b = setup_team("Team A"), setup_team("Team B")
    overs = int(ask("Overs per innings: "))
    match = Match(a, b, overs)
    first = a if ask(f"Who bats first? (1={a.name}, 2={b.name}): ") == "1" else b
    second = b if first is a else a
    print(HELP)
    for team in (first, second):
        play_innings(match.start_innings(team))
    print("\n" + match.full_report())


def demo():
    royals = Team("Royals", "Arjun Bhavin Chetan Dev Eshan Farhan Gopal Harsh Imran Jatin Kiran".split())
    titans = Team("Titans", "Lakshman Manoj Naveen Omkar Pranav Qasim Rohit Suresh Tarun Umesh Vikram".split())
    match = Match(royals, titans, overs=4)
    script1 = [("Vikram", "1 4 0 wd 0 6 1"),
               ("Umesh", "2|0 W bowled|1|nb2|4|1 W runout Tarun non|0"),
               ("Vikram", "6|6|0 W lbw|1|wd2|2|lb1"),
               ("Umesh", "4|1|b2|0 W caught Manoj|1|6")]
    script2 = [("Jatin", "1 4 6 0 2 1"),
               ("Imran", "4|wd|1|6|0 W bowled|2|1"),
               ("Jatin", "6|1|4|0 W caught Gopal|2|nb|1"),
               ("Imran", "4|1|6|0 W stumped Arjun|1|0")]
    for team, script in ((royals, script1), (titans, script2)):
        inn = match.start_innings(team)
        for bowler, over in script:
            sep = "|" if "|" in over else " "
            for tok in over.split(sep):
                inn.record(parse_ball(tok, bowler))
            print(inn.status_line())
        print()
    print(match.full_report())


if __name__ == "__main__":
    demo() if "--demo" in sys.argv else interactive()

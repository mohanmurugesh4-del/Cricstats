/* CricStats scoring engine: a JavaScript port of cricstats.py.
   Every delivery is an immutable event; every figure is derived from the events.
   Players are referenced by id. Display names come from NAMES, so renaming a
   player never changes the scores. */

var NAMES = new Map();
function nameOf(id) { return NAMES.get(id) || String(id); }

var BOWLER_WICKETS = ["bowled", "caught", "lbw", "stumped", "hitwicket"];
var ALL_WICKETS = BOWLER_WICKETS.concat(["runout"]);

function fmtOvers(balls) { return Math.floor(balls / 6) + "." + (balls % 6); }
function ordinal(n) { return ({ 1: "1st", 2: "2nd", 3: "3rd" })[n] || n + "th"; }
function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
function sg(n) { return (n >= 0 ? "+" : "") + n; }
function newBat() { return { runs: 0, balls: 0, fours: 0, sixes: 0, out: false, how: "" }; }
function newBowl() { return { balls: 0, runs: 0, wkts: 0, maidens: 0, wides: 0, noballs: 0 }; }
function newPart(wicket, a, b) {
  return { wicket: wicket, a: a, b: b, runs: 0, balls: 0, extras: 0, contrib: new Map([[a, 0], [b, 0]]) };
}
function strikeRate(f) { return f.balls ? f.runs * 100 / f.balls : 0; }
function economy(f) { return f.balls ? f.runs * 6 / f.balls : 0; }

function labelOf(b) {
  if (b.wicket) return "W";
  if (b.extra === "wd") return b.extraRuns ? "Wd+" + b.extraRuns : "Wd";
  if (b.extra === "nb") return b.batRuns ? "Nb" + b.batRuns : "Nb";
  if (b.extra === "b") return "B" + b.extraRuns;
  if (b.extra === "lb") return "Lb" + b.extraRuns;
  return String(b.batRuns);
}

class Innings {
  constructor(batting, bowling, maxOvers, target) {
    this.batting = batting;
    this.bowling = bowling;
    this.maxOvers = maxOvers;
    this.maxBalls = maxOvers * 6;
    this.target = target === undefined ? null : target;
    this.events = [];
    this.reset();
  }

  reset() {
    const p = this.batting.players;
    this.runs = 0; this.wickets = 0; this.balls = 0;
    this.extras = { wd: 0, nb: 0, b: 0, lb: 0 };
    this.bat = new Map([[p[0], newBat()], [p[1], newBat()]]);
    this.bowl = new Map();
    this.fielding = new Map();
    this.striker = p[0];
    this.nonStriker = p[1];
    this.nextIdx = 2;
    this.fow = [];
    this.donePart = [];
    this.part = newPart(1, p[0], p[1]);
    this.overBowler = null;
    this.lastBowler = null;
    this.overRuns = 0; this.overLegal = 0;
    this.finished = false; this.endReason = "";
  }

  get allOut() { return this.wickets >= this.batting.players.length - 1; }

  record(ball) { this.validate(ball); this.apply(ball); this.events.push(ball); }

  undo() {
    if (!this.events.length) return false;
    const kept = this.events.slice(0, -1);
    this.events = [];
    this.reset();
    for (const b of kept) { this.apply(b); this.events.push(b); }
    return true;
  }

  validate(b) {
    if (this.finished) throw new Error("This innings is already over");
    if (!this.bowling.players.includes(b.bowler)) throw new Error(nameOf(b.bowler) + " is not in " + this.bowling.name);
    if (this.overBowler === null && b.bowler === this.lastBowler) throw new Error("A bowler cannot bowl two overs in a row");
    if (this.overBowler !== null && b.bowler !== this.overBowler) throw new Error(nameOf(this.overBowler) + " must finish the over");
    if (b.batRuns < 0 || b.batRuns > 7) throw new Error("Runs off the bat must be 0 to 7");
    if (b.wicket) {
      if (!ALL_WICKETS.includes(b.wicket)) throw new Error("Unknown wicket type");
      if (b.wicket !== "runout") {
        if (b.batRuns || b.extraRuns || ["b", "lb", "nb"].includes(b.extra)) {
          throw new Error("A " + b.wicket + " cannot happen with runs or that extra");
        }
        if (b.extra === "wd" && !["stumped", "hitwicket"].includes(b.wicket)) {
          throw new Error("On a wide only stumped, hit wicket or run out is allowed");
        }
      }
      if (["caught", "stumped"].includes(b.wicket) && !b.fielder) throw new Error("A " + b.wicket + " needs a fielder");
      if (b.fielder && !this.bowling.players.includes(b.fielder)) throw new Error(nameOf(b.fielder) + " is not in " + this.bowling.name);
    }
  }

  apply(b) {
    const ex = b.extra;
    const legal = ex !== "wd" && ex !== "nb";
    const bat = this.bat.get(this.striker);
    if (!this.bowl.has(b.bowler)) this.bowl.set(b.bowler, newBowl());
    const bowl = this.bowl.get(b.bowler);
    this.overBowler = b.bowler;

    let batRuns = 0, extraTotal = 0, cost, rotate;
    if (ex === "wd") { extraTotal = 1 + b.extraRuns; bowl.wides += extraTotal; cost = extraTotal; rotate = b.extraRuns; }
    else if (ex === "nb") { batRuns = b.batRuns; extraTotal = 1; bowl.noballs++; cost = 1 + batRuns; rotate = batRuns; }
    else if (ex === "b" || ex === "lb") { extraTotal = b.extraRuns; cost = 0; rotate = b.extraRuns; }
    else { batRuns = b.batRuns; cost = batRuns; rotate = batRuns; }
    if (ex) this.extras[ex] += extraTotal;

    if (ex !== "wd") {
      bat.balls++; bat.runs += batRuns;
      if (batRuns === 4) bat.fours++;
      if (batRuns === 6) bat.sixes++;
    }
    const total = batRuns + extraTotal;
    this.runs += total;
    bowl.runs += cost; this.overRuns += cost;
    this.part.runs += total; this.part.extras += extraTotal;
    this.part.contrib.set(this.striker, (this.part.contrib.get(this.striker) || 0) + batRuns);
    if (legal) { this.balls++; this.part.balls++; bowl.balls++; this.overLegal++; }

    let outId = null;
    if (b.wicket) outId = b.out === "striker" ? this.striker : this.nonStriker;
    if (rotate % 2) { const t = this.striker; this.striker = this.nonStriker; this.nonStriker = t; }
    if (outId) this.wicketFall(b, outId, bowl);

    if (legal && this.overLegal === 6) {
      if (this.overRuns === 0) bowl.maidens++;
      const t = this.striker; this.striker = this.nonStriker; this.nonStriker = t;
      this.lastBowler = b.bowler; this.overBowler = null;
      this.overLegal = 0; this.overRuns = 0;
    }

    if (this.allOut) { this.finished = true; this.endReason = "all out"; }
    else if (this.balls >= this.maxBalls) { this.finished = true; this.endReason = "overs completed"; }
    else if (this.target !== null && this.runs >= this.target) { this.finished = true; this.endReason = "target reached"; }
  }

  wicketFall(b, outId, bowl) {
    const fig = this.bat.get(outId);
    fig.out = true; fig.how = Innings.howOut(b);
    this.wickets++;
    if (BOWLER_WICKETS.includes(b.wicket)) bowl.wkts++;
    if (b.fielder) this.fielding.set(b.fielder, (this.fielding.get(b.fielder) || 0) + 1);
    this.fow.push({ n: this.wickets, score: this.runs, name: outId, balls: this.balls });
    this.donePart.push(this.part);
    const survivor = outId === this.striker ? this.nonStriker : this.striker;
    let repl = null;
    if (!this.allOut) {
      repl = this.batting.players[this.nextIdx++];
      this.bat.set(repl, newBat());
      this.part = newPart(this.wickets + 1, survivor, repl);
    }
    if (outId === this.striker) this.striker = repl; else this.nonStriker = repl;
  }

  static howOut(b) {
    const w = b.wicket, bw = nameOf(b.bowler), f = b.fielder ? nameOf(b.fielder) : null;
    if (w === "bowled") return "b " + bw;
    if (w === "lbw") return "lbw b " + bw;
    if (w === "caught") return b.fielder === b.bowler ? "c & b " + bw : "c " + f + " b " + bw;
    if (w === "stumped") return "st " + f + " b " + bw;
    if (w === "hitwicket") return "hit wicket b " + bw;
    return f ? "run out (" + f + ")" : "run out";
  }

  get runRate() { return this.balls ? this.runs * 6 / this.balls : 0; }

  get requiredRate() {
    const left = this.maxBalls - this.balls;
    if (this.target === null || left <= 0) return null;
    return Math.max(this.target - this.runs, 0) * 6 / left;
  }

  partnerships() {
    const parts = this.donePart.slice();
    if (!this.allOut && (this.part.balls || this.part.runs)) parts.push(this.part);
    return parts;
  }

  statusLine() {
    let s = this.batting.name + " " + this.runs + "/" + this.wickets + " (" + fmtOvers(this.balls) + "/" + this.maxOvers + " ov)  CRR " + this.runRate.toFixed(2);
    if (this.target !== null) {
      const need = this.target - this.runs, left = this.maxBalls - this.balls;
      s += "  | Target " + this.target;
      if (need > 0 && left > 0) s += ", need " + need + " off " + left + " balls, RRR " + this.requiredRate.toFixed(2);
    }
    return s;
  }

  battersAtCrease() {
    const parts = [];
    for (const pair of [[this.striker, "*"], [this.nonStriker, ""]]) {
      if (pair[0]) { const f = this.bat.get(pair[0]); parts.push(nameOf(pair[0]) + " " + f.runs + "(" + f.balls + ")" + pair[1]); }
    }
    return parts.join("   ");
  }
}

class Match {
  constructor(teamA, teamB, overs) {
    this.teams = [teamA, teamB];
    this.overs = overs;
    this.innings = [];
  }

  start(batting) {
    const bowling = batting === this.teams[0] ? this.teams[1] : this.teams[0];
    const target = this.innings.length ? this.innings[0].runs + 1 : null;
    const inn = new Innings(batting, bowling, this.overs, target);
    this.innings.push(inn);
    return inn;
  }

  result() {
    if (this.innings.length < 2 || !this.innings[1].finished) return "Match in progress";
    const i1 = this.innings[0], i2 = this.innings[1];
    if (i2.runs > i1.runs) {
      const left = i2.batting.players.length - 1 - i2.wickets;
      return i2.batting.name + " won by " + plural(left, "wicket");
    }
    if (i2.runs === i1.runs) return "Match tied";
    return i1.batting.name + " won by " + plural(i1.runs - i2.runs, "run");
  }

  potm() {
    const pts = new Map(), notes = new Map();
    const add = (id, n, why) => {
      pts.set(id, (pts.get(id) || 0) + n);
      if (!notes.has(id)) notes.set(id, []);
      notes.get(id).push(why + " " + sg(n));
    };
    for (const inn of this.innings) {
      for (const [id, f] of inn.bat) {
        add(id, f.runs + f.fours + 2 * f.sixes, "bat " + f.runs + "(" + f.balls + ")");
        if (f.runs >= 100) add(id, 40, "century");
        else if (f.runs >= 50) add(id, 20, "fifty");
        if (f.out && f.runs === 0) add(id, -5, "duck");
      }
      for (const [id, f] of inn.bowl) {
        if (f.wkts) add(id, 25 * f.wkts, f.wkts + " wkt");
        if (f.maidens) add(id, 10 * f.maidens, f.maidens + " maiden");
        if (f.wkts >= 5) add(id, 30, "5-wkt haul");
        else if (f.wkts >= 3) add(id, 15, "3-wkt haul");
      }
      for (const [id, n] of inn.fielding) add(id, 10 * n, n + " fielding");
    }
    return [...pts].sort((x, y) => y[1] - x[1]).map(([id, p]) => ({ name: nameOf(id), pts: p, why: notes.get(id).join(", ") }));
  }
}

/* Turn a stored row into a ball. */
function fromRow(b) {
  return {
    bowler: b.bowler,
    batRuns: b.batRuns || 0,
    extra: b.extra || null,
    extraRuns: b.extraRuns || 0,
    wicket: b.wicket || null,
    out: b.out || "striker",
    fielder: b.fielder || null
  };
}

function describeBall(inn, ball, prevStriker) {
  let d = nameOf(ball.bowler) + " to " + nameOf(prevStriker) + ", " + labelOf(ball);
  if (ball.wicket) {
    const f = inn.fow[inn.fow.length - 1];
    d += ": " + nameOf(f.name) + " " + inn.bat.get(f.name).how;
  }
  return d;
}

/* Replay stored rows ({innings, ball}) in order and return the match plus commentary.
   Innings 2 starts automatically once innings 1 is finished. */
function replayMatch(teamA, teamB, overs, battingFirst, rows) {
  const match = new Match(teamA, teamB, overs);
  const first = battingFirst === "b" ? teamB : teamA;
  const second = first === teamA ? teamB : teamA;
  const byInnings = { 1: [], 2: [] };
  for (const r of rows) byInnings[r.innings].push(r.ball);
  const commentary = [];

  const play = (batting, balls, number) => {
    const inn = match.start(batting);
    for (const raw of balls) {
      const ball = fromRow(raw);
      const prev = inn.striker;
      inn.record(ball);
      commentary.push({ inn: number, text: describeBall(inn, ball, prev) });
    }
    return inn;
  };

  const i1 = play(first, byInnings[1], 1);
  if (i1.finished) play(second, byInnings[2], 2);
  return { match: match, commentary: commentary };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NAMES: NAMES, nameOf: nameOf, Innings: Innings, Match: Match, replayMatch: replayMatch, fromRow: fromRow, labelOf: labelOf, fmtOvers: fmtOvers, ordinal: ordinal, strikeRate: strikeRate, economy: economy };
}

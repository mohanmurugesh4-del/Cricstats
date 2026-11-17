/* CricStats web app: accounts, match list, match pages and admin scoring.
   Needs engine.js (scoring) and config.js (Supabase keys). */

const CFG = window.CRICSTATS_CONFIG || {};
const READY = !!CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR-PROJECT");
const LIB_OK = !!(window.supabase && window.supabase.createClient);
const sb = READY && LIB_OK ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const app = document.getElementById("app");

const S = { user: null, role: "viewer", filter: "live", tab: "commentary", current: null, channel: null, summaries: [] };

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isAdmin = () => S.role === "admin";
const splitNames = s => s.split(",").map(x => x.trim()).filter(Boolean);

function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = "toast"; }, 3200);
}
function fail(err) { toast((err && err.message) || "Something went wrong", "err"); }

/* ---------- boot and auth ---------- */
async function boot() {
  if (!LIB_OK || window.__libFailed) {
    app.innerHTML = `<div class="notice"><b>The site could not load its database library.</b> Check your internet connection, then refresh the page. If it still fails, try a private window or another browser.</div>`;
    return;
  }
  if (!READY) {
    app.innerHTML = `<div class="notice"><b>Connect Supabase to turn this on.</b> Edit <code>config.js</code> with your project URL and anon key, and run <code>supabase.sql</code> once. See the README.</div>`;
    return;
  }
  let data;
  try { ({ data } = await sb.auth.getSession()); }
  catch (err) {
    app.innerHTML = `<div class="notice"><b>Could not reach the database.</b> ${esc(err.message || err)}</div>`;
    return;
  }
  await setUser(data.session ? data.session.user : null);
  sb.auth.onAuthStateChange(async (_event, session) => {
    const before = S.user ? S.user.id : null;
    await setUser(session ? session.user : null);
    if (before !== (S.user ? S.user.id : null)) route();
  });
  window.addEventListener("hashchange", route);
  route();
}

async function setUser(user) {
  S.user = user;
  S.role = "viewer";
  if (user) {
    const { data } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (data && data.role) S.role = data.role;
    const code = sessionStorage.getItem("pendingAdminCode");
    if (code) {
      sessionStorage.removeItem("pendingAdminCode");
      const { data: ok, error } = await sb.rpc("claim_admin", { code: code });
      if (!error && ok) { S.role = "admin"; toast("Admin access granted", "ok"); }
      else toast("That admin code was not accepted", "err");
    }
  }
  renderHeader();
}

function renderHeader() {
  $("#auth-area").innerHTML = S.user
    ? `<span class="role ${isAdmin() ? "admin" : ""}">${isAdmin() ? "Admin" : "Viewer"}</span>
       <span class="who">${esc(S.user.email)}</span>
       <button class="btn ghost small" data-action="signout">Sign out</button>`
    : `<button class="btn small" data-action="open-auth">Sign in</button>`;
  $("#new-link").hidden = !(S.user && isAdmin());
}

function openAuth() { $("#auth-dialog").showModal(); }
function closeAuth() { $("#auth-dialog").close(); }

async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email: email, password: password });
  if (error) return fail(error);
  closeAuth();
}

async function register(email, password, role, code) {
  if (role === "admin" && code) sessionStorage.setItem("pendingAdminCode", code);
  const { data, error } = await sb.auth.signUp({ email: email, password: password });
  if (error) { sessionStorage.removeItem("pendingAdminCode"); return fail(error); }
  if (!data.session) toast("Check your email to confirm your account, then sign in.", "ok");
  else toast("Account created", "ok");
  closeAuth();
}

/* ---------- routing ---------- */
function route() {
  stopLive();
  if (!READY) return;
  if (!S.user) {
    app.innerHTML = `<section class="hero-note">
      <h1>Live cricket scores</h1>
      <p>Sign in to follow matches. Admins score the matches they start and can rename players.</p>
      <button class="btn primary" data-action="open-auth">Sign in or register</button>
    </section>`;
    return;
  }
  const h = location.hash || "#/";
  const m = h.match(/^#\/match\/([0-9a-f-]{36})$/i);
  if (m) return showMatch(m[1]);
  if (h === "#/new") {
    if (!isAdmin()) { location.hash = "#/"; return; }
    return showNew();
  }
  return showHome();
}

/* ---------- home: match list ---------- */
async function showHome() {
  app.innerHTML = `<div class="tabs" id="filters">
      <button data-filter="live" aria-pressed="${S.filter === "live"}">Live</button>
      <button data-filter="done" aria-pressed="${S.filter === "done"}">Completed</button>
    </div>
    <div id="list" class="list"><p class="muted">Loading matches…</p></div>`;
  S.summaries = await loadSummaries();
  drawList();
}

function drawList() {
  const list = $("#list");
  if (!list) return;
  const items = S.summaries.filter(x => S.filter === "live" ? !x.finished : x.finished);
  list.innerHTML = items.length
    ? items.map(cardHTML).join("")
    : `<p class="muted">No ${S.filter === "live" ? "live" : "completed"} matches yet.${isAdmin() ? ' <a href="#/new">Start a match</a>.' : ""}</p>`;
}

async function loadSummaries() {
  const { data: matches, error } = await sb.from("matches").select("*").order("created_at", { ascending: false });
  if (error) { fail(error); return []; }
  return Promise.all((matches || []).map(async m => summarize(await loadDetail(m))));
}

async function loadDetail(m) {
  const [p, e] = await Promise.all([
    sb.from("players").select("*").eq("match_id", m.id).order("position"),
    sb.from("match_events").select("*").eq("match_id", m.id).order("seq")
  ]);
  return { match: m, players: p.data || [], events: e.data || [] };
}

/* Build a replayed match from stored rows. Sets the global name map first. */
function buildReplay(d) {
  NAMES = new Map(d.players.map(p => [p.id, p.name]));
  const A = { name: d.match.team_a, players: d.players.filter(p => p.team === "a").map(p => p.id) };
  const B = { name: d.match.team_b, players: d.players.filter(p => p.team === "b").map(p => p.id) };
  const rows = d.events.map(e => ({ innings: e.innings, ball: e.ball }));
  return replayMatch(A, B, d.match.overs, d.match.batting_first, rows);
}

function currentStatus(ms) {
  if (ms.innings.length === 2 && ms.innings[1].finished) return ms.result();
  const inn = ms.innings[ms.innings.length - 1];
  if (ms.innings.length === 1 && inn.balls === 0) return "Yet to start";
  if (inn.target !== null) {
    const need = inn.target - inn.runs, left = inn.maxBalls - inn.balls;
    return inn.batting.name + " need " + need + " from " + left + " balls";
  }
  return inn.batting.name + " batting";
}

function summarize(d) {
  let r;
  try { r = buildReplay(d); }
  catch (err) { return { match: d.match, error: err.message, finished: true, lines: [], status: "Scoring error" }; }
  const ms = r.match;
  const finished = ms.innings.length === 2 && ms.innings[1].finished;
  return {
    match: d.match,
    finished: finished,
    lines: ms.innings.map(inn => ({ team: inn.batting.name, runs: inn.runs, wkts: inn.wickets, overs: fmtOvers(inn.balls) })),
    status: currentStatus(ms)
  };
}

function cardHTML(x) {
  const m = x.match;
  if (x.error) return `<a class="card" href="#/match/${m.id}"><div class="meta">${esc(m.title)}</div><div class="status bad">${esc(x.error)}</div></a>`;
  const rows = x.lines.length
    ? x.lines.map(l => `<div class="team-row"><span class="tn">${esc(l.team)}</span><b>${l.runs}/${l.wkts}</b><span class="ov">${l.overs} ov</span></div>`).join("")
    : `<div class="team-row"><span class="tn">${esc(m.team_a)} vs ${esc(m.team_b)}</span></div>`;
  return `<a class="card" href="#/match/${m.id}">
    <div class="meta"><span>${esc(m.title)} · ${m.overs} ov</span>${x.finished ? "" : '<span class="live-tag">LIVE</span>'}</div>
    ${rows}
    <div class="status ${x.finished ? "" : "live"}">${esc(x.status)}</div>
  </a>`;
}

/* ---------- match page ---------- */
async function showMatch(id) {
  app.innerHTML = `<p class="muted">Loading match…</p>`;
  const { data: m, error } = await sb.from("matches").select("*").eq("id", id).maybeSingle();
  if (error || !m) {
    app.innerHTML = `<div class="notice">This match is not available. It may be private to its admin.</div>`;
    return;
  }
  S.current = { id: id, match: m, owner: m.owner === S.user.id, detail: null, replay: null, error: null, scorerReady: false };
  app.innerHTML = `<section class="match">
      <div id="m-head"></div>
      <div id="m-scorer"></div>
      <nav class="tabs" id="m-tabs">
        <button data-tab="commentary">Commentary</button>
        <button data-tab="scorecard">Scorecard</button>
        <button data-tab="squads">Squads</button>
      </nav>
      <div id="m-body"></div>
    </section>`;
  markTabs();
  await reloadMatch(true);
  subscribe(id);
}

async function reloadMatch(first) {
  const c = S.current;
  if (!c) return;
  const { data: mm } = await sb.from("matches").select("*").eq("id", c.id).maybeSingle();
  if (!mm) {
    toast("This match is no longer available", "err");
    location.hash = "#/";
    return;
  }
  c.match = mm;
  c.owner = mm.owner === S.user.id;
  c.detail = await loadDetail(mm);
  try { c.replay = buildReplay(c.detail); c.error = null; }
  catch (err) { c.replay = null; c.error = err.message; }
  if (first || !c.scorerReady) buildScorer();
  renderHead();
  refreshScorer();
  renderBody();
}

function renderHead() {
  const c = S.current, m = c.match;
  if (!c.replay) {
    $("#m-head").innerHTML = `<div class="notice">${esc(c.error || "Loading…")}</div>`;
    return;
  }
  const ms = c.replay.match;
  const lines = ms.innings.map(inn => `<div class="score-line">
      <span class="tn">${esc(inn.batting.name)}</span>
      <b>${inn.runs}/${inn.wickets}</b>
      <span class="ov">(${fmtOvers(inn.balls)}/${inn.maxOvers} ov)</span>
    </div>`).join("");
  const pub = c.owner
    ? `<label class="check"><input type="checkbox" id="pub" ${m.published ? "checked" : ""}> Visible to viewers</label>`
    : "";
  $("#m-head").innerHTML = `<div class="card head">
      <div class="meta"><span>${esc(m.title)} · ${m.overs} overs</span>${c.owner ? '<span class="badge">Your match</span>' : ""}</div>
      ${lines}
      <div class="status">${esc(currentStatus(ms))}</div>
      ${pub}
    </div>`;
}

function markTabs() {
  document.querySelectorAll("#m-tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === S.tab)));
}

function renderBody() {
  const c = S.current, body = $("#m-body");
  if (!body) return;
  if (!c.replay) { body.innerHTML = ""; return; }
  markTabs();
  const ms = c.replay.match;
  if (S.tab === "commentary") {
    body.innerHTML = c.replay.commentary.length
      ? c.replay.commentary.slice().reverse().map(x => `<p class="comm-line"><span class="inn">${x.inn}</span>${esc(x.text)}</p>`).join("")
      : `<p class="muted">No deliveries yet.</p>`;
  } else if (S.tab === "scorecard") {
    body.innerHTML = ms.innings.map((inn, i) => `<div class="panel">${scorecardHTML(inn, ordinal(i + 1) + " innings")}</div>`).join("")
      + (ms.innings.every(i => i.finished) ? `<div class="panel result-big">${esc(ms.result())}</div>` : "");
  } else {
    body.innerHTML = squadsHTML(c);
  }
}

function squadsHTML(c) {
  const editable = c.owner && isAdmin();
  const team = (key, label) => {
    const list = c.detail.players.filter(p => p.team === key);
    return `<div class="panel"><h3>${esc(label)}</h3>
      ${list.map(p => editable
        ? `<label class="name-row"><input data-pid="${p.id}" value="${esc(p.name)}" maxlength="40" aria-label="Player name"></label>`
        : `<div class="name-row ro">${esc(p.name)}</div>`).join("")}
    </div>`;
  };
  return `<div class="squads">${team("a", c.match.team_a)}${team("b", c.match.team_b)}</div>
    ${editable ? '<button class="btn primary" data-action="save-names">Save names</button>' : '<p class="muted">Only the match admin can rename players.</p>'}`;
}

async function saveNames() {
  const c = S.current;
  const inputs = [...document.querySelectorAll("#m-body input[data-pid]")];
  if (inputs.some(i => !i.value.trim())) return toast("Player names cannot be empty", "err");
  const changes = inputs
    .map(i => ({ id: i.dataset.pid, name: i.value.trim() }))
    .filter(x => { const p = c.detail.players.find(q => q.id === x.id); return p && p.name !== x.name; });
  for (const ch of changes) {
    const { error } = await sb.from("players").update({ name: ch.name }).eq("id", ch.id);
    if (error) return fail(error);
  }
  toast(changes.length ? "Names saved" : "No changes to save", "ok");
  if (changes.length) reloadMatch(false);
}

/* ---------- admin scorer ---------- */
function buildScorer() {
  const c = S.current, box = $("#m-scorer");
  if (!(c.owner && isAdmin())) { box.innerHTML = ""; c.scorerReady = false; return; }
  box.innerHTML = `<div class="panel scorer">
      <div class="label">Bowler</div>
      <select id="bowler" aria-label="Bowler"></select>
      <div class="label">Runs</div>
      <div class="seg" id="seg-runs">
        ${[0, 1, 2, 3, 4, 6].map(v => `<button type="button" data-seg="runs" data-v="${v}" aria-pressed="${v === 0}">${v}</button>`).join("")}
      </div>
      <div class="label">Extra</div>
      <div class="seg" id="seg-extra">
        <button type="button" data-seg="extra" data-v="" aria-pressed="true">None</button>
        <button type="button" data-seg="extra" data-v="wd" aria-pressed="false">Wide</button>
        <button type="button" data-seg="extra" data-v="nb" aria-pressed="false">No-ball</button>
        <button type="button" data-seg="extra" data-v="b" aria-pressed="false">Bye</button>
        <button type="button" data-seg="extra" data-v="lb" aria-pressed="false">Leg bye</button>
      </div>
      <div class="label">Wicket</div>
      <div class="row2">
        <select id="wkt" aria-label="Wicket type">
          <option value="">No wicket</option>
          <option value="bowled">Bowled</option>
          <option value="caught">Caught</option>
          <option value="lbw">LBW</option>
          <option value="stumped">Stumped</option>
          <option value="hitwicket">Hit wicket</option>
          <option value="runout">Run out</option>
        </select>
        <select id="fld" aria-label="Fielder"></select>
      </div>
      <label class="check"><input type="checkbox" id="nons"> Non-striker is out</label>
      <button class="rec" id="rec" type="button">Record ball</button>
      <div class="row3">
        <button class="btn" id="undo" type="button">Undo last ball</button>
      </div>
      <div class="msg" id="scorer-msg" role="status"></div>
      <div class="small" id="scorer-note"></div>
    </div>`;
  c.scorerReady = true;
}

function refreshScorer() {
  const c = S.current, r = c.replay;
  if (!$("#bowler") || !r) return;
  const inn = r.match.innings[r.match.innings.length - 1];
  const opts = inn.bowling.players.map(id => `<option value="${esc(id)}">${esc(nameOf(id))}</option>`).join("");
  const bowl = $("#bowler"), prevB = bowl.value;
  bowl.innerHTML = `<option value="">Choose bowler</option>` + opts;
  if (inn.overBowler) bowl.value = inn.overBowler;
  else if ([...bowl.options].some(o => o.value === prevB)) bowl.value = prevB;
  bowl.disabled = inn.finished || !!inn.overBowler;

  const fld = $("#fld"), prevF = fld.value;
  fld.innerHTML = `<option value="">Fielder</option>` + opts;
  if ([...fld.options].some(o => o.value === prevF)) fld.value = prevF;

  $("#rec").disabled = inn.finished;
  $("#undo").disabled = !c.detail.events.length;
  $("#scorer-note").textContent = inn.finished ? "Innings over (" + inn.endReason + ")" : "";
}

function scorerMsg(text, kind) {
  const m = $("#scorer-msg");
  m.textContent = text;
  m.className = "msg" + (kind ? " " + kind : "");
}

function pressed(group) {
  const b = document.querySelector(`#seg-${group} [aria-pressed="true"]`);
  return b ? b.dataset.v : "";
}

function resetExtraAndRuns() {
  document.querySelectorAll('[data-seg="extra"]').forEach((b, i) => b.setAttribute("aria-pressed", String(i === 0)));
  document.querySelectorAll('[data-seg="runs"]').forEach((b, i) => b.setAttribute("aria-pressed", String(i === 0)));
  $("#wkt").value = "";
  $("#nons").checked = false;
}

async function recordBall() {
  const c = S.current, ms = c.replay.match;
  const inn = ms.innings[ms.innings.length - 1];
  const bowler = inn.overBowler || $("#bowler").value;
  if (!bowler) return scorerMsg("Choose a bowler first", "err");
  const runs = parseInt(pressed("runs"), 10);
  const extra = pressed("extra") || null;
  const kind = $("#wkt").value || null;
  const ball = {
    bowler: bowler, extra: extra, batRuns: 0, extraRuns: 0,
    wicket: kind,
    out: $("#nons").checked ? "non_striker" : "striker",
    fielder: ["caught", "stumped", "runout"].includes(kind) ? ($("#fld").value || null) : null
  };
  if (!extra || extra === "nb") ball.batRuns = runs; else ball.extraRuns = runs;
  if ((extra === "b" || extra === "lb") && runs < 1) return scorerMsg("Byes and leg byes need at least 1 run", "err");
  try { inn.validate(ball); } catch (err) { return scorerMsg(err.message, "err"); }

  const lastSeq = c.detail.events.length ? c.detail.events[c.detail.events.length - 1].seq : 0;
  const { error } = await sb.from("match_events").insert({
    match_id: c.id, innings: ms.innings.length, seq: lastSeq + 1, ball: ball
  });
  if (error) return scorerMsg(error.message, "err");
  resetExtraAndRuns();
  scorerMsg("Ball recorded", "ok");
  await reloadMatch(false);
}

async function undoBall() {
  const c = S.current, ev = c.detail.events;
  if (!ev.length) return;
  const last = ev[ev.length - 1];
  const { error } = await sb.from("match_events").delete().eq("match_id", c.id).eq("seq", last.seq);
  if (error) return scorerMsg(error.message, "err");
  scorerMsg("Last ball removed", "ok");
  await reloadMatch(false);
}

/* ---------- live updates ---------- */
function subscribe(id) {
  stopLive();
  S.channel = sb.channel("match-" + id)
    .on("postgres_changes", { event: "*", schema: "public", table: "match_events", filter: "match_id=eq." + id }, () => reloadMatch(false))
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: "match_id=eq." + id }, () => reloadMatch(false))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches", filter: "id=eq." + id }, () => reloadMatch(false))
    .subscribe();
}
function stopLive() {
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
}

/* ---------- new match (admin) ---------- */
function showNew() {
  app.innerHTML = `<section class="panel form">
      <h1>Start a new match</h1>
      <p class="muted">You become the only person who can score this match and rename its players.</p>
      <form id="new-form">
        <label>Match title<input name="title" required maxlength="60" placeholder="Royals v Titans, Final"></label>
        <div class="two">
          <label>Team A<input name="team_a" required maxlength="30"></label>
          <label>Team B<input name="team_b" required maxlength="30"></label>
        </div>
        <div class="two">
          <label>Overs per innings<input name="overs" type="number" min="1" max="50" value="5" required></label>
          <label>Batting first<select name="batting_first"><option value="a">Team A</option><option value="b">Team B</option></select></label>
        </div>
        <div class="two">
          <label>Team A players (comma separated, batting order)<textarea name="pa" required></textarea></label>
          <label>Team B players (comma separated, batting order)<textarea name="pb" required></textarea></label>
        </div>
        <label class="check"><input type="checkbox" name="published"> Visible to viewers now (leave off to keep it private)</label>
        <button class="btn primary" type="submit">Create match</button>
      </form>
    </section>`;
  $("#new-form").addEventListener("submit", createMatch);
}

async function createMatch(e) {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target));
  const pa = splitNames(v.pa), pb = splitNames(v.pb);
  if (pa.length < 2 || pb.length < 2 || pa.length > 11 || pb.length > 11) return toast("Each team needs 2 to 11 players", "err");
  if (new Set([...pa, ...pb]).size !== pa.length + pb.length) return toast("Player names must be unique", "err");
  const overs = parseInt(v.overs, 10);
  if (!(overs >= 1 && overs <= 50)) return toast("Overs must be between 1 and 50", "err");

  const { data: m, error } = await sb.from("matches").insert({
    title: v.title.trim(), team_a: v.team_a.trim(), team_b: v.team_b.trim(), overs: overs,
    batting_first: v.batting_first, published: !!v.published
  }).select("id").single();
  if (error) return fail(error);

  const rows = [
    ...pa.map((n, i) => ({ match_id: m.id, team: "a", position: i + 1, name: n })),
    ...pb.map((n, i) => ({ match_id: m.id, team: "b", position: i + 1, name: n }))
  ];
  const { error: e2 } = await sb.from("players").insert(rows);
  if (e2) return fail(e2);
  toast("Match created", "ok");
  location.hash = "#/match/" + m.id;
}

/* ---------- scorecard rendering ---------- */
function scorecardHTML(inn, title) {
  const e = inn.extras, ext = e.wd + e.nb + e.b + e.lb;
  const dnb = inn.batting.players.slice(inn.nextIdx);
  const bats = [...inn.bat].map(([id, f]) =>
    `<tr><td class="nm">${esc(nameOf(id))}</td><td class="how">${esc(f.out ? f.how : "not out")}</td><td>${f.runs}</td><td>${f.balls}</td><td>${f.fours}</td><td>${f.sixes}</td><td>${strikeRate(f).toFixed(2)}</td></tr>`).join("");
  const bowls = [...inn.bowl].map(([id, f]) =>
    `<tr><td class="nm">${esc(nameOf(id))}</td><td>${fmtOvers(f.balls)}</td><td>${f.maidens}</td><td>${f.runs}</td><td>${f.wkts}</td><td>${economy(f).toFixed(2)}</td><td>${f.wides}</td><td>${f.noballs}</td></tr>`).join("");
  const fow = inn.fow.map(f => `${f.n}-${f.score} (${esc(nameOf(f.name))}, ${fmtOvers(f.balls)} ov)`).join(", ") || "-";
  const parts = inn.partnerships().map(p => {
    const tag = (p === inn.part && !inn.allOut) ? "*" : "";
    return `<li>${ordinal(p.wicket)} wkt: ${esc(nameOf(p.a))} &amp; ${esc(nameOf(p.b))}: <b>${p.runs}${tag}</b> (${p.balls} b) <span>[${esc(nameOf(p.a))} ${p.contrib.get(p.a)}, ${esc(nameOf(p.b))} ${p.contrib.get(p.b)}, extras ${p.extras}]</span></li>`;
  }).join("") || "<li>-</li>";
  return `
    <div class="sc-head"><h3>${esc(inn.batting.name)} · ${esc(title)}</h3><span class="tot">${inn.runs}/${inn.wickets}</span></div>
    <div class="tbl"><table class="sc-t">
      <thead><tr><th>Batter</th><th>Dismissal</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
      <tbody>${bats || '<tr><td colspan="7">Yet to bat</td></tr>'}</tbody>
    </table></div>
    <p class="sc-meta">Extras <b>${ext}</b> (b ${e.b}, lb ${e.lb}, w ${e.wd}, nb ${e.nb}) · Total <b>${inn.runs}</b> (${inn.wickets} wkts, ${fmtOvers(inn.balls)} ov, RR ${inn.runRate.toFixed(2)})</p>
    ${dnb.length ? `<p class="sc-meta">Did not bat: ${dnb.map(id => esc(nameOf(id))).join(", ")}</p>` : ""}
    <p class="sc-sub">Fall of wickets</p>
    <p class="sc-meta">${fow}</p>
    <p class="sc-sub">Bowling</p>
    <div class="tbl"><table class="sc-t">
      <thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th><th>Wd</th><th>Nb</th></tr></thead>
      <tbody>${bowls}</tbody>
    </table></div>
    <p class="sc-sub">Partnerships</p>
    <ul class="sc-list">${parts}</ul>`;
}

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const seg = e.target.closest("[data-seg]");
  if (seg) {
    seg.parentElement.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === seg)));
    return;
  }
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.dataset.filter) {
    S.filter = t.dataset.filter;
    t.parentElement.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === t)));
    return drawList();
  }
  if (t.dataset.tab) { S.tab = t.dataset.tab; return renderBody(); }
  switch (t.dataset.action) {
    case "open-auth": return openAuth();
    case "signout": return sb.auth.signOut();
    case "save-names": return saveNames();
  }
  if (t.id === "rec") return recordBall();
  if (t.id === "undo") return undoBall();
});

document.addEventListener("change", async e => {
  if (e.target.id === "pub" && S.current) {
    const { error } = await sb.from("matches").update({ published: e.target.checked }).eq("id", S.current.id);
    if (error) { e.target.checked = !e.target.checked; return fail(error); }
    toast(e.target.checked ? "Match is visible to viewers" : "Match is now private", "ok");
  }
  if (e.target.id === "role-select") {
    $("#code-row").hidden = e.target.value !== "admin";
  }
});

document.querySelectorAll("[data-auth]").forEach(b => b.addEventListener("click", () => {
  const up = b.dataset.auth === "up";
  document.querySelectorAll("[data-auth]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $("#signin-form").hidden = up;
  $("#signup-form").hidden = !up;
}));
$("#auth-close").addEventListener("click", closeAuth);
$("#signin-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = new FormData(e.target);
  signIn(f.get("email").trim(), f.get("password"));
});
$("#signup-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = new FormData(e.target);
  register(f.get("email").trim(), f.get("password"), f.get("role"), (f.get("code") || "").trim());
});

boot().catch(err => { app.innerHTML = `<div class="notice"><b>Something went wrong loading the site.</b> ${esc(err && err.message || err)}</div>`; });

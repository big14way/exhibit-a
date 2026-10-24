const STAGES = [
  "REPORTED", "SCOPING", "LINEAGE", "BASELINED", "HYPOTHESES", "EVIDENCE",
  "CRITIQUED", "ADJUDICATED", "REPAIR_PROPOSED", "SHADOW_VERIFIED",
  "AWAITING_APPROVAL", "WRITTEN", "WRITE_VERIFIED", "MEMORISED", "CLOSED",
];

const state = {
  cases: [],
  current: null,
  source: "",
  exhibits: [],
  selected: null,
  trace: [],
  graph: null,
  filter: "",
  kind: "",
  caseFilter: "",
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

const STATIC = Boolean(window.EXHIBIT_A_STATIC);

/* The static export (GitHub Pages) serves JSON files instead of the API.
   Re-runs execute tools, so they need the local viewer. */
async function api(path, options) {
  if (STATIC) {
    if (options?.method === "POST") {
      throw new Error("re-runs execute the recorded tool; run the local viewer (npm run web) to re-run");
    }
    const match = path.match(/^\/api\/cases(?:\/([^/]+))?$/);
    const file = match?.[1] ? `./data/${decodeURIComponent(match[1])}.json` : "./data/cases.json";
    const response = await fetch(file);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

const shortSha = (value) => (value ? `${String(value).slice(0, 12)}…` : "—");
const pct = (value, digits = 1) => `${(Number(value ?? 0) * 100).toFixed(digits)}%`;
function usd(value) {
  const n = Number(value ?? 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
function usdAxis(value) {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(0)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(0)}M`;
  return String(abs);
}
const pill = (text, className = "") => el("span", `pill ${className}`.trim(), text);
const dateLabel = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
const sourceLabel = (source) =>
  source === "live" ? "recorded live Zetaris close" : source === "sample" ? "curated sample replay" : "this machine";

/* ------------------------------------------------------------------ cases */

async function loadCases() {
  const data = await api("/api/cases");
  state.cases = data.cases || [];
  renderCaseList();
}

function renderCaseList() {
  const list = $("case-list");
  list.replaceChildren();
  const filter = state.caseFilter.toLowerCase();
  const rows = state.cases.filter(
    (item) => !filter || `${item.question} ${item.metric} ${item.id}`.toLowerCase().includes(filter),
  );
  if (!rows.length) {
    list.append(el("div", "empty", state.cases.length ? "No cases match." : "No cases yet. Run the CLI investigate command."));
    return;
  }
  const groups = [
    ["live", "Live Zetaris"],
    ["sample", "Sample replay"],
    ["local", "Local runs"],
  ];
  for (const [key, label] of groups) {
    const items = rows.filter((item) => item.source === key);
    if (!items.length) continue;
    list.append(el("div", "case-group", label));
    for (const item of items) {
      const button = el("button", "case-item");
      button.type = "button";
      button.append(el("span", "q", item.question));
      button.append(el("span", "metric", item.metric));
      const meta = el("span", "m");
      meta.append(
        pill(item.verdict || item.stage, verdictClass(item.verdict)),
        el("span", "", item.stage === "CLOSED" ? "closed" : item.stage.toLowerCase().replaceAll("_", " ")),
        el("span", "", `${item.exhibits} exhibits`),
      );
      const when = dateLabel(item.reported_at);
      if (when) meta.append(el("span", "", when));
      button.append(meta);
      button.addEventListener("click", () => loadCase(item.id));
      if (state.current?.id === item.id) button.classList.add("active");
      list.append(button);
    }
  }
}

function verdictClass(kind) {
  if (kind === "MIXED") return "warn";
  if (kind === "DATA_ARTIFACT") return "bad";
  if (kind === "REAL_CHANGE") return "good";
  return "";
}

async function loadCase(id) {
  const data = await api(`/api/cases/${encodeURIComponent(id)}`);
  state.current = data.state;
  state.source = data.source || "local";
  state.trace = data.trace || [];
  state.graph = data.graph || null;
  state.exhibits = data.state.exhibits || [];
  state.selected = null;
  state.filter = "";
  state.kind = "";
  $("exhibit-search").value = "";
  $("empty-state").classList.add("hidden");
  $("case-view").classList.remove("hidden");
  history.replaceState(null, "", `#case=${encodeURIComponent(id)}`);
  render();
  renderCaseList();
}

/* ----------------------------------------------------------------- render */

function render() {
  const s = state.current;
  if (!s) return;
  const mode = $("mode-badge");
  mode.textContent = STATIC ? "static export · read-only" : s.sample_mode ? "SAMPLE_MODE replay" : "live Zetaris";
  mode.className = `pill ${s.sample_mode ? "info" : "good"}`;

  $("case-id").textContent = s.id;
  $("case-source").textContent = sourceLabel(state.source);
  $("case-question").textContent = s.question;
  $("case-metric").textContent = s.metric;
  $("case-mode").textContent = s.sample_mode ? "replayed from cassette" : "live";
  $("case-mode").className = `pill ${s.sample_mode ? "info" : "good"}`;
  $("case-stage").textContent = s.stage.replaceAll("_", " ");
  $("case-stage").className = `pill ${s.stage === "CLOSED" ? "dark" : s.stage === "FAILED" ? "bad" : ""}`;
  $("case-date").textContent = dateLabel(s.reported_at);

  renderHero(s);
  renderStages(s);
  renderSymptom(s);
  renderVerdict(s);
  renderChannels(s);
  renderHypotheses(s);
  renderRepair(s);
  renderWriteback(s);
  renderLineage(state.graph);
  renderExhibits();
  renderTimeline(s);
}

function renderHero(s) {
  const hero = $("verdict-hero");
  hero.replaceChildren();
  const verdict = s.verdict;
  hero.append(el("div", "label", "Verdict"));
  hero.append(el("div", `kind ${verdict?.kind || "PENDING"}`, verdict ? verdict.kind.replaceAll("_", " ") : "not adjudicated"));
  if (!verdict) return;
  const artifact = verdict.causes.filter((c) => c.kind === "artifact").reduce((sum, c) => sum + c.share, 0);
  const real = verdict.causes.filter((c) => c.kind === "real").reduce((sum, c) => sum + c.share, 0);
  const unexplained = Math.max(0, verdict.unexplained_share ?? 1 - artifact - real);
  const bar = el("div", "share-bar");
  for (const [cls, value] of [["artifact", artifact], ["real", real], ["unexplained", unexplained]]) {
    const span = el("span", cls);
    span.style.width = `${Math.max(0, Math.min(100, value * 100))}%`;
    bar.append(span);
  }
  hero.append(bar);
  const legend = el("div", "share-legend");
  legend.append(
    Object.assign(el("span", "artifact"), { innerHTML: `<i></i>artifact ${pct(artifact)}` }),
    Object.assign(el("span", "real"), { innerHTML: `<i></i>real ${pct(real)}` }),
    Object.assign(el("span", "unexplained"), { innerHTML: `<i></i>unexplained ${pct(unexplained)}` }),
  );
  hero.append(legend);
}

function renderStages(s) {
  const strip = $("stage-strip");
  strip.replaceChildren();
  const currentIndex = STAGES.indexOf(s.stage);
  STAGES.forEach((stage, index) => {
    const step = el("span", "stage-step", stage.replaceAll("_", " "));
    if (index < currentIndex || s.stage === "CLOSED") step.classList.add("reached");
    if (stage === s.stage) step.classList.add("current");
    strip.append(step);
  });
  if (s.stage === "FAILED") strip.append(el("span", "stage-step failed", "FAILED"));
}

/* ---------------------------------------------------------------- symptom */

function historySeries(s) {
  const exhibit = state.exhibits.find((row) => row.tool === "metric_history");
  const grain = s.baseline?.grain || "fiscal_year";
  if (!exhibit?.result?.columns) return null;
  const cols = exhibit.result.columns;
  const gi = cols.indexOf(grain);
  const vi = cols.findIndex((c) => /revenue|income|value|amount|total|usd/i.test(c) && c !== grain);
  const si = cols.findIndex((c, i) => i !== gi && i !== vi);
  if (gi < 0 || vi < 0) return null;
  const bySegment = new Map();
  for (const row of exhibit.result.rows) {
    const segment = si >= 0 ? String(row[si]) : "all";
    const points = bySegment.get(segment) ?? [];
    points.push({ period: String(row[gi]), value: Number(row[vi]) });
    bySegment.set(segment, points);
  }
  for (const points of bySegment.values()) points.sort((a, b) => a.period.localeCompare(b.period));
  return bySegment;
}

function correctedSeries(segment, periods) {
  const exhibit = state.exhibits.find((row) => row.tool === "canonical_series");
  if (!exhibit?.result?.rows) return [];
  const wanted = new Set(periods.map((p) => `CY${p}`));
  return exhibit.result.rows
    .filter((row) => String(row[0]) === segment && wanted.has(String(row[1])))
    .map((row) => ({ period: String(row[1]).replace(/^CY/, ""), value: Number(row[2]) }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

function renderSymptom(s) {
  const chart = $("symptom-chart");
  const facts = $("symptom-facts");
  const legend = $("symptom-legend");
  chart.replaceChildren();
  facts.replaceChildren();
  legend.replaceChildren();
  const series = historySeries(s);
  const onset = s.baseline?.onset;
  $("symptom-sub").textContent = s.baseline?.explanation || "No baseline recorded.";
  if (!series) {
    chart.append(el("div", "empty", "No metric history exhibit on file."));
    return;
  }
  const focus = onset?.segment ?? [...series.keys()][0];
  const periods = [...new Set([...series.values()].flat().map((p) => p.period))].sort();
  const corrected = focus ? correctedSeries(focus, periods) : [];
  const cf = state.exhibits.find((row) => row.tool === "counterfactual")?.result;

  const width = 640;
  const height = 300;
  const pad = { l: 56, r: 18, t: 18, b: 34 };
  const all = [...series.values()].flat().map((p) => p.value).concat(corrected.map((p) => p.value), [0]);
  const max = Math.max(...all) * 1.08;
  const x = (period) => pad.l + (periods.indexOf(period) / Math.max(1, periods.length - 1)) * (width - pad.l - pad.r);
  const y = (value) => height - pad.b - (value / max) * (height - pad.t - pad.b);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Reported and corrected series" });

  if (onset) {
    const x0 = x(String(onset.prior_period));
    const x1 = x(String(onset.period));
    svg.append(svgEl("rect", { class: "onset-band", x: Math.min(x0, x1), y: pad.t, width: Math.abs(x1 - x0), height: height - pad.t - pad.b }));
  }
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = (max / ticks) * i;
    svg.append(svgEl("line", { class: "grid-line", x1: pad.l, x2: width - pad.r, y1: y(value), y2: y(value) }));
    const label = svgEl("text", { class: "tick", x: pad.l - 8, y: y(value) + 3, "text-anchor": "end" });
    label.textContent = usdAxis(value);
    svg.append(label);
  }
  for (const period of periods) {
    const label = svgEl("text", { class: "tick", x: x(period), y: height - pad.b + 18, "text-anchor": "middle" });
    label.textContent = period;
    svg.append(label);
  }
  svg.append(svgEl("line", { class: "axis", x1: pad.l, x2: width - pad.r, y1: height - pad.b, y2: height - pad.b }));

  const pathFor = (points) => points.map((p, i) => `${i ? "L" : "M"} ${x(p.period)} ${y(p.value)}`).join(" ");
  for (const [segment, points] of series) {
    if (segment === focus) continue;
    svg.append(svgEl("path", { class: "series other", d: pathFor(points) }));
  }
  const focusPoints = series.get(focus) ?? [];
  svg.append(svgEl("path", { class: "series reported", d: pathFor(focusPoints) }));
  for (const p of focusPoints) {
    const isOnset = onset && String(onset.period) === p.period;
    svg.append(svgEl("circle", { class: `dot reported ${isOnset ? "onset" : ""}`, cx: x(p.period), cy: y(p.value), r: isOnset ? 5 : 3.5 }));
    if (isOnset) {
      const t = svgEl("text", { class: "annot", x: x(p.period) - 8, y: y(p.value) - 10, "text-anchor": "end" });
      t.textContent = `${usd(p.value)} reported · ${onset.ratio.toFixed(2)}x`;
      svg.append(t);
    }
  }
  if (corrected.length) {
    svg.append(svgEl("path", { class: "series corrected", d: pathFor(corrected) }));
    for (const p of corrected) svg.append(svgEl("circle", { class: "dot corrected", cx: x(p.period), cy: y(p.value), r: 3.5 }));
  }
  chart.append(svg);

  legend.append(el("span", "reported", `${focus} · reported view`));
  if (corrected.length) legend.append(el("span", "corrected", `${focus} · corrected (one fact per cik, period)`));
  if (series.size > 1) legend.append(el("span", "", "other segments"));

  const fact = (k, v, d, cls = "", wide = false) => {
    const node = el("div", `fact ${wide ? "wide" : ""}`);
    node.append(el("div", "k", k), el("div", `v ${cls}`, v));
    if (d) node.append(el("div", "d", d));
    return node;
  };
  if (onset) {
    facts.append(
      fact("Reported move", `${usd(onset.prior_value)} → ${usd(onset.value)}`, `${focus}, ${onset.prior_period} → ${onset.period} · ${onset.ratio.toFixed(2)}x, outside the ${s.baseline.band.lo}–${s.baseline.band.hi}x band`, "bad", true),
      fact("Reported delta", usd(onset.delta), "what the dashboard claims moved"),
    );
    if (cf) {
      facts.append(
        fact("Corrected delta", usd(cf.corrected_delta), `${usd(cf.corrected_prior)} → ${usd(cf.corrected_now)} after deduplication`, "good"),
        fact("Artifact share", pct(cf.explained_share), cf.rule, "bad"),
        fact("Real share", pct(cf.unexplained_share), "survives dedup and the SEC second channel", "good"),
      );
    }
  } else {
    facts.append(fact("No onset", "—", "every period moved inside the baseline band", "", true));
  }
}

/* ---------------------------------------------------------------- verdict */

function renderVerdict(s) {
  const body = $("verdict-body");
  body.replaceChildren();
  const verdict = s.verdict;
  if (!verdict) {
    body.append(el("div", "empty", "This case has not been adjudicated yet."));
    return;
  }
  const rows = el("div", "cause-rows");
  for (const cause of verdict.causes || []) {
    const row = el("div", "cause-row");
    row.append(el("div", "name", cause.cause));
    const bar = el("div", `bar ${cause.kind}`);
    const fill = el("span");
    fill.style.width = `${Math.max(0, Math.min(100, cause.share * 100))}%`;
    bar.append(fill);
    row.append(bar, el("div", "share", pct(cause.share)));
    rows.append(row);
  }
  if (!verdict.causes?.length) rows.append(el("div", "empty", "No cause carried a share."));
  body.append(rows);
  const gate = el("div", "gate");
  if (verdict.gate_failures?.length) {
    gate.append(pill("gate: downgraded", "bad"), el("span", "muted", `${verdict.gate_failures.length} rule(s) failed`));
    body.append(gate);
    for (const failure of verdict.gate_failures) body.append(el("div", "failure", `${failure.rule}: ${failure.detail}`));
  } else {
    gate.append(pill("gate: pass", "good"), el("span", "muted", "located · quantified · sufficient · timed · corroborated"));
    body.append(gate);
  }
  if (verdict.notes?.length) {
    const notes = el("ul", "notes");
    for (const note of verdict.notes) notes.append(el("li", "", note));
    body.append(notes);
  }
}

/* --------------------------------------------------------------- channels */

function channel(title, model, detail) {
  const node = el("div", "channel");
  const head = el("div", "head");
  head.append(el("div", "title", title));
  if (model) head.append(el("span", "model", model));
  node.append(head);
  if (detail) node.append(el("div", "detail", detail));
  return node;
}

function renderChannels(s) {
  const body = $("channels-body");
  body.replaceChildren();
  if (s.memory) {
    const m = s.memory;
    const embed = m.embedding;
    const node = channel(
      "H-MEM recall",
      embed?.status === "ran" ? `${embed.model} · ${embed.dims} dims` : "lexical index",
      m.cold_start
        ? `Cold start: ${m.records} record(s) in the index. Nothing to recall yet.`
        : `${m.hits.length} hit(s) from ${m.records} record(s) · scoring ${m.scoring || "lexical"}` +
          (embed && embed.status !== "ran" ? ` · embeddings ${embed.status}` : ""),
    );
    for (const hit of m.hits.slice(0, 3)) {
      node.append(
        el("div", "memory-hit", `${hit.case_id} · ${hit.verdict_kind} · ${hit.causes.join(", ")} · ${hit.match.join(", ")}`),
      );
    }
    body.append(node);
  }
  if (s.discovery) {
    const d = s.discovery;
    body.append(
      channel(
        "Scout source discovery",
        "SEC companyfacts",
        `${d.company}: ${d.current_concept} (${d.current_annual_facts} annual facts) → ${d.replacement_concept || "no replacement"}. ${d.replacement_reason}`,
      ),
    );
  }
  if (s.critic) {
    const c = s.critic;
    const node = channel(
      "Defense Counsel critic",
      c.model || "not configured",
      c.status === "ran"
        ? `${c.objections.length} objection(s) · ${c.cited_unknown.length} unknown citation(s) · ${c.usage.prompt_tokens}+${c.usage.completion_tokens} tokens · ${c.context_chunks} Markovian window(s), ${c.context_chars} chars`
        : c.detail,
    );
    if (c.objections?.length) {
      const list = el("ul", "objections");
      for (const objection of c.objections) {
        const li = el("li");
        li.append(el("span", `sev ${objection.severity}`, objection.severity), el("span", "", objection.claim));
        list.append(li);
      }
      node.append(list);
    }
    body.append(node);
  }
  if (s.safety) {
    const sf = s.safety;
    const model = sf.model;
    const node = channel(
      "Content safety",
      model?.status === "ran" ? model.model : "lexical rules",
      `Lexical guard ${sf.findings.filter((f) => f.rule !== "nemotron_content_safety").length ? "blocked" : "passed"} ${sf.checked_chars} chars` +
        (model
          ? model.status === "ran"
            ? ` · model: user ${model.user_safety}, response ${model.response_safety}`
            : ` · model ${model.status}`
          : ""),
    );
    body.append(node);
  }
  if (s.hmem) {
    body.append(
      channel("H-MEM persistence", null, `Closed case remembered as ${s.hmem.record_id} · ${s.hmem.valid} valid, ${s.hmem.malformed} malformed, ${s.hmem.duplicates} duplicate(s)`),
    );
  }
  if (!body.children.length) body.append(el("div", "empty", "No model roles recorded for this case."));
}

/* ------------------------------------------------------------- hypotheses */

function renderHypotheses(s) {
  const body = $("hypotheses-body");
  body.replaceChildren();
  const rows = s.hypotheses || [];
  $("hypotheses-hint").textContent = rows.length
    ? `${rows.filter((r) => r.status === "confirmed").length} confirmed · ${rows.filter((r) => r.status === "eliminated").length} eliminated · ${rows.filter((r) => r.status === "open").length} open`
    : "";
  if (!rows.length) {
    body.append(el("div", "empty", "No hypotheses recorded."));
    return;
  }
  const table = el("table", "hyp-table");
  const colgroup = el("colgroup");
  for (const cls of ["c-cause", "c-status", "c-share", "c-note"]) colgroup.append(el("col", cls));
  table.append(colgroup);
  const head = el("thead");
  const hrow = el("tr");
  for (const label of ["cause", "status", "share", "evidence"]) hrow.append(el("th", "", label));
  head.append(hrow);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    const causeCell = el("td");
    causeCell.append(el("div", "cause", row.cause));
    if (row.subjects?.length) {
      const chips = el("div", "subjects");
      for (const subject of row.subjects) chips.append(pill(`${subject.entity_name} · ${subject.role}`));
      causeCell.append(chips);
    }
    const statusCell = el("td");
    statusCell.append(el("span", `status ${row.status}`, row.status));
    const noteCell = el("td");
    noteCell.append(el("div", "note", row.note || row.statement || ""));
    if (row.exhibit_ids?.length) noteCell.append(el("div", "ids", row.exhibit_ids.join(" · ")));
    tr.append(causeCell, statusCell, el("td", "mono", row.share === undefined ? "—" : pct(row.share)), noteCell);
    tbody.append(tr);
  }
  table.append(head, tbody);
  body.append(table);
}

/* ------------------------------------------------------- repair/writeback */

function checks(list) {
  const node = el("div", "check-list");
  for (const check of list) {
    const row = el("div", `check ${check.ok ? "ok" : ""}`);
    const text = el("div");
    text.append(el("div", "name", check.name), el("div", "detail", check.detail));
    row.append(el("span", "dot"), text);
    node.append(row);
  }
  return node;
}

function kv(pairs) {
  const node = el("dl", "kv");
  for (const [key, value] of pairs) node.append(el("dt", "", key), el("dd", "", value));
  return node;
}

function renderRepair(s) {
  const body = $("repair-body");
  body.replaceChildren();
  if (!s.repair) {
    body.append(el("div", "empty", s.verdict ? "No artifact share: nothing to repair." : "Not adjudicated yet."));
    return;
  }
  body.append(
    kv([
      ["shadow view", s.repair.shadow_metric],
      ["corrected view", s.repair.corrected_metric],
      ["rule", "one annual fact per (cik, period_end), last filed wins"],
      ["shadow contract", s.contract ? `${s.contract.id} · scope ${s.contract.scope.join(", ")} · approved ${s.contract.approved ? "yes" : "no (shadow only)"}` : "none"],
    ]),
  );
  if (s.verification) {
    body.append(el("div", "section-label", `shadow verifier · ${s.verification.invariants.filter((i) => i.ok).length}/${s.verification.invariants.length} invariants`));
    body.append(checks(s.verification.invariants));
  }
  if (s.repair.corrected_sql) {
    const details = el("details", "statements");
    details.append(el("summary", "", "corrected view SQL"));
    details.append(el("pre", "", s.repair.corrected_sql));
    body.append(details);
  }
}

function renderWriteback(s) {
  const body = $("writeback-body");
  body.replaceChildren();
  const contract = s.write_contract;
  const writeback = s.writeback;
  body.append(
    kv([
      ["stage", s.stage.replaceAll("_", " ")],
      ["final contract", contract ? `${contract.id} · ${contract.statements.length} signed statements` : "none"],
      ["approved", contract?.approved ? `yes · ${contract.approved_by || "operator"}` : "no"],
      ["result", writeback ? (writeback.ok ? `verified ${writeback.checks.filter((c) => c.ok).length}/${writeback.checks.length}` : "failed") : "not written"],
      ["catalog memory", writeback?.memory_note || "—"],
    ]),
  );
  if (!contract) {
    const note = el("div", "empty");
    note.append(document.createTextNode("Approval is a deliberate CLI action: "));
    note.append(el("code", "", `npm run cli -- approve ${s.id}`));
    body.append(note);
    return;
  }
  if (writeback?.checks?.length) {
    body.append(el("div", "section-label", "verify-after-write · separate Zetaris session"));
    body.append(checks(writeback.checks));
  }
  const details = el("details", "statements");
  details.append(el("summary", "", `signed statements (${contract.statements.length})`));
  details.append(el("pre", "", contract.statements.join("\n\n")));
  body.append(details);
}

/* ---------------------------------------------------------------- lineage */

function shortLabel(value, max = 36) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderLineage(graph) {
  const body = $("lineage-body");
  body.replaceChildren();
  if (!graph) {
    body.append(el("div", "empty", "No World Model graph recorded for this case."));
    return;
  }
  const sources = graph.sources || [];
  const columns = graph.columns || [];
  if (!sources.length && !columns.length) {
    body.append(el("div", "empty", "The World Model graph is empty."));
    return;
  }
  const positions = new Map();
  const sourceX = 16;
  const columnX = 300;
  const viewX = 640;
  sources.forEach((source, index) => positions.set(source.source_table, { x: sourceX, y: 36 + index * 32, w: 240, h: 22 }));
  const uniqueColumns = [];
  for (const column of columns) {
    const key = `${column.source_table}.${column.source_column}`;
    if (!uniqueColumns.includes(key)) uniqueColumns.push(key);
  }
  uniqueColumns.forEach((key, index) => positions.set(key, { x: columnX, y: 36 + index * 28, w: 290, h: 20 }));
  const height = Math.max(200, ...Array.from(positions.values()).map((p) => p.y + 44));
  positions.set(graph.view, { x: viewX, y: Math.max(36, height / 2 - 40), w: 220, h: 28, view: true });

  const svg = svgEl("svg", { viewBox: `0 0 880 ${height}`, width: "100%", height, role: "img", "aria-label": "Lineage graph" });
  for (const [label, xPos] of [["sources", sourceX], ["columns", columnX], ["metric view", viewX]]) {
    const t = svgEl("text", { class: "col-label", x: xPos, y: 18 });
    t.textContent = label.toUpperCase();
    svg.append(t);
  }
  for (const edge of graph.edges || []) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to) ?? (edge.to.startsWith(`${graph.view}.`) ? positions.get(graph.view) : undefined);
    if (!from || !to) continue;
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const mid = (x1 + x2) / 2;
    svg.append(svgEl("path", { class: "edge", d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` }));
  }
  for (const [name, p] of positions) {
    svg.append(svgEl("rect", { class: `node ${p.view ? "view" : ""}`, x: p.x, y: p.y, width: p.w, height: p.h, rx: 5 }));
    const label = svgEl("text", { class: `node-label ${p.view ? "view" : ""}`, x: p.x + 8, y: p.y + (p.view ? 18 : 14) });
    label.textContent = shortLabel(name, p.view ? 30 : 40);
    svg.append(label);
  }
  body.append(svg);
}

/* --------------------------------------------------------------- exhibits */

function renderExhibits() {
  const list = $("exhibit-list");
  const kindSelect = $("exhibit-kind");
  const kinds = [...new Set(state.exhibits.map((exhibit) => exhibit.kind))].sort();
  const previous = kindSelect.value;
  kindSelect.replaceChildren(el("option", "", "All kinds"));
  kindSelect.firstChild.value = "";
  for (const kind of kinds) {
    const option = el("option", "", kind);
    option.value = kind;
    kindSelect.append(option);
  }
  kindSelect.value = kinds.includes(previous) ? previous : "";
  list.replaceChildren();

  const filtered = state.exhibits.filter((exhibit) => {
    if (state.kind && exhibit.kind !== state.kind) return false;
    if (!state.filter) return true;
    const haystack = `${exhibit.title} ${exhibit.tool || ""} ${exhibit.kind} ${exhibit.id} ${exhibit.result_sha256}`.toLowerCase();
    return haystack.includes(state.filter.toLowerCase());
  });
  if (!filtered.length) {
    list.append(el("div", "empty", "No exhibits match the filter."));
    return;
  }
  for (const exhibit of filtered) {
    const row = el("div", `exhibit-row ${state.selected?.id === exhibit.id ? "active" : ""}`);
    row.append(el("div", "kind", exhibit.kind));
    const main = el("div");
    main.append(el("div", "title", exhibit.title));
    main.append(el("div", "sub", `${exhibit.tool || "—"} · ${exhibit.transport} · ${shortSha(exhibit.result_sha256)}`));
    row.append(main);
    row.addEventListener("click", () => selectExhibit(exhibit));
    list.append(row);
  }
  if (!state.selected && filtered.length) selectExhibit(filtered[0]);
}

function selectExhibit(exhibit) {
  state.selected = exhibit;
  renderExhibits();
  renderExhibitDetail(exhibit);
}

function resultView(result) {
  if (result && Array.isArray(result.columns) && Array.isArray(result.rows)) {
    const wrap = el("div", "result-wrap");
    const table = el("table", "result-table");
    const head = el("thead");
    const hrow = el("tr");
    for (const column of result.columns) hrow.append(el("th", "", column));
    head.append(hrow);
    const tbody = el("tbody");
    for (const row of result.rows.slice(0, 200)) {
      const tr = el("tr");
      for (const cell of row) {
        const numeric = typeof cell === "number";
        tr.append(el("td", numeric ? "num" : "", numeric && Math.abs(cell) >= 1e6 ? cell.toLocaleString() : String(cell ?? "")));
      }
      tbody.append(tr);
    }
    table.append(head, tbody);
    wrap.append(table);
    const note = el("div", "muted", `${result.row_count ?? result.rows.length} rows${result.truncated ? " (truncated)" : ""}${result.rows.length > 200 ? " · first 200 shown" : ""}`);
    note.style.fontSize = "11.5px";
    note.style.margin = "6px 0 0";
    const box = el("div");
    box.append(wrap, note);
    return box;
  }
  return el("pre", "", JSON.stringify(result, null, 2));
}

function renderExhibitDetail(exhibit) {
  const detail = $("exhibit-detail");
  detail.replaceChildren();
  detail.append(el("h3", "", exhibit.title));
  detail.append(el("div", "sha", `${exhibit.kind} · ${exhibit.tool || "—"} · ${exhibit.agent} · ${exhibit.id} · sha256 ${exhibit.result_sha256}`));
  const actions = el("div", "detail-actions");
  const rerun = el("button", "button ghost small", "Re-run exhibit");
  rerun.type = "button";
  const result = el("span", "rerun-result", "");
  rerun.addEventListener("click", async () => {
    rerun.disabled = true;
    result.className = "rerun-result";
    result.textContent = "re-running…";
    try {
      const response = await api(
        `/api/cases/${encodeURIComponent(state.current.id)}/rerun/${encodeURIComponent(exhibit.id)}`,
        { method: "POST" },
      );
      result.classList.add(response.same ? "same" : "diff");
      result.textContent = response.same
        ? `same result via ${response.mode} (${shortSha(response.rerun_sha256)})`
        : `DRIFT via ${response.mode}: expected ${shortSha(response.expected_sha256)}, got ${shortSha(response.rerun_sha256)}`;
    } catch (error) {
      result.classList.add("diff");
      result.textContent = `error: ${error.message}`;
    } finally {
      rerun.disabled = false;
    }
  });
  const copy = el("button", "button ghost small", "Copy CLI rerun");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`npm run cli -- rerun ${exhibit.id}`);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy CLI rerun"), 1200);
    } catch {
      copy.textContent = `npm run cli -- rerun ${exhibit.id}`;
    }
  });
  actions.append(rerun, copy, result);
  detail.append(actions);
  if (exhibit.sql) {
    detail.append(el("div", "section-label", "SQL"));
    detail.append(el("pre", "", exhibit.sql));
  }
  if (exhibit.args && !(exhibit.args.sql && Object.keys(exhibit.args).length === 1)) {
    detail.append(el("div", "section-label", "arguments"));
    const args = { ...exhibit.args };
    if (typeof args.text === "string" && args.text.length > 400) args.text = `${args.text.slice(0, 400)}…`;
    detail.append(el("pre", "", JSON.stringify(args, null, 2)));
  }
  detail.append(el("div", "section-label", "result"));
  detail.append(resultView(exhibit.result));
}

/* --------------------------------------------------------------- timeline */

const AGENT_COLORS = {
  LeadInvestigator: "#15201b",
  SourceScout: "#1d4f91",
  DefenseCounsel: "#9a5b00",
  SafetyGuard: "#6b3fa0",
  RepairEngineer: "#1f7a4d",
  Verifier: "#1f7a4d",
  ScoutIntent: "#b3261e",
  Writer: "#b3261e",
  Rerun: "#6b7a72",
};

function renderTimeline(s) {
  const body = $("timeline-body");
  body.replaceChildren();
  $("timeline-hint").textContent = s.sample_mode
    ? `${state.trace.length} trace lines · emitted by code at action time · replay`
    : `${state.trace.length} trace lines · emitted by code at action time`;
  if (!state.trace.length) {
    body.append(el("div", "empty", "No trace lines recorded."));
    return;
  }
  for (const line of state.trace) {
    const row = el("div", `trace-row ${line.status === "error" ? "error" : ""}`);
    const ts = line.timestamp ? new Date(line.timestamp).toLocaleTimeString([], { hour12: false }) : "—";
    row.append(el("div", "ts", ts));
    const avatar = el("div", "avatar", (line.agent_name || "?").replace(/[a-z]/g, "").slice(0, 2));
    avatar.style.background = AGENT_COLORS[line.agent_name] || "#6b7a72";
    row.append(avatar);
    row.append(el("div", "agent", line.agent_name));
    const what = el("div", "what");
    what.append(el("div", "action", line.action));
    what.append(el("div", "summary", line.output_summary));
    const meta = [];
    if (line.model) meta.push(line.model);
    if (line.tokens_in || line.tokens_out) meta.push(`${line.tokens_in}+${line.tokens_out} tokens`);
    if (line.exhibit_ids?.length) meta.push(`${line.exhibit_ids.length} exhibit(s)`);
    if (meta.length) what.append(el("div", "meta", meta.join(" · ")));
    row.append(what);
    body.append(row);
  }
}

/* ------------------------------------------------------------------- wire */

$("refresh").addEventListener("click", async () => {
  await loadCases();
  if (state.current) await loadCase(state.current.id);
});
$("case-filter").addEventListener("input", (event) => {
  state.caseFilter = event.target.value;
  renderCaseList();
});
$("exhibit-search").addEventListener("input", (event) => {
  state.filter = event.target.value;
  renderExhibits();
});
$("exhibit-kind").addEventListener("change", (event) => {
  state.kind = event.target.value;
  renderExhibits();
});

(async () => {
  try {
    await loadCases();
    const wanted = new URLSearchParams(location.hash.replace(/^#/, "")).get("case");
    const first = state.cases.find((item) => item.id === wanted) || state.cases[0];
    if (first) await loadCase(first.id);
  } catch (error) {
    $("case-list").replaceChildren(el("div", "empty", `Could not load cases: ${error.message}`));
  }
})();

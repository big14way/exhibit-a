const STAGES = [
  "REPORTED", "SCOPING", "LINEAGE", "BASELINED", "HYPOTHESES", "EVIDENCE",
  "CRITIQUED", "ADJUDICATED", "BRIEFED", "REPAIR_PROPOSED", "SHADOW_VERIFIED",
  "AWAITING_APPROVAL", "WRITTEN", "WRITE_VERIFIED", "MEMORISED", "CLOSED", "FAILED",
];

const state = {
  cases: [],
  current: null,
  exhibits: [],
  selected: null,
  trace: [],
  graph: null,
  filter: "",
  kind: "",
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

function shortSha(value) {
  return value ? `${String(value).slice(0, 12)}…` : "—";
}

function pct(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function badge(text, className = "") {
  return el("span", `badge ${className}`.trim(), text);
}

function modeLabel(sample) {
  return sample ? "SAMPLE_MODE · replay" : "LIVE · Zetaris";
}

function setTopMode(sample) {
  const node = $("mode-badge");
  node.textContent = sample ? "SAMPLE_MODE" : "LIVE";
  node.className = `badge ${sample ? "sample" : "live"}`;
}

async function loadCases() {
  const data = await api("/api/cases");
  state.cases = data.cases || [];
  const list = $("case-list");
  list.replaceChildren();
  if (!state.cases.length) {
    list.append(el("div", "empty", "No cases yet. Run the CLI investigate command."));
    return;
  }
  for (const item of state.cases) {
    const button = el("button", "case-item");
    button.type = "button";
    button.append(el("span", "q", item.question));
    const meta = el("span", "m");
    meta.append(
      el("span", "", item.verdict || item.stage),
      el("span", "", `${item.exhibits} exhibits`),
      el("span", "", item.sample_mode ? "sample" : "live"),
    );
    button.append(meta);
    button.addEventListener("click", () => loadCase(item.id));
    if (state.current?.id === item.id) button.classList.add("active");
    list.append(button);
  }
}

async function loadCase(id) {
  const data = await api(`/api/cases/${encodeURIComponent(id)}`);
  state.current = data.state;
  state.trace = data.trace || [];
  state.graph = data.graph || null;
  state.exhibits = data.state.exhibits || [];
  state.selected = null;
  state.filter = "";
  state.kind = "";
  $("exhibit-search").value = "";
  $("empty-state").classList.add("hidden");
  $("case-view").classList.remove("hidden");
  render();
  await loadCases();
}

function render() {
  const s = state.current;
  if (!s) return;
  setTopMode(s.sample_mode);
  $("case-id").textContent = s.id;
  $("case-question").textContent = s.question;
  $("case-metric").textContent = s.metric;
  $("case-mode").textContent = modeLabel(s.sample_mode);
  $("case-mode").className = `badge ${s.sample_mode ? "sample" : "live"}`;
  $("case-stage").textContent = s.stage;
  $("case-stage").className = "badge stage";
  $("verdict-kind").textContent = s.verdict?.kind || "NOT ADJUDICATED";
  $("verdict-kind").className = `verdict-big ${s.verdict?.kind || ""}`;

  renderStages(s);
  renderVerdict(s);
  renderWriteback(s);
  renderHypotheses(s);
  renderChannels(s);
  renderLineage(state.graph);
  renderExhibits();
  renderTimeline();
}

function renderStages(s) {
  const strip = $("stage-strip");
  strip.replaceChildren();
  const currentIndex = STAGES.indexOf(s.stage);
  const failed = s.stage === "FAILED";
  STAGES.filter((stage) => stage !== "FAILED").forEach((stage, index) => {
    const step = el("span", "stage-step", stage.replaceAll("_", " "));
    if (failed && stage === "FAILED") step.classList.add("failed");
    if (index < currentIndex) step.classList.add("reached");
    if (stage === s.stage) step.classList.add("current");
    if (failed) step.classList.remove("current");
    strip.append(step);
  });
  if (failed) {
    const step = el("span", "stage-step failed", "FAILED");
    strip.append(step);
  }
}

function renderVerdict(s) {
  const body = $("verdict-body");
  body.replaceChildren();
  const verdict = s.verdict;
  if (!verdict) {
    body.append(el("div", "empty", "This case has not been adjudicated yet."));
    return;
  }
  body.append(el("div", "mono", `${verdict.kind} · unexplained ${pct(verdict.unexplained_share ?? 0)}`));
  const reasons = el("div", "verdict-reasons");
  for (const cause of verdict.causes || []) {
    const row = el("div", "cause-row");
    row.append(el("div", "name", cause.cause));
    const bar = el("div", "bar");
    const fill = el("span");
    fill.style.width = `${Math.max(0, Math.min(100, cause.share * 100))}%`;
    bar.append(fill);
    row.append(bar, el("div", "share", pct(cause.share)));
    reasons.append(row);
  }
  body.append(reasons);
  if (verdict.gate_failures?.length) {
    const list = el("div");
    for (const failure of verdict.gate_failures) {
      list.append(el("div", "failure", `${failure.rule}: ${failure.detail}`));
    }
    body.append(list);
  } else {
    body.append(el("div", "mono", "gate: pass"));
  }
  if (verdict.notes?.length) {
    const notes = el("ul", "notes");
    for (const note of verdict.notes) notes.append(el("li", "", note));
    body.append(notes);
  }
}

function renderWriteback(s) {
  const body = $("writeback-body");
  body.replaceChildren();
  const contract = s.write_contract;
  const writeback = s.writeback;
  const kv = el("dl", "kv");
  const add = (key, value) => {
    kv.append(el("dt", "", key), el("dd", "", value));
  };
  add("stage", s.stage);
  add("contract", contract?.id || "none");
  add("approved", contract?.approved ? "yes (operator)" : "no");
  add("statements", contract?.statements?.length ?? 0);
  add("result", writeback ? (writeback.ok ? "verified" : "failed") : "not written");
  add("memory note", writeback?.memory_note || "—");
  body.append(kv);

  if (!contract) {
    body.append(el("div", "empty", `Approval is a deliberate CLI action: npm run cli -- approve ${s.id}`));
    return;
  }
  if (writeback?.checks?.length) {
    const list = el("div", "check-list");
    for (const check of writeback.checks) {
      const row = el("div", `check ${check.ok ? "ok" : ""}`);
      row.append(el("span", "dot"), el("span", "name", check.name), el("span", "", check.detail));
      list.append(row);
    }
    body.append(list);
  }
  body.append(el("div", "empty", "The viewer is read-only for writes; approval and writeback stay in the CLI."));
}

function renderHypotheses(s) {
  const body = $("hypotheses-body");
  body.replaceChildren();
  if (!s.hypotheses?.length) {
    body.append(el("div", "empty", "No hypotheses recorded."));
    return;
  }
  const table = el("table");
  const head = el("thead");
  const hrow = el("tr");
  for (const label of ["cause", "status", "share", "note"]) hrow.append(el("th", "", label));
  head.append(hrow);
  const tbody = el("tbody");
  for (const row of s.hypotheses) {
    const tr = el("tr");
    tr.append(
      el("td", "mono", row.cause),
      el("td", "", ""),
      el("td", "mono", row.share === undefined ? "—" : pct(row.share)),
      el("td", "muted", row.note || row.statement || ""),
    );
    const statusCell = tr.children[1];
    statusCell.append(el("span", `status ${row.status}`, row.status));
    tbody.append(tr);
  }
  table.append(head, tbody);
  body.append(table);
}

function channel(title, detail, className = "") {
  const node = el("div", `channel ${className}`.trim());
  node.append(el("div", "title", title), el("div", "detail", detail));
  return node;
}

function renderChannels(s) {
  const body = $("channels-body");
  body.replaceChildren();
  if (s.memory) {
    body.append(
      channel(
        "H-MEM recall",
        `${s.memory.cold_start ? "cold start" : `${s.memory.hits.length} hit(s)`} · ${s.memory.records} record(s) · ${s.memory.audit?.valid ?? 0} valid`,
      ),
    );
  }
  if (s.discovery) {
    body.append(
      channel(
        "Scout source discovery",
        `${s.discovery.current_concept} → ${s.discovery.replacement_concept || "no replacement"} · ${s.discovery.candidates?.length ?? 0} candidates · ${s.discovery.peers?.length ?? 0} peers`,
      ),
    );
  }
  if (s.critic) {
    body.append(
      channel(
        "Defense Counsel critic",
        `${s.critic.status}${s.critic.model ? ` · ${s.critic.model}` : ""} · ${s.critic.objections?.length ?? 0} objection(s) · ${s.critic.cited_unknown?.length ?? 0} unknown citation(s) · ${s.critic.usage?.prompt_tokens ?? 0}+${s.critic.usage?.completion_tokens ?? 0} tokens`,
      ),
    );
  }
  if (s.safety) {
    body.append(
      channel(
        "Content safety",
        `${s.safety.ok ? "pass" : "blocked"} · ${s.safety.policy} · ${s.safety.findings?.length ?? 0} finding(s)`,
      ),
    );
  }
  if (s.hmem) {
    body.append(
      channel("H-MEM persistence", `${s.hmem.record_id} · ${s.hmem.valid} valid · ${s.hmem.malformed} malformed`),
    );
  }
  if (!body.children.length) body.append(el("div", "empty", "No auxiliary channels recorded."));
}

function shortLabel(value, max = 34) {
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
  const nodes = graph.nodes || [];
  if (!nodes.length && !sources.length && !columns.length) {
    body.append(el("div", "empty", "The World Model graph is empty."));
    return;
  }
  const positions = new Map();
  const sourceX = 24;
  const columnX = 280;
  const viewX = 590;
  sources.forEach((source, index) => {
    positions.set(source.source_table, { x: sourceX, y: 34 + index * 34, w: 220, h: 22 });
  });
  const uniqueColumns = [];
  for (const column of columns) {
    const key = `${column.source_table}.${column.source_column}`;
    if (!uniqueColumns.includes(key)) uniqueColumns.push(key);
  }
  uniqueColumns.forEach((key, index) => {
    positions.set(key, { x: columnX, y: 34 + index * 30, w: 250, h: 20 });
  });
  const view = graph.view;
  positions.set(view, { x: viewX, y: 34, w: 160, h: 26 });
  const height = Math.max(
    180,
    ...Array.from(positions.values()).map((position) => position.y + 40),
  );
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 780 ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Lineage graph");

  for (const edge of graph.edges || []) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const mid = (x1 + x2) / 2;
    path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
    path.setAttribute("class", "edge");
    svg.append(path);
  }

  for (const [name, position] of positions) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(position.x));
    rect.setAttribute("y", String(position.y));
    rect.setAttribute("width", String(position.w));
    rect.setAttribute("height", String(position.h));
    rect.setAttribute("rx", "5");
    rect.setAttribute("class", "node");
    svg.append(rect);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(position.x + 8));
    label.setAttribute("y", String(position.y + 14));
    label.setAttribute("class", "node-label");
    label.textContent = shortLabel(name);
    svg.append(label);
  }
  body.append(svg);
}

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
    const haystack = `${exhibit.title} ${exhibit.tool || ""} ${exhibit.kind} ${exhibit.result_sha256}`.toLowerCase();
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
    main.append(el("div", "sub", `${exhibit.tool || "—"} · ${shortSha(exhibit.result_sha256)}`));
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

function renderExhibitDetail(exhibit) {
  const detail = $("exhibit-detail");
  detail.replaceChildren();
  detail.append(el("h3", "", exhibit.title));
  detail.append(el("div", "sha", `${exhibit.kind} · ${exhibit.tool || "—"} · ${exhibit.id} · sha256 ${exhibit.result_sha256}`));
  const actions = el("div", "detail-actions");
  const rerun = el("button", "button ghost", "Rerun exhibit");
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
        ? `same result (${shortSha(response.rerun_sha256)})`
        : `DRIFT expected ${shortSha(response.expected_sha256)} got ${shortSha(response.rerun_sha256)}`;
    } catch (error) {
      result.classList.add("diff");
      result.textContent = `error: ${error.message}`;
    } finally {
      rerun.disabled = false;
    }
  });
  actions.append(rerun, result);
  detail.append(actions);
  if (exhibit.sql) {
    detail.append(el("div", "mono muted", "SQL"));
    detail.append(el("pre", "", exhibit.sql));
  }
  if (exhibit.args) {
    detail.append(el("div", "mono muted", "args"));
    detail.append(el("pre", "", JSON.stringify(exhibit.args, null, 2)));
  }
  detail.append(el("div", "mono muted", "result"));
  detail.append(el("pre", "", JSON.stringify(exhibit.result, null, 2)));
}

function renderTimeline() {
  const body = $("timeline-body");
  body.replaceChildren();
  if (!state.trace.length) {
    body.append(el("div", "empty", "No trace lines recorded."));
    return;
  }
  for (const line of state.trace) {
    const row = el("div", `trace-row ${line.status === "error" ? "error" : ""}`);
    const ts = line.timestamp ? new Date(line.timestamp).toLocaleTimeString() : "—";
    row.append(el("div", "ts", ts));
    row.append(el("div", "agent", line.agent_name));
    const what = el("div", "what");
    what.append(el("div", "action", line.action));
    what.append(el("div", "summary", line.output_summary));
    row.append(what);
    body.append(row);
  }
}

$("refresh").addEventListener("click", async () => {
  await loadCases();
  if (state.current) await loadCase(state.current.id);
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
    if (state.cases.length) await loadCase(state.cases[0].id);
  } catch (error) {
    $("case-list").replaceChildren(el("div", "empty", `Could not load cases: ${error.message}`));
  }
})();

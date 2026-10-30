import type { ReportModel, Span } from "./model.js";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
const secs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/** Categorical slots in fixed order, one per role (light / dark). */
const ROLE_SLOT: Record<string, number> = { builder: 1, "test-author": 2, reviewer: 3, architect: 4, analyst: 5, arbiter: 6, utility: 7 };

const GRAIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`);

function niceStep(ms: number): number {
  const target = ms / 8;
  for (const s of [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]) if (s >= target) return s;
  return 900_000;
}

function timeline(m: ReportModel): string {
  const W = 1040;
  const LABEL = 150;
  const LANE = 30;
  const TOP = 26;
  const TEST_ROW = 34;
  const plotW = W - LABEL - 16;
  const span = Math.max(1, m.run.end - m.run.start);
  const x = (t: number) => LABEL + ((t - m.run.start) / span) * plotW;
  const laneY = new Map(m.lanes.map((l, i) => [l.lane, TOP + i * LANE]));
  const H = TOP + m.lanes.length * LANE + TEST_ROW + 18;
  const step = niceStep(span);
  const ticks: string[] = [];
  for (let t = 0; t <= span; t += step) {
    const px = x(m.run.start + t);
    ticks.push(`<line x1="${px}" x2="${px}" y1="${TOP - 6}" y2="${H - 18}" class="grid"/><text x="${px}" y="14" class="tick">${secs(t)}</text>`);
  }
  const bar = (s: Span) => {
    const x0 = x(s.start);
    const w = Math.max(3, x(s.end) - x0);
    const y = laneY.get(s.lane)! + 7;
    const tip = `${s.lane}${s.taskId ? ` · ${s.taskId}` : ""} · ${s.role}\n${s.model} · ${secs(s.end - s.start)} · ${usd(s.costUsd)} · ${s.calls} calls${s.answer ? `\n“${s.answer.slice(0, 140)}”` : ""}`;
    return `<rect x="${x0}" y="${y}" width="${w}" height="16" rx="4" class="span s${ROLE_SLOT[s.role] ?? 7}" data-tip="${esc(tip)}"/>${w > 46 && s.taskId ? `<text x="${x0 + 6}" y="${y + 12}" class="in">${esc(s.taskId)}</text>` : ""}`;
  };
  const laneRows = m.lanes
    .map((l) => {
      const y = laneY.get(l.lane)!;
      return `<g><text x="${LABEL - 12}" y="${y + 19}" class="lane">${esc(l.lane)}</text><line x1="${LABEL}" x2="${W - 16}" y1="${y + LANE}" y2="${y + LANE}" class="hair"/>${l.spans.map(bar).join("")}</g>`;
    })
    .join("");
  const laneOf = (who: string) => laneY.get(who.split("(")[0]);
  const stale = m.stale
    .map((s) => {
      const y = laneOf(s.who);
      if (y === undefined) return "";
      const px = x(s.t);
      return `<g class="mark" data-tip="${esc(`STALE write refused\n${s.who} wrote ${s.path} from v${s.seen ?? "—"}; ${s.currentAuthor} had made it v${s.current}.\nThe agent re-read and re-applied.`)}"><circle cx="${px}" cy="${y + 15}" r="8" class="ring"/><path d="M${px - 1.5} ${y + 9} l-3.5 7 h4 l-1.5 6 l6 -8 h-4 l1.5 -5 z" class="bolt"/></g>`;
    })
    .join("");
  const gates = m.gates
    .map((g) => {
      const y = laneOf(g.who);
      if (y === undefined) return "";
      const px = x(g.t);
      return `<path d="M${px} ${y + 4} l5 8 h-10 z" class="gatemark" data-tip="${esc(`gate refused ${g.tool} [${g.rule}]\n${g.message}`)}"/>`;
    })
    .join("");
  const ty = TOP + m.lanes.length * LANE + 10;
  const tests = m.tests
    .map((r) => {
      const px = x(r.t);
      const ok = r.fail === 0 && r.tscErrors === 0;
      return `<g class="mark" data-tip="${esc(`tests at rev ${r.rev}: ${r.pass} pass, ${r.fail} failing, ${r.tscErrors} type errors`)}"><circle cx="${px}" cy="${ty + 10}" r="6" class="${ok ? "good" : "bad"}"/><text x="${px}" y="${ty + 28}" class="tick">${ok ? "✓" : `${r.fail}✗`}</text></g>`;
    })
    .join("");
  return `<svg class="tl" viewBox="0 0 ${W} ${H}" role="img" aria-label="Timeline of every agent in the run">
${ticks.join("")}${laneRows}
<text x="${LABEL - 12}" y="${ty + 14}" class="lane">verifier</text>${tests}${gates}${stale}
</svg>`;
}

function bars(rows: [string, number][], cls = "s1"): string {
  const max = Math.max(...rows.map((r) => r[1]), 1e-9);
  return rows
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<div class="hbar"><span class="k">${esc(k)}</span><span class="track"><span class="fill ${cls}" style="width:${Math.max(1.5, (v / max) * 100)}%"></span></span><span class="v">${usd(v)}</span></div>`)
    .join("");
}

export function renderHtml(m: ReportModel): string {
  const r = m.run;
  const status = r.green === null ? "no release check" : r.green ? "Green" : "Incomplete";
  const statusIcon = r.green ? "✓" : r.green === false ? "!" : "·";
  const tiles: [string, string][] = [
    ["wall time", secs(r.wallMs)],
    ["model cost", usd(r.costUsd)],
    ["agents", String(r.agents)],
    ["peak concurrent", String(r.peakConcurrency)],
    ["stale writes caught", String(r.staleRefusals)],
    ["gate refusals", String(r.gateRefusals)],
    ["human steps", String(r.humanSteps)],
  ];
  const roles = Object.entries(ROLE_SLOT).filter(([role]) => m.lanes.some((l) => l.spans.some((s) => s.role === role)));
  const reqStatus = (s: string) => (s === "pass" ? `<span class="st good">✓ pass</span>` : s === "fail" ? `<span class="st bad">✗ fail</span>` : `<span class="st muted">${esc(s)}</span>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)} · grout run</title>
<style>
:root{color-scheme:light;--ground:#f3f2ee;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--hair:rgba(11,11,11,.09);--gridbg:rgba(11,11,11,.045);--grid:#e1e0d9;--accent:#eb6834;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--good:#0ca30c;--bad:#d03b3b;}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--ground:#0c0d0c;--surface:#151615;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--hair:rgba(255,255,255,.08);--gridbg:rgba(255,255,255,.035);--grid:#2c2c2a;--accent:#d95926;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;}}
:root[data-theme="dark"]{color-scheme:dark;--ground:#0c0d0c;--surface:#151615;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--hair:rgba(255,255,255,.08);--gridbg:rgba(255,255,255,.035);--grid:#2c2c2a;--accent:#d95926;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
background-image:radial-gradient(60rem 30rem at 85% -10%,color-mix(in oklab,var(--s1) 14%,transparent),transparent 70%),radial-gradient(40rem 26rem at -5% 30%,color-mix(in oklab,var(--accent) 9%,transparent),transparent 70%),linear-gradient(var(--gridbg) 1px,transparent 1px),linear-gradient(90deg,var(--gridbg) 1px,transparent 1px);
background-size:auto,auto,64px 64px,64px 64px;min-height:100vh}
body::after{content:"";position:fixed;inset:0;pointer-events:none;background:url("${GRAIN}");opacity:.06;mix-blend-mode:multiply}
main{max-width:1120px;margin:0 auto;padding:56px 16px 96px}
.eyebrow{font:500 12px/1 ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1{font-weight:500;font-size:clamp(40px,7vw,84px);letter-spacing:-.045em;line-height:.98;margin:14px 0 18px}
h2{font-weight:550;font-size:22px;letter-spacing:-.02em;margin:56px 0 14px}
.status{display:inline-flex;gap:8px;align-items:center;padding:6px 12px;border-radius:999px;border:1px solid var(--hair);background:var(--surface);font-weight:550}
.status i{font-style:normal;display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;color:#fff;font-size:12px;background:${r.green ? "var(--good)" : "var(--bad)"}}
.sub{color:var(--ink2);max-width:62ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;background:var(--hair);border:1px solid var(--hair);border-radius:14px;overflow:hidden;margin-top:28px}
.tile{background:var(--surface);padding:16px 18px}.tile b{display:block;font-weight:500;font-size:28px;letter-spacing:-.03em}.tile span{color:var(--muted);font-size:12.5px}
.card{background:var(--surface);border:1px solid var(--hair);border-radius:14px;padding:18px 18px 10px;overflow-x:auto}
svg.tl{width:100%;min-width:720px;height:auto;display:block}.legend svg{width:auto;height:14px}
svg .grid{stroke:var(--grid);stroke-width:1}svg .hair{stroke:var(--hair)}
svg .tick{fill:var(--muted);font:11px ui-monospace,Consolas,monospace;text-anchor:middle}
svg .lane{fill:var(--ink2);font:12.5px ui-monospace,Consolas,monospace;text-anchor:end}
svg .span{stroke:var(--surface);stroke-width:2}svg .in{fill:#fff;font:600 10.5px ui-monospace,Consolas,monospace;pointer-events:none}
${[1, 2, 3, 4, 5, 6, 7].map((i) => `svg .s${i},.fill.s${i},.key.s${i}{fill:var(--s${i});background:var(--s${i})}`).join("")}
svg .ring{fill:var(--surface);stroke:var(--accent);stroke-width:2}svg .bolt{fill:var(--accent)}
svg .gatemark{fill:var(--ink2);stroke:var(--surface);stroke-width:1.5}
svg .good{fill:var(--good);stroke:var(--surface);stroke-width:2}svg .bad{fill:var(--bad);stroke:var(--surface);stroke-width:2}
svg [data-tip]{cursor:default}svg [data-tip]:hover{filter:brightness(1.12)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--ink2);margin:10px 0 4px}.legend span{display:inline-flex;align-items:center;gap:6px}
.key{width:12px;height:12px;border-radius:3px;display:inline-block}
.tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--surface);padding:8px 10px;border-radius:8px;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;max-width:380px;opacity:0;transition:opacity .12s}
table{width:100%;border-collapse:collapse;font-size:14px}th{font-weight:500;color:var(--muted);text-align:left;font-size:12px;letter-spacing:.04em;text-transform:uppercase}
td,th{padding:9px 10px;border-bottom:1px solid var(--hair);vertical-align:top}td.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.st{white-space:nowrap;font-weight:550}.st.good{color:var(--good)}.st.bad{color:var(--bad)}.st.muted{color:var(--muted);font-weight:450}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:760px){.cols{grid-template-columns:1fr}}
.hbar{display:grid;grid-template-columns:110px 1fr 70px;gap:10px;align-items:center;font-size:13px;margin:8px 0}.hbar .k{color:var(--ink2)}.hbar .v{text-align:right;font-variant-numeric:tabular-nums}
.track{height:12px;background:color-mix(in oklab,var(--grid) 60%,transparent);border-radius:4px;overflow:hidden}.fill{display:block;height:100%;border-radius:0 4px 4px 0}
.log li{margin:6px 0;color:var(--ink2)}.log b{color:var(--ink);font-weight:550}
@media (prefers-reduced-motion:reduce){.tip{transition:none}}
</style></head>
<body><main>
<div class="eyebrow">grout · run ${esc(r.runId)} · ${esc(r.mode)}</div>
<h1>${esc(r.title || "Run report")}</h1>
<p><span class="status"><i>${statusIcon}</i>${status}</span></p>
<p class="sub">${r.agents} agents worked on one shared, versioned codebase. Every write was a compare-and-swap checked by the gate before it reached the workspace; every failure went back to the task that owned it.</p>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>

<h2>Who worked when</h2>
<div class="card">
<div class="legend">${roles.map(([role, i]) => `<span><i class="key s${i}"></i>${esc(role)}</span>`).join("")}<span><svg width="16" height="16" viewBox="0 0 16 16" style="min-width:0"><circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>stale write refused</span><span><svg width="14" height="12" viewBox="0 0 14 12" style="min-width:0"><path d="M7 1 l6 10 h-12 z" fill="var(--ink2)"/></svg>gate refusal</span><span>● test run (✓ green, n✗ failing)</span></div>
${timeline(m)}
</div>

<h2>Tasks: time and cost</h2>
<div class="card"><table>
<thead><tr><th>task</th><th>title</th><th>status</th><th class="num">attempts</th><th class="num">time</th><th class="num">cost</th><th>sent back because</th></tr></thead>
<tbody>${m.tasks
    .map(
      (t) =>
        `<tr><td class="mono">${esc(t.taskId)}</td><td>${esc(t.title)}</td><td>${t.status === "approved" ? `<span class="st good">✓ approved</span>` : `<span class="st bad">! open</span>`}</td><td class="num">${t.attempts}</td><td class="num">${t.ms !== undefined ? secs(t.ms) : "—"}</td><td class="num">${usd(t.costUsd)}</td><td>${t.reopens.map((x) => esc(x.slice(0, 120))).join("<br>") || "—"}</td></tr>`,
    )
    .join("")}</tbody></table></div>

<div class="cols">
<div><h2>Cost by role</h2><div class="card">${bars(Object.entries(m.costByRole))}</div></div>
<div><h2>Cost by model</h2><div class="card">${bars(Object.entries(m.costByModel))}</div></div>
</div>

<h2>Requirements</h2>
<div class="card"><table><thead><tr><th>id</th><th>requirement</th><th>kind</th><th>status</th></tr></thead>
<tbody>${m.requirements.map((q) => `<tr><td class="mono">${esc(q.id)}</td><td>${esc(q.statement)}</td><td class="mono">${esc(q.kind)}</td><td>${reqStatus(q.status)}</td></tr>`).join("")}</tbody></table></div>

<h2>Every refusal</h2>
<div class="card"><table><thead><tr><th class="num">at</th><th>agent</th><th>what</th><th>rule / detail</th></tr></thead>
<tbody>${[
    ...m.stale.map((s) => ({ t: s.t, who: s.who, what: `write ${s.path}`, detail: `stale: read v${s.seen ?? "—"}, file was v${s.current} (by ${s.currentAuthor}); re-applied` })),
    ...m.gates.map((g) => ({ t: g.t, who: g.who, what: g.tool, detail: `[${g.rule}] ${g.message}` })),
  ]
    .sort((a, b) => a.t - b.t)
    .map((x) => `<tr><td class="num mono">${secs(x.t - r.start)}</td><td class="mono">${esc(x.who)}</td><td class="mono">${esc(x.what)}</td><td>${esc(x.detail.slice(0, 220))}</td></tr>`)
    .join("") || `<tr><td colspan="4">No refusals in this run.</td></tr>`}</tbody></table></div>

<h2>Recoveries and messages</h2>
<div class="card"><ul class="log">${m.events.map((e) => `<li><span class="mono">${secs(e.t - r.start)}</span> · <b>${esc(e.kind)}</b> · ${esc(e.detail.slice(0, 200))}</li>`).join("") || "<li>None.</li>"}</ul></div>

<p class="sub" style="margin-top:40px">${r.llmCalls} model calls · ${r.inputTokens.toLocaleString("en")} input / ${r.outputTokens.toLocaleString("en")} output tokens · costs are the provider's own per-call figures where it reports them.</p>
</main>
<div class="tip" id="tip"></div>
<script>
const tip=document.getElementById("tip");
document.addEventListener("mousemove",e=>{const el=e.target.closest&&e.target.closest("[data-tip]");if(!el){tip.style.opacity=0;return;}tip.textContent=el.getAttribute("data-tip");tip.style.opacity=1;const x=Math.min(e.clientX+14,innerWidth-tip.offsetWidth-8);tip.style.left=x+"px";tip.style.top=(e.clientY+16)+"px";});
</script>
</body></html>`;
}

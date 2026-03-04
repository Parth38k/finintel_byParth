// FinIntel — vanilla JS (no frameworks), GitHub Pages-friendly.
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const CONFIG = {
  // Set true to use TradingView real-time widget for indices ticker (recommended for "live" on static sites).
  USE_TRADINGVIEW_TICKER: true,

  // Optional: if you provide a CORS-friendly JSON endpoint for indices, you can use the custom ticker instead.
  CUSTOM_TICKER_SOURCE: "./data/indices.json",

  // Core datasets (static JSON; can be refreshed by GitHub Actions or committed manually)
  STOCKS_SOURCE: "./data/stocks.sample.json",
  FUNDS_SOURCE: "./data/funds.sample.json",
  BENCHMARKS_SOURCE: "./data/benchmarks.sample.json",

  // News RSS feeds (fetched via CORS proxy; can be changed in ./data/news_sources.json)
  NEWS_SOURCES: "./data/news_sources.json",

  // Public CORS proxy (free, but not guaranteed forever). You can self-host a proxy if needed.
  CORS_PROXY: "https://api.allorigins.win/raw?url=",

  // Claude Sonnet (Anthropic Messages API)
  ANTHROPIC_API: "https://api.anthropic.com/v1/messages",
  ANTHROPIC_MODEL: "claude-3-5-sonnet-20241022" // update if you want newer
};

const state = {
  theme: localStorage.getItem("fi:theme") || "dark",
  stocks: [],
  funds: [],
  benchmarks: {},
  newsSources: null,
  newsItems: [],
  stockPage: 1,
  fundPage: 1,
  pageSize: 50,
  activeNewsCat: "All"
};

// ---------- Utilities ----------
function fmt(n, d=2){
  if(n === null || n === undefined || Number.isNaN(+n)) return "—";
  return (+n).toFixed(d);
}
function fmtInt(n){
  if(n === null || n === undefined || Number.isNaN(+n)) return "—";
  return Intl.NumberFormat("en-IN").format(Math.round(+n));
}
function pctClass(v){
  if(v === null || v === undefined || Number.isNaN(+v)) return "";
  return (+v) >= 0 ? "pos" : "neg";
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function parseRss(xmlText){
  // Minimal RSS/Atom parser (works best with standard RSS items).
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "text/xml");
  const items = Array.from(xml.querySelectorAll("item")).slice(0, 60);
  if(items.length){
    return items.map(it => ({
      title: it.querySelector("title")?.textContent?.trim() || "",
      link: it.querySelector("link")?.textContent?.trim() || "",
      pubDate: it.querySelector("pubDate")?.textContent?.trim() || "",
      description: (it.querySelector("description")?.textContent || "").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim()
    }));
  }
  // Atom fallback
  const entries = Array.from(xml.querySelectorAll("entry")).slice(0, 60);
  return entries.map(en => ({
    title: en.querySelector("title")?.textContent?.trim() || "",
    link: en.querySelector("link")?.getAttribute("href") || "",
    pubDate: en.querySelector("updated")?.textContent?.trim() || en.querySelector("published")?.textContent?.trim() || "",
    description: (en.querySelector("summary")?.textContent || "").replace(/\s+/g," ").trim()
  }));
}
function toIsoGuess(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr);
  if(!Number.isNaN(+d)) return d.toISOString();
  return null;
}
function signalBadge(signal){
  const s = (signal || "WATCH").toUpperCase();
  const cls = s === "BUY" ? "buy" : (s === "HOLD" ? "hold" : "watch");
  return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
}
function riskBadge(grade){
  const g = (grade || "C").toUpperCase();
  const txt = g === "A" ? "A (Low)" : g === "B" ? "B" : g === "D" ? "D (High)" : "C";
  return `<span class="badge watch">${escapeHtml(txt)}</span>`;
}

// ---------- Theme ----------
function applyTheme(){
  // This UI is designed as dark-first; theme toggle is included for future extension.
  document.documentElement.dataset.theme = state.theme;
  $("#themeIcon").textContent = state.theme === "dark" ? "☾" : "☀";
  localStorage.setItem("fi:theme", state.theme);
}
$("#btnTheme").addEventListener("click", () => {
  state.theme = "dark"; // keep dark (premium green look)
  applyTheme();
});

// ---------- TradingView ticker ----------
function initTradingViewTicker(){
  if(!CONFIG.USE_TRADINGVIEW_TICKER) return;
  $("#tvTickerWrap").classList.remove("hidden");
  $("#customTickerWrap").classList.add("hidden");

  // TradingView widget script injection
  const script = document.createElement("script");
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js";
  script.async = true;
  script.innerHTML = JSON.stringify({
    symbols: [
      { proName: "NSE:NIFTY", title: "Nifty 50" },
      { proName: "BSE:SENSEX", title: "Sensex" },
      { proName: "NSE:BANKNIFTY", title: "Bank Nifty" },
      { proName: "NSE:NIFTYIT", title: "Nifty IT" },
      { proName: "NSE:NIFTYPHARMA", title: "Nifty Pharma" },
      { proName: "NSE:NIFTYMIDCAP150", title: "Midcap 150" }
    ],
    showSymbolLogo: true,
    isTransparent: true,
    displayMode: "adaptive",
    colorTheme: "dark",
    locale: "en"
  });
  const host = $("#tvTicker");
  host.innerHTML = "";
  host.appendChild(script);
}

// ---------- Data loading ----------
async function loadJson(url){
  const r = await fetch(url, { cache: "no-store" });
  if(!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}
async function loadCoreData(){
  const [stocks, funds, benchmarks, sources] = await Promise.all([
    loadJson(CONFIG.STOCKS_SOURCE),
    loadJson(CONFIG.FUNDS_SOURCE),
    loadJson(CONFIG.BENCHMARKS_SOURCE),
    loadJson(CONFIG.NEWS_SOURCES),
  ]);
  state.stocks = stocks?.data || [];
  state.funds = funds?.data || [];
  state.benchmarks = benchmarks?.data || {};
  state.newsSources = sources;

  $("#dataStatus").textContent = `Data: stocks ${state.stocks.length} • funds ${state.funds.length}`;
  $("#statUniverse").textContent = fmtInt(state.stocks.length + state.funds.length);

  // Benchmarks dropdown
  const benchSel = $("#benchmarkSelect");
  benchSel.innerHTML = "";
  const keys = Object.keys(state.benchmarks);
  keys.forEach((k,i) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = state.benchmarks[k].label || k;
    if(i===0) opt.selected = true;
    benchSel.appendChild(opt);
  });
}

// ---------- Stocks screener ----------
function computeSignal(stock){
  // Lightweight local "AI-like" rules; replace with your model outputs in data if desired.
  // Inputs: pe, ret1m, mcapCr, chgPct.
  const pe = +stock.pe;
  const r1m = +stock.ret1m;
  const day = +stock.chgPct;
  if(Number.isFinite(r1m) && r1m > 6 && Number.isFinite(day) && day > -1) return "BUY";
  if(Number.isFinite(r1m) && r1m > 0) return "HOLD";
  return "WATCH";
}

function buildSectorOptions(){
  const sel = $("#sectorFilter");
  const sectors = new Set(state.stocks.map(s => s.sector).filter(Boolean));
  const list = ["", ...Array.from(sectors).sort((a,b)=>a.localeCompare(b))];
  sel.innerHTML = "";
  list.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v || "All";
    sel.appendChild(opt);
  });
}

function applyStockFilters(){
  const q = $("#stockSearch").value.trim().toLowerCase();
  const sector = $("#sectorFilter").value;
  const signal = $("#signalFilter").value;

  let rows = state.stocks.slice();

  rows.forEach(s => { if(!s.signal) s.signal = computeSignal(s); });

  if(q){
    rows = rows.filter(s =>
      (s.symbol||"").toLowerCase().includes(q) ||
      (s.name||"").toLowerCase().includes(q)
    );
  }
  if(sector) rows = rows.filter(s => s.sector === sector);
  if(signal) rows = rows.filter(s => (s.signal||"").toUpperCase() === signal);

  const [col, dir] = $("#stockSort").value.split(":");
  rows.sort((a,b)=>{
    const va = +a[col]; const vb = +b[col];
    const aa = Number.isFinite(va) ? va : -Infinity;
    const bb = Number.isFinite(vb) ? vb : -Infinity;
    return dir === "asc" ? aa - bb : bb - aa;
  });

  return rows;
}

function renderStocks(){
  const rows = applyStockFilters();
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.stockPage = Math.min(state.stockPage, pages);

  const start = (state.stockPage - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  const tbody = $("#stocksTbody");
  tbody.innerHTML = pageRows.map(s => {
    const day = +s.chgPct;
    const sig = (s.signal || computeSignal(s)).toUpperCase();
    return `<tr data-type="stock" data-id="${escapeHtml(s.symbol)}">
      <td><div class="rowTitle">${escapeHtml(s.name || s.symbol)}</div><div class="muted">${escapeHtml(s.symbol)}</div></td>
      <td>${escapeHtml(s.sector || "—")}</td>
      <td class="num">${fmt(s.price, 2)}</td>
      <td class="num ${pctClass(day)}">${fmt(day, 2)}</td>
      <td class="num">${fmt(s.pe, 1)}</td>
      <td class="num">${fmtInt(s.mcapCr)}</td>
      <td class="num ${pctClass(s.ret1m)}">${fmt(s.ret1m, 2)}</td>
      <td>${signalBadge(sig)}</td>
      <td><button class="iconBtn" data-action="ai" type="button">Ask AI</button></td>
    </tr>`;
  }).join("");

  $("#stocksCount").textContent = `${fmtInt(total)} matches • showing ${start+1}–${Math.min(start+state.pageSize, total)}`;
  $("#stocksPage").textContent = `${state.stockPage} / ${pages}`;

  $("#stocksPrev").disabled = state.stockPage <= 1;
  $("#stocksNext").disabled = state.stockPage >= pages;
}

function wireStockControls(){
  ["stockSearch","sectorFilter","signalFilter","stockSort"].forEach(id=>{
    $("#"+id).addEventListener("input", ()=>{ state.stockPage = 1; renderStocks(); });
    $("#"+id).addEventListener("change", ()=>{ state.stockPage = 1; renderStocks(); });
  });
  $("#stocksPrev").addEventListener("click", ()=>{ state.stockPage = Math.max(1, state.stockPage-1); renderStocks(); });
  $("#stocksNext").addEventListener("click", ()=>{ state.stockPage += 1; renderStocks(); });
  $("#btnRefreshStocks").addEventListener("click", async ()=>{
    $("#dataStatus").textContent = "Data: refreshing…";
    await loadCoreData();
    buildSectorOptions();
    renderStocks();
    renderFunds();
    renderBeaters();
    $("#dataStatus").textContent = `Data: stocks ${state.stocks.length} • funds ${state.funds.length}`;
  });

  $("#btnExplainSignals").addEventListener("click", ()=>{
    addAiMsg("system", "Signals are lightweight rules (client-side) by default: BUY if 1M return > 6% and today’s move isn’t deeply negative, HOLD if 1M return > 0%, else WATCH. You can replace this with model outputs in your stocks.json or ask Claude to produce signals for a shortlist.");
  });
}

// ---------- Funds ranking ----------
function applyFundFilters(){
  const q = $("#fundSearch").value.trim().toLowerCase();
  const cat = $("#fundCategory").value;

  let rows = state.funds.slice();
  if(q){
    rows = rows.filter(f =>
      (f.name||"").toLowerCase().includes(q) ||
      (f.amc||"").toLowerCase().includes(q)
    );
  }
  if(cat) rows = rows.filter(f => f.category === cat);

  const [col, dir] = $("#fundSort").value.split(":");
  rows.sort((a,b)=>{
    const va = +a[col]; const vb = +b[col];
    const aa = Number.isFinite(va) ? va : -Infinity;
    const bb = Number.isFinite(vb) ? vb : -Infinity;
    return dir === "asc" ? aa - bb : bb - aa;
  });

  return rows;
}

function renderFunds(){
  const rows = applyFundFilters();
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.fundPage = Math.min(state.fundPage, pages);

  const start = (state.fundPage - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  const tbody = $("#fundsTbody");
  tbody.innerHTML = pageRows.map(f => {
    const rating = "★".repeat(Math.max(0, Math.min(5, Math.round(+f.rating || 0))));
    return `<tr data-type="fund" data-id="${escapeHtml(f.code)}">
      <td><div class="rowTitle">${escapeHtml(f.name)}</div><div class="muted">${escapeHtml(f.amc || "—")} • Code ${escapeHtml(f.code)}</div></td>
      <td>${escapeHtml(f.category || "—")}</td>
      <td class="num ${pctClass(f.ret1y)}">${fmt(f.ret1y, 2)}</td>
      <td class="num ${pctClass(f.cagr3y)}">${fmt(f.cagr3y, 2)}</td>
      <td class="num ${pctClass(f.cagr5y)}">${fmt(f.cagr5y, 2)}</td>
      <td class="num">${fmtInt(f.aumCr)}</td>
      <td class="num">${fmtInt(f.minSip)}</td>
      <td>${rating || "—"}</td>
      <td><button class="iconBtn" data-action="ai" type="button">Ask AI</button></td>
    </tr>`;
  }).join("");

  $("#fundsCount").textContent = `${fmtInt(total)} matches • showing ${start+1}–${Math.min(start+state.pageSize, total)}`;
  $("#fundsPage").textContent = `${state.fundPage} / ${pages}`;

  $("#fundsPrev").disabled = state.fundPage <= 1;
  $("#fundsNext").disabled = state.fundPage >= pages;
}

function wireFundControls(){
  ["fundSearch","fundCategory","fundSort"].forEach(id=>{
    $("#"+id).addEventListener("input", ()=>{ state.fundPage = 1; renderFunds(); });
    $("#"+id).addEventListener("change", ()=>{ state.fundPage = 1; renderFunds(); });
  });
  $("#fundsPrev").addEventListener("click", ()=>{ state.fundPage = Math.max(1, state.fundPage-1); renderFunds(); });
  $("#fundsNext").addEventListener("click", ()=>{ state.fundPage += 1; renderFunds(); });
  $("#btnRefreshFunds").addEventListener("click", ()=>renderFunds());
}

// ---------- Nifty-beater tracker ----------
function calcAlphaRows(){
  const benchKey = $("#benchmarkSelect").value;
  const b = state.benchmarks[benchKey];
  const bench3 = +b?.cagr3y;
  const bench5 = +b?.cagr5y;

  return state.funds.map(f => {
    const alpha3 = (Number.isFinite(+f.cagr3y) && Number.isFinite(bench3)) ? (+f.cagr3y - bench3) : null;
    const alpha5 = (Number.isFinite(+f.cagr5y) && Number.isFinite(bench5)) ? (+f.cagr5y - bench5) : null;
    const vol = +f.vol3y;
    const mdd = +f.maxdd;
    const riskGrade = gradeRisk(vol, mdd);
    return { ...f, alpha3, alpha5, riskGrade };
  });
}

function gradeRisk(vol3y, maxdd){
  // Simple risk grading heuristic; replace with your own.
  const v = Number.isFinite(+vol3y) ? +vol3y : 18;
  const d = Number.isFinite(+maxdd) ? +maxdd : 25;
  const score = (v/18) + (d/25); // ~1 is medium
  if(score < 0.9) return "A";
  if(score < 1.1) return "B";
  if(score < 1.35) return "C";
  return "D";
}

function renderBeaters(){
  const risk = $("#riskFilter").value;
  const alphaMin = +$("#alphaMin").value;

  const rows = calcAlphaRows()
    .filter(f => Number.isFinite(+f.alpha3) && Number.isFinite(+f.alpha5))
    .filter(f => +f.alpha3 >= alphaMin && +f.alpha5 >= alphaMin)
    .filter(f => !risk || f.riskGrade === risk)
    .sort((a,b)=> (+b.alpha5) - (+a.alpha5));

  const tbody = $("#beatersTbody");
  tbody.innerHTML = rows.slice(0, 250).map(f => `
    <tr data-type="fund" data-id="${escapeHtml(f.code)}">
      <td><div class="rowTitle">${escapeHtml(f.name)}</div><div class="muted">${escapeHtml(f.amc || "—")}</div></td>
      <td>${escapeHtml(f.category || "—")}</td>
      <td class="num ${pctClass(f.alpha3)}">${fmt(f.alpha3, 2)}</td>
      <td class="num ${pctClass(f.alpha5)}">${fmt(f.alpha5, 2)}</td>
      <td class="num">${fmt(f.vol3y, 1)}</td>
      <td class="num">${fmt(f.maxdd, 1)}</td>
      <td>${riskBadge(f.riskGrade)}</td>
    </tr>
  `).join("");

  $("#beatersCount").textContent = `${fmtInt(rows.length)} consistent outperformers (showing up to 250)`;
  $("#statBeaters").textContent = fmtInt(rows.length);
}

function wireBeaterControls(){
  ["benchmarkSelect","riskFilter","alphaMin"].forEach(id=>{
    $("#"+id).addEventListener("change", renderBeaters);
    $("#"+id).addEventListener("input", renderBeaters);
  });
  $("#btnRecalcAlpha").addEventListener("click", renderBeaters);
}

// ---------- News ----------
function newsCategories(){
  return ["All","Monetary Policy","FII Data","Budget","Sector","Commodities","Regulation","Pharma"];
}

function categorise(item){
  const t = (item.title + " " + (item.description||"")).toLowerCase();
  if(/rbi|monetary|repo|mpr|mpc|inflation|liquidity/.test(t)) return "Monetary Policy";
  if(/fii|fpi|foreign institutional|flows/.test(t)) return "FII Data";
  if(/budget|union budget|interim budget|finance bill/.test(t)) return "Budget";
  if(/sebi|circular|regulation|guidelines|order|penalty/.test(t)) return "Regulation";
  if(/crude|oil|brent|gold|silver|commodity|lme/.test(t)) return "Commodities";
  if(/pharma|drug|fda|clinical|vaccine/.test(t)) return "Pharma";
  if(/it\b|bank\b|auto|fmcg|metal|realty|infra|power|psu/.test(t)) return "Sector";
  return "Sector";
}

async function fetchRss(url){
  const proxied = CONFIG.CORS_PROXY + encodeURIComponent(url);
  const r = await fetch(proxied, { cache: "no-store" });
  if(!r.ok) throw new Error(`RSS fetch failed ${r.status}`);
  return r.text();
}

async function refreshNews(){
  const sources = state.newsSources?.sources || [];
  const collected = [];

  for(const src of sources){
    try{
      const xml = await fetchRss(src.url);
      const items = parseRss(xml).map(it => ({
        ...it,
        source: src.name,
        category: src.category || categorise(it),
        isoTime: toIsoGuess(it.pubDate) || null
      }));
      collected.push(...items);
    }catch(e){
      console.warn("News source failed:", src.name, e);
    }
  }

  collected.sort((a,b)=>{
    const ta = a.isoTime ? +new Date(a.isoTime) : 0;
    const tb = b.isoTime ? +new Date(b.isoTime) : 0;
    return tb - ta;
  });

  state.newsItems = collected.slice(0, 120);
  $("#statNews").textContent = fmtInt(state.newsItems.length);
  renderNews();
}

function renderNewsTabs(){
  const tabs = $("#newsTabs");
  tabs.innerHTML = "";
  newsCategories().forEach(cat=>{
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.type = "button";
    btn.setAttribute("role","tab");
    btn.setAttribute("aria-selected", cat === state.activeNewsCat ? "true":"false");
    btn.textContent = cat;
    btn.addEventListener("click", ()=>{
      state.activeNewsCat = cat;
      renderNews();
    });
    tabs.appendChild(btn);
  });
}

function renderNews(){
  $$("#newsTabs .tab").forEach(t=>{
    t.setAttribute("aria-selected", t.textContent === state.activeNewsCat ? "true":"false");
  });

  const cat = state.activeNewsCat;
  let items = state.newsItems.slice();
  if(cat && cat !== "All") items = items.filter(x => x.category === cat);

  const list = $("#newsList");
  if(!items.length){
    list.innerHTML = `<div class="muted">No items loaded. Click Refresh. If sources block CORS, set up a proxy or switch sources.</div>`;
    return;
  }

  list.innerHTML = items.slice(0, 60).map(it=>{
    const when = it.isoTime ? new Date(it.isoTime).toLocaleString("en-GB", { dateStyle:"medium", timeStyle:"short" }) : (it.pubDate || "");
    return `
      <article class="newsItem">
        <div class="newsItem__top">
          <div class="newsItem__title"><a href="${escapeHtml(it.link)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a></div>
          <div class="newsItem__meta">${escapeHtml(it.source)} • ${escapeHtml(it.category)} • ${escapeHtml(when)}</div>
        </div>
        ${it.description ? `<div class="newsItem__desc">${escapeHtml(it.description.slice(0, 260))}${it.description.length>260?"…":""}</div>` : ""}
      </article>
    `;
  }).join("");
}

// ---------- AI Analyst (Claude) ----------
function addAiMsg(type, content){
  const log = $("#aiLog");
  const div = document.createElement("div");
  div.className = `ai__msg ${type==="user" ? "ai__msg--user" : (type==="system" ? "ai__msg--system" : "")}`;
  div.innerHTML = content;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function presetPrompt(kind){
  if(kind === "stock") return "Analyse {TICKER/NAME}: business model, moat, key drivers, risks, near-term catalysts, valuation range, and what could go wrong. Keep it structured with bullet points.";
  if(kind === "dcf") return "Do a simple DCF for {COMPANY}. Ask me for missing inputs (FCF, growth, WACC, terminal growth, shares, net debt) and show a sensitivity table (base/bull/bear).";
  if(kind === "sector") return "Give a sector outlook for {SECTOR} in India for the next 6–12 months: tailwinds, headwinds, key KPIs, and a watchlist of 5 tickers with 1-line thesis each.";
  if(kind === "portfolio") return "Help me build a diversified India portfolio for a retail investor: risk profile questions first, then an asset allocation (equity funds/index, debt, gold, cash) with rebalancing rules.";
  return "";
}

function getAnthropicKey(){
  return (localStorage.getItem("fi:anthropicKey") || "").trim();
}
function setAnthropicKey(k){
  localStorage.setItem("fi:anthropicKey", k.trim());
}
$("#anthropicKey").value = getAnthropicKey();
$("#anthropicKey").addEventListener("change", (e)=> setAnthropicKey(e.target.value));

$$(".chip").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const kind = btn.dataset.preset;
    $("#aiPrompt").value = presetPrompt(kind);
    $("#aiPrompt").focus();
  });
});

async function callClaude(userPrompt){
  const key = getAnthropicKey();
  if(!key) throw new Error("Missing API key. Paste your Anthropic key first.");

  const system = [
    "You are FinIntel, an AI finance analyst for Indian retail investors.",
    "Be cautious, educational, and avoid giving direct buy/sell instructions.",
    "If data is missing, ask targeted questions. Provide structured output with headings and bullet points.",
    "For DCF: show the steps, assumptions, and a simple sensitivity (base/bull/bear).",
    "Always include a brief risk section and a disclaimer."
  ].join("\n");

  const payload = {
    model: CONFIG.ANTHROPIC_MODEL,
    max_tokens: 900,
    temperature: 0.4,
    system,
    messages: [{ role: "user", content: userPrompt }]
  };

  const r = await fetch(CONFIG.ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(payload)
  });

  if(!r.ok){
    const txt = await r.text().catch(()=> "");
    throw new Error(`Anthropic API error (${r.status}): ${txt.slice(0, 240)}`);
  }
  const data = await r.json();
  const text = (data.content || []).map(x => x.text || "").join("\n").trim();
  return text || "(No content returned.)";
}

$("#btnAskAi").addEventListener("click", async ()=>{
  const p = $("#aiPrompt").value.trim();
  if(!p) return;

  addAiMsg("user", `<strong>You:</strong> ${escapeHtml(p)}`);
  $("#btnAskAi").disabled = true;
  try{
    const ans = await callClaude(p);
    addAiMsg("assistant", `<strong>AI:</strong><br>${escapeHtml(ans).replace(/\n/g,"<br>")}`);
  }catch(e){
    addAiMsg("system", `<strong>Error:</strong> ${escapeHtml(e.message || String(e))}`);
  }finally{
    $("#btnAskAi").disabled = false;
  }
});
$("#btnClearAi").addEventListener("click", ()=> { $("#aiLog").innerHTML = ""; });

// Clicking rows -> autofill prompt context
function wireRowClicks(){
  document.body.addEventListener("click", (e)=>{
    const btn = e.target.closest("[data-action='ai']");
    const tr = e.target.closest("tr[data-type]");
    if(!tr && !btn) return;

    if(btn){
      const row = btn.closest("tr[data-type]");
      if(row) {
        const type = row.dataset.type;
        const id = row.dataset.id;
        autoPrompt(type, id);
      }
      e.stopPropagation();
      return;
    }

    if(tr){
      autoPrompt(tr.dataset.type, tr.dataset.id);
    }
  });
}

function autoPrompt(type, id){
  if(type === "stock"){
    const s = state.stocks.find(x => x.symbol === id);
    if(!s) return;
    $("#aiPrompt").value =
`Analyse ${s.name} (${s.symbol}) in India.
Context (from screener):
- Sector: ${s.sector}
- Price: ₹${fmt(s.price,2)} | Day%: ${fmt(s.chgPct,2)} | 1M%: ${fmt(s.ret1m,2)}
- P/E: ${fmt(s.pe,1)} | Market cap: ₹${fmtInt(s.mcapCr)} Cr
Ask for missing data if needed, then give a structured thesis + risks + valuation range.`;
    window.location.hash = "#ai";
  }
  if(type === "fund"){
    const f = state.funds.find(x => String(x.code) === String(id));
    if(!f) return;
    $("#aiPrompt").value =
`Evaluate mutual fund: ${f.name} (Code ${f.code})
Context:
- Category: ${f.category}
- 1Y: ${fmt(f.ret1y,2)}% | 3Y CAGR: ${fmt(f.cagr3y,2)}% | 5Y CAGR: ${fmt(f.cagr5y,2)}%
- AUM: ₹${fmtInt(f.aumCr)} Cr | Min SIP: ₹${fmtInt(f.minSip)}
Please discuss suitability, risk, and how to compare vs index funds.`;
    window.location.hash = "#ai";
  }
}

// ---------- DCF ----------
function calcDcf({fcf, growth, wacc, tg, netDebt, shares}){
  // 5-year explicit forecast
  const g = growth/100;
  const r = wacc/100;
  const t = tg/100;

  let pv = 0;
  let f = fcf;

  for(let yr=1; yr<=5; yr++){
    f = f * (1+g);
    pv += f / Math.pow(1+r, yr);
  }

  // Gordon growth terminal value at year 5
  const tv = (f * (1+t)) / (r - t);
  const pvTv = tv / Math.pow(1+r, 5);

  const ev = pv + pvTv;
  const eq = ev - netDebt; // (₹ Cr)
  const valPerShare = (eq) / (shares); // both in Cr => ₹/share
  return valPerShare;
}

function wireDcf(){
  const dlg = $("#dcfDialog");
  $("#btnOpenDcf").addEventListener("click", ()=> dlg.showModal());
  $("#btnCalcDcf").addEventListener("click", ()=>{
    const inputs = {
      fcf: +$("#dcfFcf").value,
      growth: +$("#dcfGrowth").value,
      wacc: +$("#dcfWacc").value,
      tg: +$("#dcfTg").value,
      netDebt: +$("#dcfNetDebt").value,
      shares: +$("#dcfShares").value
    };
    if(inputs.wacc <= inputs.tg){
      $("#dcfValue").textContent = "WACC must be > terminal growth";
      return;
    }
    const v = calcDcf(inputs);
    $("#dcfValue").textContent = `₹ ${fmt(v, 2)}`;
  });
}

// ---------- Demo data helper ----------
$("#btnDemoData").addEventListener("click", ()=>{
  addAiMsg("system", "Demo data loaded. Replace ./data/*.sample.json with your real universe (2,500+ stocks and 1,400+ funds) and commit to GitHub Pages.");
});

// ---------- Boot ----------
async function boot(){
  applyTheme();
  initTradingViewTicker();

  $("#buildStamp").textContent = `Build: ${new Date().toLocaleString("en-GB", {dateStyle:"medium", timeStyle:"short"})}`;

  try{
    await loadCoreData();
    buildSectorOptions();
    renderStocks();
    renderFunds();
    renderNewsTabs();
    renderBeaters();
    wireStockControls();
    wireFundControls();
    wireBeaterControls();
    wireRowClicks();
    wireDcf();

    $("#btnRefreshNews").addEventListener("click", refreshNews);
    // initial news load (non-blocking)
    refreshNews().catch(()=>{});
  }catch(e){
    console.error(e);
    $("#dataStatus").textContent = "Data: failed to load";
    addAiMsg("system", `Data load error: ${escapeHtml(e.message || String(e))}`);
  }
}

boot();

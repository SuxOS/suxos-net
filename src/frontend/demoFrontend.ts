// Rendering layer for the /demo/* JSON endpoints (navigator.ts / demoQa.ts / demoFlags.ts) —
// the actual 2D navigator UI called for in design doc §2/§3: verbosity axis × time-scope
// axis as ONE control (not separate "timeline"/"report" views), QA as cited pointer-routing,
// and flags rendered with mandatory hedged language, never a bare "wrong" treatment.
//
// Deliberately a static HTML shell + same-origin CSS/JS strings, no build step or framework —
// this Worker has none, and the /demo/* JSON endpoints are already the real data source. Script
// and style are served from their own routes (not inlined) so the page can run under a strict
// `script-src 'self'; style-src 'self'` CSP instead of 'unsafe-inline'.

export const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>suxos.net — record navigator (demo)</title>
<link rel="stylesheet" href="/demo/app.css">
</head>
<body>
<header class="site-header">
  <h1>Record navigator</h1>
  <p id="notice-banner" class="notice">FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.</p>
</header>

<nav class="tabs" role="tablist">
  <button id="tab-navigator" class="tab" role="tab" type="button" aria-selected="true">Navigator</button>
  <button id="tab-qa" class="tab" role="tab" type="button" aria-selected="false">Ask a question</button>
  <button id="tab-flags" class="tab" role="tab" type="button" aria-selected="false">Flags</button>
  <button id="tab-highlights" class="tab" role="tab" type="button" aria-selected="false">Highlights</button>
</nav>

<main>
  <section id="panel-navigator" class="panel">
    <div class="controls">
      <label for="verbosity-select">Verbosity
        <select id="verbosity-select">
          <option value="bare">Bare</option>
          <option value="oneline" selected>One line</option>
          <option value="paragraph">Paragraph</option>
          <option value="narrative">Full narrative</option>
        </select>
      </label>
      <label for="timescope-select">Time scope
        <select id="timescope-select">
          <option value="week">Past week</option>
          <option value="year">Past year</option>
          <option value="all" selected>Whole span</option>
        </select>
      </label>
    </div>
    <div id="navigator-entries" class="entries" aria-live="polite"></div>
  </section>

  <section id="panel-qa" class="panel" hidden>
    <form id="qa-form" class="qa-form">
      <label for="qa-input">Ask a question about the record</label>
      <input id="qa-input" type="text" name="question" placeholder="e.g. what happened in March?" autocomplete="off">
      <button type="submit">Ask</button>
    </form>
    <div id="qa-results" class="qa-results" aria-live="polite"></div>
  </section>

  <section id="panel-flags" class="panel" hidden>
    <div id="flags-content" aria-live="polite"></div>
  </section>

  <section id="panel-highlights" class="panel" hidden>
    <div id="highlights-content" aria-live="polite"></div>
  </section>
</main>

<script src="/demo/app.js"></script>
</body>
</html>
`;

export const DEMO_CSS = `:root {
  color-scheme: light;
  --ink: #1b1f24;
  --muted: #5b6470;
  --bg: #ffffff;
  --panel-bg: #f6f7f9;
  --border: #d8dce1;
  --caution: #926c00;
  --caution-bg: #fdf3d8;
  --support: #146c43;
  --support-bg: #e6f4ea;
  --accent: #2c5eea;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--ink);
  background: var(--bg);
  line-height: 1.45;
}

.site-header { padding: 1rem 1.25rem 0.5rem; border-bottom: 1px solid var(--border); }
.site-header h1 { margin: 0 0 0.35rem; font-size: 1.35rem; }

.notice {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--caution);
  background: var(--caution-bg);
  padding: 0.4rem 0.6rem;
  border-radius: 0.35rem;
  display: inline-block;
}

.tabs { display: flex; gap: 0.25rem; padding: 0.5rem 1.25rem 0; border-bottom: 1px solid var(--border); overflow-x: auto; }

.tab {
  background: none;
  border: none;
  padding: 0.6rem 0.9rem;
  font-size: 0.95rem;
  cursor: pointer;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

.tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

main { padding: 1rem 1.25rem 2rem; max-width: 780px; margin: 0 auto; }

.panel[hidden] { display: none; }

.controls { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
.controls label { display: flex; flex-direction: column; font-size: 0.85rem; color: var(--muted); gap: 0.25rem; }

select, input[type="text"] {
  font-size: 0.95rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg);
  color: var(--ink);
}

.entry-card, .qa-match, .flag-card {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem 0.9rem;
  margin-bottom: 0.75rem;
  background: var(--panel-bg);
}

.entry-date { font-size: 0.8rem; color: var(--muted); }
.entry-title { margin: 0.2rem 0 0.35rem; font-size: 1.05rem; }
.entry-body { margin: 0 0 0.5rem; white-space: pre-wrap; }

.citations { font-size: 0.8rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
.citation-label { font-weight: 600; }
.citation-pill { background: #eef1f5; border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.5rem; }
.citation-missing { color: var(--caution); font-weight: 600; }

.qa-form { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
.qa-form label { flex-basis: 100%; font-size: 0.85rem; color: var(--muted); }
.qa-form input { flex: 1 1 220px; }

.no-source, .error { color: var(--caution); font-weight: 600; }
.loading, .empty { color: var(--muted); font-style: italic; }

.flag-section { margin-bottom: 1.25rem; }
.flag-section h3 { font-size: 1rem; margin-bottom: 0.5rem; }

.flag-header { display: flex; align-items: center; gap: 0.4rem; font-weight: 600; margin-bottom: 0.35rem; }
.flag-icon { font-size: 1rem; }

.flag-caution { border-left: 4px solid var(--caution); }
.flag-support { border-left: 4px solid var(--support); }

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  margin-bottom: 0.35rem;
}
.badge-caution { color: var(--caution); background: var(--caution-bg); }
.badge-support { color: var(--support); background: var(--support-bg); }

.flag-note { margin: 0.25rem 0 0; font-size: 0.9rem; color: var(--muted); }

@media (max-width: 480px) {
  main { padding: 0.75rem; }
  .controls { flex-direction: column; gap: 0.6rem; }
}
`;

export const DEMO_JS = `(function () {
  "use strict";

  var state = { verbosity: "oneline", timeScope: "all" };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "class") node.className = attrs[key];
        else if (key === "text") node.textContent = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function confidenceBadge(confidence, tone) {
    var pct = Math.round(confidence * 100) + "% confidence";
    return el("span", { class: "badge badge-" + tone, text: pct });
  }

  function citationList(ids) {
    var wrap = el("div", { class: "citations" });
    if (!ids || ids.length === 0) {
      wrap.appendChild(el("span", { class: "citation-missing", text: "could not find a source" }));
      return wrap;
    }
    wrap.appendChild(el("span", { class: "citation-label", text: "sources:" }));
    ids.forEach(function (id) {
      wrap.appendChild(el("span", { class: "citation-pill", text: id }));
    });
    return wrap;
  }

  function setNotice(notice) {
    if (notice) document.getElementById("notice-banner").textContent = notice;
  }

  // --- Navigator tab ---

  function renderNavigatorEntries(data) {
    var list = document.getElementById("navigator-entries");
    clear(list);
    setNotice(data.notice);
    if (!data.entries || data.entries.length === 0) {
      list.appendChild(el("p", { class: "empty", text: "No entries in this time scope." }));
      return;
    }
    data.entries.forEach(function (entry) {
      var card = el("article", { class: "entry-card" });
      card.appendChild(el("div", { class: "entry-date", text: entry.date }));
      card.appendChild(el("h3", { class: "entry-title", text: entry.title }));
      if (entry.body) card.appendChild(el("p", { class: "entry-body", text: entry.body }));
      card.appendChild(citationList(entry.citationIds));
      list.appendChild(card);
    });
  }

  function loadNavigator() {
    var params = new URLSearchParams({ verbosity: state.verbosity, timeScope: state.timeScope });
    fetch("/demo/navigator?" + params.toString())
      .then(function (res) { return res.json(); })
      .then(renderNavigatorEntries)
      .catch(function () {
        var list = document.getElementById("navigator-entries");
        clear(list);
        list.appendChild(el("p", { class: "error", text: "Could not load the navigator right now." }));
      });
  }

  // --- QA tab ---

  function renderQaMatch(match) {
    var card = el("article", { class: "qa-match" });
    if (match.date) card.appendChild(el("div", { class: "entry-date", text: match.date }));
    card.appendChild(el("p", { class: "qa-text", text: match.text }));
    card.appendChild(citationList(match.citations));
    return card;
  }

  function submitQuestion(question) {
    var resultsEl = document.getElementById("qa-results");
    clear(resultsEl);
    resultsEl.appendChild(el("p", { class: "loading", text: "Searching…" }));

    fetch("/demo/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        clear(resultsEl);
        if (!result.ok) {
          resultsEl.appendChild(el("p", { class: "error", text: result.data.error || "Something went wrong." }));
          return;
        }
        setNotice(result.data.notice);
        if (result.data.status !== "matched" || !result.data.matches || result.data.matches.length === 0) {
          resultsEl.appendChild(el("p", { class: "no-source", text: "Could not find a source-backed answer to that question." }));
          return;
        }
        result.data.matches.forEach(function (match) {
          resultsEl.appendChild(renderQaMatch(match));
        });
      })
      .catch(function () {
        clear(resultsEl);
        resultsEl.appendChild(el("p", { class: "error", text: "Could not reach the question service right now." }));
      });
  }

  // --- Flags tab ---

  function renderFlagSection(title, items, renderItem, emptyText) {
    var section = el("section", { class: "flag-section" });
    section.appendChild(el("h3", { text: title }));
    if (!items || items.length === 0) {
      section.appendChild(el("p", { class: "empty", text: emptyText }));
      return section;
    }
    items.forEach(function (item) {
      section.appendChild(renderItem(item));
    });
    return section;
  }

  function renderInconsistency(flag) {
    var card = el("div", { class: "flag-card flag-caution" });
    card.appendChild(el("div", { class: "flag-header" }, [
      el("span", { class: "flag-icon", text: "⚠" }),
      el("span", { text: "Claim " + flag.claimIdA + " appears inconsistent with claim " + flag.claimIdB }),
    ]));
    card.appendChild(confidenceBadge(flag.confidence, "caution"));
    card.appendChild(el("p", { class: "flag-note", text: flag.note }));
    return card;
  }

  function renderGrounding(signal) {
    var card = el("div", { class: "flag-card flag-support" });
    card.appendChild(el("div", { class: "flag-header" }, [
      el("span", { class: "flag-icon", text: "✓" }),
      el("span", { text: "Claim " + signal.claimId + " appears well-supported" }),
    ]));
    card.appendChild(confidenceBadge(signal.confidence, "support"));
    card.appendChild(el("p", { class: "flag-note", text: signal.note }));
    return card;
  }

  function renderReferenceFlag(flag) {
    var card = el("div", { class: "flag-card flag-caution" });
    card.appendChild(el("div", { class: "flag-header" }, [
      el("span", { class: "flag-icon", text: "⚠" }),
      el("span", { text: "Claim " + flag.claimId + " appears inconsistent with reference " + flag.appearsInconsistentWith }),
    ]));
    card.appendChild(confidenceBadge(flag.confidence, "caution"));
    card.appendChild(el("p", { class: "flag-note", text: flag.note }));
    return card;
  }

  function renderCitationIntegrity(report) {
    var card = el("div", { class: "flag-card " + (report.clean ? "flag-support" : "flag-caution") });
    var summary = report.clean
      ? "All " + report.citationReferencesChecked + " citation references across " + report.recordsChecked + " records resolve to a known source."
      : report.dangling.length + " citation reference(s) do not resolve to a known source.";
    card.appendChild(el("p", { text: summary }));
    (report.dangling || []).forEach(function (d) {
      card.appendChild(el("p", { class: "flag-note", text: "Record " + d.recordId + " cites unknown source " + d.citationId }));
    });
    return card;
  }

  function loadFlags() {
    var container = document.getElementById("flags-content");
    clear(container);
    container.appendChild(el("p", { class: "loading", text: "Loading…" }));

    fetch("/demo/flags")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        clear(container);
        setNotice(data.notice);
        container.appendChild(renderFlagSection("Possible inconsistencies", data.selfConsistency, renderInconsistency, "No candidate inconsistencies detected."));
        container.appendChild(renderFlagSection("Well-supported claims", data.groundingSignals, renderGrounding, "No claims met the corroboration threshold yet."));
        container.appendChild(renderFlagSection("Reference consistency", data.referenceConsistency, renderReferenceFlag, "No candidate inconsistencies against trusted references."));
        var integritySection = el("section", { class: "flag-section" });
        integritySection.appendChild(el("h3", { text: "Citation integrity" }));
        integritySection.appendChild(renderCitationIntegrity(data.citationIntegrity));
        container.appendChild(integritySection);
      })
      .catch(function () {
        clear(container);
        container.appendChild(el("p", { class: "error", text: "Could not load flags right now." }));
      });
  }

  // --- Highlights tab ---

  function renderHighlight(highlight) {
    var icon = highlight.type === "tone" ? "⚑" : "⚠";
    var label = highlight.type === "tone"
      ? "Tone highlight — " + highlight.sourceId
      : "Possible inconsistency — " + highlight.sourceId + " / " + highlight.relatedId;
    var card = el("div", { class: "flag-card flag-caution" });
    card.appendChild(el("div", { class: "flag-header" }, [
      el("span", { class: "flag-icon", text: icon }),
      el("span", { text: label }),
    ]));
    card.appendChild(confidenceBadge(highlight.confidence, "caution"));
    card.appendChild(el("p", { class: "flag-note", text: highlight.note }));
    return card;
  }

  function loadHighlights() {
    var container = document.getElementById("highlights-content");
    clear(container);
    container.appendChild(el("p", { class: "loading", text: "Loading…" }));

    fetch("/demo/highlights")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        clear(container);
        setNotice(data.notice);
        container.appendChild(renderFlagSection("Highlights", data.highlights, renderHighlight, "No highlights detected."));
      })
      .catch(function () {
        clear(container);
        container.appendChild(el("p", { class: "error", text: "Could not load highlights right now." }));
      });
  }

  // --- Tabs & wiring ---

  var TABS = ["navigator", "qa", "flags", "highlights"];
  var flagsLoaded = false;
  var highlightsLoaded = false;

  function showTab(name) {
    TABS.forEach(function (tab) {
      document.getElementById("panel-" + tab).hidden = tab !== name;
      document.getElementById("tab-" + tab).setAttribute("aria-selected", String(tab === name));
    });
    if (name === "flags" && !flagsLoaded) {
      flagsLoaded = true;
      loadFlags();
    }
    if (name === "highlights" && !highlightsLoaded) {
      highlightsLoaded = true;
      loadHighlights();
    }
  }

  function init() {
    TABS.forEach(function (tab) {
      document.getElementById("tab-" + tab).addEventListener("click", function () {
        showTab(tab);
      });
    });

    var verbositySelect = document.getElementById("verbosity-select");
    var timeScopeSelect = document.getElementById("timescope-select");
    verbositySelect.addEventListener("change", function () {
      state.verbosity = verbositySelect.value;
      loadNavigator();
    });
    timeScopeSelect.addEventListener("change", function () {
      state.timeScope = timeScopeSelect.value;
      loadNavigator();
    });

    document.getElementById("qa-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var input = document.getElementById("qa-input");
      var question = input.value.trim();
      if (!question) return;
      submitQuestion(question);
    });

    loadNavigator();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
`;

const grid = document.getElementById('grid');
const refreshBtn = document.getElementById('refresh');
const autoToggle = document.getElementById('auto');
const updatedEl = document.getElementById('updated');

const AUTO_INTERVAL = 10 * 60 * 1000; // 10 minutes
let autoTimer = null;

async function load() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Loading…';
  try {
    const resp = await fetch('/api/usage');
    const json = await resp.json();
    render(json);
    updatedEl.textContent = 'updated ' + new Date(json.timestamp).toLocaleTimeString();
  } catch (err) {
    grid.innerHTML = `<div class="card error">Failed to load: ${escapeHtml(err.message)}</div>`;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  }
}

function render(json) {
  const providers = json.providers || {};
  const keys = Object.keys(providers);
  if (keys.length === 0) {
    grid.innerHTML = '<div class="card placeholder">No providers.</div>';
    return;
  }
  grid.innerHTML = keys.map((k) => cardHtml(providers[k])).join('');
}

function cardHtml(p) {
  const label = p.label || p.provider || 'Unknown';
  const planLabel = p.summary?.plan_label;
  if (!p.ok) {
    return `
      <div class="card error">
        <div class="card-head">
          <span class="label">${escapeHtml(label)}</span>
          <span class="tag">offline</span>
        </div>
        <div class="text-note">${escapeHtml(p.error || 'unknown error')}</div>
      </div>`;
  }

  const rows = limitRows(p.summary);
  const bars = rows.length
    ? rows.map((r) => barHtml(r.label, r.percent, r)).join('')
    : '';

  const raw = p.raw != null ? rawHtml(p.raw) : '';
  const note = p.text ? `<div class="text-note">${escapeHtml(p.text)}</div>` : '';

  return `
    <div class="card">
      <div class="card-head">
        <span class="label">${escapeHtml(label)}</span>
        <span class="tag">${escapeHtml(planLabel || 'live')}</span>
      </div>
      ${bars}
      ${note}
      ${raw}
    </div>`;
}

/** Collect limit rows from summary.limits, falling back to flat numeric summary. */
function limitRows(summary) {
  if (!summary || typeof summary !== 'object') return [];
  if (Array.isArray(summary.limits)) {
    return summary.limits.filter((l) => l && typeof l.percent === 'number');
  }
  // Flat {key:number} fallback
  return Object.entries(summary)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => ({ label: prettify(k), percent: v }));
}

function barHtml(label, percent, extra) {
  const p = Math.max(0, Math.min(100, percent));
  const color = p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--yellow)' : 'var(--green)';
  const used =
    extra && typeof extra.used === 'number' && typeof extra.total === 'number'
      ? `<span class="used">${extra.used} / ${extra.total}</span>`
      : '';
  const reset =
    extra && extra.reset_at
      ? `<span class="reset" title="${escapeHtml(extra.reset_at)}">resets ${fmtRel(extra.reset_at)}</span>`
      : '';
  const detail = extra && extra.detail ? `<div class="detail">${escapeHtml(extra.detail)}</div>` : '';
  return `
    <div class="metric">
      <div class="k"><span>${escapeHtml(label)}</span><span class="v">${p}%</span></div>
      <div class="bar"><span style="width:${p}%;background:${color}"></span></div>
      ${(used || reset) ? `<div class="meta">${used}${reset}</div>` : ''}${detail}
    </div>`;
}

function fmtRel(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.round(diff / 3_600_000);
  if (h < 1) return '<1h';
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function rawHtml(obj) {
  return `
    <details class="raw">
      <summary>raw response</summary>
      <pre>${escapeHtml(JSON.stringify(obj, null, 2))}</pre>
    </details>`;
}

function prettify(key) {
  return key.replace(/_/g, ' ').replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

refreshBtn.addEventListener('click', load);

autoToggle.addEventListener('change', () => {
  if (autoToggle.checked) {
    autoTimer = setInterval(load, AUTO_INTERVAL);
  } else if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
});

load();

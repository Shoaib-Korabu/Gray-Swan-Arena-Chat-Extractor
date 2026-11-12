// popup/popup.js
// Universal Gray Swan Arena Chat Extractor popup (v2.1).
// Synchronizes live website breaks, challenge scenarios, and models per slug.

(function () {
  'use strict';

  const state = {
    slug: '',
    challengeName: '',
    baseUrl: 'https://app.grayswan.ai',
    isGSA: false,
    chats: [],
    rosterModels: [],
    rosterScenarios: [],
    breakStats: null,
    serverTotals: null,
    filters: { outcome: 'all', scenario: 'all', model: 'all', search: '' },
    selected: new Set(),
    extracting: false
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = (c, i) => c && c.chatId ? `id:${c.chatId}` : `idx:${i}`;
  const outcomeOf = (c) => {
    const o = c?.rejectionDetails?.outcome;
    if (o === 'rejected' || c?.rejectionDetails?.isRejected) return 'rejected';
    if (o === 'accepted') return 'accepted';
    if (o === 'error') return 'error';
    return 'pending';
  };

  function toast(msg, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = msg;
    $('toastContainer').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
  }

  function assignKeys() {
    state.chats.forEach((c, i) => { c._key = keyOf(c, i); });
  }

  const send = (type, payload) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ success: false, error: err.message });
        else resolve(resp || { success: false, error: 'Empty response' });
      });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });

  function effectiveSlug() {
    const override = $('challengeSlug').value.trim();
    return override || state.slug;
  }

  // ---- Tab detection & live website synchronization --------------------
  async function syncChallengeData(slug, baseUrl) {
    state.chats = [];
    state.rosterModels = [];
    state.rosterScenarios = [];
    state.breakStats = null;
    state.serverTotals = null;
    state.selected.clear();
    state.filters = { outcome: 'all', scenario: 'all', model: 'all', search: '' };
    $('searchInput').value = '';
    $('btnClearSearch').classList.add('hidden');

    if (!slug) {
      state.challengeName = '';
      renderChallengeHeader(state.isGSA);
      renderAll();
      return;
    }

    const [stResp, sumResp] = await Promise.all([
      send('GET_EXTRACTION_STATE', { slug, baseUrl, allowFallbackLast: false }),
      send('GET_CHALLENGE_SUMMARY', { slug, baseUrl })
    ]);

    const d = stResp?.data || {};
    const summary = sumResp?.summary || stResp?.summary || null;

    if (d.challengeSlug === slug) {
      state.challengeName = summary?.challengeName || d.challengeName || state.challengeName;
      state.rosterModels = (summary?.allModels?.length ? summary.allModels : d.allModels) || [];
      state.rosterScenarios = (summary?.allScenarios?.length ? summary.allScenarios : d.allScenarios) || [];
      state.breakStats = summary?.breakStats || d.breakStats || null;
      state.serverTotals = summary
        ? { chats: summary.chatsCount || 0, submissions: summary.submissionsCount || 0 }
        : (d.serverTotals || null);

      if (Array.isArray(d.extractedChats) && d.extractedChats.length) {
        state.chats = d.extractedChats;
        assignKeys();
      }
    } else if (summary) {
      state.challengeName = summary.challengeName || state.challengeName;
      state.rosterModels = summary.allModels || [];
      state.rosterScenarios = summary.allScenarios || [];
      state.breakStats = summary.breakStats || null;
      state.serverTotals = { chats: summary.chatsCount || 0, submissions: summary.submissionsCount || 0 };
    }

    renderChallengeHeader(state.isGSA);
    renderAll();

    if (state.chats.length) {
      setProgress(100, `Loaded ${state.chats.length} stored chats for ${slug}.`);
      $('progressContainer').classList.remove('hidden');
    } else if (state.serverTotals) {
      setProgress(0, `Synced live site (${state.serverTotals.chats} chats, ${state.serverTotals.submissions} subs). Click Extract chats.`);
      $('progressContainer').classList.remove('hidden');
    } else {
      $('progressContainer').classList.add('hidden');
    }
  }

  async function detectTab(silent) {
    const info = await send('GET_ACTIVE_TAB_INFO');
    if (!info || !info.success) return info;

    state.isGSA = !!info.isGSA;
    state.baseUrl = info.baseUrl || state.baseUrl;
    state.slug = info.slug || '';
    state.challengeName = info.challengeName || '';
    $('challengeSlug').placeholder = info.slug || 'auto-detected';

    if (!info.slug && !silent) {
      toast('No challenge detected on the active tab. Open a Gray Swan Arena challenge page.', 'warn');
    }

    renderChallengeHeader(info.isGSA);
    return info;
  }

  function renderChallengeHeader(isGSA) {
    const slug = effectiveSlug();
    const name = state.challengeName || (slug ? GSANormalizer.humanizeSlug(slug) : '');
    $('challengeName').textContent = name || '—';
    $('challengeSlugText').textContent = slug || (isGSA === false ? 'not on grayswan.ai' : 'not on a challenge page');
    $('challengeCard').classList.toggle('detected', !!slug);

    const summaryEl = $('websiteSummary');
    if (!slug || (!state.breakStats && !state.serverTotals)) {
      summaryEl.innerHTML = '';
      summaryEl.classList.add('hidden');
      return;
    }

    const pills = [];
    if (state.breakStats) {
      const reg = Number(state.breakStats.registeredBreaks ?? 0);
      const tot = Number(state.breakStats.totalCombinations ?? 0);
      const scS = Number(state.breakStats.scenariosSolved ?? 0);
      const scT = Number(state.breakStats.totalScenarios ?? 0);
      pills.push(`<span class="ws-pill ws-breaks" title="Unique (scenario, model) breaks registered on website">Site Breaks: ${reg}${tot ? ` / ${tot}` : ''}</span>`);
      if (scT > 0) {
        pills.push(`<span class="ws-pill" title="Scenarios with at least one registered break">Scenarios: ${scS} / ${scT}</span>`);
      }
    }
    if (state.serverTotals && (state.serverTotals.chats || state.serverTotals.submissions)) {
      pills.push(`<span class="ws-pill">${state.serverTotals.chats || 0} chats &bull; ${state.serverTotals.submissions || 0} subs</span>`);
    }
    summaryEl.innerHTML = pills.join('');
    summaryEl.classList.toggle('hidden', pills.length === 0);
  }

  // ---- Extraction ------------------------------------------------------
  async function startExtraction() {
    const slug = effectiveSlug();
    if (!slug) { toast('No challenge to extract. Open a challenge page or set a slug in Advanced.', 'warn'); return; }

    const rawMax = $('maxPages').value.trim();
    const parsedMax = rawMax === '0' ? 0 : (parseInt(rawMax, 10) || 250);

    state.extracting = true;
    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    $('progressContainer').classList.remove('hidden');
    setProgress(8, `Starting extraction for ${slug}...`);

    const resp = await send('START_EXTRACTION', {
      slug,
      baseUrl: state.baseUrl,
      maxPages: parsedMax,
      delayMs: parseInt($('delayMs').value, 10) || 250,
      fetchFullDetails: $('fetchFullDetails').checked
    });

    state.extracting = false;
    $('btnStart').disabled = false;
    $('btnStop').disabled = true;

    if (!resp || !resp.success) {
      setProgress(100, `Error: ${resp?.error || 'extraction failed'}`, true);
      toast(resp?.error || 'Extraction failed', 'error');
      return;
    }

    state.slug = slug;
    state.challengeName = resp.challengeName || state.challengeName;
    state.chats = resp.chats || [];
    state.rosterModels = resp.allModels || state.rosterModels;
    state.rosterScenarios = resp.allScenarios || state.rosterScenarios;
    state.breakStats = resp.breakStats || state.breakStats;
    state.serverTotals = resp.serverTotals || state.serverTotals;
    assignKeys();
    state.selected.clear();
    renderChallengeHeader(true);

    const warnCount = Array.isArray(resp.warnings) ? resp.warnings.length : 0;
    const summaryText = `Done — ${state.chats.length} chats (${resp.stats?.rejected || 0} rejected, ${resp.stats?.accepted || 0} accepted subs).`;
    setProgress(100, warnCount ? `${summaryText} ${resp.warnings[0]}` : summaryText);
    if (warnCount) toast(resp.warnings[0], 'warn');

    renderAll();
  }

  function setProgress(pct, text, isError) {
    const bar = $('progressBar');
    bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    bar.classList.toggle('error', !!isError);
    $('statusText').textContent = text;
  }

  // ---- Rendering -------------------------------------------------------
  function renderAll() {
    renderStats();
    renderFilters();
    renderList();
    updateDownloadButton();
  }

  function renderStats() {
    const counts = { all: state.chats.length, rejected: 0, accepted: 0, error: 0, pending: 0 };
    for (const c of state.chats) counts[outcomeOf(c)]++;
    $('statTotalCount').textContent = counts.all;
    $('statRejectedCount').textContent = counts.rejected;
    $('statAcceptedCount').textContent = counts.accepted;
    $('statErrorCount').textContent = counts.error;
    $('statPendingCount').textContent = counts.pending;
    document.querySelectorAll('.stat-card').forEach(card => {
      card.classList.toggle('active', card.dataset.outcome === state.filters.outcome);
    });
  }

  function renderFilters() {
    const scenarios = GSANormalizer.collectScenarios(state.chats, state.rosterScenarios);
    const models = GSANormalizer.collectModels(state.chats, state.rosterModels);

    const scenCounts = {};
    const modCounts = {};
    for (const c of state.chats) {
      if (c.scenario) scenCounts[c.scenario] = (scenCounts[c.scenario] || 0) + 1;
      if (c.model) modCounts[c.model] = (modCounts[c.model] || 0) + 1;
    }

    const solvedIds = new Set(state.breakStats?.solvedBehaviors || []);
    const scenLabels = {};
    for (const c of state.chats) {
      if (c.scenario && c.behaviorId && solvedIds.has(c.behaviorId)) {
        scenLabels[c.scenario] = ' [broken]';
      }
    }

    fillSelect($('scenarioSelect'), scenarios, state.filters.scenario, 'All scenarios', scenCounts, scenLabels);
    fillSelect($('modelSelect'), models, state.filters.model, 'All models', modCounts);
  }

  function fillSelect(sel, values, current, allLabel, countsMap = {}, tagsMap = {}) {
    const prev = current && values.includes(current) ? current : 'all';
    state.filters[sel === $('scenarioSelect') ? 'scenario' : 'model'] = prev;
    sel.innerHTML = `<option value="all">${esc(allLabel)} (${values.length})</option>` +
      values.map(v => {
        const cnt = countsMap[v];
        const tag = tagsMap[v] || '';
        const suffix = (cnt ? ` (${cnt})` : '') + tag;
        return `<option value="${esc(v)}"${v === prev ? ' selected' : ''}>${esc(v + suffix)}</option>`;
      }).join('');
  }

  function getFiltered() {
    const f = state.filters;
    const q = f.search.toLowerCase();
    return state.chats.filter(c => {
      if (f.outcome !== 'all' && outcomeOf(c) !== f.outcome) return false;
      if (f.scenario !== 'all' && c.scenario !== f.scenario) return false;
      if (f.model !== 'all' && c.model !== f.model) return false;
      if (q) {
        const hay = [
          c.model, c.scenario, c.behaviorId, c.title, c.chatId, c.rejectionDetails?.reason,
          ...(c.messages || []).map(m => `${m.content || ''} ${m.toolCallSummary || ''}`)
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function getDownloadTarget() {
    const filtered = getFiltered();
    if (state.selected.size === 0) return filtered;
    return filtered.filter(c => state.selected.has(c._key));
  }

  function renderList() {
    const list = $('chatsList');
    const filtered = getFiltered();
    $('emptyState').classList.toggle('hidden', state.chats.length > 0);

    if (state.chats.length === 0) {
      list.innerHTML = '';
      syncSelectAll(filtered);
      return;
    }
    if (filtered.length === 0) {
      list.innerHTML = `<div class="no-results">No conversations match the current filters.</div>`;
      syncSelectAll(filtered);
      return;
    }

    list.innerHTML = filtered.map(c => {
      const oc = outcomeOf(c);
      const checked = state.selected.has(c._key) ? ' checked' : '';
      const title = c.title && !/^\[|^\{/.test(c.title) ? c.title : (c.scenario || 'Conversation');
      const reason = c.rejectionDetails?.reason || '';
      const msgs = (c.messages || []).length;
      return `
        <div class="chat-row outcome-${oc}" data-key="${esc(c._key)}">
          <input type="checkbox" class="row-check" data-key="${esc(c._key)}"${checked}>
          <div class="chat-row-body" data-key="${esc(c._key)}">
            <div class="chat-row-top">
              <span class="chat-model">${esc(c.model)}</span>
              <span class="outcome-pill pill-${oc}">${oc}</span>
            </div>
            <div class="chat-scenario">${esc(c.scenario)}</div>
            <div class="chat-title">${esc(title.slice(0, 140))}</div>
            ${reason ? `<div class="chat-reason">${esc(reason.slice(0, 160))}</div>` : ''}
            <div class="chat-meta"><code>${esc((c.chatId || '').slice(-10))}</code> &bull; ${msgs} msgs</div>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(cb.dataset.key);
        else state.selected.delete(cb.dataset.key);
        syncSelectAll(getFiltered());
        updateDownloadButton();
      });
    });
    list.querySelectorAll('.chat-row-body').forEach(body => {
      body.addEventListener('click', () => {
        const c = state.chats.find(x => x._key === body.dataset.key);
        if (c) openInspector(c);
      });
    });

    syncSelectAll(filtered);
  }

  function syncSelectAll(filtered) {
    const keys = filtered.map(c => c._key);
    const selectedVisible = keys.filter(k => state.selected.has(k)).length;
    const all = $('selectAll');
    all.checked = keys.length > 0 && selectedVisible === keys.length;
    all.indeterminate = selectedVisible > 0 && selectedVisible < keys.length;
    $('selectAllLabel').textContent = state.selected.size > 0 ? `Selected ${state.selected.size}` : 'Select all';
  }

  function updateDownloadButton() {
    const n = getDownloadTarget().length;
    $('downloadCount').textContent = `(${n})`;
    $('btnDownload').disabled = n === 0;
    $('downloadHint').textContent = n === 1
      ? 'Downloads as a single .json file.'
      : n > 1
        ? `Downloads as a .zip of ${n} JSON files. No 10-chat cap.`
        : 'Select chats or adjust filters to choose what to download.';
  }

  // ---- Download (single JSON, or ZIP of JSON files) --------------------
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function download() {
    const target = getDownloadTarget();
    if (target.length === 0) { toast('Nothing to download.', 'warn'); return; }
    const ts = GSANormalizer.formatTimestampCompact(new Date());
    const slug = (effectiveSlug() || 'challenge').replace(/[^a-zA-Z0-9_-]/g, '_');

    if (target.length === 1) {
      const c = target[0];
      const blob = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' });
      triggerBlobDownload(blob, GSANormalizer.generateChatFilename(c));
      toast('Downloaded 1 JSON file.', 'success');
      return;
    }

    const files = target.map(c => ({ name: GSANormalizer.generateChatFilename(c), data: JSON.stringify(c, null, 2) }));
    const manifest = {
      formatVersion: 1,
      challenge: { slug: effectiveSlug(), name: state.challengeName },
      breakStats: state.breakStats || undefined,
      exportedAt: new Date().toISOString(),
      count: target.length,
      files: files.map((f, i) => ({
        file: f.name,
        chatId: target[i].chatId,
        model: target[i].model,
        scenario: target[i].scenario,
        outcome: outcomeOf(target[i])
      }))
    };
    files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

    const blob = GSAZip.createZipBlob(files);
    triggerBlobDownload(blob, `gsa-${slug}-chats-${target.length}-${ts}.zip`);
    toast(`Downloaded ${target.length} JSON files in a ZIP.`, 'success');
  }

  // ---- Inspector -------------------------------------------------------
  let inspectChat = null;
  function openInspector(c) {
    inspectChat = c;
    $('modalTitle').textContent = c.scenario || 'Conversation';
    $('modalScenario').textContent = outcomeOf(c);
    $('modalScenario').className = `modal-scenario-tag pill-${outcomeOf(c)}`;
    $('modalModel').textContent = c.model;
    $('modalStatusBadge').textContent = c.rejectionDetails?.outcome || 'unknown';
    $('modalChatId').textContent = c.chatId || '(none)';

    $('modalDialogue').innerHTML = (c.messages || []).map(m => {
      const toolCallsHtml = Array.isArray(m.toolCalls) && m.toolCalls.length
        ? `<div class="msg-tools">${m.toolCalls.map(t => `<code>${esc(t.name)}</code>`).join(' ')}</div>`
        : '';
      const toolSummaryHtml = (m.toolCalled || m.toolCallSummary)
        ? `<div class="msg-tool-summary"><strong>Tool call:</strong> ${esc(m.toolCallSummary || (m.toolCalled ? 'invoked' : ''))}</div>`
        : '';
      const reasoningHtml = m.reasoning
        ? `<details class="msg-reasoning"><summary>Reasoning trace</summary><div class="msg-reasoning-body">${esc(m.reasoning)}</div></details>`
        : '';
      return `
        <div class="msg msg-${esc(m.role)}">
          <div class="msg-role">${esc(m.role)}</div>
          <div class="msg-content">${esc(m.content)}</div>
          ${toolSummaryHtml}
          ${toolCallsHtml}
          ${reasoningHtml}
        </div>`;
    }).join('') || '<div class="no-results">No messages.</div>';

    const sig = c.rejectionDetails?.signals || [];
    const subMeta = c.submissionMeta
      ? `<div class="sig-line"><strong>Submission:</strong> grade=${esc(c.submissionMeta.gradeStatus || 'n/a')}${c.submissionMeta.appealStatus ? `, appeal=${esc(c.submissionMeta.appealStatus)}` : ''}${c.submissionMeta.manualStatus ? `, manual=${esc(c.submissionMeta.manualStatus)}` : ''}</div>`
      : '';
    $('modalSignals').innerHTML = `
      <div class="sig-line"><strong>Outcome:</strong> ${esc(c.rejectionDetails?.outcome)} (${esc(c.rejectionDetails?.confidence)})</div>
      <div class="sig-line"><strong>Reason:</strong> ${esc(c.rejectionDetails?.reason || '')}</div>
      ${subMeta}
      <div class="sig-list">${sig.length ? sig.map(s => `<code>${esc(s)}</code>`).join('') : '<em>no signals</em>'}</div>`;

    $('modalRawJson').textContent = JSON.stringify(c, null, 2);
    switchTab('messages');
    $('inspectModal').classList.remove('hidden');
  }

  function switchTab(name) {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab' + name.charAt(0).toUpperCase() + name.slice(1)));
  }

  // ---- Wire up ---------------------------------------------------------
  function wire() {
    $('btnDetect').addEventListener('click', async () => {
      const info = await detectTab(false);
      await syncChallengeData(effectiveSlug(), info?.baseUrl || state.baseUrl);
    });
    $('challengeSlug').addEventListener('change', async () => {
      await syncChallengeData(effectiveSlug(), state.baseUrl);
    });
    $('btnStart').addEventListener('click', startExtraction);
    $('btnStop').addEventListener('click', () => send('STOP_EXTRACTION', { slug: effectiveSlug() }));
    $('btnDownload').addEventListener('click', download);
    $('btnClearData').addEventListener('click', async () => {
      const slug = effectiveSlug();
      await send('CLEAR_EXTRACTION_DATA', { slug });
      state.chats = [];
      state.selected.clear();
      renderAll();
      toast(slug ? `Cleared stored chats for ${slug}.` : 'Cleared.', 'info');
    });

    document.querySelectorAll('.stat-card').forEach(card => {
      card.addEventListener('click', () => {
        state.filters.outcome = card.dataset.outcome;
        renderStats(); renderList(); updateDownloadButton();
      });
    });

    $('scenarioSelect').addEventListener('change', (e) => { state.filters.scenario = e.target.value; renderList(); updateDownloadButton(); });
    $('modelSelect').addEventListener('change', (e) => { state.filters.model = e.target.value; renderList(); updateDownloadButton(); });

    $('searchInput').addEventListener('input', (e) => {
      state.filters.search = e.target.value;
      $('btnClearSearch').classList.toggle('hidden', !e.target.value);
      renderList(); updateDownloadButton();
    });
    $('btnClearSearch').addEventListener('click', () => {
      $('searchInput').value = ''; state.filters.search = '';
      $('btnClearSearch').classList.add('hidden');
      renderList(); updateDownloadButton();
    });

    $('selectAll').addEventListener('change', (e) => {
      const filtered = getFiltered();
      if (e.target.checked) filtered.forEach(c => state.selected.add(c._key));
      else filtered.forEach(c => state.selected.delete(c._key));
      renderList(); updateDownloadButton();
    });

    $('btnCloseModal').addEventListener('click', () => $('inspectModal').classList.add('hidden'));
    $('inspectModal').addEventListener('click', (e) => { if (e.target.id === 'inspectModal') $('inspectModal').classList.add('hidden'); });
    document.querySelectorAll('.modal-tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    $('btnCopyPrompt').addEventListener('click', async () => {
      if (!inspectChat) return;
      const u = (inspectChat.messages || []).find(m => m.role === 'user');
      try {
        await navigator.clipboard.writeText(u?.content || inspectChat.title || '');
        toast('Prompt copied.', 'success');
      } catch (e) {
        toast(`Copy failed: ${e.message}`, 'error');
      }
    });

    $('btnCopyJson').addEventListener('click', async () => {
      if (!inspectChat) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(inspectChat, null, 2));
        toast('JSON copied.', 'success');
      } catch (e) {
        toast(`Copy failed: ${e.message}`, 'error');
      }
    });

    $('btnDownloadCurrentJson').addEventListener('click', () => {
      if (!inspectChat) return;
      const blob = new Blob([JSON.stringify(inspectChat, null, 2)], { type: 'application/json' });
      triggerBlobDownload(blob, GSANormalizer.generateChatFilename(inspectChat));
      toast('Downloaded 1 JSON file.', 'success');
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'EXTRACTION_PROGRESS') {
        const p = msg.payload || {};
        if (p.slug && p.slug !== effectiveSlug()) return;
        const pct = Math.min(90, 10 + (p.page || 0) * 6);
        setProgress(pct, p.status || 'Working...');
      } else if (msg.type === 'EXTRACTION_ERROR') {
        const p = msg.payload || {};
        if (p.slug && p.slug !== effectiveSlug()) return;
        setProgress(100, `Error: ${p.error}`, true);
      }
    });
  }

  // ---- Init ------------------------------------------------------------
  async function init() {
    wire();
    const info = await detectTab(true);
    await syncChallengeData(effectiveSlug(), info?.baseUrl || state.baseUrl);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

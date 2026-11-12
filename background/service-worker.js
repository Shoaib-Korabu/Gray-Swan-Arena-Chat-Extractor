// background/service-worker.js
// Service worker for Gray Swan Arena Chat Extractor (v2.1, universal + per-slug isolated).

importScripts(
  '../lib/heuristics.js',
  '../lib/normalizer.js',
  '../lib/zip-writer.js',
  '../lib/api-client.js'
);

let activeClient = null;
const DEFAULT_BASE_URL = 'https://app.grayswan.ai';

function emptyExtractionEntry(slug = '', baseUrl = DEFAULT_BASE_URL) {
  return {
    challengeSlug: slug,
    challengeName: slug ? GSANormalizer.humanizeSlug(slug) : '',
    baseUrl,
    extractedChats: [],
    modelMap: {},
    scenarioMap: {},
    allModels: [],
    allScenarios: [],
    breakStats: null,
    lastExtractedAt: null,
    extractionStatus: 'idle',
    stats: { total: 0, rejected: 0, accepted: 0, errors: 0, pending: 0 },
    counts: { chats: 0, submissions: 0 },
    serverTotals: { chats: 0, submissions: 0 },
    truncated: false,
    warnings: []
  };
}

const LEGACY_KEYS = [
  'challengeSlug', 'challengeName', 'baseUrl', 'extractedChats',
  'modelMap', 'scenarioMap', 'lastExtractedAt', 'extractionStatus', 'stats'
];

async function ensureStore() {
  const cur = await chrome.storage.local.get(['extractionsBySlug', 'summariesBySlug', 'lastActiveSlug', ...LEGACY_KEYS]);
  const patch = {};
  if (!cur.extractionsBySlug || typeof cur.extractionsBySlug !== 'object') patch.extractionsBySlug = {};
  if (!cur.summariesBySlug || typeof cur.summariesBySlug !== 'object') patch.summariesBySlug = {};
  if (typeof cur.lastActiveSlug !== 'string') patch.lastActiveSlug = '';
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);

  // Drop stale v2.0 global keys that caused cross-challenge bleed.
  const toRemove = LEGACY_KEYS.filter(k => cur[k] !== undefined);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);

  return {
    extractionsBySlug: patch.extractionsBySlug || cur.extractionsBySlug,
    summariesBySlug: patch.summariesBySlug || cur.summariesBySlug,
    lastActiveSlug: patch.lastActiveSlug ?? cur.lastActiveSlug ?? ''
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureStore();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'GET_ACTIVE_TAB_INFO': {
          sendResponse({ success: true, ...(await detectActiveTabInfo()) });
          break;
        }
        case 'LIST_CHALLENGES': {
          const info = await detectActiveTabInfo();
          const client = new GSAClient({ baseUrl: info.baseUrl });
          const challenges = await client.listChallenges().catch(() => []);
          sendResponse({ success: true, challenges });
          break;
        }
        case 'GET_CHALLENGE_SUMMARY': {
          const p = message.payload || {};
          const slug = String(p.slug || '').trim();
          const baseUrl = p.baseUrl || DEFAULT_BASE_URL;
          if (!slug) {
            sendResponse({ success: false, error: 'Missing challenge slug' });
            break;
          }
          const store = await ensureStore();
          try {
            const client = new GSAClient({ baseUrl });
            const summary = await client.getChallengeSummary(slug);
            store.summariesBySlug[slug] = summary;

            // Synchronize any cached extraction header without erasing stored chats.
            if (store.extractionsBySlug[slug]) {
              if (summary.challengeName) store.extractionsBySlug[slug].challengeName = summary.challengeName;
              if (summary.breakStats) store.extractionsBySlug[slug].breakStats = summary.breakStats;
              if (Array.isArray(summary.allModels) && summary.allModels.length) store.extractionsBySlug[slug].allModels = summary.allModels;
              if (Array.isArray(summary.allScenarios) && summary.allScenarios.length) store.extractionsBySlug[slug].allScenarios = summary.allScenarios;
            }
            await chrome.storage.local.set({
              summariesBySlug: store.summariesBySlug,
              extractionsBySlug: store.extractionsBySlug
            });
            sendResponse({ success: true, summary });
          } catch (err) {
            const cached = store.summariesBySlug[slug] || null;
            if (cached) {
              sendResponse({ success: true, summary: { ...cached, stale: true }, warning: err.message });
            } else {
              sendResponse({ success: false, error: err.message });
            }
          }
          break;
        }
        case 'START_EXTRACTION': {
          const p = message.payload || {};
          const maxPagesVal = p.maxPages === 0 || p.maxPages === '0' ? 0 : (parseInt(p.maxPages, 10) || 250);
          const result = await runExtraction({
            slug: String(p.slug || '').trim(),
            baseUrl: p.baseUrl,
            delayMs: parseInt(p.delayMs, 10) || 250,
            maxPages: maxPagesVal,
            fetchFullDetails: !!p.fetchFullDetails
          });
          sendResponse({ success: true, ...result });
          break;
        }
        case 'STOP_EXTRACTION': {
          const p = message.payload || {};
          if (activeClient) { activeClient.abort(); activeClient = null; }
          const store = await ensureStore();
          const targetSlug = String(p.slug || store.lastActiveSlug || '').trim();
          if (targetSlug && store.extractionsBySlug[targetSlug]) {
            store.extractionsBySlug[targetSlug].extractionStatus = 'stopped';
            await chrome.storage.local.set({ extractionsBySlug: store.extractionsBySlug });
          }
          await updateBadge('');
          sendResponse({ success: true, message: 'Extraction stopped' });
          break;
        }
        case 'GET_EXTRACTION_STATE': {
          const p = message.payload || {};
          const store = await ensureStore();
          let targetSlug = String(p.slug || '').trim();
          if (!targetSlug && p.allowFallbackLast) {
            targetSlug = store.lastActiveSlug || '';
          }
          const entry = targetSlug && store.extractionsBySlug[targetSlug]
            ? store.extractionsBySlug[targetSlug]
            : emptyExtractionEntry(targetSlug, p.baseUrl || DEFAULT_BASE_URL);
          const summary = targetSlug ? (store.summariesBySlug[targetSlug] || null) : null;
          sendResponse({
            success: true,
            data: entry,
            summary,
            lastActiveSlug: store.lastActiveSlug
          });
          break;
        }
        case 'CLEAR_EXTRACTION_DATA': {
          const p = message.payload || {};
          const slug = String(p.slug || '').trim();
          const store = await ensureStore();
          if (slug) {
            delete store.extractionsBySlug[slug];
            await chrome.storage.local.set({ extractionsBySlug: store.extractionsBySlug });
          } else {
            await chrome.storage.local.set({ extractionsBySlug: {}, lastActiveSlug: '' });
          }
          await updateBadge('');
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error('Service worker message error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true;
});

/** Parses slug, clean title, and base origin from a browser tab record. */
function parseTabInfo(tab) {
  if (!tab || !tab.url) return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  try {
    const url = new URL(tab.url);
    const isGSA = url.hostname.includes('grayswan.ai');
    const baseUrl = isGSA ? `${url.protocol}//${url.host}` : DEFAULT_BASE_URL;
    const match = url.pathname.match(/\/(?:arena\/)?challenge\/([^/?#]+)/i);
    const slug = match ? decodeURIComponent(match[1]) : '';

    let challengeName = '';
    if (slug && tab.title) {
      let clean = tab.title.split(/[|–—\-]\s*(?:Gray\s*Swan|GSA|Arena)/i)[0].trim();
      clean = clean.replace(/\s+Chat$/i, '').trim();
      if (clean && !/^gray\s*swan$|^arena$/i.test(clean)) challengeName = clean;
    }
    return { isGSA, slug, challengeName, baseUrl, tabId: tab.id };
  } catch {
    return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  }
}

/** Reads slug / name / origin from the active tab (with fallback if popup is opened as its own tab). */
async function detectActiveTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome-extension://')) {
      return parseTabInfo(tab);
    }

    // Fallback when popup.html is opened directly inside a browser tab.
    if (tab && tab.url && tab.url.startsWith('chrome-extension://')) {
      const extUrl = new URL(tab.url);
      const paramSlug = extUrl.searchParams.get('slug');
      const gsaTabs = await chrome.tabs.query({ url: ['https://app.grayswan.ai/*', 'https://*.grayswan.ai/*'] });
      const parsedGsa = (gsaTabs || [])
        .map(t => ({ t, info: parseTabInfo(t) }))
        .sort((a, b) => {
          const score = (x) => (x.info.slug ? 4 : 0) + (x.t.windowId === tab.windowId ? 2 : 0) + (x.t.lastAccessed ? 1 : 0);
          return score(b) - score(a) || (b.t.lastAccessed || 0) - (a.t.lastAccessed || 0);
        });
      if (paramSlug) {
        const matched = parsedGsa.find(x => x.info.slug === paramSlug);
        return matched ? matched.info : { isGSA: true, slug: paramSlug, challengeName: '', baseUrl: DEFAULT_BASE_URL, tabId: parsedGsa[0]?.t.id };
      }
      if (parsedGsa.length) return parsedGsa[0].info;
    }
    return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  } catch {
    return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  }
}

async function runExtraction({ slug, baseUrl, delayMs, maxPages, fetchFullDetails }) {
  if (!slug) throw new Error('No challenge detected. Open a Gray Swan Arena challenge page first.');
  const effectiveBase = baseUrl || DEFAULT_BASE_URL;
  activeClient = new GSAClient({ baseUrl: effectiveBase, delayMs });

  const store = await ensureStore();
  const prev = store.extractionsBySlug[slug] || emptyExtractionEntry(slug, effectiveBase);
  store.extractionsBySlug[slug] = { ...prev, challengeSlug: slug, baseUrl: effectiveBase, extractionStatus: 'running' };
  store.lastActiveSlug = slug;
  await chrome.storage.local.set({ extractionsBySlug: store.extractionsBySlug, lastActiveSlug: slug });
  await updateBadge('…', '#3b82f6');

  const onProgress = async (progress) => {
    try { await chrome.runtime.sendMessage({ type: 'EXTRACTION_PROGRESS', payload: { slug, ...progress } }); } catch {}
  };

  try {
    const extracted = await activeClient.extractUnified(slug, {
      maxPages, fetchFullDetails, onProgress, normalizer: GSANormalizer
    });

    const stats = { total: extracted.chats.length, rejected: 0, accepted: 0, errors: 0, pending: 0 };
    for (const chat of extracted.chats) {
      const outcome = chat.rejectionDetails?.outcome;
      if (outcome === 'rejected' || chat.rejectionDetails?.isRejected) stats.rejected++;
      else if (outcome === 'accepted') stats.accepted++;
      else if (outcome === 'error') stats.errors++;
      else stats.pending++;
    }

    const nowIso = new Date().toISOString();
    const resolvedName = extracted.challengeName || GSANormalizer.humanizeSlug(slug);

    const entry = {
      challengeSlug: slug,
      challengeName: resolvedName,
      baseUrl: effectiveBase,
      extractedChats: extracted.chats,
      modelMap: extracted.modelMap || {},
      scenarioMap: extracted.scenarioMap || {},
      allModels: extracted.allModels || [],
      allScenarios: extracted.allScenarios || [],
      breakStats: extracted.breakStats || null,
      lastExtractedAt: nowIso,
      extractionStatus: 'complete',
      stats,
      counts: extracted.counts || { chats: extracted.chats.length, submissions: 0 },
      serverTotals: extracted.serverTotals || { chats: extracted.chats.length, submissions: 0 },
      truncated: !!extracted.truncated,
      warnings: extracted.warnings || []
    };

    const latestStore = await ensureStore();
    latestStore.extractionsBySlug[slug] = entry;
    if (extracted.breakStats) {
      latestStore.summariesBySlug[slug] = {
        slug,
        challengeName: resolvedName,
        breakStats: extracted.breakStats,
        chatsCount: extracted.serverTotals?.chats ?? extracted.chats.length,
        submissionsCount: extracted.serverTotals?.submissions ?? extracted.counts?.submissions ?? 0,
        allModels: extracted.allModels || [],
        allScenarios: extracted.allScenarios || [],
        modelMap: extracted.modelMap || {},
        scenarioMap: extracted.scenarioMap || {},
        fetchedAt: nowIso
      };
    }
    await chrome.storage.local.set({
      extractionsBySlug: latestStore.extractionsBySlug,
      summariesBySlug: latestStore.summariesBySlug,
      lastActiveSlug: slug
    });

    await updateBadge(String(extracted.chats.length), extracted.chats.length ? '#10b981' : '#64748b');

    const payload = {
      slug,
      chats: extracted.chats,
      modelMap: entry.modelMap,
      scenarioMap: entry.scenarioMap,
      allModels: entry.allModels,
      allScenarios: entry.allScenarios,
      challengeName: resolvedName,
      breakStats: entry.breakStats,
      stats,
      counts: entry.counts,
      serverTotals: entry.serverTotals,
      truncated: entry.truncated,
      warnings: entry.warnings,
      extractedAt: nowIso
    };
    try { await chrome.runtime.sendMessage({ type: 'EXTRACTION_COMPLETE', payload }); } catch {}

    return payload;
  } catch (err) {
    const latestStore = await ensureStore();
    if (latestStore.extractionsBySlug[slug]) {
      latestStore.extractionsBySlug[slug].extractionStatus = 'error';
      await chrome.storage.local.set({ extractionsBySlug: latestStore.extractionsBySlug });
    }
    await updateBadge('!', '#ef4444');
    try { await chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', payload: { slug, error: err.message } }); } catch {}
    throw err;
  } finally {
    activeClient = null;
  }
}

async function updateBadge(text, color = '#10b981') {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}

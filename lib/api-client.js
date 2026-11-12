// lib/api-client.js
// Universal client for Gray Swan Arena.
// Discovers challenge metadata, models, scenarios, appeals, and live registered
// break counts directly from SvelteKit `__data.json` + `/panels/*` endpoints.

class GSAClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://app.grayswan.ai';
    this.delayMs = options.delayMs ?? 250;
    this.maxRetries = options.maxRetries ?? 2;
    this.abortController = null;
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** Authenticated GET using the browser session cookies. */
  async request(path, queryParams = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const signal = this.abortController ? this.abortController.signal : undefined;

    let response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Extraction cancelled by user');
      throw new Error(`Network error connecting to Gray Swan Arena: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authentication required (${response.status}). Please log into ${this.baseUrl} in your browser.`);
    }
    if (!response.ok) {
      const err = new Error(`Gray Swan Arena API error (${response.status}): ${response.statusText}`);
      err.status = response.status;
      throw err;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      if (text.includes('<!DOCTYPE html>') || text.includes('<html')) {
        throw new Error(`Session expired or login redirect detected. Please refresh your session at ${this.baseUrl}.`);
      }
      try { return JSON.parse(text); } catch { throw new Error(`Unexpected non-JSON response from ${path}`); }
    }
    return await response.json();
  }

  /** Like request() but swallows only non-auth / non-abort failures. */
  async tryRequest(path, queryParams = {}) {
    try { return await this.request(path, queryParams); }
    catch (err) {
      if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
      return null;
    }
  }

  async getChallengeDataJson(slug) {
    if (!slug) return null;
    const raw = await this.tryRequest(`/arena/challenge/${encodeURIComponent(slug)}/__data.json`);
    return GSAClient.parseDataJson(raw);
  }

  async getFilterOptions(slug) {
    if (!slug) return null;
    return await this.tryRequest(`/arena/challenge/${encodeURIComponent(slug)}/panels/filter-options`);
  }

  async getBatches(slug) {
    if (!slug) return null;
    return await this.tryRequest(`/arena/challenge/${encodeURIComponent(slug)}/panels/batches`);
  }

  async getChatsPage(slug, page = 0, limit = 50) {
    return await this.request(`/arena/challenge/${encodeURIComponent(slug)}/panels/chats`, { page, limit, sort: 'recent' });
  }

  async getSubmissionsPage(slug, page = 0, limit = 50) {
    return await this.request(`/arena/challenge/${encodeURIComponent(slug)}/panels/submissions`, { page, limit, sort: 'recent' });
  }

  async getChatDetail(slug, chatId) {
    if (!chatId) return null;
    const candidatePaths = [
      `/arena/challenge/${encodeURIComponent(slug)}/panels/chat/${encodeURIComponent(chatId)}`,
      `/arena/challenge/${encodeURIComponent(slug)}/chats/${encodeURIComponent(chatId)}`,
      `/arena/challenge/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}`,
      `/arena/chat/${encodeURIComponent(chatId)}`,
      `/arena/challenge/${encodeURIComponent(slug)}/panels/chats/${encodeURIComponent(chatId)}`
    ];
    for (const path of candidatePaths) {
      const data = await this.tryRequest(path);
      if (data && (data.messages || data.chat?.messages || data.data?.messages)) {
        return data.chat || data.data || data;
      }
    }
    return null;
  }

  // ----- SvelteKit devalue decoder & website break calculation -----------

  /**
   * Unflattens a SvelteKit devalue payload node array (`node.data`) into plain
   * JSON-safe JS values (`ObjectId`/`Date`/`BigInt` -> strings, `Set` -> arrays,
   * `Map` -> plain objects). Survives cyclic references via pre-registered cache.
   */
  static unflattenDevalue(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const cache = new Map();

    const hydrate = (idx) => {
      if (typeof idx !== 'number') return idx;
      if (idx === -1) return undefined;
      if (idx === -2) return null;
      if (idx === -3) return NaN;
      if (idx === -4) return Infinity;
      if (idx === -5) return -Infinity;
      if (idx === -6) return -0;
      if (idx < 0 || idx >= arr.length) return undefined;
      if (cache.has(idx)) return cache.get(idx);

      const raw = arr[idx];
      if (raw === null || typeof raw !== 'object') {
        cache.set(idx, raw);
        return raw;
      }

      if (Array.isArray(raw)) {
        const tag = raw[0];
        if (typeof tag === 'string') {
          if (tag === 'Date' || tag === 'ObjectId' || tag === 'BigInt' || tag === 'URL' || tag === 'URLSearchParams') {
            const val = typeof raw[1] === 'number' ? hydrate(raw[1]) : raw[1];
            const strVal = val === undefined || val === null ? '' : String(val);
            cache.set(idx, strVal);
            return strVal;
          }
          if (tag === 'RegExp') {
            const pat = typeof raw[1] === 'number' ? hydrate(raw[1]) : raw[1];
            const flg = raw.length > 2 ? (typeof raw[2] === 'number' ? hydrate(raw[2]) : raw[2]) : '';
            const out = { pattern: pat || '', flags: flg || '' };
            cache.set(idx, out);
            return out;
          }
          if (tag === 'Set') {
            const out = [];
            cache.set(idx, out);
            for (let i = 1; i < raw.length; i++) out.push(hydrate(raw[i]));
            return out;
          }
          if (tag === 'Map') {
            const out = {};
            cache.set(idx, out);
            for (let i = 1; i + 1 < raw.length; i += 2) {
              const k = String(hydrate(raw[i]));
              out[k] = hydrate(raw[i + 1]);
            }
            return out;
          }
          if (tag === 'null' && raw[1] && typeof raw[1] === 'object') {
            const out = {};
            cache.set(idx, out);
            for (const [k, vIdx] of Object.entries(raw[1])) out[k] = hydrate(vIdx);
            return out;
          }
        }

        const out = [];
        cache.set(idx, out);
        for (const itemIdx of raw) out.push(hydrate(itemIdx));
        return out;
      }

      const out = {};
      cache.set(idx, out);
      for (const [k, vIdx] of Object.entries(raw)) {
        out[k] = hydrate(vIdx);
      }
      return out;
    };

    return hydrate(0);
  }

  /**
   * Parses `/arena/challenge/{slug}/__data.json` response and extracts the
   * challenge node (`challengeInfo`, `modelMap`, `modelIdNameMap`, etc.) and root node.
   */
  static parseDataJson(raw) {
    if (!raw || !Array.isArray(raw.nodes)) return null;
    const decodedNodes = [];
    let challengeNode = null;
    let rootNode = null;

    for (let i = 0; i < raw.nodes.length; i++) {
      const node = raw.nodes[i];
      if (!node || node.type !== 'data' || !Array.isArray(node.data)) {
        decodedNodes.push(null);
        continue;
      }
      const unflattened = GSAClient.unflattenDevalue(node.data);
      decodedNodes.push(unflattened);
      if (i === 0) rootNode = unflattened;
      if (unflattened && (unflattened.challengeInfo || unflattened.behaviorIdToBehaviorMap || unflattened.modelListsByWave)) {
        challengeNode = unflattened;
      }
    }

    if (!challengeNode && decodedNodes[2]) challengeNode = decodedNodes[2];
    if (!challengeNode) return null;

    return { rootNode, challengeNode, nodes: decodedNodes };
  }

  /** Builds lookup key matching Arena frontend `Td(modelId, classifierId, wave)`. */
  static makeModelIndexKey(modelId, classifierId = null, wave = undefined) {
    const id = String(modelId || '').trim();
    const cls = classifierId !== undefined && classifierId !== null && String(classifierId).trim() !== ''
      ? String(classifierId).trim()
      : null;
    if (typeof wave === 'number' && !Number.isNaN(wave)) {
      return `${id}:${cls ?? ''}:${wave}`;
    }
    return cls ? `${id}:${cls}` : id;
  }

  /**
   * Replicates Arena's website break-count calculation (`Bv4MNIV6.js` Qe/X/$e/et).
   * Counts unique `(scenario, model)` pairs broken in active waves, distinct from
   * raw accepted submission count (`successfulSubmissionCount`).
   */
  static computeBreakStats(challengeNode, nowMs = Date.now()) {
    if (!challengeNode || typeof challengeNode !== 'object') return null;

    const info = challengeNode.challengeInfo || {};
    const waves = Array.isArray(info.waves) ? info.waves : [];
    const modelMap = challengeNode.modelMap || {};
    const modelListsByWave = challengeNode.modelListsByWave || {};
    const modelMapByBehavior = challengeNode.modelMapByBehavior || {};
    const behaviorMap = challengeNode.behaviorIdToBehaviorMap || {};
    const appeals = Array.isArray(challengeNode.appeals) ? challengeNode.appeals : [];

    // Collect displayed behavior IDs matching frontend displayedBehaviorIds.
    const collectedDisp = [];
    const pushBehaviorRef = (b) => {
      if (!b) return;
      if (typeof b === 'string') collectedDisp.push(b);
      else if (typeof b === 'object') {
        const id = b.behaviorId || b.behavior_id || b.id || b._id;
        if (id) collectedDisp.push(String(id));
      }
    };
    if (Array.isArray(info.behaviors)) info.behaviors.forEach(pushBehaviorRef);
    if (Array.isArray(info.categories)) {
      for (const cat of info.categories) {
        if (cat && Array.isArray(cat.behaviors)) cat.behaviors.forEach(pushBehaviorRef);
      }
    }
    if (Array.isArray(info.areas)) {
      for (const area of info.areas) {
        if (area && Array.isArray(area.behaviors)) area.behaviors.forEach(pushBehaviorRef);
      }
    }
    if (collectedDisp.length === 0) {
      for (const id of Object.keys(behaviorMap)) collectedDisp.push(id);
      for (const w of waves) {
        if (Array.isArray(w?.behaviors)) w.behaviors.forEach(pushBehaviorRef);
      }
    }
    const displayedSet = new Set(collectedDisp.filter(Boolean));

    const effectiveWaves = waves.length > 0
      ? waves
      : [{ start_time: null, behaviors: Array.from(displayedSet) }];

    const perWave = [];
    let registeredBreaks = 0;
    let totalCombinations = 0;
    const solvedBehaviors = new Set();
    const activeBehaviors = new Set();
    const fallbackModels = Object.keys(modelMap).map(name => ({ name, disabled: false, deprecated: false }));

    for (let waveIdx = 0; waveIdx < effectiveWaves.length; waveIdx++) {
      const wave = effectiveWaves[waveIdx] || {};
      const startMs = wave.start_time ? new Date(wave.start_time).getTime() : NaN;
      const started = Number.isNaN(startMs) || startMs <= nowMs;

      const waveRawBehaviors = Array.isArray(wave.behaviors) ? wave.behaviors : [];
      const waveBehaviors = [];
      const seenBeh = new Set();
      for (const b of waveRawBehaviors) {
        const bId = typeof b === 'string' ? b : String(b?.behaviorId || b?.id || '');
        if (!bId || !displayedSet.has(bId) || seenBeh.has(bId)) continue;
        seenBeh.add(bId);
        waveBehaviors.push(bId);
      }

      if (!started) {
        perWave.push({ waveIndex: waveIdx, started: false, completed: 0, total: 0, scenariosSolved: 0, totalScenarios: waveBehaviors.length });
        continue;
      }

      waveBehaviors.forEach(b => activeBehaviors.add(b));

      const waveModelsRaw = modelListsByWave[waveIdx + 1]
        ?? modelListsByWave[String(waveIdx + 1)]
        ?? modelListsByWave[1]
        ?? modelListsByWave['1']
        ?? fallbackModels;
      const waveModels = Array.isArray(waveModelsRaw) ? waveModelsRaw : [];

      let waveCompleted = 0;
      let waveTotal = 0;
      const waveSolvedBehaviors = new Set();

      for (const m of waveModels) {
        if (!m || m.disabled || m.deprecated) continue;
        if (Array.isArray(m.excluded_waves) && m.excluded_waves.includes(waveIdx)) continue;

        const mmGlobal = modelMap[m.name] || {};
        const disabledGlobal = new Set((mmGlobal.disabledBehaviors || []).map(String));
        if (Array.isArray(m.disabled_behaviors)) {
          for (const db of m.disabled_behaviors) disabledGlobal.add(String(db));
        }
        const succGlobal = new Set((mmGlobal.successfulSubmissionBehaviors || []).map(String));

        for (const behId of waveBehaviors) {
          const mmBeh = modelMapByBehavior?.[behId]?.[m.name];
          const disBeh = disabledGlobal.has(behId)
            || (Array.isArray(mmBeh?.disabledBehaviors) && mmBeh.disabledBehaviors.includes(behId));
          if (disBeh) continue;

          waveTotal += 1;
          const isSucc = succGlobal.has(behId)
            || (Array.isArray(mmBeh?.successfulSubmissionBehaviors) && mmBeh.successfulSubmissionBehaviors.includes(behId));
          if (isSucc) {
            waveCompleted += 1;
            solvedBehaviors.add(behId);
            waveSolvedBehaviors.add(behId);
          }
        }
      }

      registeredBreaks += waveCompleted;
      totalCombinations += waveTotal;
      perWave.push({
        waveIndex: waveIdx,
        started: true,
        completed: waveCompleted,
        total: waveTotal,
        scenariosSolved: waveSolvedBehaviors.size,
        totalScenarios: waveBehaviors.length
      });
    }

    let acceptedSubmissions = 0;
    const modelBreakdown = {};
    for (const [mName, mm] of Object.entries(modelMap)) {
      if (!mm || typeof mm !== 'object') continue;
      const succCount = Number(mm.successfulSubmissionCount || 0);
      const uniqueBehs = Array.isArray(mm.successfulSubmissionBehaviors)
        ? Array.from(new Set(mm.successfulSubmissionBehaviors.map(String)))
        : [];
      acceptedSubmissions += succCount;
      modelBreakdown[mName] = {
        uniqueBreaks: uniqueBehs.length,
        successfulSubmissionCount: succCount,
        successfulSubmissionBehaviors: uniqueBehs,
        communityBreaks: Number(mm.breaks || 0)
      };
    }

    return {
      registeredBreaks,
      totalCombinations,
      scenariosSolved: solvedBehaviors.size,
      totalScenarios: activeBehaviors.size || displayedSet.size || Object.keys(behaviorMap).length,
      acceptedSubmissions,
      solvedBehaviors: Array.from(solvedBehaviors),
      appealsCount: appeals.length,
      chatsCount: Number(challengeNode.chatsCount ?? 0),
      submissionsCount: Number(challengeNode.submissionsCount ?? 0),
      perWave,
      modelBreakdown
    };
  }

  /** Parses list responses into an array of items (tolerant to wrappers). */
  extractItems(responseData) {
    if (!responseData) return [];
    if (Array.isArray(responseData)) return responseData;
    const listKeys = ['userSubmissions', 'userChats', 'chats', 'submissions', 'models', 'agents', 'behaviors', 'scenarios', 'batches', 'challenges', 'data', 'items', 'results', 'records', 'conversations'];
    for (const key of listKeys) if (Array.isArray(responseData[key])) return responseData[key];
    const wrapperKeys = ['data', 'result', 'payload', 'body', 'response'];
    for (const w of wrapperKeys) {
      const nested = responseData[w];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        for (const key of listKeys) if (Array.isArray(nested[key])) return nested[key];
      }
    }
    if (responseData.chat && typeof responseData.chat === 'object') return [responseData.chat];
    if (responseData.submission && typeof responseData.submission === 'object') return [responseData.submission];
    return [];
  }

  // ----- Roster / metadata discovery -------------------------------------

  /**
   * Discovers authoritative challenge metadata from:
   *  1) `/arena/challenge/{slug}/__data.json` (complete roster, wave map, appeals, break math)
   *  2) `/arena/challenge/{slug}/panels/filter-options`
   *  3) `/arena/challenge/{slug}/panels/batches` (`batchGroupId` AND `behaviorId` -> `scenarioName`)
   */
  async discoverRoster(slug) {
    const modelMap = {};
    const modelIdIndex = {};
    const scenarioMap = {};
    const behaviorWaveMap = {};
    const appealsMap = {};
    const batchMap = new Map();
    const allModelsSet = new Set();
    const allScenariosSet = new Set();
    let challengeName = '';
    let breakStats = null;
    let chatsCount = 0;
    let submissionsCount = 0;

    const [parsedData, filterOpts, batchesResp] = await Promise.all([
      this.getChallengeDataJson(slug),
      this.getFilterOptions(slug),
      this.getBatches(slug)
    ]);

    if (parsedData && parsedData.challengeNode) {
      const cn = parsedData.challengeNode;
      const info = cn.challengeInfo || {};
      challengeName = info.name || info.title || '';
      chatsCount = Number(cn.chatsCount ?? 0);
      submissionsCount = Number(cn.submissionsCount ?? 0);

      // 1. Model lookup index (matching Arena `Td(model_id, classifier_id, wave)`).
      const idNameMap = cn.modelIdNameMap || {};
      for (const [mIdRaw, entries] of Object.entries(idNameMap)) {
        const list = Array.isArray(entries) ? entries : [entries];
        for (const entry of list) {
          if (!entry || !entry.name) continue;
          const mId = this._id(entry.model_id || entry._id || mIdRaw);
          if (!mId) continue;
          const name = String(entry.name).trim();
          const cls = entry.classifier_id ? String(entry.classifier_id).trim() : null;
          const wave = typeof entry.wave === 'number' ? entry.wave : undefined;

          if (!modelMap[mId]) modelMap[mId] = name;
          if (!modelIdIndex[mId]) modelIdIndex[mId] = name;
          modelIdIndex[GSAClient.makeModelIndexKey(mId, cls, wave)] = name;
          if (cls) modelIdIndex[GSAClient.makeModelIndexKey(mId, cls)] = name;
          if (typeof wave === 'number') modelIdIndex[GSAClient.makeModelIndexKey(mId, null, wave)] = name;
          if (!entry.disabled && !entry.deprecated) allModelsSet.add(name);
        }
      }

      // Also scan modelListsByWave to ensure every wave model is indexed.
      const waveLists = cn.modelListsByWave || {};
      for (const [waveKey, entries] of Object.entries(waveLists)) {
        if (!Array.isArray(entries)) continue;
        const waveNum = parseInt(waveKey, 10);
        for (const entry of entries) {
          if (!entry || !entry.name) continue;
          const mId = this._id(entry.model_id || entry._id);
          const name = String(entry.name).trim();
          const cls = entry.classifier_id ? String(entry.classifier_id).trim() : null;
          if (mId) {
            if (!modelMap[mId]) modelMap[mId] = name;
            if (!modelIdIndex[mId]) modelIdIndex[mId] = name;
            if (!Number.isNaN(waveNum)) {
              modelIdIndex[GSAClient.makeModelIndexKey(mId, cls, waveNum)] = name;
              modelIdIndex[GSAClient.makeModelIndexKey(mId, null, waveNum)] = name;
            }
          }
          if (!entry.disabled && !entry.deprecated) allModelsSet.add(name);
        }
      }

      // If modelMap from challenge node exists by name, include active model names too.
      if (allModelsSet.size === 0 && cn.modelMap) {
        for (const name of Object.keys(cn.modelMap)) allModelsSet.add(name);
      }

      // 2. Complete behavior/scenario map (`behaviorIdToBehaviorMap`).
      const bMap = cn.behaviorIdToBehaviorMap || {};
      for (const [bKeyRaw, bObj] of Object.entries(bMap)) {
        if (!bObj || typeof bObj !== 'object') continue;
        const bKey = String(bObj.behaviorId || bKeyRaw || '').toLowerCase().trim();
        const bName = bObj.name ? String(bObj.name).trim() : '';
        if (bKey && bName) {
          scenarioMap[bKey] = bName;
          allScenariosSet.add(bName);
        }
        if (bKey && typeof bObj.wave === 'number') {
          behaviorWaveMap[bKey] = bObj.wave;
        }
      }

      // 3. Human/auto appeal map keyed by submission_id.
      if (Array.isArray(cn.appeals)) {
        for (const ap of cn.appeals) {
          if (!ap || typeof ap !== 'object') continue;
          const subId = this._id(ap.submission_id || ap.submissionId);
          if (subId) {
            appealsMap[subId] = {
              _id: this._id(ap._id),
              submission_id: subId,
              appeal_status: ap.appeal_status || null,
              manual_status: ap.manual_status || null,
              appeal_analysis: ap.appeal_analysis || null
            };
          }
        }
      }

      breakStats = GSAClient.computeBreakStats(cn);
    }

    // Supplement with `/panels/filter-options`
    if (filterOpts && typeof filterOpts === 'object') {
      if (Array.isArray(filterOpts.behaviors)) {
        for (const b of filterOpts.behaviors) {
          if (!b || typeof b !== 'object') continue;
          const key = String(b.id || b.behaviorId || b._id || '').toLowerCase().trim();
          const name = b.name ? String(b.name).trim() : '';
          if (key && name) {
            if (!scenarioMap[key]) scenarioMap[key] = name;
            allScenariosSet.add(name);
          }
        }
      }
      if (Array.isArray(filterOpts.models)) {
        this.harvestModelList(filterOpts.models, modelMap);
      }
    }

    // Supplement with `/panels/batches` (`batchGroupId` AND `behaviorId` -> `scenarioName`)
    if (batchesResp) {
      for (const b of this.extractItems(batchesResp)) {
        const bgId = this._id(b.batchGroupId || b.batch_group_id || b.batchId || b.id || b._id);
        const behKey = String(b.behaviorId || b.behavior_id || b.behavior || '').toLowerCase().trim();
        const name = (b.scenarioName || b.scenario || b.behaviorName || b.name || '').trim();
        if (bgId && name) {
          batchMap.set(bgId, name);
          scenarioMap[`batchgroup:${bgId}`] = name;
        }
        if (behKey && name) {
          if (!scenarioMap[behKey]) scenarioMap[behKey] = name;
          allScenariosSet.add(name);
        }
      }
    }

    return {
      challengeName,
      modelMap,
      modelIdIndex,
      scenarioMap,
      behaviorWaveMap,
      appealsMap,
      batchMap,
      breakStats,
      chatsCount,
      submissionsCount,
      allModels: Array.from(allModelsSet).sort((a, b) => a.localeCompare(b)),
      allScenarios: Array.from(allScenariosSet).sort((a, b) => a.localeCompare(b))
    };
  }

  /** Convenience method used by popup & content widget to sync website counts immediately. */
  async getChallengeSummary(slug) {
    if (!slug) throw new Error('Challenge slug is required');
    const roster = await this.discoverRoster(slug);
    return {
      slug,
      challengeName: roster.challengeName,
      breakStats: roster.breakStats,
      chatsCount: roster.chatsCount || roster.breakStats?.chatsCount || 0,
      submissionsCount: roster.submissionsCount || roster.breakStats?.submissionsCount || 0,
      allModels: roster.allModels,
      allScenarios: roster.allScenarios,
      modelMap: roster.modelMap,
      scenarioMap: roster.scenarioMap,
      fetchedAt: new Date().toISOString()
    };
  }

  harvestModelList(list, modelMap) {
    if (!Array.isArray(list)) return;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const id = this._id(m.id || m._id || m.modelId || m.model_id || m.agentId || m.agent_id);
      const name = m.name || m.modelName || m.model_name || m.alias || m.displayName || m.label;
      if (id && name) modelMap[id] = String(name);
    }
  }

  harvestBehaviorList(list, scenarioMap) {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      const key = String(b.id || b._id || b.behaviorId || b.behavior_id || b.key || b.slug || '').toLowerCase().trim();
      const name = b.name || b.scenarioName || b.behaviorName || b.title || b.label;
      if (key && name) scenarioMap[key] = String(name);
    }
  }

  _id(val) {
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') return val.$oid ? String(val.$oid) : String(val._id || val.id || '');
    return String(val).trim();
  }

  /** Best-effort list of challenges the user can see (from SvelteKit data or endpoints). */
  async listChallenges() {
    const out = [];
    const seen = new Set();
    const pushItem = (c) => {
      if (!c || typeof c !== 'object') return;
      const slug = c.slug || c.challengeSlug || c.key;
      if (!slug || seen.has(String(slug))) return;
      seen.add(String(slug));
      out.push({ slug: String(slug), name: c.name || c.title || c.displayName || String(slug) });
    };

    for (const p of ['/challenges/__data.json', '/arena/__data.json']) {
      const resp = await this.tryRequest(p);
      if (!resp || !Array.isArray(resp.nodes)) continue;
      for (const n of resp.nodes) {
        if (!n || n.type !== 'data' || !Array.isArray(n.data)) continue;
        const decoded = GSAClient.unflattenDevalue(n.data);
        if (decoded && Array.isArray(decoded.challenges)) decoded.challenges.forEach(pushItem);
      }
      if (out.length) return out;
    }

    for (const p of ['/arena/challenges', '/arena/panels/challenges']) {
      const resp = await this.tryRequest(p);
      if (!resp) continue;
      this.extractItems(resp).forEach(pushItem);
      if (out.length) break;
    }
    return out;
  }

  // ----- Pagination & Extraction -----------------------------------------

  async extractAllChats(slug, options = {}, metaOut = null) {
    this.abortController = new AbortController();
    const limit = options.limit || 50;
    const maxPages = options.maxPages === 0 ? Infinity : (options.maxPages || 250);
    const onProgress = options.onProgress || (() => {});
    const fetchFullDetails = options.fetchFullDetails ?? false;

    const allChats = [];
    const seenIds = new Set();
    let page = 0;
    let pagesScanned = 0;
    let hasMore = true;
    let truncated = false;
    let serverTotal = null;

    while (hasMore) {
      if (pagesScanned >= maxPages) {
        truncated = true;
        break;
      }
      onProgress({ type: 'chats_page', page, totalFound: allChats.length, status: `Fetching chats page ${page}...` });
      let resp;
      try {
        resp = await this.getChatsPage(slug, page, limit);
      } catch (err) {
        if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
        if (page === 0) { page = 1; continue; }
        throw err;
      }

      if (serverTotal === null && typeof resp.total === 'number') serverTotal = resp.total;
      const items = this.extractItems(resp);
      if (items.length === 0) {
        if (page === 0) { page = 1; continue; }
        break;
      }

      pagesScanned++;
      let newItemsOnPage = 0;
      for (const item of items) {
        const cleanId = this._id(item.chatId || item.id || item._id);
        if (cleanId && seenIds.has(cleanId)) continue;
        if (cleanId) seenIds.add(cleanId);

        let fullItem = item;
        const msgList = item.messages || item.chat?.messages || item.conversation;
        if (fetchFullDetails && (!msgList || msgList.length === 0) && cleanId) {
          const detail = await this.getChatDetail(slug, cleanId);
          if (detail) fullItem = { ...item, ...detail };
          await this.sleep(100);
        }
        allChats.push(fullItem);
        newItemsOnPage++;
      }
      if (newItemsOnPage === 0 && items.length > 0) break;

      const totalPages = resp.totalPages || resp.total_pages || resp.pagination?.totalPages || resp.pagination?.total_pages || resp.meta?.totalPages;
      const hasMoreFlag = resp.hasMore ?? resp.has_more ?? resp.pagination?.hasMore ?? resp.pagination?.has_more;
      if (totalPages && (page + 1) >= totalPages) hasMore = false;
      else if (hasMoreFlag === false) hasMore = false;
      else { page++; await this.sleep(this.delayMs); }
    }

    if (metaOut) {
      metaOut.chatsTruncated = truncated;
      metaOut.chatsServerTotal = serverTotal ?? allChats.length;
    }
    return allChats;
  }

  async extractAllSubmissions(slug, options = {}, metaOut = null) {
    this.abortController = new AbortController();
    const limit = options.limit || 50;
    const maxPages = options.maxPages === 0 ? Infinity : (options.maxPages || 250);
    const onProgress = options.onProgress || (() => {});

    const allSubmissions = [];
    const seenIds = new Set();
    let page = 0;
    let pagesScanned = 0;
    let hasMore = true;
    let truncated = false;
    let serverTotal = null;

    while (hasMore) {
      if (pagesScanned >= maxPages) {
        truncated = true;
        break;
      }
      onProgress({ type: 'submissions_page', page, totalFound: allSubmissions.length, status: `Fetching submissions page ${page}...` });
      let resp;
      try {
        resp = await this.getSubmissionsPage(slug, page, limit);
      } catch (err) {
        if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
        if (page === 0) { page = 1; continue; }
        throw err;
      }

      if (serverTotal === null && typeof resp.total === 'number') serverTotal = resp.total;
      const items = this.extractItems(resp);
      if (items.length === 0) {
        if (page === 0) { page = 1; continue; }
        break;
      }

      pagesScanned++;
      let newItemsOnPage = 0;
      for (const item of items) {
        const cleanId = this._id(item.submissionId || item.id || item._id);
        if (cleanId && seenIds.has(cleanId)) continue;
        if (cleanId) seenIds.add(cleanId);
        allSubmissions.push(item);
        newItemsOnPage++;
      }
      if (newItemsOnPage === 0 && items.length > 0) break;

      const totalPages = resp.totalPages || resp.total_pages || resp.pagination?.totalPages || resp.pagination?.total_pages || resp.meta?.totalPages;
      const hasMoreFlag = resp.hasMore ?? resp.has_more ?? resp.pagination?.hasMore ?? resp.pagination?.has_more;
      if (totalPages && (page + 1) >= totalPages) hasMore = false;
      else if (hasMoreFlag === false) hasMore = false;
      else { page++; await this.sleep(this.delayMs); }
    }

    if (metaOut) {
      metaOut.subsTruncated = truncated;
      metaOut.subsServerTotal = serverTotal ?? allSubmissions.length;
    }
    return allSubmissions;
  }

  getChatIdFrom(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj.trim();
    if (typeof obj === 'number') return String(obj);
    if (typeof obj === 'object') {
      const ref = obj.chatId || obj.chat_id;
      if (ref) return typeof ref === 'string' ? ref.trim() : (ref.$oid ? String(ref.$oid).trim() : String(ref).trim());
      if (obj.chat) {
        if (typeof obj.chat === 'string') return obj.chat.trim();
        if (typeof obj.chat === 'object') {
          const nested = obj.chat.chatId || obj.chat.chat_id || obj.chat._id || obj.chat.id;
          if (nested) return typeof nested === 'string' ? nested.trim() : (nested.$oid ? String(nested.$oid).trim() : String(nested).trim());
        }
      }
      const selfId = obj._id || obj.id;
      if (selfId) return typeof selfId === 'string' ? selfId.trim() : (selfId.$oid ? String(selfId.$oid).trim() : String(selfId).trim());
    }
    return '';
  }

  /**
   * Selects the authoritative submission among multiple submissions for a single chat:
   *  1) Any submission with a winning appeal (`appeal_status === 'success'` or `manual_status === 'success'`)
   *  2) Any confirmed accepted break (`successful === true`, `grading.is_break === true`, or `grade_status === 'success'` without `successful === false`)
   *  3) Otherwise the most recent submission by `created_at` / `updated_at`.
   */
  static selectPrimarySubmission(subs, appealsMap = {}) {
    if (!Array.isArray(subs) || subs.length === 0) return null;

    const scoreSubmission = (sub) => {
      const subId = sub._id?.$oid || String(sub._id || sub.id || '');
      const appeal = sub.appeal || (subId ? appealsMap[subId] : null);
      const apSucc = appeal && (appeal.appeal_status === 'success' || appeal.manual_status === 'success');
      if (apSucc) return 3;

      const isConfirmedBreak = sub.successful === true
        || sub.grading?.is_break === true
        || (sub.grade_status === 'success' && sub.successful !== false && sub.grading?.is_break !== false);
      if (isConfirmedBreak) return 2;

      const gs = (sub.grade_status || '').toLowerCase();
      if (gs === 'ungraded' || gs === 'maybe_success') return 1;
      return 0;
    };

    const tsOf = (sub) => {
      const t = new Date(sub.updated_at || sub.created_at || 0).getTime();
      return Number.isNaN(t) ? 0 : t;
    };

    const enriched = subs.map((s, idx) => {
      const subId = this._protoId(s);
      const appeal = subId && appealsMap[subId] ? appealsMap[subId] : s.appeal || null;
      return { sub: appeal ? { ...s, appeal } : s, rank: scoreSubmission(s), ts: tsOf(s), idx };
    });

    enriched.sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.idx - b.idx; // preserve sort=recent newest-first tie-breaker
    });

    const primary = enriched[0].sub;
    if (subs.length > 1) {
      return { ...primary, submissionCount: subs.length };
    }
    return primary;
  }

  static _protoId(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const v = obj.submissionId || obj._id || obj.id;
    if (!v) return '';
    return typeof v === 'object' && v.$oid ? String(v.$oid) : String(v);
  }

  /**
   * Unified extraction. Returns:
   *   { chats, modelMap, scenarioMap, allModels, allScenarios, challengeName,
   *     breakStats, counts, warnings, truncated, serverTotals }
   */
  async extractUnified(slug, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const normalizer = options.normalizer
      || (typeof GSANormalizer !== 'undefined' ? GSANormalizer : null)
      || (typeof require !== 'undefined' ? require('./normalizer') : null);

    const warnings = [];
    onProgress({ status: 'Discovering challenge metadata, roster & breaks...' });

    let roster = {
      challengeName: '', modelMap: {}, modelIdIndex: {}, scenarioMap: {},
      behaviorWaveMap: {}, appealsMap: {}, batchMap: new Map(), breakStats: null,
      chatsCount: 0, submissionsCount: 0, allModels: [], allScenarios: []
    };
    try {
      roster = await this.discoverRoster(slug);
    } catch (err) {
      if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
      warnings.push(`Challenge metadata warning: ${err.message}`);
    }

    const paginationMeta = {};
    onProgress({ status: 'Fetching chats...' });
    const rawChats = await this.extractAllChats(slug, options, paginationMeta);
    if (paginationMeta.chatsTruncated) {
      warnings.push(`Chats capped by Max pages setting (fetched ${rawChats.length} of ${paginationMeta.chatsServerTotal}). Set Max pages to 0 for unlimited.`);
    }

    onProgress({ status: `Retrieved ${rawChats.length} chats. Fetching submissions...` });
    let rawSubmissions = [];
    try {
      rawSubmissions = await this.extractAllSubmissions(slug, options, paginationMeta);
      if (paginationMeta.subsTruncated) {
        warnings.push(`Submissions capped by Max pages setting (fetched ${rawSubmissions.length} of ${paginationMeta.subsServerTotal}).`);
      }
    } catch (err) {
      if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
      warnings.push(`Submissions fetch warning: ${err.message}`);
    }

    // Pass 1: harvest id->name pairs from the raw data into the roster maps.
    const maps = {
      slug,
      modelMap: { ...roster.modelMap },
      modelIdIndex: { ...roster.modelIdIndex },
      scenarioMap: { ...roster.scenarioMap },
      behaviorWaveMap: { ...roster.behaviorWaveMap },
      appealsMap: { ...roster.appealsMap },
      allModels: [...roster.allModels],
      batchMap: roster.batchMap
    };
    if (normalizer && normalizer.harvestMaps) {
      for (const c of rawChats) normalizer.harvestMaps(c, maps);
      for (const s of rawSubmissions) normalizer.harvestMaps(s, maps);
    }

    // Group ALL submissions by chat_id instead of overwriting newer with older.
    const subsByChatId = new Map();
    for (const sub of rawSubmissions) {
      const cId = this.getChatIdFrom(sub);
      if (!cId) continue;
      let list = subsByChatId.get(cId);
      if (!list) {
        list = [];
        subsByChatId.set(cId, list);
      }
      list.push(sub);
    }

    // Pass 2: normalize.
    const challengeName = roster.challengeName
      || (normalizer ? normalizer.resolveChallengeName(slug, {}, rawChats[0] || {}) : slug);

    const unifiedList = [];
    const seenChatIds = new Set();

    for (const rawChat of rawChats) {
      const cId = this.getChatIdFrom(rawChat);
      const chatSubs = cId ? subsByChatId.get(cId) : null;
      const associatedSub = chatSubs
        ? GSAClient.selectPrimarySubmission(chatSubs, maps.appealsMap)
        : null;
      const normalized = normalizer
        ? normalizer.normalizeArenaChat({ ...rawChat, submission: associatedSub }, { slug, challengeName, maps, batchMap: roster.batchMap })
        : rawChat;
      unifiedList.push(normalized);
      if (cId) seenChatIds.add(cId);
    }

    for (const [cId, chatSubs] of subsByChatId.entries()) {
      if (seenChatIds.has(cId)) continue;
      const primary = GSAClient.selectPrimarySubmission(chatSubs, maps.appealsMap);
      if (!primary || (!primary.chat && !primary.messages)) continue;
      const item = typeof primary.chat === 'object' ? primary.chat : primary;
      const normalized = normalizer
        ? normalizer.normalizeArenaChat({ ...item, submission: primary }, { slug, challengeName, maps, batchMap: roster.batchMap })
        : item;
      unifiedList.push(normalized);
      seenChatIds.add(cId);
    }

    const allModelsSet = new Set(roster.allModels);
    const allScenariosSet = new Set(roster.allScenarios);
    for (const c of unifiedList) {
      if (c.model && c.model !== 'Unknown model') allModelsSet.add(c.model);
      if (c.scenario && c.scenario !== 'Unknown scenario' && !maps.scenarioMap[c.scenario]) {
        allScenariosSet.add(c.scenario);
      }
    }

    return {
      chats: unifiedList,
      modelMap: maps.modelMap,
      scenarioMap: maps.scenarioMap,
      allModels: Array.from(allModelsSet).sort((a, b) => a.localeCompare(b)),
      allScenarios: Array.from(allScenariosSet).sort((a, b) => a.localeCompare(b)),
      challengeName,
      breakStats: roster.breakStats,
      counts: { chats: rawChats.length, submissions: rawSubmissions.length },
      serverTotals: {
        chats: paginationMeta.chatsServerTotal ?? roster.chatsCount ?? rawChats.length,
        submissions: paginationMeta.subsServerTotal ?? roster.submissionsCount ?? rawSubmissions.length
      },
      truncated: !!(paginationMeta.chatsTruncated || paginationMeta.subsTruncated),
      warnings
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSAClient };
} else if (typeof globalThis !== 'undefined') {
  globalThis.GSAClient = GSAClient;
}

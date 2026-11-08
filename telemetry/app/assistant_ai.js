// Telemetry's assistant on a computer. The AI runs on the computer itself,
// never on Telemetry's servers. The first of these that works is used:
//   1. the browser's built-in AI, through the Prompt API (Gemini Nano in
//      Chrome; Edge has its own model);
//   2. Ollama on this computer, if the person turns it on in the assistant
//      (off by default: reaching localhost makes Chrome ask about the local
//      network, and Ollama has to allow this site with OLLAMA_ORIGINS);
//   3. a small open model run by WebLLM on the computer's graphics chip,
//      after a one-time download that the browser keeps: Qwen2.5 1.5B (about
//      1 GB) unless the person downloaded a bigger one from the list below;
//   4. otherwise the app searches the team's data instead (no AI).
// The person can also pick one in the chat (choose(); options() lists them,
// including models not downloaded yet). Their pick is used while it's
// available, otherwise the order above.
// Questions and answers stay on the computer with all of them. The Dart side
// is lib/assistant/web_model_web.dart.
(function () {
  'use strict';

  // Pinned: the WebLLM library (served from this site; tool/build_web.sh fetches
  // it from npm and checks its hash). Its models download from Hugging Face.
  var WEBLLM = new URL('vendor/web-llm-0.2.86.js', document.baseURI).href;
  var OLLAMA = 'http://localhost:11434';
  var LANGS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };

  // Models WebLLM can run in the browser (all in its built-in list), smallest
  // first; the first is the default. 'big' ones need about 5 GB of graphics memory.
  var WEBLLM_MODELS = [
    { key: 'qwen2.5-1.5b', name: 'Qwen2.5 1.5B', short: 'Qwen 1.5B', mlc: 'Qwen2.5-1.5B-Instruct', size: 'about 1 GB' },
    { key: 'llama3.2-3b', name: 'Llama 3.2 3B', short: 'Llama 3B', mlc: 'Llama-3.2-3B-Instruct', size: 'about 2 GB' },
    { key: 'qwen2.5-3b', name: 'Qwen2.5 3B', short: 'Qwen 3B', mlc: 'Qwen2.5-3B-Instruct', size: 'about 2 GB' },
    { key: 'qwen2.5-7b', name: 'Qwen2.5 7B', short: 'Qwen 7B', mlc: 'Qwen2.5-7B-Instruct', size: 'about 4.5 GB', big: true },
    { key: 'llama3.1-8b', name: 'Llama 3.1 8B', short: 'Llama 8B', mlc: 'Llama-3.1-8B-Instruct', size: 'about 4.5 GB', big: true },
  ];
  // Ollama models offered for download when Ollama is running (each is that
  // model's default size, so 'name:latest' is the same model).
  var OLLAMA_SUGGESTED = [
    { name: 'llama3.2:3b', size: '2 GB' },
    { name: 'gemma3:4b', size: '3.3 GB' },
    { name: 'qwen2.5:7b', size: '4.7 GB' },
    { name: 'llama3.1:8b', size: '4.9 GB' },
  ];

  // This site's storage is shared with the 13115 Task Tracker, so names start with telemetry/.
  function saved(key) {
    try { return localStorage.getItem('telemetry/ai/' + key); } catch (_) { return null; }
  }
  function save(key, value) {
    try {
      if (value == null) localStorage.removeItem('telemetry/ai/' + key);
      else localStorage.setItem('telemetry/ai/' + key, value);
    } catch (_) { /* private window: just not remembered */ }
  }

  // The WebLLM models this browser has downloaded (WebLLM's own ids).
  function downloaded() {
    var list = [];
    try { list = JSON.parse(saved('webllm-models') || '[]'); } catch (_) { list = []; }
    var old = saved('webllm'); // before more than one model could be downloaded
    if (old && list.indexOf(old) < 0) list.push(old);
    return list;
  }
  function markDownloaded(id, yes) {
    var list = downloaded().filter(function (m) { return m !== id; });
    if (yes) list.push(id);
    save('webllm', null);
    save('webllm-models', list.length ? JSON.stringify(list) : null);
  }

  var current = null;   // 'chrome' (the browser's built-in AI) | 'ollama' | 'webllm' | null
  var progress = null;  // 0 to 1 while a model downloads
  var preparing = null; // the download under way
  var abort = null;     // stops the answer being written
  var webllm = null, engine = null, engineModel = null;
  var ollamaModel = null;   // the Ollama model in use
  var ollamaNeedsPull = false; // it's picked but not on the computer yet
  var webllmEntry = WEBLLM_MODELS[0]; // the WebLLM model in use
  var loading = null;   // a WebLLM model being loaded
  var warming = null;   // a WebLLM model being loaded and warmed up (see warm)
  var warmedModel = null;
  // Right after Ollama is turned on, Chrome may first ask the person whether
  // this site can reach their computer's local network; wait for that answer.
  var ollamaJustTurnedOn = false;

  // Edge also has the Prompt API, with its own model.
  function browserName() {
    var brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    if (brands.some(function (b) { return /Edge/.test(b.brand); }) || /Edg\//.test(navigator.userAgent || '')) return 'Edge';
    return 'Chrome';
  }

  async function chromeAvailability() {
    if (!('LanguageModel' in self)) return 'unavailable';
    try { return await self.LanguageModel.availability(LANGS); } catch (_) {
      try { return await self.LanguageModel.availability(); } catch (_) { return 'unavailable'; }
    }
  }

  /** Ollama's chat models on this computer; null if it's off or not answering. */
  async function ollamaList() {
    if (saved('ollama') !== 'on') return null;
    try {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, ollamaJustTurnedOn ? 30000 : 1500);
      ollamaJustTurnedOn = false;
      var res = await fetch(OLLAMA + '/api/tags', { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return ((await res.json()).models || []).map(function (m) { return m.name; })
        .filter(function (n) { return !/embed/i.test(n); });
    } catch (_) { return null; }
  }

  function ollamaHas(installed, name) {
    return installed.indexOf(name) >= 0 || installed.indexOf(name.split(':')[0] + ':latest') >= 0;
  }

  async function findOllamaModel() {
    var names = (await ollamaList()) || [];
    return names.find(function (n) { return /llama3|qwen|gemma|phi|mistral/i.test(n); }) || names[0] || null;
  }

  /** Whether the graphics chip has 16-bit shaders; null without WebGPU. */
  async function gpuF16() {
    if (!navigator.gpu) return null;
    try {
      var adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      return adapter.features.has('shader-f16');
    } catch (_) { return null; }
  }

  function mlcId(entry, f16) { return entry.mlc + (f16 ? '-q4f16_1-MLC' : '-q4f32_1-MLC'); }

  function entryFor(key) {
    return WEBLLM_MODELS.find(function (e) { return e.key === key; }) || null;
  }

  function label(kind) {
    if (kind === 'chrome') return browserName() + "'s built-in AI";
    if (kind === 'ollama') return 'Ollama (' + ollamaModel + ')';
    if (kind === 'webllm') return webllmEntry.name + ', running in your browser';
    return null;
  }

  function sizeOf(kind) {
    if (kind === 'chrome') return 'a few GB';
    if (kind === 'webllm') return webllmEntry.size;
    if (kind === 'ollama') {
      var s = OLLAMA_SUGGESTED.find(function (o) { return o.name === ollamaModel; });
      return s ? s.size : null;
    }
    return null;
  }

  function result(kind, state, reason) {
    current = kind;
    return {
      state: state, engine: kind, label: label(kind), progress: progress, reason: reason || null,
      size: state === 'ready' ? null : sizeOf(kind),
    };
  }

  // A WebLLM model's status (warming it up if it's already downloaded).
  function webllmStatus(entry, f16) {
    webllmEntry = entry;
    var id = mlcId(entry, f16);
    var ready = engineModel === id || downloaded().indexOf(id) >= 0;
    // The assistant is open: have the model warm before the first question.
    if (ready && warmedModel !== id) warm(false).catch(function () { /* the question will report it */ });
    return result('webllm', ready ? 'ready' : 'downloadable');
  }

  // Automatic: the first WebLLM model this browser has, or else the default.
  function defaultEntry(f16) {
    var have = downloaded();
    return WEBLLM_MODELS.find(function (e) { return have.indexOf(mlcId(e, f16)) >= 0; }) || WEBLLM_MODELS[0];
  }

  // The person's pick from the chat, if it's available on this computer now.
  async function chosenStatus(choice) {
    if (choice === 'search') return result(null, 'unsupported', 'search');
    if (choice === 'chrome') {
      var c = await chromeAvailability();
      if (c === 'available') return result('chrome', 'ready');
      if (c === 'downloadable' || c === 'downloading') return result('chrome', c);
    } else if (choice.indexOf('ollama:') === 0) {
      var name = choice.slice(7);
      var installed = await ollamaList();
      if (installed) {
        if (ollamaHas(installed, name)) {
          ollamaModel = installed.indexOf(name) >= 0 ? name : name.split(':')[0] + ':latest';
          ollamaNeedsPull = false;
          return result('ollama', 'ready');
        }
        if (OLLAMA_SUGGESTED.some(function (o) { return o.name === name; })) {
          ollamaModel = name;
          ollamaNeedsPull = true;
          return result('ollama', 'downloadable');
        }
      }
    } else if (choice === 'webllm' || choice.indexOf('webllm:') === 0) {
      var f16 = await gpuF16();
      var entry = choice === 'webllm' ? WEBLLM_MODELS[0] : entryFor(choice.slice(7));
      if (f16 !== null && entry) return webllmStatus(entry, f16);
    }
    return null;
  }

  async function status() {
    if (preparing) return result(current, 'downloading');
    var choice = saved('choice');
    if (choice) {
      var picked = await chosenStatus(choice);
      if (picked) return picked;
    }
    var chrome = await chromeAvailability();
    if (chrome === 'available') return result('chrome', 'ready');
    ollamaModel = await findOllamaModel();
    ollamaNeedsPull = false;
    if (ollamaModel) return result('ollama', 'ready');
    if (chrome === 'downloadable' || chrome === 'downloading') return result('chrome', chrome);
    var f16 = await gpuF16();
    if (f16 !== null) return webllmStatus(defaultEntry(f16), f16);
    return result(null, 'unsupported', saved('ollama') === 'on' ? 'noOllama' : 'noWebGpu');
  }

  /** Every AI the person can pick on this computer, including ones to download, for the chat's menu. */
  async function options() {
    var list = [];
    var chrome = await chromeAvailability();
    if (chrome !== 'unavailable') {
      list.push({ id: 'chrome', label: browserName() + "'s built-in AI", short: browserName() + ' AI',
        state: chrome === 'available' ? 'ready' : chrome, size: chrome === 'available' ? null : 'a few GB' });
    }
    var installed = await ollamaList();
    if (installed) {
      installed.forEach(function (n) {
        list.push({ id: 'ollama:' + n, label: 'Ollama (' + n + ')', short: n, state: 'ready' });
      });
      OLLAMA_SUGGESTED.forEach(function (o) {
        if (!ollamaHas(installed, o.name)) {
          list.push({ id: 'ollama:' + o.name, label: 'Ollama (' + o.name + ')', short: o.name, state: 'downloadable', size: o.size });
        }
      });
    }
    var f16 = await gpuF16();
    if (f16 !== null) {
      var have = downloaded();
      WEBLLM_MODELS.forEach(function (e) {
        var id = mlcId(e, f16);
        var ready = engineModel === id || have.indexOf(id) >= 0;
        list.push({ id: 'webllm:' + e.key, label: e.name + ', running in your browser', short: e.short,
          state: ready ? 'ready' : 'downloadable', size: ready ? null : e.size, big: !!e.big });
      });
    }
    list.push({ id: 'search', label: 'Search only (no AI)', short: 'Search', state: 'ready' });
    return list;
  }

  async function loadWebLLM() {
    var f16 = await gpuF16();
    if (f16 === null) throw new Error("This browser can't use the computer's graphics chip (WebGPU).");
    var model = mlcId(webllmEntry, f16);
    if (loading) { try { await loading; } catch (_) { /* tried below */ } }
    if (engine && engineModel === model) return engine;
    loading = (async function () {
      try {
        webllm = webllm || await import(WEBLLM);
        if (engine) {
          // Another model was loaded: free the graphics memory first.
          try { await engine.unload(); } catch (_) { /* gone anyway */ }
          engine = null;
          engineModel = null;
        }
        var e = await webllm.CreateMLCEngine(model, {
          initProgressCallback: function (report) { progress = report.progress; },
        });
        engine = e;
        engineModel = model;
        warmedModel = null;
        markDownloaded(model, true);
        return e;
      } catch (e) {
        markDownloaded(model, false);
        throw e;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // Loads the model onto the graphics chip and writes a one-word answer,
  // which compiles its shaders: otherwise the first real question waits
  // several seconds before any words appear (measured: 6.5 s down to 1.5 s
  // on a 2018 MacBook Pro). With download false it does nothing if the
  // model isn't in the browser any more, so it's offered as a download again
  // instead of quietly downloading 1 GB or more.
  function warm(download) {
    if (warming) return warming;
    warming = (async function () {
      try {
        if (!download) {
          var f16 = await gpuF16();
          if (f16 === null) return;
          var model = mlcId(webllmEntry, f16);
          webllm = webllm || await import(WEBLLM);
          if (webllm.hasModelInCache && !(await webllm.hasModelInCache(model))) {
            markDownloaded(model, false);
            return;
          }
        }
        var e = await loadWebLLM();
        if (warmedModel !== engineModel) {
          await e.chat.completions.create({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 });
          warmedModel = engineModel;
        }
      } finally {
        warming = null;
      }
    })();
    return warming;
  }

  /** Asks Ollama to download a model, with progress. */
  async function pullOllama(name) {
    var res = await fetch(OLLAMA + '/api/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
    });
    if (!res.ok) throw new Error('Ollama answered ' + res.status);
    var layers = {};
    var body = res.body.getReader(), decoder = new TextDecoder(), buffered = '';
    for (;;) {
      var chunk = await body.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      var nl;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        var line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        var json = JSON.parse(line);
        if (json.error) throw new Error(json.error);
        if (json.digest && json.total) {
          layers[json.digest] = { total: json.total, completed: json.completed || 0 };
          var total = 0, completed = 0;
          Object.keys(layers).forEach(function (k) { total += layers[k].total; completed += layers[k].completed; });
          progress = total ? completed / total : progress;
        }
      }
    }
    ollamaNeedsPull = false;
  }

  /** Gets the model (a download the first time). Resolves once it's ready. */
  function prepare() {
    if (preparing) return preparing;
    var kind = current;
    progress = 0;
    preparing = (async function () {
      try {
        if (kind === 'chrome') {
          var session = await self.LanguageModel.create(Object.assign({}, LANGS, {
            monitor: function (m) { m.addEventListener('downloadprogress', function (e) { progress = e.loaded; }); },
          }));
          session.destroy();
        } else if (kind === 'webllm') {
          await warm(true);
        } else if (kind === 'ollama' && ollamaNeedsPull) {
          await pullOllama(ollamaModel);
        }
      } finally {
        preparing = null;
        progress = null;
      }
    })();
    return preparing;
  }

  /** Deletes the WebLLM models this browser downloaded (Chrome's and Ollama's are theirs to manage). */
  async function removeDownloads() {
    stop();
    if (warming) { try { await warming; } catch (_) { /* removing anyway */ } }
    if (engine) {
      try { await engine.unload(); } catch (_) { /* gone anyway */ }
      engine = null;
      engineModel = null;
      warmedModel = null;
    }
    webllm = webllm || await import(WEBLLM);
    for (var i = 0; i < WEBLLM_MODELS.length; i++) {
      for (var f16 of [true, false]) {
        try { await webllm.deleteModelAllInfoInCache(mlcId(WEBLLM_MODELS[i], f16)); } catch (_) { /* wasn't there */ }
      }
    }
    save('webllm', null);
    save('webllm-models', null);
  }

  /** Writes an answer, calling onText with the answer so far. Resolves with the whole answer. */
  async function ask(instructions, prompt, maxTokens, onText) {
    stop();
    var ctl = new AbortController();
    abort = ctl;
    var text = '';
    var limit = maxTokens * 6; // about maxTokens tokens, for the APIs without a limit
    function emit(next) { text = next; onText(text); }
    var messages = [{ role: 'system', content: instructions }, { role: 'user', content: prompt }];
    try {
      if (current === 'chrome') {
        var session = await self.LanguageModel.create(Object.assign({}, LANGS, {
          initialPrompts: [messages[0]], signal: ctl.signal,
        }));
        try {
          var reader = session.promptStreaming(prompt, { signal: ctl.signal }).getReader();
          for (;;) {
            var part = await reader.read();
            if (part.done) break;
            // Older Chrome sent the whole answer each time; newer sends what's new.
            emit(text && part.value.startsWith(text) ? part.value : text + part.value);
            if (text.length > limit) { ctl.abort(); break; }
          }
        } finally { session.destroy(); }
      } else if (current === 'ollama' && !ollamaNeedsPull) {
        var res = await fetch(OLLAMA + '/api/chat', {
          method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: ollamaModel, stream: true, options: { num_predict: maxTokens }, messages: messages }),
        });
        if (!res.ok) throw new Error('Ollama answered ' + res.status);
        var body = res.body.getReader(), decoder = new TextDecoder(), buffered = '';
        for (;;) {
          var chunk = await body.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          var nl;
          while ((nl = buffered.indexOf('\n')) >= 0) {
            var line = buffered.slice(0, nl).trim();
            buffered = buffered.slice(nl + 1);
            if (!line) continue;
            var json = JSON.parse(line);
            if (json.error) throw new Error(json.error);
            if (json.message && json.message.content) emit(text + json.message.content);
          }
        }
      } else if (current === 'webllm') {
        if (warming) { try { await warming; } catch (_) { /* loading again below reports it */ } }
        var e = await loadWebLLM();
        ctl.signal.addEventListener('abort', function () { e.interruptGenerate(); });
        var chunks = await e.chat.completions.create({
          stream: true, max_tokens: maxTokens, temperature: 0.3, messages: messages,
        });
        for await (var c of chunks) {
          var delta = c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content;
          if (delta) emit(text + delta);
        }
      } else {
        throw new Error('There is no AI on this computer.');
      }
    } catch (err) {
      if (!ctl.signal.aborted) throw err;
    } finally {
      if (abort === ctl) abort = null;
    }
    return text;
  }

  function stop() {
    if (abort) abort.abort();
    abort = null;
  }

  window.telemetryAI = {
    status: status,
    prepare: prepare,
    ask: ask,
    stop: stop,
    setOllama: function (on) { ollamaJustTurnedOn = !!on; save('ollama', on ? 'on' : null); },
    get ollamaOn() { return saved('ollama') === 'on'; },
    options: options,
    /** 'auto' (the order above) or an id from options(). */
    choose: function (id) { save('choice', !id || id === 'auto' ? null : id); },
    get chosen() { return saved('choice') || 'auto'; },
    removeDownloads: removeDownloads,
  };
})();

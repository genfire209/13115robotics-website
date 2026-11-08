// Telemetry's assistant on a computer. The AI runs on the computer itself,
// never on Telemetry's servers. The first of these that works is used:
//   1. the browser's built-in AI, through the Prompt API (Gemini Nano in
//      Chrome; Edge has its own model);
//   2. Ollama on this computer, if the person turns it on in the assistant
//      (off by default: reaching localhost makes Chrome ask about the local
//      network, and Ollama has to allow this site with OLLAMA_ORIGINS);
//   3. a small open model, Qwen2.5 1.5B (Apache 2.0), run by WebLLM on the
//      computer's graphics chip, after a one-time download of about 1 GB
//      that the browser keeps;
//   4. otherwise the app searches the team's data instead (no AI).
// The person can also pick one of these in the chat (choose(); options()
// lists them); their pick is used while it's available, otherwise the order
// above.
// Questions and answers stay on the computer with all of them. The Dart side
// is lib/assistant/web_model_web.dart.
(function () {
  'use strict';

  // Pinned: the WebLLM library (served from this site; tool/build_web.sh fetches
  // it from npm and checks its hash) and the model it downloads (from Hugging Face).
  var WEBLLM = new URL('vendor/web-llm-0.2.86.js', document.baseURI).href;
  var QWEN_F16 = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
  var QWEN_F32 = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC';
  var OLLAMA = 'http://localhost:11434';
  var LANGS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };

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

  var current = null;   // 'chrome' (the browser's built-in AI) | 'ollama' | 'webllm' | null
  var progress = null;  // 0 to 1 while a model downloads
  var preparing = null; // the download under way
  var abort = null;     // stops the answer being written
  var webllm = null, engine = null, engineModel = null, ollamaModel = null;
  var loading = null;   // the WebLLM model being loaded
  var warming = null;   // the WebLLM model being loaded and warmed up (see warm)
  var warmed = false;
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

  /** Ollama's chat models on this computer, if it's turned on and answering ([] otherwise). */
  async function ollamaModels() {
    if (saved('ollama') !== 'on') return [];
    try {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, ollamaJustTurnedOn ? 30000 : 1500);
      ollamaJustTurnedOn = false;
      var res = await fetch(OLLAMA + '/api/tags', { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      return ((await res.json()).models || []).map(function (m) { return m.name; })
        .filter(function (n) { return !/embed/i.test(n); });
    } catch (_) { return []; }
  }

  async function findOllamaModel() {
    var names = await ollamaModels();
    return names.find(function (n) { return /llama3|qwen|gemma|phi|mistral/i.test(n); }) || names[0] || null;
  }

  async function webGpuModel() {
    if (!navigator.gpu) return null;
    try {
      var adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      return adapter.features.has('shader-f16') ? QWEN_F16 : QWEN_F32;
    } catch (_) { return null; }
  }

  function label(kind) {
    if (kind === 'chrome') return browserName() + "'s built-in AI";
    if (kind === 'ollama') return 'Ollama (' + ollamaModel + ')';
    if (kind === 'webllm') return 'Qwen2.5 1.5B, running in your browser';
    return null;
  }

  function result(kind, state, reason) {
    current = kind;
    return { state: state, engine: kind, label: label(kind), progress: progress, reason: reason || null };
  }

  // The WebLLM model's status (warming it up if it's already downloaded).
  function webllmStatus(model) {
    var ready = engineModel === model || saved('webllm') === model;
    // The assistant is open: have the model warm before the first question.
    if (ready && !warmed) warm(false).catch(function () { /* the question will report it */ });
    return result('webllm', ready ? 'ready' : 'downloadable');
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
      if ((await ollamaModels()).indexOf(name) >= 0) {
        ollamaModel = name;
        return result('ollama', 'ready');
      }
    } else if (choice === 'webllm') {
      var m = await webGpuModel();
      if (m) return webllmStatus(m);
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
    if (ollamaModel) return result('ollama', 'ready');
    if (chrome === 'downloadable' || chrome === 'downloading') return result('chrome', chrome);
    var model = await webGpuModel();
    if (model) return webllmStatus(model);
    return result(null, 'unsupported', saved('ollama') === 'on' ? 'noOllama' : 'noWebGpu');
  }

  /** Every AI the person can pick on this computer, for the chat's menu. */
  async function options() {
    var list = [];
    var chrome = await chromeAvailability();
    if (chrome !== 'unavailable') {
      list.push({ id: 'chrome', label: label('chrome'), short: browserName() + ' AI', state: chrome === 'available' ? 'ready' : chrome });
    }
    (await ollamaModels()).forEach(function (n) {
      list.push({ id: 'ollama:' + n, label: 'Ollama (' + n + ')', short: n, state: 'ready' });
    });
    var model = await webGpuModel();
    if (model) {
      list.push({ id: 'webllm', label: label('webllm'), short: 'Qwen 1.5B',
        state: engineModel === model || saved('webllm') === model ? 'ready' : 'downloadable' });
    }
    list.push({ id: 'search', label: 'Search only (no AI)', short: 'Search', state: 'ready' });
    return list;
  }

  async function loadWebLLM() {
    var model = await webGpuModel();
    if (!model) throw new Error("This browser can't use the computer's graphics chip (WebGPU).");
    if (engine && engineModel === model) return engine;
    if (loading) return loading; // one load at a time, however many callers
    loading = (async function () {
      try {
        webllm = webllm || await import(WEBLLM);
        var e = await webllm.CreateMLCEngine(model, {
          initProgressCallback: function (report) { progress = report.progress; },
        });
        engine = e;
        engineModel = model;
        warmed = false;
        save('webllm', model);
        return e;
      } catch (e) {
        save('webllm', null);
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
  // instead of quietly downloading 1 GB.
  function warm(download) {
    if (warming) return warming;
    warming = (async function () {
      try {
        if (!download) {
          var model = await webGpuModel();
          webllm = webllm || await import(WEBLLM);
          if (!model || (webllm.hasModelInCache && !(await webllm.hasModelInCache(model)))) {
            save('webllm', null);
            return;
          }
        }
        var e = await loadWebLLM();
        if (!warmed) {
          await e.chat.completions.create({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 });
          warmed = true;
        }
      } finally {
        warming = null;
      }
    })();
    return warming;
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
        }
      } finally {
        preparing = null;
        progress = null;
      }
    })();
    return preparing;
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
      } else if (current === 'ollama') {
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
  };
})();

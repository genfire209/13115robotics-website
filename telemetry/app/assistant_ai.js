// Telemetry's assistant on a computer. The AI runs on the computer itself,
// never on Telemetry's servers. The first of these that works is used:
//   1. Chrome's built-in AI (Gemini Nano, through the Prompt API);
//   2. Ollama on this computer, if the person turns it on in the assistant
//      (off by default: reaching localhost makes Chrome ask about the local
//      network, and Ollama has to allow this site with OLLAMA_ORIGINS);
//   3. a small open model, Qwen2.5 1.5B (Apache 2.0), run by WebLLM on the
//      computer's graphics chip, after a one-time download of about 1 GB
//      that the browser keeps;
//   4. otherwise the app searches the team's data instead (no AI).
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

  var current = null;   // 'chrome' | 'ollama' | 'webllm' | null
  var progress = null;  // 0 to 1 while a model downloads
  var preparing = null; // the download under way
  var abort = null;     // stops the answer being written
  var webllm = null, engine = null, engineModel = null, ollamaModel = null;

  async function chromeAvailability() {
    if (!('LanguageModel' in self)) return 'unavailable';
    try { return await self.LanguageModel.availability(LANGS); } catch (_) {
      try { return await self.LanguageModel.availability(); } catch (_) { return 'unavailable'; }
    }
  }

  async function findOllamaModel() {
    if (saved('ollama') !== 'on') return null;
    try {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 1500);
      var res = await fetch(OLLAMA + '/api/tags', { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      var names = ((await res.json()).models || []).map(function (m) { return m.name; })
        .filter(function (n) { return !/embed/i.test(n); });
      return names.find(function (n) { return /llama3|qwen|gemma|phi|mistral/i.test(n); }) || names[0] || null;
    } catch (_) { return null; }
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
    if (kind === 'chrome') return "Chrome's built-in AI";
    if (kind === 'ollama') return 'Ollama (' + ollamaModel + ')';
    if (kind === 'webllm') return 'Qwen2.5 1.5B, running in your browser';
    return null;
  }

  function result(kind, state, reason) {
    current = kind;
    return { state: state, engine: kind, label: label(kind), progress: progress, reason: reason || null };
  }

  async function status() {
    if (preparing) return result(current, 'downloading');
    var chrome = await chromeAvailability();
    if (chrome === 'available') return result('chrome', 'ready');
    ollamaModel = await findOllamaModel();
    if (ollamaModel) return result('ollama', 'ready');
    if (chrome === 'downloadable' || chrome === 'downloading') return result('chrome', chrome);
    var model = await webGpuModel();
    if (model) return result('webllm', engineModel === model || saved('webllm') === model ? 'ready' : 'downloadable');
    return result(null, 'unsupported', saved('ollama') === 'on' ? 'noOllama' : 'noWebGpu');
  }

  async function loadWebLLM() {
    var model = await webGpuModel();
    if (!model) throw new Error("This browser can't use the computer's graphics chip (WebGPU).");
    if (engine && engineModel === model) return engine;
    webllm = webllm || await import(WEBLLM);
    try {
      engine = await webllm.CreateMLCEngine(model, {
        initProgressCallback: function (report) { progress = report.progress; },
      });
    } catch (e) {
      save('webllm', null);
      throw e;
    }
    engineModel = model;
    save('webllm', model);
    return engine;
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
          await loadWebLLM();
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
    setOllama: function (on) { save('ollama', on ? 'on' : null); },
    get ollamaOn() { return saved('ollama') === 'on'; },
  };
})();

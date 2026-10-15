(function () {
  // Estados vacíos: ilustraciones line-art (SVG en línea, sin recursos externos)
  var EMPTY_ART = {
    memory: '<rect x="30" y="12" width="60" height="62" rx="4"/><rect class="f" x="52" y="6" width="16" height="10" rx="2"/><path d="M42 36h36M42 48h24"/><path d="M96 20v8M92 24h8"/>',
    files: '<path d="M16 28h30l8 8h50v44H16z"/><path d="M16 40h92"/><path d="M104 14v8M100 18h8"/><circle class="f" cx="38" cy="58" r="3"/><circle class="f" cx="52" cy="58" r="3"/><path d="M36 68q9 6 18 0"/>'
  };
  function emptyHtml(kind, text) {
    return '<div class="empty-art"><svg viewBox="0 0 120 90" aria-hidden="true">' + EMPTY_ART[kind] + '</svg><span>' + text + '</span></div>';
  }
  var api = window.agentik;
  var ch = api.channels;

  var status = document.getElementById('status');
  var perm = document.getElementById('perm');
  var toggle = document.getElementById('toggle');
  var pause = document.getElementById('pause');
  var messages = document.getElementById('messages');
  var thinking = document.getElementById('thinking');
  var chatForm = document.getElementById('chat-form');
  var chatInput = document.getElementById('chat-input');
  var memoryProposal = document.getElementById('memory-proposal');
  var proposalText = document.getElementById('proposal-text');
  var proposalApprove = document.getElementById('proposal-approve');
  var proposalReject = document.getElementById('proposal-reject');
  var viewChat = document.getElementById('view-chat');
  var viewMemory = document.getElementById('view-memory');
  var viewFiles = document.getElementById('view-files');
  var tabChat = document.getElementById('tab-chat');
  var tabMemory = document.getElementById('tab-memory');
  var tabFiles = document.getElementById('tab-files');
  var memoryList = document.getElementById('memory-list');
  var fileEditList = document.getElementById('file-edit-list');

  var suggestionBanner = document.getElementById('suggestion-banner');
  var suggestionText = document.getElementById('suggestion-text');
  var suggestionAccept = document.getElementById('suggestion-accept');
  var suggestionDismiss = document.getElementById('suggestion-dismiss');
  var viewGuide = document.getElementById('view-guide');
  var tabSettings = document.getElementById('tab-settings');
  var viewSettings = document.getElementById('view-settings');
  var avatarChoices = document.getElementById('avatar-choices');
  var setNotif = document.getElementById('set-notif');
  var setSound = document.getElementById('set-sound');
  var tabModels = document.getElementById('tab-models');
  var viewModels = document.getElementById('view-models');
  var modelList = document.getElementById('model-list');
  var modelChip = document.getElementById('model-chip');
  var mForm = document.getElementById('model-form');
  var folderListEl = document.getElementById('folder-list');
  var addFolderBtn = document.getElementById('add-folder');

  var costEl = document.getElementById('cost');
  function usd(n) { return n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toFixed(2); }
  function loadCost() {
    api.invoke(ch.usageGet).then(function (t) {
      if (!t) return;
      costEl.textContent = usd(t.today) + ' hoy';
      costEl.title = 'Últimos 7 días: ' + usd(t.week) + ' · Este mes: ' + usd(t.month) + ' (estimado)';
    });
  }

  var current = { enabled: false, paused: false };
  var pendingMemory = null;
  var pendingSuggestion = null;
  var pendingOpsCount = 0;

  function renderStatus(s) {
    current = s;
    if (!s.enabled) {
      status.textContent = 'Reposo';
    } else if (s.paused) {
      status.textContent = 'Pausado';
    } else {
      status.textContent = 'Observando';
    }
    perm.hidden = s.permissionsOk !== false || !s.enabled;
    toggle.textContent = s.enabled ? 'Desactivar' : 'Activar';
    pause.hidden = !s.enabled;
    pause.textContent = s.paused ? 'Reanudar' : 'Pausar';
  }

  var chatTools = document.getElementById('chat-tools');
  var chatStop = document.getElementById('chat-stop');

  // Respuestas del agente con **negrita**, `código` y viñetas, armadas con nodos de texto (nunca HTML)
  function fillRich(div, text) {
    window.AgentikRichText.parse(text).forEach(function (spans, i) {
      if (i > 0) div.appendChild(document.createTextNode('\n'));
      spans.forEach(function (sp) {
        if (sp.t === 'text') { div.appendChild(document.createTextNode(sp.s)); return; }
        var node = document.createElement(sp.t === 'b' ? 'strong' : 'code');
        node.textContent = sp.s;
        div.appendChild(node);
      });
    });
  }

  function addMessage(role, text) {
    chatTools.hidden = false; // hay historial: se puede borrar
    var div = document.createElement('div');
    div.className = 'msg msg-' + role;
    if (role === 'assistant') fillRich(div, text); else div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function updateFilesBadge(count) {
    pendingOpsCount = count;
    tabFiles.textContent = count > 0 ? 'Archivos (' + count + ')' : 'Archivos';
    tabFiles.classList.toggle('has-badge', count > 0);
  }

  function showTab(name) {
    viewChat.hidden = name !== 'chat';
    viewMemory.hidden = name !== 'memory';
    viewFiles.hidden = name !== 'files';
    viewModels.hidden = name !== 'models';
    viewSettings.hidden = name !== 'settings';
    viewGuide.hidden = name !== 'guide';
    document.getElementById('view-chats').hidden = name !== 'chats';
    document.getElementById('view-scripts').hidden = name !== 'scripts';
    tabSettings.classList.toggle('active', name === 'settings');
    tabModels.classList.toggle('active', name === 'models');
    tabChat.classList.toggle('active', name === 'chat');
    tabMemory.classList.toggle('active', name === 'memory');
    tabFiles.classList.toggle('active', name === 'files');
    if (name === 'memory') loadMemories();
    if (name === 'files') { loadFileEdits(); loadFolders(); }
    if (name === 'models') loadModels();
    if (name === 'settings') loadSettings();
    if (name === 'guide') renderGuide();
    if (name === 'chats') loadChats();
    if (name === 'scripts') loadScripts();
  }

  function loadMemories() {
    api.invoke(ch.memoryList).then(function (list) {
      memoryList.innerHTML = '';
      // Los rechazados no se muestran (en la BD quedan para no volver a proponer el mismo proyecto)
      list = (list || []).filter(function (m) { return m.estado !== 'rechazado'; });
      var pending = (list || []).filter(function (m) { return m.estado === 'propuesto'; });
      tabMemory.textContent = pending.length > 0 ? 'Memoria (' + pending.length + ')' : 'Memoria';
      tabMemory.classList.toggle('has-badge', pending.length > 0);
      if (!list || list.length === 0) {
        memoryList.innerHTML = emptyHtml('memory', 'Sin recuerdos guardados.');
        return;
      }
      if (pending.length > 1) {
        // Aprobar o rechazar todo de una vez (sin ir uno por uno)
        var bar = document.createElement('div');
        bar.className = 'batch-actions';
        var okAll = document.createElement('button');
        okAll.className = 'btn btn-sm btn-ok';
        okAll.textContent = 'Aprobar todo (' + pending.length + ')';
        okAll.onclick = function () {
          okAll.disabled = true;
          Promise.all(pending.map(function (m) { return api.invoke(ch.memoryApprove, m.id); })).then(function () { loadMemories(); });
        };
        var noAll = document.createElement('button');
        noAll.className = 'btn btn-sm btn-danger';
        noAll.textContent = 'Rechazar todo';
        noAll.onclick = function () {
          Promise.all(pending.map(function (m) { return api.invoke(ch.memoryReject, m.id); })).then(function () { loadMemories(); });
        };
        bar.appendChild(okAll);
        bar.appendChild(noAll);
        memoryList.appendChild(bar);
      }
      list.forEach(function (m) {
        var item = document.createElement('div');
        item.className = 'memory-item memory-' + m.estado;
        var label = document.createElement('span');
        label.className = 'memory-label';
        label.textContent = '[' + m.tipo + '] ';
        var content = document.createElement('span');
        content.textContent = m.contenido;
        item.appendChild(label);
        item.appendChild(content);

        if (m.estado === 'propuesto') {
          var approveBtn = document.createElement('button');
          approveBtn.className = 'btn btn-xs btn-ok';
          approveBtn.textContent = '✓';
          approveBtn.onclick = function () {
            api.invoke(ch.memoryApprove, m.id).then(function () { loadMemories(); });
          };
          var rejectBtn = document.createElement('button');
          rejectBtn.className = 'btn btn-xs';
          rejectBtn.textContent = '✗';
          rejectBtn.onclick = function () {
            api.invoke(ch.memoryReject, m.id).then(function () { loadMemories(); });
          };
          item.appendChild(approveBtn);
          item.appendChild(rejectBtn);
        } else if (m.estado === 'aprobado') {
          var delBtn = document.createElement('button');
          delBtn.className = 'btn btn-xs btn-danger';
          delBtn.textContent = '🗑';
          delBtn.onclick = function () {
            api.invoke(ch.memoryDelete, m.id).then(function () { loadMemories(); });
          };
          item.appendChild(delBtn);
        }

        memoryList.appendChild(item);
      });
    });
  }

  function renderDiff(diffText) {
    var container = document.createElement('div');
    container.className = 'diff-preview';
    if (!diffText) { container.textContent = '(sin diff)'; return container; }
    var lines = diffText.split('\n');
    lines.forEach(function (line) {
      var span = document.createElement('span');
      if (line.startsWith('+ ')) {
        span.className = 'diff-add';
      } else if (line.startsWith('- ')) {
        span.className = 'diff-del';
      }
      span.textContent = line + '\n';
      container.appendChild(span);
    });
    return container;
  }

  function loadFileEdits() {
    api.invoke(ch.fileEditList).then(function (list) {
      fileEditList.innerHTML = '';
      if (!list || list.length === 0) {
        fileEditList.innerHTML = emptyHtml('files', 'Sin operaciones pendientes.');
        updateFilesBadge(0);
        return;
      }
      var pending = list.filter(function (e) { return e.status === 'propuesto'; }).length;
      updateFilesBadge(pending);
      if (pending > 1) {
        var batchBar = document.createElement('div');
        batchBar.className = 'batch-actions';
        var approveAllBtn = document.createElement('button');
        approveAllBtn.className = 'btn btn-sm btn-ok';
        approveAllBtn.textContent = 'Aprobar todo (' + pending + ')';
        approveAllBtn.onclick = function () {
          approveAllBtn.disabled = true;
          api.invoke(ch.fileEditApproveAll).then(function (res) {
            showToast(res.applied + ' aplicadas' + (res.failed.length ? ', ' + res.failed.length + ' fallidas' : ''));
            loadFileEdits();
          });
        };
        var rejectAllBtn = document.createElement('button');
        rejectAllBtn.className = 'btn btn-sm btn-danger';
        rejectAllBtn.textContent = 'Rechazar todo';
        rejectAllBtn.onclick = function () {
          api.invoke(ch.fileEditRejectAll).then(function () {
            showToast('Todas rechazadas');
            loadFileEdits();
          });
        };
        batchBar.appendChild(approveAllBtn);
        batchBar.appendChild(rejectAllBtn);
        fileEditList.appendChild(batchBar);
      }

      list.forEach(function (edit) {
        var item = document.createElement('div');
        item.className = 'file-edit-item';

        var header = document.createElement('div');
        var pathSpan = document.createElement('span');
        pathSpan.className = 'file-edit-path';
        pathSpan.textContent = edit.path.split('/').slice(-2).join('/');
        pathSpan.title = edit.path;
        header.appendChild(pathSpan);

        var statusSpan = document.createElement('span');
        statusSpan.className = 'file-edit-status file-edit-status-' + edit.status;
        statusSpan.textContent = edit.status;
        header.appendChild(statusSpan);
        item.appendChild(header);

        var opLabel = '';
        if (edit.diff && edit.diff.startsWith('mover:')) opLabel = 'MOVER';
        else if (edit.diff && edit.diff.startsWith('copiar:')) opLabel = 'COPIAR';
        else if (edit.diff && edit.diff.startsWith('crear carpeta:')) opLabel = 'MKDIR';
        else opLabel = 'EDITAR';
        var opSpan = document.createElement('span');
        opSpan.className = 'file-edit-op file-edit-op-' + opLabel.toLowerCase();
        opSpan.textContent = opLabel;
        header.insertBefore(opSpan, statusSpan);

        if (edit.diff) {
          item.appendChild(renderDiff(edit.diff));
        }

        if (edit.status === 'propuesto') {
          var actions = document.createElement('div');
          actions.className = 'file-edit-actions';
          var approveBtn = document.createElement('button');
          approveBtn.className = 'btn btn-sm btn-ok';
          approveBtn.textContent = 'Aprobar';
          approveBtn.onclick = function () {
            api.invoke(ch.fileEditApprove, edit.id).then(function () { loadFileEdits(); });
          };
          var rejectBtn = document.createElement('button');
          rejectBtn.className = 'btn btn-sm btn-danger';
          rejectBtn.textContent = 'Rechazar';
          rejectBtn.onclick = function () {
            api.invoke(ch.fileEditReject, edit.id).then(function () { loadFileEdits(); });
          };
          actions.appendChild(approveBtn);
          actions.appendChild(rejectBtn);
          item.appendChild(actions);
        }

        fileEditList.appendChild(item);
      });
    });
  }

  // Folders management
  function loadFolders() {
    api.invoke(ch.configGetFolders).then(function (folders) {
      folderListEl.innerHTML = '';
      if (!folders || folders.length === 0) {
        folderListEl.innerHTML = '<p class="muted">Sin carpetas configuradas. Agrega una para habilitar operaciones de archivos.</p>';
        return;
      }
      folders.forEach(function (f) {
        var item = document.createElement('div');
        item.className = 'folder-item';
        var path = document.createElement('span');
        path.className = 'folder-path';
        path.textContent = f.replace(/^\/Users\/[^/]+/, '~');
        path.title = f;
        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn btn-xs btn-danger';
        removeBtn.textContent = '✗';
        removeBtn.onclick = function () {
          api.invoke(ch.configRemoveFolder, f).then(function () { loadFolders(); });
        };
        item.appendChild(path);
        item.appendChild(removeBtn);
        folderListEl.appendChild(item);
      });
    });
  }

  addFolderBtn.addEventListener('click', function () {
    api.invoke(ch.configAddFolder).then(function () { loadFolders(); });
  });

  window.showToast = showToast;
  function showToast(text) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(function () { toast.classList.add('show'); }, 10);
    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
  }

  // ── Modelos: elegir el activo, agregar APIs (Anthropic, compatibles con OpenAI) y modelos locales (Ollama)
  var DEFAULT_URL = { openai: 'https://api.openai.com/v1', ollama: 'http://localhost:11434' };
  // Presets: todos usan el proveedor 'openai' (API compatible) con URL y modelo de ejemplo propios
  var PRESETS = {
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
    'openai-main': { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    groq: { url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
    openrouter: { url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
    mistral: { url: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
    kimi: { url: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6' },
    xai: { url: 'https://api.x.ai/v1', model: 'grok-4' },
    opencode: { url: 'https://opencode.ai/zen/v1', model: 'space-bunny-free' },
    together: { url: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  };
  function realProvider(v) { return PRESETS[v] ? 'openai' : v; }
  function presetFor(profile) {
    if (profile.provider !== 'openai') return profile.provider;
    var u = (profile.base_url || DEFAULT_URL.openai).replace(/\/+$/, '');
    for (var k in PRESETS) if (PRESETS[k].url === u) return k;
    return 'openai';
  }
  var PROVIDER_NAME = { anthropic: 'Anthropic', openai: 'API compatible con OpenAI', ollama: 'Ollama (local)' };
  var mf = {
    provider: document.getElementById('mf-provider'),
    label: document.getElementById('mf-label'),
    model: document.getElementById('mf-model'),
    models: document.getElementById('mf-models'),
    detect: document.getElementById('mf-detect'),
    urlRow: document.getElementById('mf-url-row'),
    url: document.getElementById('mf-url'),
    keyRow: document.getElementById('mf-key-row'),
    key: document.getElementById('mf-key'),
    ctxRow: document.getElementById('mf-ctx-row'),
    ctx: document.getElementById('mf-ctx'),
    prices: document.getElementById('mf-prices'),
    pin: document.getElementById('mf-pin'),
    pout: document.getElementById('mf-pout'),
    error: document.getElementById('mf-error'),
  };
  var editing = null; // perfil que se edita (null = nuevo)

  function mfError(text) {
    mf.error.textContent = text || '';
    mf.error.hidden = !text;
  }

  // Muestra solo los campos que aplican al tipo elegido
  function applyProviderUI(keepUrl) {
    var sel = mf.provider.value;
    var p = realProvider(sel);
    mf.urlRow.hidden = p === 'anthropic';
    mf.keyRow.hidden = p === 'ollama';
    mf.ctxRow.hidden = p !== 'ollama';
    mf.prices.hidden = p === 'anthropic'; // en Ollama solo aplica a modelos -cloud; local = $0
    mf.detect.hidden = p !== 'ollama';
    var pre = PRESETS[sel];
    var url = pre ? pre.url : DEFAULT_URL[p] || '';
    mf.model.placeholder = pre ? pre.model : p === 'anthropic' ? 'claude-sonnet-5-5' : p === 'ollama' ? 'qwen3:8b' : 'gpt-4o-mini';
    if (!keepUrl) mf.url.value = url;
    mf.url.placeholder = url;
  }

  function openModelForm(profile) {
    editing = profile || null;
    mfError('');
    mf.provider.value = profile ? presetFor(profile) : 'ollama';
    mf.provider.disabled = !!profile;
    applyProviderUI(!!profile);
    mf.label.value = profile ? profile.label : '';
    mf.model.value = profile ? profile.model : '';
    mf.url.value = profile && profile.base_url ? profile.base_url : (profile ? '' : DEFAULT_URL.ollama);
    mf.key.value = '';
    mf.key.placeholder = profile && profile.hasKey ? 'Guardada. Déjalo vacío para conservarla' : 'Se guarda cifrada en el Llavero';
    mf.ctx.value = profile && profile.num_ctx ? profile.num_ctx : '';
    mf.pin.value = profile && profile.price_in != null ? profile.price_in : '';
    mf.pout.value = profile && profile.price_out != null ? profile.price_out : '';
    mf.models.innerHTML = '';
    mForm.hidden = false;
    mf.label.focus();
  }

  function renderModels(state) {
    if (!state || state.error) { if (state && state.error) showToast(state.error); return; }
    modelList.innerHTML = '';
    modelChip.textContent = 'Sin modelo';
    modelChip.title = 'No hay modelo configurado (clic para agregar uno)';
    if (state.profiles.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'model-empty';
      empty.textContent = 'No hay ningún modelo. Pulsa "+ Agregar" para configurar uno (necesitas su API key, o un Ollama local).';
      modelList.appendChild(empty);
    }
    state.profiles.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'model-item' + (p.id === state.active ? ' active' : '');

      var main = document.createElement('div');
      main.className = 'model-main';
      var name = document.createElement('div');
      name.className = 'model-name';
      name.textContent = p.label;
      var sub = document.createElement('div');
      sub.className = 'model-sub';
      sub.textContent = PROVIDER_NAME[p.provider] + ' · ' + p.model;
      main.appendChild(name);
      main.appendChild(sub);
      if (p.provider !== 'ollama' && !p.hasKey) {
        var warn = document.createElement('div');
        warn.className = 'model-warn';
        warn.textContent = p.provider === 'anthropic' ? 'Falta la API key' : 'Sin API key (solo si el servidor la pide)';
        main.appendChild(warn);
      }
      item.appendChild(main);

      if (p.id !== state.active) {
        var use = document.createElement('button');
        use.className = 'btn btn-xs btn-ok';
        use.textContent = 'Usar';
        use.onclick = function () {
          api.invoke(ch.modelsSetActive, p.id).then(function (s) { renderModels(s); showToast('Modelo: ' + p.label); });
        };
        item.appendChild(use);
      }
      var edit = document.createElement('button');
      edit.className = 'btn btn-xs';
      edit.textContent = 'Editar';
      edit.onclick = function () { openModelForm(p); };
      item.appendChild(edit);
      var del = document.createElement('button');
      del.className = 'btn btn-xs btn-danger';
      del.textContent = '✗';
      del.title = 'Quitar este modelo';
      del.onclick = function () {
        if (!window.confirm('¿Quitar "' + p.label + '"? También se borra su API key guardada.')) return;
        api.invoke(ch.modelsDelete, p.id).then(renderModels);
      };
      item.appendChild(del);
      modelList.appendChild(item);

      if (p.id === state.active) {
        modelChip.textContent = p.label;
        modelChip.title = 'Modelo activo: ' + p.model + ' (clic para cambiar)';
      }
    });
  }

  function loadModels() {
    api.invoke(ch.modelsList).then(renderModels);
  }

  document.getElementById('model-add').addEventListener('click', function () { openModelForm(null); });
  document.getElementById('mf-cancel').addEventListener('click', function () { mForm.hidden = true; });
  mf.provider.addEventListener('change', function () { applyProviderUI(false); });

  mf.detect.addEventListener('click', function () {
    mfError('');
    api.invoke(ch.modelsDetect, mf.url.value.trim() || undefined).then(function (r) {
      if (r.error) { mfError(r.error); return; }
      mf.models.innerHTML = '';
      r.models.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        mf.models.appendChild(o);
      });
      if (r.models.length === 0) { mfError('Ollama no tiene modelos instalados. Descarga uno con: ollama pull qwen3:8b'); return; }
      if (!mf.model.value) mf.model.value = r.models[0];
      if (!mf.label.value) mf.label.value = r.models[0] + ' (local)';
      showToast(r.models.length + ' modelos encontrados');
    });
  });

  mForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var p = realProvider(mf.provider.value);
    var payload = { label: mf.label.value.trim(), provider: p, model: mf.model.value.trim() };
    if (editing) payload.id = editing.id;
    if (p !== 'anthropic' && mf.url.value.trim()) payload.base_url = mf.url.value.trim();
    if (p === 'ollama' && mf.ctx.value) payload.num_ctx = Number(mf.ctx.value);
    if (p !== 'anthropic' && mf.pin.value !== '' && mf.pout.value !== '') {
      payload.price_in = Number(mf.pin.value);
      payload.price_out = Number(mf.pout.value);
    }
    if (p !== 'ollama' && mf.key.value.trim()) payload.api_key = mf.key.value.trim();
    api.invoke(ch.modelsSave, payload).then(function (res) {
      mf.key.value = '';
      if (res && res.error) { mfError(res.error); return; }
      mForm.hidden = true;
      renderModels(res);
      showToast('Modelo guardado');
    });
  });

  // ── Ajustes: avatar (niño o niña), avisos y sonido
  function renderSettings(s) {
    if (!s || s.error) { if (s && s.error) showToast(s.error); return; }
    avatarChoices.innerHTML = '';
    window.AgentikAvatars.IDS.forEach(function (id) {
      var def = window.AgentikAvatars.get(id);
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'avatar-choice' + (s.avatar === id ? ' selected' : '');
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      card.appendChild(svg);
      window.AgentikAvatars.build(svg, id);
      // El mismo motor dibuja la miniatura (cara sonriente), pero quieta: sin animación
      window.AgentikAvatar.mount(svg, { geometry: def.geometry, autoStart: false, random: function () { return 0.5; } });
      var name = document.createElement('span');
      name.textContent = def.label;
      card.appendChild(name);
      card.onclick = function () { api.invoke(ch.settingsSet, { avatar: id }).then(function (r) { renderSettings(r); showToast('Avatar: ' + def.label); }); };
      avatarChoices.appendChild(card);
    });
    setNotif.checked = !!s.notifications;
    setSound.checked = !!s.sounds;
    var verEl = document.getElementById('set-version');
    if (verEl && s.version) verEl.textContent = 'Versión ' + s.version;
    var screenStatus = document.getElementById('set-screen-status');
    var screenBtn = document.getElementById('set-screen-open');
    if (screenStatus) {
      var sr = s.screenRecording;
      if (sr === 'granted') {
        screenStatus.textContent = '✓ Permiso concedido — Kogn puede ver tu pantalla.';
        if (screenBtn) screenBtn.hidden = true;
      } else if (sr === 'denied' || sr === 'restricted') {
        screenStatus.textContent = '✗ Permiso denegado — actívalo en Ajustes del sistema.';
        if (screenBtn) screenBtn.hidden = false;
      } else {
        screenStatus.textContent = 'Permiso no solicitado aún.';
        if (screenBtn) screenBtn.hidden = false;
      }
    }
  }

  function loadSettings() {
    api.invoke(ch.settingsGet).then(renderSettings);
  }

  setNotif.addEventListener('change', function () { api.invoke(ch.settingsSet, { notifications: setNotif.checked }); });
  setSound.addEventListener('change', function () { api.invoke(ch.settingsSet, { sounds: setSound.checked }); });
  var screenOpenBtn = document.getElementById('set-screen-open');
  if (screenOpenBtn) screenOpenBtn.addEventListener('click', function () {
    api.invoke(ch.openUrl, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
  document.getElementById('set-test').addEventListener('click', function () { window.AgentikSounds.playPop(); });

  // ── Guía de inicio: se abre sola la primera vez; después con el botón "?" o desde Ajustes
  var G = window.AgentikOnboarding;
  var guideIdx = 0;
  var guideState = { hasModel: false, folders: 0, observing: false, chatted: false };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // Ilustraciones animadas de la guía (SVG en línea, sin recursos externos; las animaciones están en bubble.css)
  var GUIDE_ART = {
    hola: '<svg viewBox="0 0 300 150" aria-hidden="true"><rect class="w" x="22" y="14" width="170" height="112" rx="10"/><path d="M22 36h170"/><circle class="f" cx="38" cy="25" r="3.5"/><circle class="f" cx="52" cy="25" r="3.5"/><circle class="f" cx="66" cy="25" r="3.5"/><circle class="ring" cx="107" cy="82" r="32"/><g class="bnc"><circle class="p" cx="107" cy="82" r="32"/><ellipse class="f blk" cx="96" cy="76" rx="3.5" ry="5.5"/><ellipse class="f blk" cx="118" cy="76" rx="3.5" ry="5.5"/><path class="smile" d="M92 92q15 14 30 0"/></g><path class="f cur" d="M200 78l46 20-20 6-6 22z"/><path class="tw" d="M238 34v14M231 41h14"/><path class="tw d1" d="M262 70v8M258 74h8"/><path class="tw d2" d="M30 138v8M26 142h8"/></svg>',
    pasos: '<svg viewBox="0 0 300 150" aria-hidden="true"><g class="clip"><rect class="w" x="70" y="10" width="160" height="132" rx="10"/><rect class="f" x="118" y="4" width="64" height="14" rx="5"/><rect x="88" y="34" width="16" height="16" rx="4"/><path class="ck" pathLength="1" d="M92 42l4 4 7-9"/><path class="ln" pathLength="1" d="M116 42h92"/><rect x="88" y="62" width="16" height="16" rx="4"/><path class="ck c2" pathLength="1" d="M92 70l4 4 7-9"/><path class="ln l2" pathLength="1" d="M116 70h70"/><rect class="wait" x="88" y="90" width="16" height="16" rx="4"/><path class="ln l3" pathLength="1" d="M116 98h80"/><rect x="88" y="118" width="16" height="16" rx="4"/><path class="ln l4" pathLength="1" d="M116 126h56"/></g><path class="tw" d="M252 30v12M246 36h12"/><path class="tw d1" d="M44 100v8M40 104h8"/></svg>',
    pedir: '<svg viewBox="0 0 300 150" aria-hidden="true"><g class="m1"><rect class="f" x="140" y="18" width="130" height="38" rx="12"/><path class="f" d="M256 56l14 12v-12z"/><path class="inv" d="M158 30h74M158 42h46"/></g><g class="m2"><rect class="w" x="30" y="66" width="150" height="38" rx="12"/><path class="w" d="M44 104l-12 14v-14z"/><path d="M46 80h96M46 92h60"/></g><g class="m3"><rect class="w" x="30" y="114" width="64" height="28" rx="12"/><circle class="f td" cx="48" cy="128" r="3.5"/><circle class="f td t2" cx="62" cy="128" r="3.5"/><circle class="f td t3" cx="76" cy="128" r="3.5"/></g><g class="fold"><path class="w" d="M214 98h18l5 6h27v32h-50z"/><path d="M214 110h50"/></g><path class="tw" d="M276 14v10M271 19h10"/><path class="tw d1" d="M24 30v8M20 34h8"/></svg>',
    scripts: '<svg viewBox="0 0 300 150" aria-hidden="true"><g class="sc"><rect class="w" x="26" y="16" width="104" height="52" rx="8"/><path d="M38 34h56M38 46h38"/><circle class="f" cx="112" cy="34" r="5"/></g><g class="sc s2"><rect class="w" x="170" y="16" width="104" height="52" rx="8"/><path d="M182 34h56M182 46h38"/><path class="f" d="M254 26l12 8-12 8z"/></g><g class="sc s3"><rect class="w" x="26" y="82" width="104" height="52" rx="8"/><path d="M38 100h56M38 112h38"/><rect x="104" y="96" width="14" height="14" rx="3"/></g><g class="sc s4"><rect class="w" x="170" y="82" width="104" height="52" rx="8"/><path d="M182 100h40M182 112h30"/><g class="spin"><path d="M255 113a11 11 0 1 1-3-8"/><path class="f" d="M248 98l9 1-3 9z"/></g></g><path class="tw" d="M150 70v12M144 76h12"/><path class="tw d1" d="M284 150v0"/></svg>',
    chats: '<svg viewBox="0 0 300 150" aria-hidden="true"><g class="cd cd3"><rect class="w" x="92" y="22" width="150" height="92" rx="10"/></g><g class="cd cd2"><rect class="w" x="72" y="34" width="150" height="92" rx="10"/></g><g class="cd cd1"><rect class="w" x="52" y="46" width="150" height="92" rx="10"/><path d="M68 66h78M68 80h110M68 94h60"/><circle class="f pin" cx="184" cy="62" r="7"/></g><path class="tw" d="M262 30v12M256 36h12"/><path class="tw d1" d="M30 40v8M26 44h8"/><path class="tw d2" d="M270 112v8M266 116h8"/></svg>',
    control: '<svg viewBox="0 0 300 150" aria-hidden="true"><circle class="pls" cx="86" cy="76" r="46"/><g class="stp"><circle class="w" cx="86" cy="76" r="46"/><rect class="f" x="68" y="58" width="36" height="36" rx="6"/></g><rect class="w" x="168" y="30" width="96" height="40" rx="8"/><path d="M168 46h96"/><circle class="f" cx="180" cy="38" r="2.5"/><circle class="f" cx="190" cy="38" r="2.5"/><g class="kp"><rect class="w" x="168" y="84" width="40" height="34" rx="8"/><path d="M178 106l8-8 8 8"/></g><g class="kp k2"><rect class="w" x="216" y="84" width="48" height="34" rx="8"/><path d="M228 102h26"/></g><path class="tw" d="M148 22v10M143 27h10"/><path class="tw d1" d="M32 130v8M28 134h8"/></svg>'
  };

  function guideGo(target) {
    if (target === 'observer') {
      if (!current.enabled) api.invoke(ch.observerSetEnabled, true).then(function (s) { renderStatus(s); renderGuide(); });
      return;
    }
    showTab(target);
  }

  function renderGuide() {
    Promise.all([api.invoke(ch.modelsList), api.invoke(ch.configGetFolders)]).then(function (r) {
      var profiles = (r[0] && r[0].profiles) || [];
      guideState.hasModel = profiles.some(function (p) { return p.provider === 'ollama' || p.hasKey; });
      guideState.folders = (r[1] || []).length;
      guideState.observing = !!current.enabled;
      guideState.chatted = !!messages.querySelector('.msg-user');
      drawGuide();
    });
  }

  function drawGuide() {
    var step = G.STEPS[guideIdx];
    var body = document.getElementById('guide-body');
    body.innerHTML = '';
    var hero = el('div', 'guide-hero');
    hero.innerHTML = GUIDE_ART[step.id] || ''; // contenido fijo del propio código, no del usuario
    body.appendChild(hero);
    body.appendChild(el('div', 'guide-kick', 'Paso ' + (guideIdx + 1) + ' de ' + G.STEPS.length));
    body.appendChild(el('h3', 'guide-title', step.title));
    if (!step.checklist && !step.examples) {
      step.body.forEach(function (t) { body.appendChild(el('p', 'guide-text', t)); });
    }
    if (step.checklist) {
      var items = G.checklist(guideState);
      body.appendChild(el('p', 'guide-text', G.progress(items).text + '. ' + step.body[0]));
      items.forEach(function (it) {
        var row = el('div', 'guide-item' + (it.done ? ' done' : ''));
        row.appendChild(el('span', 'guide-check', it.done ? '✓' : '○'));
        var txt = el('div', 'guide-item-text');
        txt.appendChild(el('div', 'guide-item-title', it.title));
        txt.appendChild(el('div', 'muted', it.hint));
        row.appendChild(txt);
        if (!it.done) {
          var go = el('button', 'btn btn-xs btn-ok', it.goLabel);
          go.type = 'button';
          go.onclick = function () { guideGo(it.go); };
          row.appendChild(go);
        }
        body.appendChild(row);
      });
    }
    if (step.examples) {
      body.appendChild(el('p', 'guide-text', step.body[0]));
      G.EXAMPLES.forEach(function (ex) {
        var b = el('button', 'guide-example');
        b.type = 'button';
        b.appendChild(el('span', 'guide-example-text', '«' + ex.text + '»'));
        b.appendChild(el('span', 'muted', ex.note));
        b.onclick = function () { showTab('chat'); chatInput.value = ex.text; chatInput.focus(); };
        body.appendChild(b);
      });
    }
    var last = guideIdx === G.STEPS.length - 1;
    document.getElementById('guide-back').hidden = guideIdx === 0;
    document.getElementById('guide-skip').hidden = last;
    document.getElementById('guide-next').textContent = last ? 'Listo' : 'Siguiente';
    var dots = document.getElementById('guide-dots');
    dots.innerHTML = '';
    G.STEPS.forEach(function (s, i) { dots.appendChild(el('span', 'guide-dot' + (i === guideIdx ? ' on' : ''))); });
  }

  function openGuide() { guideIdx = 0; showTab('guide'); }
  function closeGuide() {
    api.invoke(ch.settingsSet, { onboarding_done: true });
    showTab('chat');
  }
  document.getElementById('guide-open').addEventListener('click', openGuide);
  document.getElementById('set-guide').addEventListener('click', openGuide);
  document.getElementById('guide-skip').addEventListener('click', closeGuide);
  document.getElementById('guide-back').addEventListener('click', function () { guideIdx = Math.max(0, guideIdx - 1); drawGuide(); });
  document.getElementById('guide-next').addEventListener('click', function () {
    if (guideIdx >= G.STEPS.length - 1) { closeGuide(); return; }
    guideIdx++;
    renderGuide();
  });

  // Tabs
  tabChat.addEventListener('click', function () { showTab('chat'); });
  tabMemory.addEventListener('click', function () { showTab('memory'); });
  tabFiles.addEventListener('click', function () { showTab('files'); });
  tabModels.addEventListener('click', function () { showTab('models'); });
  tabSettings.addEventListener('click', function () { showTab('settings'); });
  modelChip.addEventListener('click', function () { showTab('models'); });

  // Observer controls
  toggle.addEventListener('click', function () {
    api.invoke(ch.observerSetEnabled, !current.enabled).then(renderStatus);
  });
  pause.addEventListener('click', function () {
    api.invoke(ch.observerTogglePause).then(renderStatus);
  });
  document.getElementById('quit').addEventListener('click', function () {
    api.send(ch.appQuit);
  });

  // Chat
  chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = chatInput.value.trim();
    var sentFiles = attachedFiles.slice();
    if (!text && sentFiles.length) text = 'Revisa los archivos adjuntos.';
    if (!text) return;
    chatInput.value = '';
    addMessage('user', sentFiles.length ? text + '\n📎 ' + sentFiles.map(function (f) { return f.name; }).join(', ') : text);
    if (sentFiles.length) { attachedFiles = []; drawAttachments(); }
    chatInput.disabled = true;
    api.invoke(ch.chatSend, text).then(function (result) {
      chatInput.disabled = false;
      chatInput.focus();
      loadCost();
      refreshChatTitle(); // el primer mensaje le pone título a la conversación
      if (result && result.reply) {
        var bubbleEl = addMessage('assistant', result.reply);
        if (result.attachDir) {
          var show = el('button', 'btn btn-xs msg-action', 'Mostrar en Finder');
          show.type = 'button';
          show.onclick = function () { api.invoke(ch.chatReveal, result.attachDir); };
          bubbleEl.appendChild(show);
        }
      } else if (result && result.error) {
        addMessage('assistant', '⚠ ' + result.error);
      }
    });
  });

  // Memory proposal from chat
  api.on(ch.memoryProposed, function (mem) {
    pendingMemory = mem;
    proposalText.textContent = '💡 Recuerdo propuesto: [' + mem.tipo + '] ' + mem.contenido;
    memoryProposal.hidden = false;
  });

  proposalApprove.addEventListener('click', function () {
    if (pendingMemory) {
      api.invoke(ch.memoryApprove, pendingMemory.id);
      pendingMemory = null;
      memoryProposal.hidden = true;
    }
  });

  proposalReject.addEventListener('click', function () {
    if (pendingMemory) {
      api.invoke(ch.memoryReject, pendingMemory.id);
      pendingMemory = null;
      memoryProposal.hidden = true;
    }
  });

  // Detener lo que Kogn esté haciendo (también con Esc)
  function stopNow() {
    chatStop.disabled = true;
    api.invoke(ch.chatStop).then(function () { chatStop.disabled = false; });
  }
  chatStop.addEventListener('click', stopNow);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !thinking.hidden) stopNow();
  });



  // ── Adjuntar archivos al chat: botón, arrastrar y soltar. Se copian a una zona interna; los originales no se tocan.
  var attachedFiles = [];
  var attachBox = document.getElementById('chat-attachments');

  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  function drawAttachments() {
    attachBox.innerHTML = '';
    attachBox.hidden = attachedFiles.length === 0;
    attachedFiles.forEach(function (f) {
      var chip = el('span', 'file-chip');
      chip.appendChild(el('span', 'file-chip-name', f.name));
      chip.appendChild(el('span', 'file-chip-size', fmtBytes(f.size)));
      var x = el('button', 'file-chip-x', '×');
      x.type = 'button';
      x.title = 'Quitar';
      x.setAttribute('aria-label', 'Quitar ' + f.name);
      x.onclick = function () {
        api.invoke(ch.chatAttachRemove, f.id).then(function () { attachedFiles = attachedFiles.filter(function (a) { return a.id !== f.id; }); drawAttachments(); });
      };
      chip.appendChild(x);
      attachBox.appendChild(chip);
    });
  }

  function staged(r) {
    if (!r) return;
    attachedFiles = attachedFiles.concat(r.files || []);
    drawAttachments();
    (r.rejected || []).slice(0, 3).forEach(function (x) { showToast('No adjunté «' + x.name + '»: ' + x.reason); });
    if ((r.files || []).length) chatInput.focus();
  }

  function refreshAttachments() {
    api.invoke(ch.chatAttachList).then(function (list) { attachedFiles = list || []; drawAttachments(); });
  }

  document.getElementById('chat-attach').addEventListener('click', function () { api.invoke(ch.chatAttachPick).then(staged); });

  // Sin esto, soltar un archivo fuera de la zona del chat haría que la ventana intente abrirlo
  ['dragover', 'drop'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); }); });
  var dropZone = viewChat;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  dropZone.addEventListener('dragenter', function (e) { if (hasFiles(e)) dropZone.classList.add('dragging'); });
  dropZone.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); dropZone.classList.add('dragging'); } });
  dropZone.addEventListener('dragleave', function (e) { if (e.target === dropZone || !dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragging'); });
  dropZone.addEventListener('drop', function (e) {
    dropZone.classList.remove('dragging');
    if (!hasFiles(e)) return;
    e.preventDefault();
    var paths = Array.prototype.map.call(e.dataTransfer.files, function (f) { return api.pathForFile(f); }).filter(Boolean);
    if (paths.length) api.invoke(ch.chatAttachDrop, paths).then(staged);
  });

  // ── Conversaciones: tarjetas, fijar, borrar y tope de 20 (la más vieja sin fijar se borra al pasar)
  var chatTitle = document.getElementById('chat-title');
  var chatCards = document.getElementById('chat-cards');
  var activeConv = 0;
  var warnedLimit = false;

  function relTime(ts) {
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return 'hace ' + m + ' min';
    var h = Math.round(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    var d = Math.round(h / 24);
    return d === 1 ? 'ayer' : 'hace ' + d + ' días';
  }

  function refreshChatTitle() {
    api.invoke(ch.conversationsList).then(function (r) {
      if (!r) return;
      activeConv = r.active;
      var cur = r.items.filter(function (c) { return c.id === r.active; })[0];
      chatTitle.textContent = (cur && cur.title) || 'Conversación nueva';
      if (!warnedLimit && r.items.length >= r.warnAt) {
        warnedLimit = true;
        showToast('Llevas ' + r.items.length + ' de ' + r.max + ' conversaciones: al llegar al límite se borra la más vieja sin fijar');
      }
    });
  }

  // Vuelve a pintar el chat con la conversación activa
  function reloadChat() {
    messages.innerHTML = '';
    chatTools.hidden = true;
    api.invoke(ch.chatHistory).then(function (rows) {
      (rows || []).forEach(function (m) { addMessage(m.role, m.content); });
    });
    refreshChatTitle();
    refreshAttachments();
  }

  function loadChats() {
    api.invoke(ch.conversationsList).then(function (r) {
      if (!r) return;
      activeConv = r.active;
      document.getElementById('chats-count').textContent = r.items.length + ' de ' + r.max;
      var note = document.getElementById('chats-note');
      note.hidden = r.items.length < r.warnAt;
      note.textContent = 'Casi lleno: al crear una más se borra la más vieja que no esté fijada. Fija las que quieras conservar.';
      chatCards.innerHTML = '';
      r.items.forEach(function (c) {
        var card = el('div', 'chat-card' + (c.id === r.active ? ' active' : ''));
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        var head = el('div', 'chat-card-head');
        head.appendChild(el('span', 'chat-card-title', c.title || 'Conversación nueva'));
        if (c.pinned) head.appendChild(el('span', 'chat-card-pin', 'Fijada'));
        card.appendChild(head);
        card.appendChild(el('div', 'chat-card-meta', relTime(c.updated) + ' · ' + c.messages + (c.messages === 1 ? ' mensaje' : ' mensajes')));
        if (c.preview) card.appendChild(el('div', 'chat-card-preview', c.preview));
        var acts = el('div', 'chat-card-actions');
        var pin = el('button', 'btn btn-xs', c.pinned ? 'Soltar' : 'Fijar');
        pin.type = 'button';
        pin.onclick = function (e) { e.stopPropagation(); api.invoke(ch.conversationPin, { id: c.id, pinned: !c.pinned }).then(loadChats); };
        var del = el('button', 'btn btn-xs btn-danger', 'Borrar');
        del.type = 'button';
        del.onclick = function (e) { e.stopPropagation(); deleteChat(c); };
        acts.appendChild(pin);
        acts.appendChild(del);
        card.appendChild(acts);
        var open = function () { api.invoke(ch.conversationOpen, c.id).then(function () { reloadChat(); showTab('chat'); }); };
        card.addEventListener('click', open);
        card.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === card) open(); });
        chatCards.appendChild(card);
      });
    });
  }

  function deleteChat(c) {
    if (!window.confirm('¿Borrar la conversación «' + (c.title || 'sin título') + '»? Se elimina de tu Mac y no se puede deshacer.')) return;
    api.invoke(ch.conversationDelete, c.id).then(function (r) {
      if (r && r.activeChanged) reloadChat();
      showToast('Conversación borrada');
      if (!viewChats().hidden) loadChats();
    });
  }
  function viewChats() { return document.getElementById('view-chats'); }

  function newChat() {
    api.invoke(ch.conversationNew).then(function (r) {
      if (r && r.error) { showToast('Todas tus conversaciones están fijadas: suelta alguna para crear otra'); return; }
      if (r && r.evicted) showToast('Se borró la conversación más vieja sin fijar (límite de 20)');
      reloadChat();
      showTab('chat');
      chatInput.focus();
    });
  }

  // ── Biblioteca de scripts: tarjetas con parámetros, vista previa, ejecutar y deshacer
  var GROUPS = [['all', 'Todos'], ['todos', 'General'], ['diseno', 'Diseño y foto'], ['dev', 'Desarrollo'], ['oficina', 'Oficina'], ['contenido', 'Contenido']];
  var RISK = { lee: 'Solo lee', escribe: 'Crea copias', mueve: 'Mueve archivos', actua: 'Actúa en tu Mac' };
  var MODULE_FOR = { ffmpeg: 'ffmpeg', 'whisper-cli': 'whisper-cli' };
  var scriptState = { group: 'all', data: null, folders: [], open: null, busy: false };

  function loadScripts() {
    Promise.all([api.invoke(ch.scriptsList), api.invoke(ch.configGetFolders)]).then(function (r) {
      scriptState.data = r[0];
      scriptState.folders = r[1] || [];
      drawScripts();
    });
  }

  function drawScripts() {
    var d = scriptState.data;
    if (!d) return;
    var groups = document.getElementById('script-groups');
    groups.innerHTML = '';
    GROUPS.forEach(function (g) {
      var b = el('button', 'tab' + (scriptState.group === g[0] ? ' active' : ''), g[1]);
      b.type = 'button';
      b.onclick = function () { scriptState.group = g[0]; drawScripts(); };
      groups.appendChild(b);
    });
    var list = document.getElementById('script-list');
    list.innerHTML = '';
    d.scripts.filter(function (sc) { return scriptState.group === 'all' || sc.group === scriptState.group; }).forEach(function (sc) { list.appendChild(scriptCard(sc)); });
    var mods = document.getElementById('module-list');
    mods.innerHTML = '';
    d.modules.forEach(function (m) { mods.appendChild(moduleRow(m)); });
    var runs = document.getElementById('run-list');
    runs.innerHTML = '';
    if (!d.runs.length) runs.appendChild(el('p', 'muted', 'Todavía no has ejecutado ningún script.'));
    d.runs.forEach(function (r) {
      var row = el('div', 'run-row' + (r.undone ? ' undone' : ''));
      var t = el('div', 'run-text');
      t.appendChild(el('div', 'run-title', r.title + (r.undone ? ' (deshecho)' : '')));
      t.appendChild(el('div', 'muted', relTime(r.ts) + ' · ' + r.summary));
      row.appendChild(t);
      if (r.undoable) {
        var u = el('button', 'btn btn-xs', 'Deshacer');
        u.type = 'button';
        u.onclick = function () { undoRunUi(r.id); };
        row.appendChild(u);
      }
      runs.appendChild(row);
    });
  }

  function undoRunUi(id) {
    api.invoke(ch.scriptUndo, id).then(function (r) {
      showToast(r && r.ok ? 'Deshecho: ' + r.restored + (r.restored === 1 ? ' cosa devuelta' : ' cosas devueltas') : (r && r.error) || 'No se pudo deshacer');
      loadScripts();
    });
  }

  function moduleRow(m) {
    var row = el('div', 'run-row');
    var t = el('div', 'run-text');
    t.appendChild(el('div', 'run-title', m.title));
    var status = el('div', 'muted', m.installed ? 'Instalado' : m.note + ' (' + m.sizeLabel + ')');
    status.id = 'mod-' + m.id;
    t.appendChild(status);
    row.appendChild(t);
    if (!m.installed) {
      var b = el('button', 'btn btn-xs btn-ok', 'Instalar');
      b.type = 'button';
      b.onclick = function () { installModuleUi(m.id, b, status); };
      row.appendChild(b);
    }
    return row;
  }

  function installModuleUi(id, btn, status) {
    var brew = id === 'ffmpeg' || id === 'whisper-cli';
    if (brew && !window.confirm('Se instalará con Homebrew (puede tardar varios minutos y descarga varios programas). ¿Continuar?')) return;
    btn.disabled = true;
    status.textContent = brew ? 'Instalando con Homebrew… puede tardar varios minutos.' : 'Descargando…';
    api.invoke(ch.moduleInstall, id).then(function (r) {
      if (r && r.modules) scriptState.data.modules = r.modules;
      showToast(r && r.ok ? 'Instalado' : (r && r.error) || 'No se pudo instalar');
      loadScripts();
    });
  }
  api.on(ch.moduleProgress, function (p) {
    var s = document.getElementById('mod-' + p.id);
    if (s) s.textContent = 'Descargando… ' + Math.round(p.fraction * 100) + '%';
  });

  function scriptCard(sc) {
    var open = scriptState.open === sc.id;
    var card = el('div', 'script-card' + (open ? ' open' : ''));
    var head = el('button', 'script-head');
    head.type = 'button';
    head.appendChild(el('span', 'script-title', sc.title));
    head.appendChild(el('span', 'script-risk risk-' + sc.risk, RISK[sc.risk] || sc.risk));
    head.onclick = function () { scriptState.open = open ? null : sc.id; drawScripts(); };
    card.appendChild(head);
    card.appendChild(el('div', 'script-desc', sc.description));
    if (!open) return card;

    var missing = sc.missing || [];
    if (missing.length) {
      var warn = el('div', 'script-missing');
      var sys = missing.filter(function (m) { return !MODULE_FOR[m]; });
      var inst = missing.filter(function (m) { return MODULE_FOR[m]; });
      warn.appendChild(el('span', '', 'Falta: ' + missing.join(', ') + (sys.length ? ' (viene con macOS o git; revisa tu sistema)' : '')));
      inst.forEach(function (m) {
        var b = el('button', 'btn btn-xs btn-ok', 'Instalar ' + m);
        b.type = 'button';
        b.onclick = function () { installModuleUi(MODULE_FOR[m], b, warn.firstChild); };
        warn.appendChild(b);
      });
      card.appendChild(warn);
    }

    var form = el('div', 'script-form');
    var fields = {};
    sc.params.forEach(function (p) {
      var lab = el('label', 'script-field');
      lab.appendChild(el('span', '', p.label + (p.required ? ' *' : '')));
      var input;
      if (p.type === 'choice') {
        input = document.createElement('select');
        (p.options || []).forEach(function (o) { var op = document.createElement('option'); op.value = o; op.textContent = o; input.appendChild(op); });
        if (p.default !== undefined) input.value = String(p.default);
      } else {
        input = document.createElement('input');
        input.type = p.type === 'number' ? 'number' : 'text';
        if (p.type === 'number') { if (p.min !== undefined) input.min = p.min; if (p.max !== undefined) input.max = p.max; }
        if (p.default !== undefined) input.value = String(p.default);
        if (p.type === 'folder' && scriptState.folders.length === 1 && !input.value) input.value = scriptState.folders[0];
        if (p.type === 'folder') input.placeholder = 'Una de tus carpetas autorizadas';
      }
      fields[p.name] = input;
      lab.appendChild(input);
      if (p.type === 'folder' || p.type === 'file') {
        var pick = el('button', 'btn btn-xs', 'Elegir…');
        pick.type = 'button';
        pick.onclick = function () { api.invoke(ch.scriptPick, p.type).then(function (path) { if (path) input.value = path; }); };
        lab.appendChild(pick);
      }
      form.appendChild(lab);
    });
    var out = el('div', 'script-out');
    var acts = el('div', 'script-actions');
    var prev = el('button', 'btn btn-sm', 'Vista previa');
    prev.type = 'button';
    var run = el('button', 'btn btn-sm btn-ok', 'Ejecutar');
    run.type = 'button';
    run.hidden = true;
    acts.appendChild(prev);
    acts.appendChild(run);
    form.appendChild(acts);
    card.appendChild(form);
    card.appendChild(out);

    function values() {
      var v = {};
      sc.params.forEach(function (p) { var x = fields[p.name].value; if (x !== '') v[p.name] = p.type === 'number' ? Number(x) : x; });
      return v;
    }
    function show(summary, lines, extra) {
      out.innerHTML = '';
      out.appendChild(el('div', 'script-summary', summary));
      if (lines && lines.length) { var ul = el('ul', 'script-lines'); lines.forEach(function (l) { ul.appendChild(el('li', '', l)); }); out.appendChild(ul); }
      if (extra) out.appendChild(extra);
    }
    prev.onclick = function () {
      run.hidden = true;
      show('Mirando…');
      api.invoke(ch.scriptPlan, { id: sc.id, params: values() }).then(function (r) {
        if (!r || !r.ok) { show('⚠ ' + ((r && r.error) || 'No se pudo')); return; }
        show(r.plan.summary, r.plan.lines);
        run.hidden = !(r.plan.count > 0 && sc.risk !== 'lee');
      });
    };
    run.onclick = function () {
      run.disabled = true; prev.disabled = true;
      show('Trabajando…');
      api.invoke(ch.scriptRun, { id: sc.id, params: values() }).then(function (r) {
        run.disabled = false; prev.disabled = false; run.hidden = true;
        if (!r || !r.ok) { show('⚠ ' + ((r && r.error) || 'No se pudo'), null, r && r.undoable ? undoButton(r.runId) : null); return; }
        show(r.summary, r.lines, r.undoable ? undoButton(r.runId) : null);
        api.invoke(ch.scriptsList).then(function (d) { scriptState.data.runs = d.runs; });
      });
    };
    function undoButton(id) {
      var b = el('button', 'btn btn-sm', 'Deshacer');
      b.type = 'button';
      b.onclick = function () { undoRunUi(id); out.innerHTML = ''; };
      return b;
    }
    if (sc.risk === 'lee' && !sc.params.some(function (p) { return p.required && !fields[p.name].value; })) { /* se puede ver con un clic */ }
    return card;
  }

  document.getElementById('scripts-open').addEventListener('click', function () { showTab('scripts'); });
  document.getElementById('scripts-back').addEventListener('click', function () { showTab('chat'); });

  document.getElementById('chats-open').addEventListener('click', function () { showTab('chats'); });
  document.getElementById('chats-back').addEventListener('click', function () { showTab('chat'); });
  document.getElementById('chat-new').addEventListener('click', newChat);
  document.getElementById('chats-new').addEventListener('click', newChat);

  // Borrar esta conversación (botón del chat) o todas (Ajustes), del chat y del disco
  document.getElementById('chat-clear').addEventListener('click', function () {
    deleteChat({ id: activeConv, title: chatTitle.textContent });
  });
  document.getElementById('set-clear').addEventListener('click', function () {
    if (!window.confirm('¿Borrar TODAS las conversaciones? Se eliminan de tu Mac y no se puede deshacer.')) return;
    api.invoke(ch.chatClearHistory).then(function () { reloadChat(); showToast('Conversaciones borradas'); });
  });

  // Al abrir la app, vuelve el historial guardado
  reloadChat();

  // Thinking indicator
  api.on(ch.chatThinking, function (on) {
    thinking.hidden = !on;
    if (on) messages.scrollTop = messages.scrollHeight;
  });

  // Kogn propuso recuerdos por su cuenta (proyectos y hábitos): actualiza la lista y el contador
  api.on(ch.memoryRefresh, function () { loadMemories(); });

  // Mensajes locales (resumen) y chat nuevo desde atajos
  api.on(ch.chatReply, function (text) { showTab('chat'); addMessage('assistant', text); });
  api.on(ch.chatClear, function () { reloadChat(); showTab('chat'); }); // atajo de conversación nueva

  // File edit proposed from AI
  api.on(ch.fileEditProposed, function (edit) {
    updateFilesBadge(pendingOpsCount + 1);
    loadFileEdits();
    showToast('Nueva operación propuesta — revisa en Archivos');
  });

  // Suggestions
  api.on(ch.suggestionShow, function (s) {
    pendingSuggestion = s;
    suggestionText.textContent = '💡 ' + s.text;
    suggestionBanner.hidden = false;
    showTab('chat');
  });

  suggestionAccept.addEventListener('click', function () {
    if (!pendingSuggestion) return;
    var id = pendingSuggestion.id;
    var text = pendingSuggestion.text;
    pendingSuggestion = null;
    suggestionBanner.hidden = true;
    addMessage('assistant', text);
    chatInput.disabled = true;
    api.invoke(ch.suggestionAccept, id).then(function (result) {
      chatInput.disabled = false;
      chatInput.focus();
      loadCost();
      if (result && result.reply) {
        addMessage('assistant', result.reply);
      }
    });
  });

  suggestionDismiss.addEventListener('click', function () {
    if (!pendingSuggestion) return;
    api.invoke(ch.suggestionDismiss, pendingSuggestion.id);
    pendingSuggestion = null;
    suggestionBanner.hidden = true;
  });

  loadCost();
  loadModels();
  loadMemories();
  api.invoke(ch.settingsGet).then(function (s) { if (s && !s.onboarding_done) openGuide(); }); // primera vez
  api.on(ch.observerChanged, renderStatus);
  api.invoke(ch.observerStatus).then(renderStatus);
})();

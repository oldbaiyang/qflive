/**
 * QFLive app —— 多画面直播墙
 * 直连优先，跨域/失败时自动降级到本站 /api/proxy
 */
(function () {
  'use strict';

  var STORE_KEY = 'qflive.v1';

  var LAYOUTS = [
    { id: '1', cols: 1, rows: 1, label: '1' },
    { id: '2', cols: 2, rows: 1, label: '2' },
    { id: '4', cols: 2, rows: 2, label: '4' },
    { id: '6', cols: 3, rows: 2, label: '6' },
    { id: '9', cols: 3, rows: 3, label: '9' }
  ];

  var DEMO = [
    { name: 'Mux 测试流', url: 'https://stream.mux.com/v69RSHhFelSm4701snP22dYz2jICy4E4FUyk02rW4gxRM.m3u8' },
    { name: 'Apple BipBop', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
    { name: 'Akamai 直播', url: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8' }
  ];

  var ICONS = {
    volume: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 9.5v5h3.6L13 19V5L7.6 9.5H4z" fill="currentColor" stroke="none"/><path d="M16.4 8.6a5 5 0 010 6.8" stroke-linecap="round"/></svg>',
    mute: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 9.5v5h3.6L13 19V5L7.6 9.5H4z" fill="currentColor" stroke="none"/><path d="M16.4 9.6l5 4.8M21.4 9.6l-5 4.8" stroke-linecap="round"/></svg>',
    solo: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 13.5v-1a7.5 7.5 0 0115 0v1" stroke-linecap="round"/><rect x="2.6" y="13.4" width="4.2" height="6.6" rx="1.5" fill="currentColor" stroke="none"/><rect x="17.2" y="13.4" width="4.2" height="6.6" rx="1.5" fill="currentColor" stroke="none"/></svg>',
    full: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    reload: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 11-2.4-5.7M20 4.4V10h-5.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };

  var state = {
    sources: [],
    layout: 'auto',
    settings: { muted: true, reconnect: true, forceProxy: false, proxyPrefix: '' }
  };

  var tiles = new Map();
  var proxyReady = null;   // null = 未探测，true/false = 探测结果
  var dragId = null;

  /* ---------------- 工具 ---------------- */

  function $(sel) { return document.querySelector(sel); }
  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function toast(msg, isErr) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () { el.remove(); }, 300);
    }, 3200);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.sources)) return;
      state.sources = data.sources.filter(function (s) { return s && s.url; });
      if (data.layout) state.layout = data.layout;
      if (data.settings) {
        for (var k in state.settings) {
          if (typeof data.settings[k] !== 'undefined') state.settings[k] = data.settings[k];
        }
      }
    } catch (e) {}
  }

  function autoName(url) {
    try {
      var u = new URL(url);
      var parts = u.pathname.split('/').filter(Boolean);
      var seg = parts.pop() || '';
      if (/^(master|index|playlist|main|live)$/i.test(seg.replace(/\.[a-z0-9]+$/i, ''))) {
        seg = parts.pop() || seg;
      }
      var name = decodeURIComponent(seg).replace(/\.(m3u8|mpd|flv|ts|m4s|mp4|m3u)$/i, '');
      return name || u.hostname;
    } catch (e) {
      return url.slice(0, 24);
    }
  }

  /* ---------------- 代理地址 ---------------- */

  function proxyUrl(u) {
    var prefix = String(state.settings.proxyPrefix || '').trim();
    if (prefix) {
      if (/[?&]url=$/.test(prefix) || /=$/.test(prefix)) return prefix + encodeURIComponent(u);
      return prefix + u;
    }
    return '/api/proxy?url=' + encodeURIComponent(u);
  }

  function needProxyByDefault(url) {
    if (state.settings.forceProxy) return true;
    // 页面是 https、源是 http：浏览器会拦混合内容，必须走代理
    if (location.protocol === 'https:' && /^http:\/\//i.test(url)) return true;
    return false;
  }

  function probeProxy() {
    if (location.protocol === 'file:') { proxyReady = false; return; }
    fetch('/api/proxy?probe=1', { method: 'GET', cache: 'no-store' })
      .then(function (r) { proxyReady = r.ok || r.status === 204; })
      .catch(function () { proxyReady = false; });
  }

  /* ---------------- 布局 ---------------- */

  function pickLayout(n) {
    if (n <= 1) return LAYOUTS[0];
    if (n <= 2) return LAYOUTS[1];
    if (n <= 4) return LAYOUTS[2];
    if (n <= 6) return LAYOUTS[3];
    return LAYOUTS[4];
  }

  function gridSpec() {
    if (state.layout === 'auto') return pickLayout(state.sources.length);
    for (var i = 0; i < LAYOUTS.length; i++) {
      if (LAYOUTS[i].id === state.layout) return LAYOUTS[i];
    }
    return pickLayout(state.sources.length);
  }

  function renderLayouts() {
    var box = $('#layoutPicker');
    box.innerHTML = '';

    var auto = document.createElement('button');
    auto.textContent = '自动';
    auto.title = '按画面数量自动选择';
    if (state.layout === 'auto') auto.className = 'active';
    auto.addEventListener('click', function () { setLayout('auto'); });
    box.appendChild(auto);

    LAYOUTS.forEach(function (l) {
      var b = document.createElement('button');
      b.textContent = l.label;
      b.title = l.cols + ' × ' + l.rows;
      if (state.layout === l.id) b.className = 'active';
      b.addEventListener('click', function () { setLayout(l.id); });
      box.appendChild(b);
    });
  }

  function setLayout(id) {
    state.layout = id;
    save();
    renderLayouts();
    syncWall();
  }

  /* ---------------- 画面 ---------------- */

  var TILE_TPL =
    '<video playsinline preload="metadata"></video>' +
    '<div class="tile-loading"><span class="spinner"></span></div>' +
    '<div class="tile-top"><span class="dot"></span><span class="tile-name"></span></div>' +
    '<div class="tile-meta"></div>' +
    '<div class="tile-ctrl">' +
      '<button data-act="mute" title="静音 / 取消静音">' + ICONS.volume + '</button>' +
      '<button data-act="solo" title="独奏：只保留这一路的声音">' + ICONS.solo + '</button>' +
      '<button data-act="full" title="全屏">' + ICONS.full + '</button>' +
      '<button data-act="reload" title="重载">' + ICONS.reload + '</button>' +
      '<button data-act="remove" title="移除">' + ICONS.close + '</button>' +
    '</div>' +
    '<div class="tile-error"><span class="err-title"></span><p></p>' +
      '<button class="btn tiny" data-act="retry">重试</button></div>' +
    '<div class="tile-tap"><span>点击播放</span></div>';

  function createTile(source) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.dataset.id = source.id;
    el.innerHTML = TILE_TPL;

    var video = el.querySelector('video');
    video.muted = !!state.settings.muted;
    video.volume = 1;

    el.querySelector('.tile-name').textContent = source.name;

    var tile = {
      el: el, video: video, source: source,
      player: null, status: 'idle', mode: 'direct',
      retries: 0, latency: null, w: 0, h: 0, started: false, lastFix: 0
    };
    tiles.set(source.id, tile);
    refreshMute(tile);

    el.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (btn) { handleTileAction(tile, btn.dataset.act); return; }
      setActive(source.id);
    });

    el.addEventListener('dblclick', function (e) {
      if (e.target.closest('button')) return;
      toggleFullscreen(el);
    });

    el.querySelector('.tile-tap').addEventListener('click', function () {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      hideTap(tile);
    });

    return tile;
  }

  function startTile(tile, mode) {
    var src = tile.source;
    var meta = window.detectSource(src.url);

    tile.type = meta.type;
    tile.label = window.TYPE_LABEL[meta.type] || meta.type;
    tile.mode = mode;

    if (tile.player) { tile.player.destroy(); tile.player = null; }

    if (!meta.playable) {
      setStatus(tile, 'unsupported');
      showError(tile, '暂不支持该协议', meta.hint, false);
      return;
    }

    setStatus(tile, 'loading');
    hideError(tile);

    tile.player = new window.LivePlayer(tile.video, src.url, {
      resolve: function (u) { return mode === 'proxy' ? proxyUrl(u) : u; },
      onStatus: function (s) { onStatus(tile, s); }
    });
    tile.player.start();
  }

  function onStatus(tile, s) {
    switch (s.state) {
      case 'loading':
        setStatus(tile, 'loading');
        break;

      case 'playing':
        setStatus(tile, 'playing');
        hideLoading(tile);
        hideError(tile);
        hideTap(tile);
        tile.retries = 0;
        if (s.width) { tile.w = s.width; tile.h = s.height; }
        updateMeta(tile);
        break;

      case 'buffering':
        setStatus(tile, 'buffering');
        break;

      case 'meta':
        tile.w = s.width; tile.h = s.height;
        updateMeta(tile);
        break;

      case 'latency':
        tile.latency = s.latency;
        updateMeta(tile);
        break;

      case 'blocked':
        showTap(tile);
        break;

      case 'stalled':
        onStalled(tile);
        break;

      case 'error':
        onFail(tile, s.message);
        break;

      case 'unsupported':
        setStatus(tile, 'unsupported');
        showError(tile, '暂不支持该协议', s.message, false);
        break;
    }
  }

  function onFail(tile, message) {
    setStatus(tile, 'error');

    // 第一次直连失败：自动降级到代理（延后一拍，避免在播放器自身的回调里销毁它）
    if (tile.mode === 'direct' && proxyReady !== false) {
      tile.mode = 'proxy';
      toast('直连受限，已切换代理重试：' + tile.source.name);
      setTimeout(function () {
        if (tiles.has(tile.source.id)) startTile(tile, 'proxy');
      }, 0);
      return;
    }

    var hint = message || '未知错误';
    if (proxyReady === false) {
      hint += '\n\n当前未启用代理（本地静态模式）。请用 npx wrangler pages dev 本地调试，或部署到 Cloudflare Pages 后使用。';
    }

    if (state.settings.reconnect && tile.retries < 3) {
      tile.retries++;
      showError(tile, '连接中断，正在重连（' + tile.retries + '/3）', hint, false);
      var wait = 1500 * tile.retries;
      setTimeout(function () {
        if (tiles.has(tile.source.id)) startTile(tile, tile.mode);
      }, wait);
      return;
    }

    showError(tile, '播放失败', hint, true);
  }

  function onStalled(tile) {
    if (!state.settings.reconnect) return;
    var now = Date.now();
    if (now - tile.lastFix < 12000) return;
    tile.lastFix = now;
    setTimeout(function () {
      if (tiles.has(tile.source.id)) startTile(tile, tile.mode);
    }, 0);
  }

  function handleTileAction(tile, act) {
    if (act === 'mute') {
      tile.video.muted = !tile.video.muted;
      refreshMute(tile);
      syncMuteAllLabel();
    } else if (act === 'solo') {
      tiles.forEach(function (t) {
        t.video.muted = (t !== tile);
        refreshMute(t);
      });
      syncMuteAllLabel();
    } else if (act === 'full') {
      toggleFullscreen(tile.el);
    } else if (act === 'reload') {
      tile.retries = 0;
      startTile(tile, tile.mode);
    } else if (act === 'retry') {
      tile.retries = 0;
      startTile(tile, needProxyByDefault(tile.source.url) ? 'proxy' : 'direct');
    } else if (act === 'remove') {
      removeSource(tile.source.id);
    }
  }

  function refreshMute(tile) {
    var btn = tile.el.querySelector('[data-act="mute"]');
    if (!btn) return;
    btn.innerHTML = tile.video.muted ? ICONS.mute : ICONS.volume;
    btn.classList.toggle('on', !tile.video.muted);
  }

  function setStatus(tile, status) {
    tile.status = status;
    var dot = tile.el.querySelector('.dot');
    if (dot) dot.className = 'dot ' + status;
    if (status === 'loading') showLoading(tile);
    if (status === 'playing' || status === 'error' || status === 'unsupported') hideLoading(tile);
    updateSourceDot(tile.source.id, status);
  }

  function showLoading(tile) {
    var el = tile.el.querySelector('.tile-loading');
    if (el) el.classList.remove('hide');
  }

  function updateMeta(tile) {
    var el = tile.el.querySelector('.tile-meta');
    if (!el) return;
    var parts = [tile.label || ''];
    if (tile.w) parts.push(tile.w + '×' + tile.h);
    if (tile.latency != null) parts.push('延迟 ' + tile.latency.toFixed(1) + 's');
    if (tile.mode === 'proxy') parts.push('代理');
    el.textContent = parts.filter(Boolean).join(' · ');
  }

  function hideLoading(tile) {
    var el = tile.el.querySelector('.tile-loading');
    if (el) el.classList.add('hide');
  }

  function showError(tile, title, msg, canRetry) {
    var box = tile.el.querySelector('.tile-error');
    box.querySelector('.err-title').textContent = title || '播放失败';
    box.querySelector('p').textContent = msg || '';
    var btn = box.querySelector('[data-act="retry"]');
    btn.style.display = canRetry ? '' : 'none';
    box.classList.add('show');
  }

  function hideError(tile) {
    var box = tile.el.querySelector('.tile-error');
    if (box) box.classList.remove('show');
  }

  function showTap(tile) { tile.el.querySelector('.tile-tap').classList.add('show'); }
  function hideTap(tile) { tile.el.querySelector('.tile-tap').classList.remove('show'); }

  function toggleFullscreen(el) {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(function () {});
    }
  }

  function setActive(id) {
    tiles.forEach(function (t) { t.el.classList.toggle('active', t.source.id === id); });
    Array.prototype.forEach.call($('#srcList').children, function (li) {
      li.classList.toggle('active', li.dataset.id === id);
    });
  }

  /* ---------------- 画面墙同步 ---------------- */

  function syncWall() {
    var spec = gridSpec();
    var count = state.sources.length;
    var cols = spec.cols;
    var rows = Math.max(spec.rows, Math.ceil(count / cols) || 1);

    var wall = $('#wall');
    wall.style.setProperty('--cols', cols);
    wall.style.setProperty('--rows', rows);

    // 移除已删除的
    Array.from(tiles.keys()).forEach(function (id) {
      var still = state.sources.some(function (s) { return s.id === id; });
      if (!still) {
        var t = tiles.get(id);
        if (t.player) t.player.destroy();
        if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
        tiles.delete(id);
      }
    });

    // 创建 / 排序
    state.sources.forEach(function (s, i) {
      var t = tiles.get(s.id);
      if (!t) t = createTile(s);
      t.el.style.order = String(i);
      if (!t.el.parentNode) wall.appendChild(t.el);
      if (!t.started) {
        t.started = true;
        startTile(t, needProxyByDefault(s.url) ? 'proxy' : 'direct');
      }
    });

    // 占位格子
    Array.prototype.slice.call(wall.querySelectorAll('.tile-placeholder')).forEach(function (p) { p.remove(); });
    if (count > 0) {
      var cells = cols * rows;
      for (var i = count; i < cells; i++) {
        var ph = document.createElement('div');
        ph.className = 'tile-placeholder';
        ph.style.order = String(1000 + i);
        ph.innerHTML = ICONS.plus;
        ph.title = '添加直播源';
        ph.addEventListener('click', function () { $('#inputUrl').focus(); });
        wall.appendChild(ph);
      }
    }

    var empty = count === 0;
    $('#emptyState').classList.toggle('show', empty);
    wall.style.display = empty ? 'none' : '';
    syncMuteAllLabel();
  }

  /* ---------------- 源管理 ---------------- */

  function addSource(url, name) {
    url = String(url || '').trim();
    if (!url) return false;

    if (!/^(https?|rtmps?|rtsp|srt|udp|rtp|mms):\/\//i.test(url)) {
      toast('地址需要以 http:// https:// rtmp:// 等协议开头', true);
      return false;
    }
    if (state.sources.some(function (s) { return s.url === url; })) {
      toast('这个地址已经在墙上了', true);
      return false;
    }

    state.sources.push({ id: uid(), url: url, name: String(name || '').trim() || autoName(url) });
    save();
    renderSourceList();
    syncWall();
    return true;
  }

  function addMany(items) {
    var added = 0;
    items.forEach(function (it) {
      var url = typeof it === 'string' ? it : it.url;
      var name = typeof it === 'string' ? '' : it.name;
      url = String(url || '').trim();
      if (!url) return;
      if (!/^(https?|rtmps?|rtsp|srt|udp|rtp|mms):\/\//i.test(url)) return;
      if (state.sources.some(function (s) { return s.url === url; })) return;
      state.sources.push({ id: uid(), url: url, name: String(name || '').trim() || autoName(url) });
      added++;
    });
    if (added) {
      save();
      renderSourceList();
      syncWall();
      toast('已添加 ' + added + ' 个源');
    } else {
      toast('没有新增可用地址', true);
    }
  }

  function removeSource(id) {
    var idx = state.sources.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return;
    var t = tiles.get(id);
    if (t) {
      if (t.player) t.player.destroy();
      if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
      tiles.delete(id);
    }
    state.sources.splice(idx, 1);
    save();
    renderSourceList();
    syncWall();
  }

  function clearSources() {
    if (!state.sources.length) return;
    if (!confirm('清空墙上的全部 ' + state.sources.length + ' 个源？')) return;
    tiles.forEach(function (t) { if (t.player) t.player.destroy(); });
    tiles.clear();
    state.sources = [];
    save();
    renderSourceList();
    syncWall();
  }

  function updateSourceDot(id, status) {
    var dot = $('#srcList').querySelector('[data-id="' + id + '"] .dot');
    if (dot) dot.className = 'dot ' + status;
  }

  function renderSourceList() {
    var list = $('#srcList');
    list.innerHTML = '';
    $('#srcCount').textContent = String(state.sources.length);

    state.sources.forEach(function (s) {
      var t = tiles.get(s.id);
      var li = document.createElement('li');
      li.className = 'src-item';
      li.dataset.id = s.id;
      li.draggable = true;

      var dot = document.createElement('span');
      dot.className = 'dot ' + (t ? t.status : '');

      var info = document.createElement('div');
      info.className = 'src-info';
      var nameEl = document.createElement('span');
      nameEl.className = 'src-name';
      nameEl.textContent = s.name;
      var urlEl = document.createElement('span');
      urlEl.className = 'src-url';
      urlEl.textContent = s.url;
      info.appendChild(nameEl);
      info.appendChild(urlEl);

      var del = document.createElement('button');
      del.className = 'src-remove';
      del.innerHTML = ICONS.close;
      del.title = '移除';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeSource(s.id);
      });

      li.appendChild(dot);
      li.appendChild(info);
      li.appendChild(del);

      li.addEventListener('click', function () {
        setActive(s.id);
        var tile = tiles.get(s.id);
        if (tile) tile.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });

      li.addEventListener('dblclick', function () {
        var name = prompt('修改名称', s.name);
        if (name && name.trim()) {
          s.name = name.trim();
          save();
          renderSourceList();
          var tile = tiles.get(s.id);
          if (tile) tile.el.querySelector('.tile-name').textContent = s.name;
        }
      });

      li.addEventListener('dragstart', function (e) {
        dragId = s.id;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', s.id); } catch (err) {}
      });
      li.addEventListener('dragend', function () {
        li.classList.remove('dragging');
        Array.prototype.forEach.call(list.children, function (x) { x.classList.remove('drop-target'); });
        dragId = null;
      });
      li.addEventListener('dragover', function (e) {
        if (!dragId || dragId === s.id) return;
        e.preventDefault();
        li.classList.add('drop-target');
      });
      li.addEventListener('dragleave', function () { li.classList.remove('drop-target'); });
      li.addEventListener('drop', function (e) {
        e.preventDefault();
        li.classList.remove('drop-target');
        if (dragId && dragId !== s.id) moveSource(dragId, s.id);
      });

      list.appendChild(li);
    });
  }

  function moveSource(fromId, toId) {
    var from = state.sources.findIndex(function (s) { return s.id === fromId; });
    var to = state.sources.findIndex(function (s) { return s.id === toId; });
    if (from < 0 || to < 0 || from === to) return;
    var item = state.sources.splice(from, 1)[0];
    state.sources.splice(to, 0, item);
    save();
    renderSourceList();
    syncWall();
  }

  /* ---------------- 导入导出 ---------------- */

  function parsePlaylist(text) {
    var out = [];
    var pending = null;
    text.split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (/^#EXTINF/i.test(line)) {
        var m = line.match(/,(.*)$/);
        pending = m ? m[1].trim() : null;
        return;
      }
      if (line.charAt(0) === '#') return;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        out.push({ url: line, name: pending || '' });
        pending = null;
      }
    });
    return out;
  }

  function parseJson(text) {
    try {
      var data = JSON.parse(text);
      var arr = Array.isArray(data) ? data : (data && data.sources) || [];
      return arr.map(function (it) {
        if (typeof it === 'string') return { url: it, name: '' };
        return { url: it.url, name: it.name || '' };
      }).filter(function (it) { return it.url; });
    } catch (e) {
      return [];
    }
  }

  function handleFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var items = /\.json$/i.test(file.name) ? parseJson(text) : parsePlaylist(text);
      if (!items.length) { toast('文件里没解析到可用地址', true); return; }
      addMany(items);
    };
    reader.readAsText(file);
  }

  function exportM3u() {
    if (!state.sources.length) { toast('还没有可导出的源', true); return; }
    var lines = ['#EXTM3U'];
    state.sources.forEach(function (s) {
      lines.push('#EXTINF:-1,' + s.name);
      lines.push(s.url);
    });
    var blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qflive.m3u';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------------- 全局操作 ---------------- */

  function syncMuteAllLabel() {
    var allMuted = true;
    tiles.forEach(function (t) { if (!t.video.muted) allMuted = false; });
    $('#btnMuteAll').textContent = allMuted ? '全部取消静音' : '全部静音';
  }

  function toggleMuteAll() {
    var allMuted = true;
    tiles.forEach(function (t) { if (!t.video.muted) allMuted = false; });
    var next = !allMuted;
    tiles.forEach(function (t) {
      t.video.muted = next;
      refreshMute(t);
    });
    syncMuteAllLabel();
  }

  function reloadAll() {
    tiles.forEach(function (t) {
      t.retries = 0;
      startTile(t, t.mode);
    });
    toast('已重载全部画面');
  }

  function loadDemo() {
    addMany(DEMO);
  }

  /* ---------------- 设置 ---------------- */

  function bindSettings() {
    var proxyInput = $('#inputProxy');
    var forceProxy = $('#optForceProxy');
    var muted = $('#optMuted');
    var reconnect = $('#optReconnect');

    proxyInput.value = state.settings.proxyPrefix || '';
    forceProxy.checked = !!state.settings.forceProxy;
    muted.checked = !!state.settings.muted;
    reconnect.checked = !!state.settings.reconnect;

    proxyInput.addEventListener('change', function () {
      state.settings.proxyPrefix = proxyInput.value.trim();
      save();
      toast('代理前缀已保存，重载画面后生效');
    });

    forceProxy.addEventListener('change', function () {
      state.settings.forceProxy = forceProxy.checked;
      save();
      toast('重载画面后生效');
    });

    muted.addEventListener('change', function () {
      state.settings.muted = muted.checked;
      save();
    });

    reconnect.addEventListener('change', function () {
      state.settings.reconnect = reconnect.checked;
      save();
    });
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    load();
    renderLayouts();
    renderSourceList();
    syncWall();
    bindSettings();
    probeProxy();

    $('#addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var ok = addSource($('#inputUrl').value, $('#inputName').value);
      if (ok) {
        $('#inputUrl').value = '';
        $('#inputName').value = '';
        $('#inputUrl').focus();
      }
    });

    $('#btnSidebar').addEventListener('click', function () { $('#sidebar').classList.toggle('hidden'); });
    $('#btnMuteAll').addEventListener('click', toggleMuteAll);
    $('#btnReloadAll').addEventListener('click', reloadAll);
    $('#btnFull').addEventListener('click', function () { toggleFullscreen(document.documentElement); });
    $('#btnDemo').addEventListener('click', loadDemo);
    $('#btnExport').addEventListener('click', exportM3u);
    $('#btnClear').addEventListener('click', clearSources);
    $('#btnImportFile').addEventListener('click', function () { $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', function (e) {
      handleFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });

    var stage = $('#stage');
    stage.addEventListener('dragover', function (e) { e.preventDefault(); });
    stage.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });

    window.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === 'f' || e.key === 'F') {
        if (!document.fullscreenElement) toggleFullscreen(document.documentElement);
      }
    });

    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement) {
        // 退出全屏后确保布局重算
        syncWall();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

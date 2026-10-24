/**
 * QFLive player core
 * 按地址自动选择播放内核：HLS / DASH / HTTP-FLV / MPEG-TS / 原生
 */
(function (global) {
  'use strict';

  var VENDOR = {
    hls: 'vendor/hls.min.js',
    mpegts: 'vendor/mpegts.js',
    dash: 'vendor/dash.all.min.js'
  };

  var scriptCache = {};

  function loadScript(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        delete scriptCache[src];
        reject(new Error('播放内核加载失败：' + src));
      };
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  var UNSUPPORTED_HINT = {
    rtmp: '浏览器无法直连 RTMP。请用 ffmpeg 转成 HLS 或 HTTP-FLV 后再添加，例如：\nffmpeg -i rtmp://src/app/key -c copy -f flv http://localhost/live/x.flv',
    rtsp: 'RTSP 需要转码（监控摄像头常用）。可用 ffmpeg 拉流转 HLS：\nffmpeg -rtsp_transport tcp -i rtsp://... -c copy -f hls out.m3u8',
    raw: 'SRT / UDP / RTP / MMS 属于传输层协议，浏览器无法直接播放，需要先转封装。'
  };

  /** 识别地址类型 */
  function detect(url) {
    var raw = String(url || '').trim();
    var low = raw.toLowerCase();
    var path = low.split('?')[0].split('#')[0];

    if (/^rtmps?:\/\//.test(low)) return { type: 'rtmp', playable: false, hint: UNSUPPORTED_HINT.rtmp };
    if (/^rtsp:\/\//.test(low)) return { type: 'rtsp', playable: false, hint: UNSUPPORTED_HINT.rtsp };
    if (/^(srt|udp|rtp|mms):/.test(low)) return { type: 'raw', playable: false, hint: UNSUPPORTED_HINT.raw };

    if (low.indexOf('.m3u8') > -1) return { type: 'hls', playable: true };
    if (path.indexOf('.mpd') > -1) return { type: 'dash', playable: true };
    if (path.indexOf('.flv') > -1) return { type: 'flv', playable: true };
    if (/\.(ts|mts|m2ts)$/.test(path)) return { type: 'mpegts', playable: true };
    if (/\.(mp4|m4v|webm|ogv|ogg|mov)$/.test(path)) return { type: 'native', playable: true };

    // 没有明显后缀时按 HLS 尝试（多数直播 CDN 的默认形态）
    return { type: 'hls', playable: true, guess: true };
  }

  var TYPE_LABEL = {
    hls: 'HLS',
    dash: 'DASH',
    flv: 'HTTP-FLV',
    mpegts: 'MPEG-TS',
    native: '原生',
    rtmp: 'RTMP',
    rtsp: 'RTSP',
    raw: '原始流'
  };

  function LivePlayer(video, url, opts) {
    opts = opts || {};
    this.video = video;
    this.url = url;
    this.opts = opts;
    this.meta = detect(url);
    this.type = this.meta.type;
    this.engine = null;
    this.dead = false;
    this._netRetry = 0;
    this._stall = 0;
    this._lastTime = -1;
    this._lastW = 0;
    this._lastH = 0;
    this._timers = [];
    this._bindMedia();
  }

  LivePlayer.prototype._emit = function (state, extra) {
    if (this.dead || !this.opts.onStatus) return;
    var payload = { state: state, type: this.type, label: TYPE_LABEL[this.type] || this.type };
    if (extra) for (var k in extra) payload[k] = extra[k];
    this.opts.onStatus(payload);
  };

  LivePlayer.prototype._bindMedia = function () {
    var self = this;
    var v = this.video;

    this._onPlaying = function () {
      self._netRetry = 0;
      self._stall = 0;
      self._emit('playing', { width: v.videoWidth, height: v.videoHeight });
    };
    this._onWaiting = function () { self._emit('buffering'); };
    this._onError = function () {
      var err = v.error;
      var msg = err ? ('媒体错误 ' + err.code + (err.message ? '：' + err.message : '')) : '媒体元素报错';
      self._emit('error', { message: msg });
    };

    v.addEventListener('playing', this._onPlaying);
    v.addEventListener('waiting', this._onWaiting);
    v.addEventListener('error', this._onError);
  };

  LivePlayer.prototype._timer = function (fn, ms) {
    var id = setInterval(fn, ms);
    this._timers.push(id);
    return id;
  };

  LivePlayer.prototype._resolveUrl = function () {
    // 上层可注入完整的地址改写逻辑（直连 / 代理 / 自定义前缀）
    if (typeof this.opts.resolve === 'function') {
      return this.opts.resolve(this.url);
    }
    var proxy = String(this.opts.proxy || '').trim();
    if (!proxy) return this.url;
    // 以 = 或 ?url= 结尾的代理需要 URL 编码
    if (/[?&]url=$/.test(proxy) || /=$/.test(proxy)) {
      return proxy + encodeURIComponent(this.url);
    }
    return proxy + this.url;
  };

  LivePlayer.prototype.start = function () {
    if (this.dead) return Promise.resolve();
    this._emit('loading');

    if (!this.meta.playable) {
      this._emit('unsupported', { message: this.meta.hint });
      return Promise.resolve();
    }

    var self = this;
    var task;
    if (this.type === 'hls') task = this._hls();
    else if (this.type === 'dash') task = this._dash();
    else if (this.type === 'flv' || this.type === 'mpegts') task = this._mpegts();
    else task = this._native();

    return Promise.resolve(task)
      .then(function () { self._watch(); })
      .catch(function (e) {
        self._emit('error', { message: (e && e.message) || String(e) });
      });
  };

  LivePlayer.prototype._play = function () {
    var v = this.video;
    var p = v.play();
    if (p && p.catch) {
      p.catch(function () {
        // 自动播放被拦截，交给界面显示"点击播放"
        if (v.paused) this._emit && this._emit('blocked');
      }.bind(this));
    }
  };

  LivePlayer.prototype._hls = function () {
    var self = this;
    var url = this._resolveUrl();
    var video = this.video;

    return loadScript(VENDOR.hls).then(function () {
      var Hls = global.Hls;
      if (!Hls) throw new Error('HLS 内核未就绪');

      if (Hls.isSupported()) {
        var hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          backBufferLength: 30,
          maxBufferLength: 20,
          manifestLoadingMaxRetry: 3,
          manifestLoadingRetryDelay: 800,
          fragLoadingMaxRetry: 4
        });
        self.engine = hls;

        hls.on(Hls.Events.ERROR, function (_, data) {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            self._netRetry++;
            if (self._netRetry <= 4) {
              try { hls.startLoad(); return; } catch (e) {}
            }
            self._emit('error', { message: '网络错误：' + (data.details || '拉流失败') + '（可能是跨域、防盗链或地址失效）' });
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); return; } catch (e) {}
            self._emit('error', { message: '解码失败：' + (data.details || '媒体错误') });
          } else {
            self._emit('error', { message: 'HLS 播放失败：' + (data.details || '未知错误') });
          }
        });

        hls.on(Hls.Events.MANIFEST_PARSED, function () { self._play(); });
        hls.on(Hls.Events.LEVEL_LOADED, function () { self._emit('ready'); });

        hls.loadSource(url);
        hls.attachMedia(video);

        self._timer(function () {
          if (hls.latency != null && isFinite(hls.latency)) {
            self._emit('latency', { latency: hls.latency });
          }
        }, 2000);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        self._play();
      } else {
        throw new Error('当前浏览器不支持 HLS 播放');
      }
    });
  };

  LivePlayer.prototype._dash = function () {
    var self = this;
    var url = this._resolveUrl();
    var video = this.video;

    return loadScript(VENDOR.dash).then(function () {
      var dashjs = global.dashjs;
      if (!dashjs) throw new Error('DASH 内核未就绪');

      var player = dashjs.MediaPlayer().create();
      self.engine = player;

      player.updateSettings({
        streaming: {
          lowLatencyEnabled: true,
          delay: { liveDelay: 3 },
          buffer: { fastSwitchEnabled: true }
        },
        debug: { logLevel: dashjs.Debug.LOG_LEVEL_NONE }
      });

      player.on('error', function (e) {
        var msg = (e && e.error && (e.error.message || e.error)) || '拉流失败';
        self._emit('error', { message: 'DASH 播放失败：' + msg });
      });

      player.initialize(video, url, true);
    });
  };

  LivePlayer.prototype._mpegts = function () {
    var self = this;
    var url = this._resolveUrl();
    var video = this.video;
    var kind = this.type === 'flv' ? 'flv' : 'mpegts';

    return loadScript(VENDOR.mpegts).then(function () {
      var mpegts = global.mpegts;
      if (!mpegts || !mpegts.isSupported()) {
        throw new Error('浏览器不支持 MSE，无法播放该格式');
      }

      var player = mpegts.createPlayer({
        type: kind,
        isLive: true,
        url: url,
        cors: true
      }, {
        enableWorker: true,
        enableStashBuffer: false,
        stashInitialSize: 128,
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3.0,
        liveBufferLatencyMinRemain: 0.5,
        autoCleanupSourceBuffer: true
      });

      self.engine = player;

      player.on(mpegts.Events.ERROR, function (type, detail) {
        self._emit('error', { message: '拉流失败：' + (detail || type) });
      });

      player.attachMediaElement(video);
      player.load();

      var p = player.play();
      if (p && p.catch) {
        p.catch(function () {
          if (video.paused) self._emit('blocked');
        });
      }
    });
  };

  LivePlayer.prototype._native = function () {
    this.video.src = this._resolveUrl();
    this._play();
    return Promise.resolve();
  };

  /** 直播卡死看门狗：连续 3 次检测到播放进度不前进就上报 stalled */
  LivePlayer.prototype._watch = function () {
    var self = this;
    var v = this.video;

    this._timer(function () {
      if (self.dead) return;

      if (!v.paused && v.readyState >= 2) {
        if (Math.abs(v.currentTime - self._lastTime) < 0.01) {
          self._stall++;
          if (self._stall >= 3) {
            self._stall = 0;
            self._emit('stalled');
          }
        } else {
          self._stall = 0;
        }
      }
      self._lastTime = v.currentTime;

      if (v.videoWidth && (v.videoWidth !== self._lastW || v.videoHeight !== self._lastH)) {
        self._lastW = v.videoWidth;
        self._lastH = v.videoHeight;
        self._emit('meta', { width: v.videoWidth, height: v.videoHeight });
      }
    }, 4000);
  };

  LivePlayer.prototype.setMuted = function (muted) {
    this.video.muted = !!muted;
  };

  LivePlayer.prototype.destroy = function () {
    this.dead = true;

    for (var i = 0; i < this._timers.length; i++) clearInterval(this._timers[i]);
    this._timers = [];

    var v = this.video;
    v.removeEventListener('playing', this._onPlaying);
    v.removeEventListener('waiting', this._onWaiting);
    v.removeEventListener('error', this._onError);

    try {
      if (this.engine) {
        if (typeof this.engine.destroy === 'function') this.engine.destroy();
        else if (typeof this.engine.reset === 'function') this.engine.reset();
      }
    } catch (e) {}
    this.engine = null;

    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch (e) {}
  };

  global.LivePlayer = LivePlayer;
  global.detectSource = detect;
  global.TYPE_LABEL = TYPE_LABEL;
})(window);

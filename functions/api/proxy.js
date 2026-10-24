/**
 * Cloudflare Pages Function: /api/proxy?url=<encoded>
 *
 * 职责：
 *  1. 绕开跨域限制，替浏览器拉流
 *  2. 透传 Referer / UA，绕过常见的防盗链
 *  3. 重写 m3u8 清单里的所有 URI，让分片也走代理（否则分片仍会直连源站撞 CORS）
 *  4. 拦截内网地址，避免被当成 SSRF 跳板
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;

function text(body, status, extra) {
  return new Response(body, {
    status,
    headers: Object.assign(
      { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      CORS,
      extra || {}
    ),
  });
}

/** 拒绝本机 / 内网 / 链路本地地址 */
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');

  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;

  // IPv6
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  // IPv4
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
  }

  return false;
}

function isPlaylist(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('vnd.apple')) return true;
  const path = String(url || '').split('?')[0].toLowerCase();
  return path.endsWith('.m3u8') || path.endsWith('.m3u');
}

function absolute(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch (e) {
    return uri;
  }
}

/** 把清单里的相对/绝对 URI 全部改写成代理地址 */
function rewritePlaylist(source, baseUrl, origin) {
  const wrap = (u) => origin + '/api/proxy?url=' + encodeURIComponent(u);

  return source
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;

      if (t.charAt(0) === '#') {
        // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF 里的 URI="..."
        return line.replace(/URI="([^"]*)"/g, (whole, uri) => {
          if (!uri || /^(data|skd):/i.test(uri)) return whole;
          return 'URI="' + wrap(absolute(uri, baseUrl)) + '"';
        });
      }

      // 普通行就是分片或子清单地址
      return wrap(absolute(t, baseUrl));
    })
    .join('\n');
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('method not allowed', 405);
  }

  const reqUrl = new URL(request.url);

  // 健康探测：前端用它判断当前环境是否具备代理能力
  if (reqUrl.searchParams.has('probe')) {
    return text('ok', 200);
  }

  const raw = reqUrl.searchParams.get('url');
  if (!raw) return text('missing ?url= parameter', 400);

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return text('invalid url', 400);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return text('only http/https is allowed', 400);
  }
  if (isBlockedHost(target.hostname)) {
    return text('blocked host', 403);
  }

  const headers = new Headers();
  headers.set('User-Agent', UA);
  headers.set('Accept', '*/*');
  headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
  // 防盗链：默认伪装成从源站首页点进来的
  headers.set('Referer', reqUrl.searchParams.get('ref') || target.origin + '/');

  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (e) {
    return text('upstream fetch failed: ' + ((e && e.message) || e), 502);
  }

  // 重定向后的真实地址，作为清单里相对路径的基准
  const finalUrl = upstream.url || target.href;

  if (isPlaylist(finalUrl, upstream.headers.get('Content-Type'))) {
    const body = await upstream.text();
    if (body.length > MAX_PLAYLIST_BYTES) return text('playlist too large', 413);

    return new Response(rewritePlaylist(body, finalUrl, reqUrl.origin), {
      status: 200,
      headers: Object.assign(
        {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        CORS
      ),
    });
  }

  // 分片 / FLV / MP4：流式透传，不缓冲
  // 注意：不透传 Content-Length —— Workers 会自动解压上游响应，长度会对不上
  const out = new Headers();
  const pass = ['Content-Type', 'Content-Range', 'Accept-Ranges', 'Last-Modified'];
  for (const key of pass) {
    const v = upstream.headers.get(key);
    if (v) out.set(key, v);
  }
  out.set('Cache-Control', 'no-store');
  for (const key of Object.keys(CORS)) out.set(key, CORS[key]);

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

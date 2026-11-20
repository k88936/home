#!/usr/bin/env node
/**
 * m3u8-probe.js — 用 Playwright 在真实浏览器上下文里嗅探页面播放的 m3u8 资源
 *
 * 用法:
 *   NODE_PATH=/usr/lib/node_modules node m3u8-probe.js "<PAGE_URL>" [outFile]
 *
 * 输出:
 *   1) 网络层捕获到的所有 .m3u8 请求（URL / status / referer / content-type）
 *   2) 播放器配置里硬编码的 m3u8（player_aaaa / DPlayer / video 标签 / 内联 JS）
 *   3) 每个 m3u8 的清单解析：master 变体 or media 分片、是否加密 (#EXT-X-KEY)、时长、分片数
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PAGE_URL = process.argv[2];
const OUT = process.argv[3] || 'm3u8-report.json';
if (!PAGE_URL) {
  console.error('usage: node m3u8-probe.js <PAGE_URL> [out.json]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isM3u8 = (u) => /\.m3u8(\?|#|$)/i.test(u) || /mpegurl/i.test(u);

async function fetchText(ctx, url, referer) {
  const res = await ctx.request.get(url, {
    headers: referer ? { referer } : {},
    timeout: 20000,
  });
  return { status: res.status(), body: await res.text() };
}

function parsePlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const info = {
    type: lines.some((l) => l.startsWith('#EXT-X-STREAM-INF')) ? 'master' : 'media',
    encrypted: lines.some((l) => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/i.test(l)),
    keys: lines.filter((l) => l.startsWith('#EXT-X-KEY')),
    segments: 0,
    duration: 0,
    variants: [],
    firstSegments: [],
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXTINF:')) {
      info.segments++;
      const d = parseFloat(l.slice(8));
      if (!Number.isNaN(d)) info.duration += d;
      const next = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (next && info.firstSegments.length < 3) info.firstSegments.push(new URL(next, baseUrl).href);
    }
    if (l.startsWith('#EXT-X-STREAM-INF')) {
      const next = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (next) info.variants.push({ attr: l, url: new URL(next, baseUrl).href });
    }
  }
  info.duration = Math.round(info.duration * 100) / 100;
  return info;
}

async function discoverInPage(page) {
  return page.evaluate(() => {
    const found = new Set();
    const push = (s) => {
      if (typeof s === 'string' && /\.m3u8/i.test(s)) found.add(s.trim().replace(/^\/\//, location.protocol + '//'));
    };
    try {
      if (window.player_aaaa) {
        push(window.player_aaaa.url);
        push(window.player_aaaa.url_next);
        if (window.player_aaaa.data) push(window.player_aaaa.data);
      }
    } catch (e) {}
    for (const k of ['mac_player', 'player_data', 'dplayer_aaaa', 'Hls', 'dp']) {
      try {
        const v = window[k];
        if (v && v.url) push(v.url);
      } catch (e) {}
    }
    document.querySelectorAll('video,source,iframe').forEach((el) => {
      push(el.src);
      push(el.getAttribute('data-src'));
    });
    // 页面内联脚本 / JSON 里的 m3u8 字面量
    const re = /https?:\/\/[^"'\s\\]+?\.m3u8[^"'\s\\]*/gi;
    for (const s of document.scripts) {
      const t = s.textContent || '';
      let m;
      while ((m = re.exec(t))) push(m[0]);
    }
    const html = document.documentElement.outerHTML;
    let m;
    while ((m = re.exec(html))) push(m[0]);
    return [...found];
  });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  const captured = [];
  page.on('requestfinished', async (req) => {
    const url = req.url();
    if (!isM3u8(url)) return;
    try {
      const res = await req.response();
      const headers = (await res?.allHeaders()) || {};
      captured.push({
        url,
        status: res ? res.status() : null,
        contentType: headers['content-type'] || null,
        referer: (await req.allHeaders())['referer'] || null,
        resourceType: req.resourceType(),
      });
    } catch (e) {
      captured.push({ url, status: null, error: String(e) });
    }
  });
  page.on('requestfailed', (req) => {
    if (isM3u8(req.url())) captured.push({ url: req.url(), status: 'FAILED', error: req.failure()?.errorText });
  });

  console.log('[*] goto', PAGE_URL);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('[!]', e.message));
  await sleep(2500);

  // 尝试触发播放：点播放按钮 / 点视频区域 / 调 play()
  console.log('[*] trigger playback');
  for (const sel of ['.dplayer-play-icon', '.dplayer-video-wrap', 'video', '#player', '.player']) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 2500 }).catch(() => {});
        break;
      }
    } catch (e) {}
  }
  await page.evaluate(() => {
    document.querySelectorAll('video').forEach((v) => {
      try { v.muted = true; v.play(); } catch (e) {}
    });
  }).catch(() => {});
  await sleep(6000);

  // iframe 内再触发一次
  for (const f of page.frames()) {
    await f.evaluate(() => {
      document.querySelectorAll('video').forEach((v) => {
        try { v.muted = true; v.play(); } catch (e) {}
      });
      const p = document.querySelector('.dplayer-play-icon, .dplayer');
      if (p) p.click();
    }).catch(() => {});
  }
  await sleep(5000);

  const inPage = await discoverInPage(page).catch(() => []);
  const uniq = [...new Set([...captured.map((c) => c.url), ...inPage])];
  console.log('[*] m3u8 candidates:', uniq.length);

  const report = { page: PAGE_URL, checkedAt: new Date().toISOString(), network: captured, inPage, playlists: [] };
  for (const u of uniq) {
    const entry = { url: u };
    try {
      if (/^https?:/i.test(u)) {
        const { status, body } = await fetchText(ctx, u, PAGE_URL);
        entry.httpStatus = status;
        entry.playlist = parsePlaylist(body, u);
        entry.head = body.split(/\r?\n/).slice(0, 8);
      }
    } catch (e) {
      entry.error = String(e);
    }
    report.playlists.push(entry);
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('[*] report ->', path.resolve(OUT));
  console.log(JSON.stringify(report, null, 2));

  await ctx.close();
  await browser.close();
})().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});

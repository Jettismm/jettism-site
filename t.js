/* Jettism visitor tracking — counts page views and where visitors came from.
   Results: jettism.productions/analytics (owner only).
   Share links like jettism.productions/?ref=discord to label a source, because the
   Discord app, many DMs and some apps don't tell the browser where a click came from. */
(function () {
  var API = 'https://script.google.com/macros/s/AKfycbyptp2MjQ9GkoG1M0LLWY0zJlYWbma1pkAwtEGVNSYctJoQpH0SR2YVj5h_oxZm6LXH/exec';
  window.jxTrack = function () {};
  try {
    if (navigator.webdriver || localStorage.getItem('jx_notrack') === '1') return;   // bots, and the owner's own browser
  } catch (e) {}

  function get(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { window[store].setItem(k, v); } catch (e) {} }

  var vid = get('localStorage', 'jx_vid');
  if (!vid) {
    vid = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^\w-]/g, '');
    set('localStorage', 'jx_vid', vid);
  }

  var KNOWN = [
    ['discord', /(^|\.)(discord\.com|discord\.gg|discordapp\.com|discordapp\.net)$/],
    ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/],
    ['tiktok', /(^|\.)tiktok\.com$/],
    ['twitter', /(^|\.)(t\.co|twitter\.com|x\.com)$/],
    ['instagram', /(^|\.)instagram\.com$/],
    ['twitch', /(^|\.)twitch\.tv$/],
    ['reddit', /(^|\.)reddit\.com$/],
    ['search', /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.com|search\.brave\.com)$/],
    ['jettism.com', /(^|\.)jettism\.com$/]
  ];
  var ALIAS = { yt: 'youtube', dc: 'discord', tt: 'tiktok', x: 'twitter', ig: 'instagram', google: 'search' };

  var refHost = '';
  try { refHost = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (e) {}
  var here = location.hostname.replace(/^www\./, '');

  var src = '';
  try {
    var q = new URLSearchParams(location.search);
    src = (q.get('ref') || q.get('utm_source') || q.get('src') || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
    src = ALIAS[src] || src;
  } catch (e) {}
  if (!src) {
    if (!refHost) src = 'direct';
    else if (refHost === here) src = get('sessionStorage', 'jx_src') || 'direct';   // moving between our own pages
    else {
      for (var i = 0; i < KNOWN.length; i++) if (KNOWN[i][1].test(refHost)) { src = KNOWN[i][0]; break; }
      if (!src) src = refHost;
    }
  }
  if (refHost !== here || !get('sessionStorage', 'jx_src')) set('sessionStorage', 'jx_src', src);

  function send(type) {
    var body = JSON.stringify({
      action: 'track', type: type, vid: vid, src: src,
      path: (location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/') || '/'),
      ref: refHost === here ? '' : refHost,
      dev: Math.min(screen.width, innerWidth) < 768 ? 'm' : 'd'
    });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(API, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {}
    try { fetch(API, { method: 'POST', body: body, mode: 'no-cors', keepalive: true }); } catch (e) {}
  }
  window.jxTrack = send;
  send('pv');
})();

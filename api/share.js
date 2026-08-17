// /s/CODE (rewritten to /api/share?code=CODE by vercel.json) is the link
// people actually copy/paste/share. It exists purely so chat apps get a
// rich preview card — the real app still lives at /?join=CODE.
//
// Facebook/WhatsApp/etc. "unfurl" a link by fetching it themselves with a
// bot user-agent and reading whatever HTML comes back — they never run
// JavaScript. So:
//   - bot request  -> return small HTML with og:title/og:image baked in
//                     (og:image points at /api/og, which draws the banner)
//   - human request -> 302 straight to the real /?join=CODE app URL,
//                       no visible redirect page, no flash
//
// If we redirected bots too, they'd just follow it to the SPA's generic
// (non-session-specific) meta tags and the whole point would be lost.

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://xqogfjttzsewrtnbwatv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhxb2dmanR0enNld3J0bmJ3YXR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2OTM3NzMsImV4cCI6MjEwMTI2OTc3M30.IEnaOjWzu7pmnEiiIvdw6NmZWPfa4q3CQ40GlKIB05k';

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

// Known link-unfurling bots. Not exhaustive, but covers every chat app
// someone is realistically pasting a PaddleStack invite into.
const BOT_UA_RE = /(facebookexternalhit|Facebot|WhatsApp|Twitterbot|Slackbot|LinkedInBot|Discordbot|TelegramBot|SkypeUriPreview|Pinterest|redditbot|Googlebot|bingbot|Applebot|vkShare|W3C_Validator|Iframely|Embedly)/i;

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

export default async function handler(req){
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const appUrl = `${url.origin}/?join=${encodeURIComponent(code)}`;

  if (!CODE_RE.test(code)){
    return Response.redirect(appUrl, 302);
  }

  const ua = req.headers.get('user-agent') || '';
  if (!BOT_UA_RE.test(ua)){
    // A real person — send them straight into the app, no detour.
    return Response.redirect(appUrl, 302);
  }

  // A bot — look up the session so the preview shows the real name/status
  // instead of a generic placeholder. Best-effort: if this fails for any
  // reason, fall back to generic PaddleStack branding rather than erroring.
  let sessionName = 'PaddleStack Session';
  let description = 'Live match — tap to view.';
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_hosted_session_by_code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ p_code: code })
    });
    if (res.ok){
      const data = await res.json().catch(() => null);
      const row = Array.isArray(data) ? data[0] : null;
      if (row){
        const nameFromState = row.state && row.state.session && row.state.session.name;
        sessionName = row.session_name || nameFromState || sessionName;
        description = row.status === 'live'
          ? 'Live now on PaddleStack — tap to watch courts and scores.'
          : 'View this PaddleStack session.';
      }
    }
  }catch(e){ /* fall through with generic defaults */ }

  const title = `${sessionName} — PaddleStack`;
  const ogImage = `${url.origin}/api/og?code=${encodeURIComponent(code)}&name=${encodeURIComponent(sessionName)}`;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${escapeHtml(appUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${ogImage}">
</head>
<body>${escapeHtml(sessionName)} on PaddleStack</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' }
  });
}

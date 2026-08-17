// /cs/INVITE/SECRET (rewritten to /api/share-cohost?invite=INVITE&secret=SECRET
// by vercel.json) is the link a host copies from the "Co-host access" panel
// and hands to a helper. It exists for the exact same reason /api/share
// does for the viewer link — chat apps unfurl links with a bot user-agent
// that never runs JavaScript, so without this the co-host link just showed
// up as a bare, banner-less URL in group chats.
//
//   - bot request  -> return small HTML with og:title/og:image baked in
//                     (og:image points at /api/og?role=cohost, which draws
//                     a co-host-flavored banner — no join code, since the
//                     real secret is 16-32 chars and isn't meant to be
//                     displayed)
//   - human request -> 302 straight to the real ?join=INVITE&cohost=SECRET
//                       app URL, no visible redirect page, no flash
//
// The invite code and cohost secret both have to live in this URL either
// way (that's what actually gets someone in), so wrapping them in a share
// page here doesn't change who can use the link — it only adds a preview.

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://xqogfjttzsewrtnbwatv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhxb2dmanR0enNld3J0bmJ3YXR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2OTM3NzMsImV4cCI6MjEwMTI2OTc3M30.IEnaOjWzu7pmnEiiIvdw6NmZWPfa4q3CQ40GlKIB05k';

// Same safe alphabet as INVITE_CODE_ALPHABET / COHOST_CODE_ALPHABET in
// script.js (no 0/O, 1/I) — duplicated here as a literal for the same
// reason it's duplicated there: no load-order dependency between files.
const INVITE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const SECRET_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16,32}$/;

// Known link-unfurling bots. Same list as /api/share.
const BOT_UA_RE = /(facebookexternalhit|Facebot|WhatsApp|Twitterbot|Slackbot|LinkedInBot|Discordbot|TelegramBot|SkypeUriPreview|Pinterest|redditbot|Googlebot|bingbot|Applebot|vkShare|W3C_Validator|Iframely|Embedly)/i;

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

export default async function handler(req){
  const url = new URL(req.url);
  const invite = (url.searchParams.get('invite') || '').toUpperCase();
  const secret = url.searchParams.get('secret') || '';
  const appUrl = `${url.origin}/?join=${encodeURIComponent(invite)}&cohost=${encodeURIComponent(secret)}`;

  if (!INVITE_RE.test(invite) || !SECRET_RE.test(secret)){
    return Response.redirect(appUrl, 302);
  }

  const ua = req.headers.get('user-agent') || '';
  if (!BOT_UA_RE.test(ua)){
    // A real person — send them straight into the app, no detour.
    return Response.redirect(appUrl, 302);
  }

  // A bot — look up the session so the preview shows the real name instead
  // of a generic placeholder. cohost_fetch_state is the same anon-key RPC
  // a co-host device calls on entry (see fetchCohostState in script.js) —
  // it already re-checks invite+secret+status server-side, so this reuses
  // that instead of needing a new RPC just for previews. Best-effort: if
  // this fails or the credential is no longer valid, fall back to generic
  // co-host branding rather than erroring or leaking that info to the bot.
  let sessionName = 'this match';
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cohost_fetch_state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ p_invite_code: invite, p_cohost_code: secret })
    });
    if (res.ok){
      const data = await res.json().catch(() => null);
      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.session_name) sessionName = row.session_name;
    }
  }catch(e){ /* fall through with generic default */ }

  const title = `Co-host “${sessionName}” — PaddleStack`;
  const description = 'You\u2019ve been invited to co-host this live match on PaddleStack.';
  const ogImage = `${url.origin}/api/og?role=cohost&name=${encodeURIComponent(sessionName)}`;

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
<body>Co-host invite for ${escapeHtml(sessionName)} on PaddleStack</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=30' }
  });
}

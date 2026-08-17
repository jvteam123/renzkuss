// Draws the banner image that shows up in link previews (icon + session
// name + invite code, on the branded navy gradient) — server-side, so
// chat-app crawlers (which never run our client JS) can fetch it too.
//
// IMPORTANT: this is deliberately written WITHOUT JSX. Vercel's plain Edge
// Functions (outside of a Next.js project) have no JSX transpiler — only
// Next.js wires that up automatically. `h()` below just builds the exact
// same plain-object tree JSX syntax would compile down to, which Satori
// (the engine behind @vercel/og) accepts directly.
import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

function h(type, props, ...children){
  const flatChildren = children.length === 1 ? children[0] : children;
  return { type, props: Object.assign({}, props, { children: flatChildren }) };
}

export default async function handler(req){
  const { searchParams, origin } = new URL(req.url);
  const name = (searchParams.get('name') || 'PaddleStack Session').slice(0, 80);
  const code = (searchParams.get('code') || '').slice(0, 6);
  const iconUrl = `${origin}/icon-512.png`;

  const headerRow = h('div', { style: { display: 'flex', alignItems: 'center' } },
    h('img', { src: iconUrl, width: 110, height: 110, style: { borderRadius: 24, display: 'flex' } }),
    h('div', { style: { display: 'flex', flexDirection: 'column', marginLeft: 26 } },
      h('div', { style: { fontSize: 42, fontWeight: 700, display: 'flex' } }, 'PaddleStack'),
      h('div', { style: { fontSize: 24, opacity: 0.75, display: 'flex' } }, 'Live match')
    )
  );

  const titleRow = h('div', {
    style: {
      display: 'flex',
      flex: 1,
      alignItems: 'center',
      fontSize: name.length > 28 ? 56 : 72,
      fontWeight: 800,
      lineHeight: 1.15
    }
  }, name);

  const rootChildren = [headerRow, titleRow];

  if (code){
    rootChildren.push(
      h('div', {
        style: {
          display: 'flex',
          alignSelf: 'flex-start',
          background: 'rgba(255,255,255,0.14)',
          borderRadius: 999,
          padding: '16px 32px',
          fontSize: 32,
          fontWeight: 600,
          color: '#FCD116'
        }
      }, `Join with code: ${code}`)
    );
  }

  const root = h('div', {
    style: {
      height: '100%',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'linear-gradient(135deg, #0038A8 0%, #00256E 100%)',
      padding: '80px',
      fontFamily: 'sans-serif',
      color: '#fff'
    }
  }, ...rootChildren);

  return new ImageResponse(root, { width: 1200, height: 630 });
}

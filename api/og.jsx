// Draws the actual banner image that shows up in the link preview card —
// same visual idea as the in-app "Share banner" download (icon + session
// name + invite code on a branded navy gradient), just rendered server-side
// so chat-app crawlers (which never run our client JS) can fetch it too.
import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

export default async function handler(req){
  const { searchParams, origin } = new URL(req.url);
  const name = (searchParams.get('name') || 'PaddleStack Session').slice(0, 80);
  const code = (searchParams.get('code') || '').slice(0, 6);
  const iconUrl = `${origin}/icon-512.png`;

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #0038A8 0%, #00256E 100%)',
          padding: '80px',
          fontFamily: 'sans-serif',
          color: '#fff'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <img
            src={iconUrl}
            width={110}
            height={110}
            style={{ borderRadius: 24, display: 'flex' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 26 }}>
            <div style={{ fontSize: 42, fontWeight: 700, display: 'flex' }}>PaddleStack</div>
            <div style={{ fontSize: 24, opacity: 0.75, display: 'flex' }}>Live match</div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            fontSize: name.length > 28 ? 56 : 72,
            fontWeight: 800,
            lineHeight: 1.15
          }}
        >
          {name}
        </div>

        {code ? (
          <div
            style={{
              display: 'flex',
              alignSelf: 'flex-start',
              background: 'rgba(255,255,255,0.14)',
              borderRadius: 999,
              padding: '16px 32px',
              fontSize: 32,
              fontWeight: 600,
              color: '#FCD116'
            }}
          >
            Join with code: {code}
          </div>
        ) : null}
      </div>
    ),
    { width: 1200, height: 630 }
  );
}

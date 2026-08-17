// Draws the banner image that shows up in link previews
// (icon + session name + invite code + LIVE + WATCH NOW)

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

function h(type, props, ...children) {
  const flatChildren = children.length === 1 ? children[0] : children;
  return {
    type,
    props: Object.assign({}, props, { children: flatChildren })
  };
}

export default async function handler(req) {
  const { searchParams, origin } = new URL(req.url);

  const name = (
    searchParams.get('name') || 'PaddleStack Session'
  ).slice(0, 80);

  const code = (
    searchParams.get('code') || ''
  ).slice(0, 6);

  const iconUrl = `${origin}/icon-512.png`;

  // ─────────────────────────────────────────────
  // HEADER
  // ─────────────────────────────────────────────

  const headerRow = h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }
    },

    // Logo + PaddleStack
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center'
        }
      },

      h('img', {
        src: iconUrl,
        width: 96,
        height: 96,
        style: {
          borderRadius: 22,
          display: 'flex'
        }
      }),

      h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            marginLeft: 22
          }
        },

        h(
          'div',
          {
            style: {
              fontSize: 40,
              fontWeight: 800,
              display: 'flex'
            }
          },
          'PaddleStack'
        ),

        h(
          'div',
          {
            style: {
              fontSize: 22,
              opacity: 0.78,
              display: 'flex'
            }
          },
          'Live Open Play'
        )
      )
    ),

    // LIVE badge
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          background: 'rgba(255,255,255,0.14)',
          border: '2px solid rgba(255,255,255,0.22)',
          borderRadius: 999,
          padding: '12px 22px',
          fontSize: 25,
          fontWeight: 800
        }
      },

      h('div', {
        style: {
          width: 14,
          height: 14,
          borderRadius: 999,
          background: '#FF4D4D',
          marginRight: 12,
          display: 'flex'
        }
      }),

      'LIVE'
    )
  );

  // ─────────────────────────────────────────────
  // SESSION TITLE
  // ─────────────────────────────────────────────

  const titleRow = h(
    'div',
    {
      style: {
        display: 'flex',
        flex: 1,
        flexDirection: 'column',
        justifyContent: 'center',
        fontSize: name.length > 28 ? 54 : 70,
        fontWeight: 800,
        lineHeight: 1.12
      }
    },

    h(
      'div',
      {
        style: {
          display: 'flex',
          opacity: 0.72,
          fontSize: 24,
          fontWeight: 700,
          marginBottom: 14
        }
      },
      'YOU’RE INVITED TO PLAY'
    ),

    h(
      'div',
      {
        style: {
          display: 'flex'
        }
      },
      name
    )
  );

  const rootChildren = [
    headerRow,
    titleRow
  ];

  // ─────────────────────────────────────────────
  // JOIN CODE + WATCH NOW
  // ─────────────────────────────────────────────

  if (code) {
    rootChildren.push(
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            background: 'rgba(255,255,255,0.13)',
            border: '2px solid rgba(255,255,255,0.22)',
            borderRadius: 24,
            padding: '20px 24px',
            boxSizing: 'border-box'
          }
        },

        // JOIN CODE
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column'
            }
          },

          h(
            'div',
            {
              style: {
                display: 'flex',
                fontSize: 22,
                fontWeight: 700,
                opacity: 0.78,
                marginBottom: 5
              }
            },
            'JOIN WITH CODE'
          ),

          h(
            'div',
            {
              style: {
                display: 'flex',
                fontSize: 52,
                fontWeight: 900,
                letterSpacing: 5,
                color: '#FCD116'
              }
            },
            code
          )
        ),

        // WATCH NOW BUTTON
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              background: '#fff',
              color: '#0038A8',
              borderRadius: 16,
              padding: '17px 28px',
              fontSize: 28,
              fontWeight: 900
            }
          },
          'WATCH NOW'
        )
      )
    );
  }

  // ─────────────────────────────────────────────
  // BANNER
  // ─────────────────────────────────────────────

  const root = h(
    'div',
    {
      style: {
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',

        background:
          'linear-gradient(135deg, #073BBA 0%, #00256E 58%, #001B50 100%)',

        padding: '58px 70px',

        fontFamily: 'sans-serif',
        color: '#fff'
      }
    },

    ...rootChildren
  );

  return new ImageResponse(root, {
    width: 1200,
    height: 630
  });
}

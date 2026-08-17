// Draws the banner image that shows up in link previews.
// Three modes:
//   - code + name  -> live/watch session banner
//   - role=cohost  -> co-host invite banner
//   - neither      -> polished PaddleStack brand/homepage banner

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

  const code = (
    searchParams.get('code') || ''
  ).slice(0, 6);

  const isCohost = searchParams.get('role') === 'cohost';
  const isGeneric = !code && !isCohost;

  const club = (
    searchParams.get('club') || ''
  ).slice(0, 60);

  const name = (
    searchParams.get('name') ||
    (
      isGeneric
        ? 'Open Play, Organized.'
        : 'PaddleStack Session'
    )
  ).slice(0, 80);

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

    // BRAND
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
        width: 92,
        height: 92,
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
            marginLeft: 20
          }
        },

        h(
          'div',
          {
            style: {
              display: 'flex',
              fontSize: 40,
              fontWeight: 900
            }
          },
          'PaddleStack'
        ),

        h(
          'div',
          {
            style: {
              display: 'flex',
              fontSize: 20,
              fontWeight: 600,
              opacity: 0.72,
              marginTop: 3
            }
          },
          'Pickleball Open Play'
        )
      )
    ),

    // STATUS / BRAND BADGE
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          background: 'rgba(255,255,255,0.12)',
          border: '2px solid rgba(255,255,255,0.20)',
          borderRadius: 999,
          padding: '11px 21px',
          fontSize: 23,
          fontWeight: 800
        }
      },

      isGeneric
        ? 'OPEN PLAY'
        : h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center'
              }
            },

            h('div', {
              style: {
                width: 13,
                height: 13,
                borderRadius: 999,
                background: isCohost
                  ? '#FCD116'
                  : '#FF4D4D',
                marginRight: 11,
                display: 'flex'
              }
            }),

            isCohost ? 'CO-HOST' : 'LIVE'
          )
    )
  );

  // ─────────────────────────────────────────────
  // MAIN CONTENT
  // ─────────────────────────────────────────────

  let titleRow;

  if (isGeneric) {
    titleRow = h(
      'div',
      {
        style: {
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          justifyContent: 'center'
        }
      },

      // SMALL LABEL
      h(
        'div',
        {
          style: {
            display: 'flex',
            fontSize: 23,
            fontWeight: 800,
            letterSpacing: 1.5,
            opacity: 0.70,
            marginBottom: 14
          }
        },
        'THE SMARTER WAY TO RUN OPEN PLAY'
      ),

      // MAIN TITLE
      h(
        'div',
        {
          style: {
            display: 'flex',
            fontSize: 76,
            fontWeight: 900,
            lineHeight: 1.05,
            letterSpacing: -1
          }
        },
        'Open Play, Organized.'
      ),

      // DESCRIPTION
      h(
        'div',
        {
          style: {
            display: 'flex',
            fontSize: 29,
            fontWeight: 600,
            lineHeight: 1.25,
            opacity: 0.82,
            marginTop: 18,
            maxWidth: 850
          }
        },
        'Queue players, manage courts, track scores, and share live games — all in one place.'
      )
    );
  } else {
    titleRow = h(
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
        isCohost
          ? 'YOU’RE INVITED TO CO-HOST'
          : 'YOU’RE INVITED TO PLAY'
      ),

      h(
        'div',
        {
          style: {
            display: 'flex'
          }
        },
        name
      ),

      club
        ? h(
            'div',
            {
              style: {
                display: 'flex',
                fontSize: 26,
                fontWeight: 700,
                opacity: 0.78,
                marginTop: 12
              }
            },
            club
          )
        : h('div', { style: { display: 'none' } })
    );
  }

  const rootChildren = [
    headerRow,
    titleRow
  ];

  // ─────────────────────────────────────────────
  // GENERIC HOMEPAGE FOOTER
  // ─────────────────────────────────────────────

  if (isGeneric) {
    rootChildren.push(
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            background: 'rgba(255,255,255,0.10)',
            border: '2px solid rgba(255,255,255,0.18)',
            borderRadius: 22,
            padding: '20px 26px',
            boxSizing: 'border-box'
          }
        },

        // FEATURES
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              fontSize: 23,
              fontWeight: 700
            }
          },

          h(
            'div',
            {
              style: {
                display: 'flex',
                marginRight: 28
              }
            },
            'QUEUE'
          ),

          h(
            'div',
            {
              style: {
                display: 'flex',
                marginRight: 28,
                opacity: 0.9
              }
            },
            'COURTS'
          ),

          h(
            'div',
            {
              style: {
                display: 'flex',
                opacity: 0.9
              }
            },
            'LIVE SCORING'
          )
        ),

        // CTA
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              background: '#fff',
              color: '#073BBA',
              borderRadius: 15,
              padding: '16px 27px',
              fontSize: 26,
              fontWeight: 900
            }
          },
          'GET STARTED'
        )
      )
    );
  }

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

        // WATCH NOW
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
  // BACKGROUND
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
          'linear-gradient(135deg, #073BBA 0%, #002B80 52%, #001B50 100%)',

        padding: '58px 70px',

        fontFamily: 'sans-serif',
        color: '#fff',

        boxSizing: 'border-box'
      }
    },

    ...rootChildren
  );

  return new ImageResponse(root, {
    width: 1200,
    height: 630
  });
}

/** Hand-drawn 24px stroke icons: currentColor, decorative (always next to words). No icon package. */

const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 4l9 16H3L12 4zM12 10v4.5M12 17.2v.1',
  shield: 'M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6L12 3z',
  shieldCheck:
    'M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6L12 3zM8.8 12l2.3 2.3 4.2-4.6',
  globe:
    'M12 3a9 9 0 100 18 9 9 0 000-18zM3.5 12h17M12 3c2.6 2.4 3.8 5.4 3.8 9s-1.2 6.6-3.8 9c-2.6-2.4-3.8-5.4-3.8-9S9.4 5.4 12 3z',
  clock: 'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zM12 7.5V12l3 2',
  pause: 'M8.5 5.5v13M15.5 5.5v13',
  play: 'M8 5.5v13l11-6.5L8 5.5z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  external: 'M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 01-1 1H6a1 1 0 01-1-1V7a1 1 0 011-1h4',
  fingerprint:
    'M6.5 9.5a6 6 0 0111 0M4.5 12.5A8 8 0 0112 4a8 8 0 017.5 5M9 20c.5-1.5.8-3 .8-4.7a2.2 2.2 0 014.4 0c0 3.2-.7 5.2-1.6 6.7M6 17c.5-1.6.7-3.2.7-4.8M17.5 14.5c0 2.2-.3 3.9-.9 5.5M12 12.3v.1',
  inbox:
    'M4 13l2.5-7.5h11L20 13M4 13v5a1 1 0 001 1h14a1 1 0 001-1v-5M4 13h4.5l1.5 2.5h4l1.5-2.5H20',
  store:
    'M4 9l1.5-4.5h13L20 9M4 9v10h16V9M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3M10 19v-4h4v4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20c1.2-3.5 4-5 7.5-5s6.3 1.5 7.5 5',
  plug: 'M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 01-11 0V8zM12 16.5V21',
  scan: 'M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16',
  radar: 'M12 3a9 9 0 109 9M12 7a5 5 0 105 5M12 12l6.5-6.5M12 12.1v-.1',
  file: 'M7 3h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v5h5M9 13h6M9 17h6',
  share: 'M12 4v11M8 8l4-4 4 4M6 12v7a1 1 0 001 1h10a1 1 0 001-1v-7',
  download: 'M12 4v11M8 11l4 4 4-4M5 20h14',
  layers: 'M12 4l8.5 4.5L12 13 3.5 8.5 12 4zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z',
  lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z',
  users:
    'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20c.9-3.2 3.4-5 6.5-5s5.6 1.8 6.5 5M16 4.3a3.5 3.5 0 010 6.4M18 15.2c1.7.7 2.9 2.4 3.5 4.8',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, strokeWidth = 1.8 }: { name: IconName; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The Countersign mark, from the logo kit (countersign-mark.svg, 13 Oct): a ring cut in two by a
 * diagonal, violet above and cyan below. Copied as drawn; only the ids are made unique per use.
 */
const RING =
  'M10 50a40 40 0 1 0 80 0a40 40 0 1 0 -80 0Z M29 50a21 21 0 1 1 42 0a21 21 0 1 1 -42 0Z';

export function Mark({ id = 'cs' }: { id?: string }) {
  return (
    <svg viewBox="8 8 84 84" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-ag`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9b7cff" />
          <stop offset="1" stopColor="#8da8ff" />
        </linearGradient>
        <linearGradient id={`${id}-hg`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#69e9ff" />
          <stop offset="1" stopColor="#b6f6ff" />
        </linearGradient>
        <clipPath id={`${id}-cu`}>
          <path d="M-60 -60L160 -60L160 -26.509L50 37.000L50 46.536L-60 110.044Z" />
        </clipPath>
        <clipPath id={`${id}-cl`}>
          <path d="M-60 116.973L50 53.464L50 69.000L160 5.491L160 160L-60 160Z" />
        </clipPath>
      </defs>
      <path d={RING} fillRule="evenodd" fill={`url(#${id}-ag)`} clipPath={`url(#${id}-cu)`} />
      <path d={RING} fillRule="evenodd" fill={`url(#${id}-hg)`} clipPath={`url(#${id}-cl)`} />
    </svg>
  );
}

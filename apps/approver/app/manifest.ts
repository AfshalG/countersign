// The installable web app: home-screen name, colours matching the dark ground, the icon.
export default function manifest() {
  return {
    name: 'Countersign',
    short_name: 'Countersign',
    description: 'AI agents can pay. Countersign makes sure only what you approved goes out.',
    start_url: '/',
    display: 'standalone' as const,
    background_color: '#070912',
    theme_color: '#070912',
    icons: [
      // From the logo kit (13 Oct). Android's installer wants bitmaps of 192 and 512 px.
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

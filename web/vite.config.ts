import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const API = process.env.PULSE_API || 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Pulse — Private Media',
        short_name: 'Pulse',
        description: 'Your private pCloud library with ThePornDB metadata and TorBox.',
        theme_color: '#06070a',
        background_color: '#06070a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        skipWaiting: true,          // a new service worker takes over immediately (no stale shell after an update)
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/pair/],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // never cache API or media; the offline shell comes from precache
        runtimeCaching: [],
      },
    }),
  ],
  server: { host: true, port: 5173, proxy: { '/api': { target: API, changeOrigin: false }, '/pair': { target: API } } },
  preview: { port: 4173, proxy: { '/api': API, '/pair': API } },
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
});

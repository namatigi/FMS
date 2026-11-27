/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:8080';
  const analyticsTarget = env.VITE_ANALYTICS_PROXY_TARGET || 'http://localhost:8090';
  const proxy = {
    '/api': { target: apiTarget, changeOrigin: true },
    '/analytics': { target: analyticsTarget, changeOrigin: true },
  };
  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        // In mock mode MSW owns the service worker scope; don't register the PWA worker.
        disable: env.VITE_USE_MOCKS === 'true',
        includeAssets: ['icon.svg'],
        manifest: {
          name: 'Zambia National Fuel Monitoring System',
          short_name: 'FMS Zambia',
          description: 'Fuel stock, sales and compliance monitoring for stations, ERB and ZRA.',
          theme_color: '#0b5d3b',
          background_color: '#ffffff',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          ],
        },
        workbox: {
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/analytics\//],
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\/.*/,
              handler: 'CacheFirst',
              options: { cacheName: 'osm-tiles', expiration: { maxEntries: 500, maxAgeSeconds: 7 * 86400 } },
            },
          ],
        },
      }),
    ],
    server: { port: Number(env.PORT) || 5173, proxy },
    preview: { port: 15173, proxy },
    build: {
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
            charts: ['recharts'],
            map: ['leaflet', 'react-leaflet'],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  };
});

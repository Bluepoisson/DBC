import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';

// ES module alternative to __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'), // Standard React pattern targets the source folder
      },
    },
    server: {
      // HMR management for your AI Studio workspace environment
      hmr: process.env.DISABLE_HMR !== 'true',
      
      // CRITICAL: Proxy rules to bridge your React app with your Express server
      proxy: {
        // Redirects HTTP calls (e.g. axios.get('/api/fleet')) to your backend
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        // Redirects Socket.io handshake traffic over websockets cleanly
        '/socket.io': {
          target: 'http://localhost:3000',
          ws: true,
          changeOrigin: true,
        }
      }
    },
  };
});
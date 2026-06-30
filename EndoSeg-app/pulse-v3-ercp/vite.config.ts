/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
  },
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
    // onnxruntime-web ships its own WASM workers — must not be pre-bundled
    exclude: ['onnxruntime-web'],
  },
  // Serve .onnx files as static assets
  assetsInclude: ['**/*.onnx'],
  build: {
    rollupOptions: {
      external: [],
    },
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer (onnxruntime-web WASM threading)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})

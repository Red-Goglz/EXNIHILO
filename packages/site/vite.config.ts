import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/** Serve /docs/ as static VitePress files, bypassing SPA fallback */
function docsStaticPlugin(): Plugin {
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  }

  function docsMiddleware(baseDir: string) {
    return (req: any, res: any, next: any) => {
      if (!req.url?.startsWith('/docs')) return next()

      let filePath = path.join(baseDir, req.url.split('?')[0])

      // Directory → try index.html
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html')
      }
      // No extension → try .html
      if (!fs.existsSync(filePath) && !path.extname(filePath)) {
        filePath += '.html'
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath)
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
        fs.createReadStream(filePath).pipe(res)
      } else {
        next()
      }
    }
  }

  return {
    name: 'docs-static',
    configureServer(server) {
      server.middlewares.use(docsMiddleware(path.resolve(__dirname, 'public')))
    },
    configurePreviewServer(server) {
      server.middlewares.use(docsMiddleware(path.resolve(__dirname, 'dist')))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [docsStaticPlugin(), react()],
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // Suppress "/*#__PURE__*/" annotation warnings from third-party packages
        if (warning.code === 'SOURCEMAP_ERROR' || warning.message?.includes('__PURE__')) return;
        warn(warning);
      },
    },
  },
})

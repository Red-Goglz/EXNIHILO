import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/** Serve /docs/ as static VitePress files, bypassing SPA fallback */
function docsStaticPlugin(): Plugin {
  return {
    name: 'docs-static',
    configureServer(server) {
      // No return — runs BEFORE Vite's internal middleware (pre-hook)
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/docs')) return next()

        const publicDir = path.resolve(__dirname, 'public')
        let filePath = path.join(publicDir, req.url.split('?')[0])

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
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.json': 'application/json',
            '.woff2': 'font/woff2',
          }
          res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
          fs.createReadStream(filePath).pipe(res)
        } else {
          next()
        }
      })
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
})

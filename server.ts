import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import workerApp, { getFlashLiteModel } from './src/worker/app';
import { createLocalEnv } from './src/worker/localAdapter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;

async function startDevServer() {
  const app = express();

  // Allow larger audio payload sizes for base64 audio submissions
  app.use(express.json({ limit: '25mb' }));

  // Create local Cloudflare Worker environment with D1 & R2 local adapters
  const localEnv = createLocalEnv();
  const flashLiteModel = getFlashLiteModel(localEnv);

  // Delegate all /api/* routes directly to the Cloudflare Worker application
  app.all('/api/*', async (req: Request, res: Response) => {
    try {
      const protocol = req.protocol || 'http';
      const host = req.get('host') || `localhost:${PORT}`;
      const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val !== undefined) {
          if (Array.isArray(val)) {
            val.forEach((v) => headers.append(key, v));
          } else {
            headers.set(key, val);
          }
        }
      }

      let body: string | null = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = JSON.stringify(req.body);
      }

      const webRequest = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
      });

      const workerRes = await workerApp.fetch(webRequest, localEnv);

      res.status(workerRes.status);
      workerRes.headers.forEach((v, k) => {
        res.setHeader(k, v);
      });

      if (workerRes.body) {
        const buffer = Buffer.from(await workerRes.arrayBuffer());
        res.send(buffer);
      } else {
        res.end();
      }
    } catch (err) {
      console.error('Error forwarding request to Worker app:', err);
      res.status(500).json({ error: 'Internal Worker routing error.' });
    }
  });

  // Serve static assets from public folder
  app.use(express.static(path.resolve(__dirname, 'public')));

  // Mount Vite in development or static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Interstitial Journal server listening on http://0.0.0.0:${PORT} (Cloudflare Worker unified backend, Model: ${flashLiteModel})`
    );
  });
}

startDevServer();

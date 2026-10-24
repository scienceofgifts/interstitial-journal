import app from './app';
import { Env, ExecutionContext } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    // 1. API routes handled by the Hono application
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }

    // 2. Static Assets handled via the Workers + Static Assets binding
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // 3. Fallback to app router
    return app.fetch(request, env, ctx);
  },
};

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { serveStatic } from 'hono/bun';
import portal from './routes/portal';
import admin from './routes/admin';
import { omada } from './services/omada';

const app = new Hono();

app.use(trimTrailingSlash());
app.use('/*', logger());
app.use('/*', cors());
app.use('/static/*', serveStatic({ root: './' }));
app.use('/fonts/*', serveStatic({ root: './static' }));

// Routes — preserve query params from Omada redirect (/?clientMac=...&ssidName=...)
app.get('/', (c) => {
    const qs = new URL(c.req.url).search;
    return c.redirect(`/portal${qs}`);
});
app.route('/portal', portal);
app.route('/admin', admin);

// Health checks
app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/health/omada', async (c) => {
    const result = await omada.healthCheck();
    return c.json(result, result.reachable ? 200 : 503);
});

export default {
    port: Number(process.env.PORT) || 3000,
    fetch: app.fetch,
};

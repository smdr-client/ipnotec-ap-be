import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import portal from './routes/portal';
import admin from './routes/admin';
import { omada } from './services/omada';

const app = new Hono();

app.use('/*', cors());
app.use('/static/*', serveStatic({ root: './' }));

// Routes
app.get('/', (c) => c.redirect('/portal'));
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

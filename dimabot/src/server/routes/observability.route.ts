import express from 'express';

// Fixed private destination. The analytics process owns authentication, grants,
// SQL, aggregation and redaction; this is only the existing public ingress.
export const observabilityRoute = express.Router();
observabilityRoute.use(async (req, res) => {
    if (!/^\/api\/(session|overview|resources|traces(?:\/[a-f0-9]{32})?|logs|grants(?:\/\d{1,30})?)$/.test(req.path)
        || !['GET', 'PUT', 'DELETE'].includes(req.method)) {
        res.status(404).json({ message: 'Analytics endpoint not found' }); return;
    }
    try {
        const response = await fetch(`http://dima-analytics:3210${req.url}`, {
            method: req.method,
            headers: { Authorization: String(req.headers.authorization || ''), 'Content-Type': 'application/json' },
            ...(req.method === 'PUT' ? { body: JSON.stringify(req.body) } : {}),
            signal: AbortSignal.timeout(12000),
            redirect: 'error'
        });
        res.set('Cache-Control', 'no-store');
        res.status(response.status).type('application/json').send(await response.text());
    } catch { res.status(503).json({ message: 'Analytics is temporarily unavailable' }); }
});

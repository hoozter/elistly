/**
 * Elistly API Worker – health + future admin routes.
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (set in Cloudflare dashboard).
 */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ ok: true, service: 'elistly-api' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }
};

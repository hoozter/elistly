// Placeholder Edge Function – health check. Add admin logic here later.
// Deploy: supabase functions deploy health
// Set SUPABASE_SERVICE_ROLE_KEY in Supabase Dashboard → Edge Functions → secrets (never in repo).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

serve(async (req: Request) => {
  return new Response(
    JSON.stringify({ ok: true, service: 'elistly' }),
    { headers: { 'Content-Type': 'application/json' }, status: 200 }
  );
});

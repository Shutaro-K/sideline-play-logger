import {handleShareRequest} from './handler.mjs';

Deno.serve(request => handleShareRequest(request, {
  url: Deno.env.get('SUPABASE_URL'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  allowedOrigins: (Deno.env.get('LOGGER_ALLOWED_ORIGINS') || 'https://shutaro-k.github.io').split(',').filter(Boolean),
  fetch,
}));

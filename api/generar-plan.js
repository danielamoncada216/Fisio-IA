// Debe coincidir con la clave anon usada en el frontend (index.html) y en
// api/admin-users.js — solo sirve para validar tokens de usuario, no da
// acceso privilegiado.
const SUPABASE_URL = 'https://rfnuzhmxdmhekqbaloko.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmbnV6aG14ZG1oZWtxYmFsb2tvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NDQwMzYsImV4cCI6MjA5NDQyMDAzNn0.6Ab4cOKOBF-5NtZjZqKCveXsYmoN-j1zrPxrTRhz13A';

async function usuarioAutenticado(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data && data.id ? data : null;
  } catch (e) {
    return null;
  }
}

// ─── LÍMITE DE PLANES GRATIS ──────────────────────────────────────────────
// Cada cuenta arranca con 5 planes gratis de por vida (columna
// profiles.planes_permitidos, default 5). Una vez se agotan (planes_usados
// >= planes_permitidos), se bloquea la generación hasta que la administradora
// le otorgue más planes manualmente desde el panel de admin (después de que
// la persona pague por fuera de la app) — eso solo suma a planes_permitidos,
// nunca resetea planes_usados, así el conteo total queda siempre correcto.
async function consultarCuota(userId) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null; // sin la key no se puede verificar cuota — ver nota más abajo
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=planes_usados,planes_permitidos`,
    { headers }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function incrementarUso(userId, planesUsadosActuales) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ planes_usados: planesUsadosActuales + 1 })
    });
  } catch (e) {
    // Si falla el incremento no se bloquea la respuesta al usuario — el plan
    // ya se generó y se le cobró a la cuota de Gemini de todas formas; es
    // preferible subestimar el conteo (a favor del usuario) que fallar la
    // petición entera por un problema al guardar el contador.
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Antes: este endpoint no verificaba quién llamaba y aceptaba peticiones
  // de cualquier origen (Access-Control-Allow-Origin: '*'), lo que permitía
  // usar la cuota de Gemini de la cuenta sin haber iniciado sesión. Ahora
  // exige el token de sesión de Supabase que ya envía el frontend
  // (ver headersIA() en index.html) y no se declara CORS abierto: las
  // llamadas legítimas son same-origin y no lo necesitan.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const usuario = await usuarioAutenticado(token);
  if (!usuario) {
    return res.status(401).json({ error: 'No autenticado. Inicia sesión de nuevo.' });
  }

  const { prompt, contarCuota } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Falta el prompt' });

  // Solo las dos acciones de "Generar plan" (fisioterapia/ortho/geria/pedia y
  // fono/TO/psicología) mandan contarCuota=true. Las llamadas auxiliares que
  // comparten este mismo endpoint (nota SOAP, análisis de progreso,
  // sugerencias de anamnesis, epicrisis, revaluación) no cuentan contra el
  // límite de 5 planes gratis — son un apoyo sobre un plan que la persona ya
  // generó, no un plan nuevo.
  const cuota = contarCuota ? await consultarCuota(usuario.id) : null;
  if (cuota && cuota.planes_usados >= cuota.planes_permitidos) {
    return res.status(402).json({
      error: 'Alcanzaste el límite de planes gratuitos.',
      error_code: 'plan_limit_reached',
      planes_usados: cuota.planes_usados,
      planes_permitidos: cuota.planes_permitidos
    });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Error con Gemini' });
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (cuota) await incrementarUso(usuario.id, cuota.planes_usados);
    return res.status(200).json({ plan: texto });
  } catch (error) {
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

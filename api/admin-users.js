// /api/admin-users.js
//
// Endpoint serverless para operaciones administrativas de FisioIA.
// Sustituye las llamadas directas desde el navegador a la API admin de
// Supabase (que antes usaban la anon key desde el cliente — un enfoque
// inseguro, ya que esos endpoints requieren service_role y no deben ser
// alcanzables ni intentados desde el frontend).
//
// Seguridad:
//  1. El cliente manda su token de sesión (Bearer) en el header Authorization.
//  2. Aquí, en el servidor, resolvemos ese token contra Supabase Auth para
//     obtener el email real del usuario que hace la petición.
//  3. Comparamos ese email contra ADMIN_EMAILS (definido solo en el servidor).
//     Si no es admin, respondemos 403 y no tocamos nada más.
//  4. Solo si es admin usamos SUPABASE_SERVICE_ROLE_KEY (variable de entorno,
//     nunca expuesta al navegador) para listar usuarios o cambiar su estado.
//
// El frontend (isAdmin() en index.html) solo controla si el botón "Admin"
// se muestra en la UI — eso es cosmético. La autorización real ocurre aquí.

const SUPABASE_URL = 'https://rfnuzhmxdmhekqbaloko.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmbnV6aG14ZG1oZWtxYmFsb2tvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NDQwMzYsImV4cCI6MjA5NDQyMDAzNn0.6Ab4cOKOBF-5NtZjZqKCveXsYmoN-j1zrPxrTRhz13A';

// Debe coincidir con la lista ADMIN_EMAILS del frontend (index.html), pero
// esta es la copia que realmente importa para la autorización.
const ADMIN_EMAILS = ['danielamoncada216@gmail.com', 'ft.mariadelangelo@gmail.com'];

async function resolverEmailDesdeToken(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data && data.email ? data.email.toLowerCase() : null;
}

module.exports = async function handler(req, res) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    res.status(500).json({ error: 'Configuración incompleta en el servidor (falta SUPABASE_SERVICE_ROLE_KEY).' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'No autenticado.' });
    return;
  }

  const email = await resolverEmailDesdeToken(token);
  if (!email || !ADMIN_EMAILS.includes(email)) {
    res.status(403).json({ error: 'No autorizado. Esta acción requiere permisos de administrador.' });
    return;
  }

  const adminHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json'
  };

  try {
    if (req.method === 'GET') {
      // Listar usuarios (auth admin), pacientes y logs de planes generados hoy.
      const [usersResp, patientsResp, logsResp] = await Promise.all([
        fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: adminHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/pacientes?select=id`, { headers: adminHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/sesiones_clinicas?select=id,created_at,user_id&order=created_at.desc&limit=500`, { headers: adminHeaders })
      ]);

      const usersData = usersResp.ok ? await usersResp.json() : { users: [] };
      const patients = patientsResp.ok ? await patientsResp.json() : [];
      const logsRaw = logsResp.ok ? await logsResp.json() : [];

      // Adjuntar email a cada log a partir de la lista de usuarios (para conteos en el frontend)
      const usersById = {};
      (usersData.users || []).forEach(u => { usersById[u.id] = u.email; });
      const planLogs = (Array.isArray(logsRaw) ? logsRaw : []).map(l => ({
        ...l,
        user_email: usersById[l.user_id] || null
      }));

      res.status(200).json({
        users: usersData.users || [],
        patients: Array.isArray(patients) ? patients : [],
        planLogs
      });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const { action, userId } = body || {};

      if (!userId || (action !== 'ban' && action !== 'unban')) {
        res.status(400).json({ error: 'Parámetros inválidos.' });
        return;
      }

      // No permitir que un admin se desactive a sí mismo ni a otros admins por accidente.
      const targetResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: adminHeaders });
      if (targetResp.ok) {
        const targetUser = await targetResp.json();
        const targetEmail = targetUser && targetUser.email ? targetUser.email.toLowerCase() : '';
        if (ADMIN_EMAILS.includes(targetEmail)) {
          res.status(403).json({ error: 'No se puede modificar el estado de una cuenta administradora.' });
          return;
        }
      }

      const banned_until = action === 'ban' ? '2100-01-01T00:00:00Z' : 'none';
      const patchResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ ban_duration: action === 'ban' ? '87600h' : 'none' })
      });

      if (!patchResp.ok) {
        const errText = await patchResp.text();
        res.status(502).json({ error: 'Error al actualizar el usuario en Supabase.', detail: errText });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Método no permitido.' });
  } catch (e) {
    res.status(500).json({ error: 'Error interno.', detail: String(e) });
  }
};

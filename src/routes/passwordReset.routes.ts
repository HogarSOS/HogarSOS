import { Router } from 'express';

/**
 * Página propia de "restablecer contraseña" a la que llegan los
 * usuarios desde el email que envía `auth.controller.ts#forgotPassword`
 * (enlace `https://hogarsos.es/auth/reset-password?mode=resetPassword&oobCode=...`
 * construido a mano ahí, no vía el ajuste "URL de acción" de Firebase
 * Console — ese ajuste devuelve un error interno de Firebase al
 * guardar, `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`, ajeno a este código).
 *
 * BUG 001 (QA, 2026-08-03): "el email llega, la contraseña se cambia
 * correctamente, pero después no permite iniciar sesión con la nueva
 * contraseña". Reproducido de punta a punta contra la Firebase real
 * (Admin SDK + REST de Identity Toolkit, ver notas de la sesión): el
 * mecanismo de Firebase (generar el link, canjear el oobCode, iniciar
 * sesión con la contraseña nueva) funciona perfectamente cuando la
 * contraseña introducida es exactamente la que el usuario cree haber
 * escrito. La causa real es que la página POR DEFECTO de Firebase solo
 * tiene UN campo de contraseña, sin "confirmar contraseña" — cualquier
 * error de tecleo (autocorrección del móvil, un dedo de más) se guarda
 * tal cual, Firebase confirma "Password changed" igualmente, y el
 * usuario queda convencido de que su contraseña es una cuando en
 * realidad guardó otra. Esta página añade el campo de confirmación que
 * faltaba y valida que coincidan ANTES de enviar nada a Firebase.
 *
 * Sin dependencias de servidor: todo el canje del oobCode ocurre en el
 * propio navegador contra la REST API pública de Identity Toolkit
 * (identitytoolkit.googleapis.com), usando la Web API Key — es una
 * clave pública por diseño (igual que la publishable key de Stripe ya
 * usada en el frontend), pensada para vivir en clientes.
 */
const router = Router();

const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDknprwo1qH3bd4x_lD9AsUh8pVH06zxsk';

function paginaResetPassword(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Restablecer contraseña — Hogar SOS</title>
  <link rel="icon" type="image/png" href="/public/favicon.png">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg, #EEF0FD, #ffffff); color: #1a1a2e; }
    .tarjeta { width: 100%; max-width: 380px; margin: 0 20px; padding: 36px 28px; background: #fff; border-radius: 20px; box-shadow: 0 12px 40px rgba(30,138,90,0.12); }
    .marca { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
    .marca span { font-size: 20px; font-weight: 800; }
    .marca span b { color: #FF6A4D; }
    h1 { font-size: 18px; margin: 0 0 6px; }
    p.sub { font-size: 13.5px; color: #666; margin: 0 0 22px; line-height: 1.4; }
    label { display: block; font-size: 12.5px; font-weight: 600; color: #444; margin: 14px 0 6px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 10px; border: 1.5px solid #ddd; font-size: 14.5px; }
    input[type=password]:focus { outline: none; border-color: #1E8A5A; }
    .error { color: #D93025; font-size: 12.5px; margin-top: 8px; min-height: 16px; }
    button { width: 100%; margin-top: 18px; padding: 13px; border: none; border-radius: 12px; background: #1E8A5A; color: #fff; font-weight: 700; font-size: 14.5px; cursor: pointer; }
    button:disabled { background: #a8c9ba; cursor: default; }
    .exito, .fallo { text-align: center; }
    .icono { width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 28px; }
    .icono.ok { background: #1E8A5A22; color: #1E8A5A; }
    .icono.err { background: #D9302522; color: #D93025; }
    .oculto { display: none; }
  </style>
</head>
<body>
  <div class="tarjeta">
    <div class="marca">
      <svg viewBox="0 0 100 100" width="30" height="30" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1E8A5A"/><stop offset="100%" stop-color="#146B45"/></linearGradient></defs>
        <rect width="100" height="100" rx="22" fill="url(#bg)"/>
        <polygon points="50,20 80,52 20,52" fill="#fff"/>
        <rect x="30" y="52" width="40" height="28" rx="6" fill="#fff"/>
        <circle cx="74" cy="28" r="7" fill="#FF6A4D"/>
      </svg>
      <span>Hogar <b>SOS</b></span>
    </div>

    <div id="cargando">
      <p class="sub">Comprobando el enlace…</p>
    </div>

    <form id="formulario" class="oculto" onsubmit="return false;">
      <h1>Restablecer contraseña</h1>
      <p class="sub" id="para-email"></p>

      <label for="nueva">Nueva contraseña</label>
      <input type="password" id="nueva" autocomplete="new-password" minlength="6" />

      <label for="confirmar">Confirmar contraseña</label>
      <input type="password" id="confirmar" autocomplete="new-password" minlength="6" />

      <div class="error" id="error"></div>

      <button id="boton" type="button" onclick="enviar()">Guardar nueva contraseña</button>
    </form>

    <div id="exito" class="oculto exito">
      <div class="icono ok">✓</div>
      <h1>Contraseña actualizada</h1>
      <p class="sub">Ya puedes volver a Hogar SOS e iniciar sesión con tu nueva contraseña.</p>
    </div>

    <div id="fallo" class="oculto fallo">
      <div class="icono err">!</div>
      <h1>El enlace no es válido</h1>
      <p class="sub" id="fallo-detalle">Puede que ya se haya usado, o que haya caducado. Vuelve a pedir el email de recuperación desde la app.</p>
    </div>
  </div>

  <script>
    const API_KEY = '${FIREBASE_WEB_API_KEY}';
    const params = new URLSearchParams(window.location.search);
    const oobCode = params.get('oobCode');
    const modo = params.get('mode');

    // Esta página solo sabe manejar "resetPassword" (es el único modo
    // que le envía forgotPassword() en el backend). Por si alguien
    // llega aquí con otro modo — enlace mal copiado, bookmark viejo —
    // se redirige a la página por defecto de Firebase en vez de mostrar
    // un formulario que no le corresponde.
    if (modo !== 'resetPassword') {
      window.location.replace('https://hogarsos.firebaseapp.com/__/auth/action' + window.location.search);
    }

    const el = (id) => document.getElementById(id);
    const mostrar = (id) => { ['cargando', 'formulario', 'exito', 'fallo'].forEach((otro) => el(otro).classList.toggle('oculto', otro !== id)); };

    async function llamar(path, body) {
      const resp = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:' + path + '?key=' + API_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error((data.error && data.error.message) || 'ERROR');
      return data;
    }

    async function comprobarEnlace() {
      if (!oobCode) { mostrar('fallo'); return; }
      try {
        // Sin newPassword: solo VERIFICA el código y devuelve a qué
        // email pertenece, sin cambiar nada todavía.
        const data = await llamar('resetPassword', { oobCode });
        el('para-email').textContent = 'Para la cuenta: ' + (data.email || '');
        mostrar('formulario');
      } catch (e) {
        mostrar('fallo');
      }
    }

    async function enviar() {
      const nueva = el('nueva').value;
      const confirmar = el('confirmar').value;
      const error = el('error');
      const boton = el('boton');

      if (nueva.length < 6) { error.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
      if (nueva !== confirmar) { error.textContent = 'Las dos contraseñas no coinciden.'; return; }

      error.textContent = '';
      boton.disabled = true;
      boton.textContent = 'Guardando…';

      try {
        await llamar('resetPassword', { oobCode, newPassword: nueva });
        mostrar('exito');
      } catch (e) {
        boton.disabled = false;
        boton.textContent = 'Guardar nueva contraseña';
        error.textContent = 'No se pudo guardar. El enlace puede haber caducado — vuelve a pedirlo desde la app.';
      }
    }

    if (modo === 'resetPassword') comprobarEnlace();
  </script>
</body>
</html>`;
}

router.get('/', (_req, res) => {
  // `helmet()` (index.ts) pone por defecto `script-src 'self'` (sin
  // 'unsafe-inline') y `connect-src` heredado de `default-src 'self'`.
  // Verificado en un navegador real (no solo con REST/Admin SDK): con
  // esa CSP el <script> de esta página ni siquiera se ejecuta, y aunque
  // se ejecutara, el fetch() a identitytoolkit.googleapis.com quedaría
  // bloqueado — la página se queda colgada para siempre en "Comprobando
  // el enlace…", indistinguible de un oobCode inválido para el usuario.
  // Se sobrescribe la cabecera solo en esta ruta con lo mínimo que
  // necesita: permitir el script inline y las llamadas a Identity
  // Toolkit.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'"
  );
  res.send(paginaResetPassword());
});

export default router;

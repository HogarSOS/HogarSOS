import { Router } from 'express';

/**
 * Páginas de retorno del onboarding hospedado de Stripe Connect
 * (`accountLinks.create` en professional.controller.ts → startStripeOnboarding).
 * Stripe redirige aquí en un navegador externo (no hay sesión de la app
 * disponible), así que estas páginas son estáticas y sin autenticación
 * — solo intentan devolver al usuario a la app vía deep link propio
 * (`hogarsos://stripe-return/...`, intent-filter en AndroidManifest.xml)
 * y, si el usuario ya está dentro, la app refresca el estado real de
 * Stripe sola (ver DeepLinkListener en el frontend). Antes estas dos
 * rutas ni siquiera existían — accountLinks.create las referenciaba,
 * pero Stripe caía en el 404 genérico del backend al terminar.
 */
const router = Router();

function paginaRetorno(opts: {
  ruta: 'completado' | 'refresh';
  titulo: string;
  texto: string;
  colorAcento: string;
  icono: string;
}): string {
  const deepLink = `hogarsos://stripe-return/${opts.ruta}`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hogar SOS</title>
  <link rel="icon" type="image/png" href="/public/favicon.png">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg, #EEF0FD, #ffffff); color: #1a1a2e; }
    .tarjeta { max-width: 420px; margin: 0 24px; text-align: center; padding: 40px 28px; }
    .icono { width: 64px; height: 64px; border-radius: 50%; background: ${opts.colorAcento}22; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 32px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { font-size: 14.5px; color: #555; line-height: 1.5; margin: 0 0 28px; }
    a.boton { display: inline-block; background: ${opts.colorAcento}; color: #fff; text-decoration: none; font-weight: 700; font-size: 14.5px; padding: 14px 28px; border-radius: 12px; }
  </style>
</head>
<body>
  <div class="tarjeta">
    <div class="icono">${opts.icono}</div>
    <h1>${opts.titulo}</h1>
    <p>${opts.texto}</p>
    <a class="boton" id="volver" href="${deepLink}">Volver a HogarSOS</a>
  </div>
  <script>
    // Intento automático: si el navegador lo permite, no hace falta ni
    // pulsar el botón. Si el sistema no tiene la app instalada o el
    // navegador bloquea la navegación automática a un esquema propio,
    // el botón de abajo sigue funcionando igual con un toque.
    setTimeout(function () {
      window.location.href = document.getElementById('volver').href;
    }, 300);
  </script>
</body>
</html>`;
}

router.get('/completado', (_req, res) => {
  res.send(
    paginaRetorno({
      ruta: 'completado',
      titulo: '¡Cuenta de cobro configurada!',
      texto: 'Ya puedes volver a Hogar SOS. Tu estado se actualizará solo al volver a la app.',
      colorAcento: '#1E8A5A',
      icono: '✓',
    })
  );
});

router.get('/refresh', (_req, res) => {
  res.send(
    paginaRetorno({
      ruta: 'refresh',
      titulo: 'El enlace ha caducado',
      texto: 'Vuelve a Hogar SOS e inténtalo de nuevo desde "Configurar cuenta de cobro".',
      colorAcento: '#F5A623',
      icono: '⟳',
    })
  );
});

export default router;

import { Router } from 'express';

/**
 * Política de privacidad y términos de servicio como páginas web reales
 * (no solo dentro de la app) — Apple y Google piden una URL pública
 * para la ficha de la tienda, no basta con la pantalla in-app (ver
 * lib/screens/legal/ en el frontend, mismo contenido). HTML sin
 * dependencias (sin motor de plantillas) porque son solo dos páginas
 * estáticas; si esto crece a más contenido público, se cambia por algo
 * más serio entonces.
 */
const router = Router();

const SITIO_URL = 'https://hogarsos.es';

/**
 * <head> compartido entre todas las páginas públicas: favicon, meta
 * descripción (SEO) y Open Graph/Twitter Card (para que compartir el
 * enlace en WhatsApp, Twitter, etc. muestre una tarjeta con imagen en
 * vez de un enlace pelado). og-image.png y favicon.png son el mismo
 * icono de marca ya generado para iOS (ver frontend_wizard/ios/.../
 * AppIcon.appiconset), copiado a public/ — una sola fuente de verdad
 * para el icono, sin generar uno nuevo aparte.
 */
function cabeza(titulo: string, descripcion: string, ruta: string): string {
  return `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titulo}</title>
  <meta name="description" content="${descripcion}">
  <link rel="icon" type="image/png" href="/public/favicon.png">
  <link rel="apple-touch-icon" href="/public/favicon.png">
  <meta property="og:title" content="${titulo}">
  <meta property="og:description" content="${descripcion}">
  <meta property="og:image" content="${SITIO_URL}/public/og-image.png">
  <meta property="og:url" content="${SITIO_URL}${ruta}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${titulo}">
  <meta name="twitter:description" content="${descripcion}">
  <meta name="twitter:image" content="${SITIO_URL}/public/og-image.png">`;
}

function pagina(titulo: string, secciones: { titulo: string; texto: string }[], ruta: string): string {
  const cuerpo = secciones
    .map(
      (s) => `
      <section>
        <h2>${s.titulo}</h2>
        <p>${s.texto.replace(/\n/g, '<br>')}</p>
      </section>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  ${cabeza(`${titulo} — hogarSOS`, `${titulo} de hogarSOS, la app que conecta clientes con profesionales de servicios a domicilio.`, ruta)}
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; color: #1a1a2e; line-height: 1.6; }
    h1 { color: #3D4FE0; font-size: 26px; }
    h2 { font-size: 17px; margin-top: 32px; }
    p { font-size: 15px; color: #333; }
    a { color: #3D4FE0; }
    header { border-bottom: 1px solid #e5e5f0; padding-bottom: 16px; margin-bottom: 24px; }
    .volver { display: inline-block; margin-bottom: 20px; font-size: 14px; text-decoration: none; }
  </style>
</head>
<body>
  <a class="volver" href="/">← Volver al inicio</a>
  <header><h1>${titulo}</h1></header>
  ${cuerpo}
</body>
</html>`;
}

router.get('/privacidad', (_req, res) => {
  res.send(
    pagina('Política de privacidad', [
      {
        titulo: '1. Quién trata tus datos',
        texto: 'hogarSOS es una app que conecta a clientes con profesionales de servicios a domicilio. Somos responsables del tratamiento de los datos personales que recoge la aplicación, descritos en esta política.',
      },
      {
        titulo: '2. Qué datos recogemos',
        texto: '• Datos de cuenta: nombre, email y teléfono al registrarte.\n• Ubicación: tu ubicación aproximada o precisa (con tu permiso) para mostrarte profesionales cercanos, o para que un profesional aparezca en las búsquedas de clientes cerca de él.\n• Fotos: las que adjuntes a una solicitud de servicio o a tu perfil.\n• Documentos de verificación (solo profesionales): documento de identidad, certificados y seguro de responsabilidad civil, usados exclusivamente para verificar tu identidad y aptitud antes de permitirte operar en la plataforma.\n• Datos de pago: gestionados directamente por Stripe, nuestro procesador de pagos — hogarSOS nunca almacena el número completo de tu tarjeta.\n• Mensajes de chat entre cliente y profesional de una misma solicitud.',
      },
      {
        titulo: '3. Para qué usamos tus datos',
        texto: 'Para prestar el servicio (conectar clientes con profesionales, procesar pagos, gestionar solicitudes), para verificar la identidad de los profesionales, para enviarte notificaciones relacionadas con tus solicitudes, y para prevenir fraude y resolver disputas.',
      },
      {
        titulo: '4. Con quién compartimos tus datos',
        texto: 'Con el otro participante de una solicitud (el cliente ve el nombre del profesional asignado y viceversa). Con proveedores que nos ayudan a operar la app: Firebase/Google (autenticación, notificaciones, chat) y Stripe (pagos). No vendemos tus datos a terceros ni los usamos con fines publicitarios ajenos a la app.',
      },
      {
        titulo: '5. Cuánto tiempo conservamos tus datos',
        texto: 'Mientras tu cuenta esté activa. Si la eliminas, borramos o anonimizamos tus datos personales, salvo lo que debamos conservar por obligación legal (p. ej. registros de pagos).',
      },
      {
        titulo: '6. Tus derechos',
        texto: 'Puedes acceder, rectificar o solicitar la eliminación de tus datos, y retirar los permisos de ubicación, cámara o galería en cualquier momento desde los ajustes de tu teléfono. Para ejercer estos derechos, contacta con nosotros desde la app.',
      },
      {
        titulo: '7. Cambios en esta política',
        texto: 'Si actualizamos esta política de forma relevante, te lo notificaremos dentro de la app antes de que entre en vigor.',
      },
    ], '/privacidad')
  );
});

/**
 * Página de inicio pública en la raíz del dominio (hogarsos.es) — antes
 * era el texto plano "hogarSOS API funcionando" (ver index.ts), nada
 * presentable si alguien visita el dominio directamente. Sencilla a
 * propósito: logo + qué es la app + enlaces legales, no una web de
 * marketing elaborada. El icono SVG reproduce (simplificado) la misma
 * geometría de HogarSosMark (lib/theme/brand_mark.dart): casa blanca +
 * punto coral de acento sobre fondo con degradado de marca.
 */
/**
 * Portada reducida a "Próximamente" a propósito — la versión anterior
 * (categorías, cómo funciona, modelo de comisión) se queda comentada
 * más abajo por si se quiere recuperar más adelante, pero mientras el
 * producto no esté público no tiene sentido explicarle el
 * funcionamiento a cualquiera que visite el dominio. /privacidad y
 * /terminos siguen igual: no revelan nada del modelo de negocio y
 * hacen falta para las tiendas de apps.
 */
export function paginaInicio(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  ${cabeza(
    'hogarSOS — Próximamente',
    'hogarSOS está en camino. Muy pronto.',
    '/'
  )}
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; color: #1a1a2e; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg, #EEF0FD, #ffffff); }
    .logo { display: flex; flex-direction: column; align-items: center; gap: 22px; text-align: center; }
    .logo .marca { display: flex; align-items: center; gap: 10px; }
    .logo .marca span { font-size: 24px; font-weight: 800; }
    .logo .marca span b { color: #FF6A4D; }
    .proximamente { font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #3D4FE0; font-weight: 700; }
  </style>
</head>
<body>
  <div class="logo">
    <div class="marca">
      <svg viewBox="0 0 100 100" width="48" height="48" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#3D4FE0"/>
            <stop offset="100%" stop-color="#2635A8"/>
          </linearGradient>
        </defs>
        <rect width="100" height="100" rx="22" fill="url(#bg)"/>
        <polygon points="50,20 80,52 20,52" fill="#fff"/>
        <rect x="30" y="52" width="40" height="28" rx="6" fill="#fff"/>
        <circle cx="74" cy="28" r="7" fill="#FF6A4D"/>
      </svg>
      <span>hogar<b>SOS</b></span>
    </div>
    <div class="proximamente">Próximamente</div>
  </div>
</body>
</html>`;
}

/* Versión anterior de la portada, con secciones, categorías y "cómo
 * funciona" — guardada aquí comentada por si se quiere recuperar más
 * adelante en vez de reescribirla desde cero.
export function _paginaInicioCompleta(): string {
  return \`<!DOCTYPE html>
<html lang="es">
<head>
  \${cabeza(
    'hogarSOS — Profesionales de confianza para tu hogar',
    'hogarSOS conecta a personas que necesitan un servicio a domicilio con profesionales verificados de su zona — electricidad, fontanería, limpieza y mucho más.',
    '/'
  )}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,500,1,0" rel="stylesheet">
  <style>
    .material-symbols-outlined { font-family: 'Material Symbols Outlined'; font-size: 26px; line-height: 1; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; color: #1a1a2e; }
    .hero { text-align: center; padding: 64px 20px 48px; background: linear-gradient(160deg, #EEF0FD, #ffffff); }
    .logo { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 28px; }
    .logo span { font-size: 22px; font-weight: 800; }
    .logo span b { color: #FF6A4D; }
    h1 { font-size: 30px; max-width: 560px; margin: 0 auto 14px; line-height: 1.25; }
    .hero p { font-size: 16px; color: #555; max-width: 460px; margin: 0 auto; line-height: 1.5; }
    .features { display: flex; flex-wrap: wrap; justify-content: center; gap: 20px; max-width: 780px; margin: 48px auto; padding: 0 20px; }
    .feature { flex: 1 1 200px; max-width: 230px; text-align: center; }
    .feature h3 { font-size: 15px; margin: 0 0 6px; }
    .feature p { font-size: 13.5px; color: #666; line-height: 1.5; margin: 0; }
    .categorias { padding: 8px 20px 48px; }
    .categorias h2 { text-align: center; font-size: 22px; margin: 0 0 8px; }
    .categorias > p { text-align: center; font-size: 14px; color: #777; margin: 0 0 32px; }
    .categoria-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 20px; max-width: 780px; margin: 0 auto; }
    .categoria-item { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
    .categoria-icon { width: 56px; height: 56px; border-radius: 16px; display: flex; align-items: center; justify-content: center; }
    .categoria-item span.label { font-size: 12.5px; font-weight: 600; color: #333; }
    .como-funciona { background: #F7F8FD; padding: 48px 20px; }
    .como-funciona h2 { text-align: center; font-size: 22px; margin: 0 0 36px; }
    .pasos { display: flex; flex-wrap: wrap; justify-content: center; gap: 28px; max-width: 820px; margin: 0 auto; }
    .paso { flex: 1 1 220px; max-width: 250px; text-align: center; }
    .paso .num { width: 32px; height: 32px; line-height: 32px; border-radius: 50%; background: #3D4FE0; color: #fff; font-weight: 700; font-size: 14px; margin: 0 auto 12px; }
    .paso h3 { font-size: 14.5px; margin: 0 0 6px; }
    .paso p { font-size: 13px; color: #666; line-height: 1.5; margin: 0; }
    .beta { text-align: center; padding: 40px 20px; }
    .beta p { font-size: 13.5px; color: #888; max-width: 420px; margin: 0 auto; }
    footer { text-align: center; padding: 16px 20px 48px; font-size: 13px; color: #888; }
    footer a { color: #3D4FE0; text-decoration: none; margin: 0 8px; }
  </style>
</head>
<body>
  <div class="hero">
    <div class="logo">
      <svg viewBox="0 0 100 100" width="40" height="40" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#3D4FE0"/>
            <stop offset="100%" stop-color="#2635A8"/>
          </linearGradient>
        </defs>
        <rect width="100" height="100" rx="22" fill="url(#bg)"/>
        <polygon points="50,20 80,52 20,52" fill="#fff"/>
        <rect x="30" y="52" width="40" height="28" rx="6" fill="#fff"/>
        <circle cx="74" cy="28" r="7" fill="#FF6A4D"/>
      </svg>
      <span>hogar<b>SOS</b></span>
    </div>
    <h1>Encuentra ayuda de confianza para tu hogar, cerca de ti</h1>
    <p>hogarSOS conecta a personas que necesitan un servicio a domicilio con profesionales verificados de su zona — electricidad, fontanería, limpieza y mucho más.</p>
  </div>
  <div class="features">
    <div class="feature">
      <h3>Profesionales verificados</h3>
      <p>Cada profesional pasa por un proceso de verificación de identidad antes de poder operar en la plataforma.</p>
    </div>
    <div class="feature">
      <h3>Pago seguro</h3>
      <p>El pago se autoriza al aceptar el trabajo y solo se cobra cuando el servicio queda completado.</p>
    </div>
    <div class="feature">
      <h3>Cerca de ti</h3>
      <p>Encuentra a alguien disponible cerca de tu ubicación, sin llamadas ni esperas.</p>
    </div>
  </div>
  <div class="categorias">
    <h2>Todo lo que puedes pedir</h2>
    <p>Y muchos oficios más, disponibles desde la app.</p>
    <div class="categoria-grid">
      ${[
        ['bolt', '#F5A623', 'Electricista'],
        ['plumbing', '#2E90FA', 'Fontanero'],
        ['format_paint', '#7A5AF8', 'Pintor'],
        ['key', '#4C5FD5', 'Cerrajería'],
        ['ac_unit', '#39C0F2', 'Aire acondicionado'],
        ['auto_awesome', '#12B3A8', 'Limpieza'],
        ['handyman', '#F76B1C', 'Manitas'],
        ['foundation', '#64748B', 'Albañilería'],
        ['grass', '#3FB950', 'Jardinería'],
      ]
        .map(
          ([icono, color, nombre]) => `
      <div class="categoria-item">
        <div class="categoria-icon" style="background:${color}22">
          <span class="material-symbols-outlined" style="color:${color}">${icono}</span>
        </div>
        <span class="label">${nombre}</span>
      </div>`
        )
        .join('')}
    </div>
  </div>
  <div class="como-funciona">
    <h2>Cómo funciona</h2>
    <div class="pasos">
      <div class="paso">
        <div class="num">1</div>
        <h3>Cuenta qué necesitas</h3>
        <p>Describe el problema y tu ubicación en menos de un minuto.</p>
      </div>
      <div class="paso">
        <div class="num">2</div>
        <h3>Un profesional lo acepta</h3>
        <p>Un profesional verificado cerca de ti acepta el trabajo y os ponéis en contacto por chat.</p>
      </div>
      <div class="paso">
        <div class="num">3</div>
        <h3>Paga solo al terminar</h3>
        <p>El pago se autoriza al aceptar, pero no se cobra hasta que el servicio queda completado.</p>
      </div>
    </div>
  </div>
  <div class="beta">
    <p>hogarSOS está actualmente en fase beta. Si quieres ser de los primeros en probarlo, escríbenos.</p>
  </div>
  <footer>
    hogarSOS · <a href="/privacidad">Política de privacidad</a> · <a href="/terminos">Términos de servicio</a>
  </footer>
</body>
</html>\`;
}
*/

router.get('/terminos', (_req, res) => {
  res.send(
    pagina('Términos de servicio', [
      {
        titulo: '1. Qué es hogarSOS',
        texto: 'hogarSOS es una plataforma que conecta a clientes que necesitan un servicio a domicilio (electricidad, fontanería, limpieza, etc.) con profesionales independientes que los ofrecen. hogarSOS no presta los servicios directamente ni es empleador de los profesionales — actúa como intermediario entre ambas partes.',
      },
      {
        titulo: '2. Cuentas de usuario',
        texto: 'Debes dar información veraz al registrarte. Eres responsable de mantener segura tu cuenta. Los profesionales deben superar un proceso de verificación (documento de identidad y, si aplica, certificados/seguro) antes de poder aceptar solicitudes.',
      },
      {
        titulo: '3. Pagos y comisión',
        texto: 'El pago de un servicio se autoriza a través de Stripe al aceptar el trabajo, pero no se cobra hasta que el profesional marca el servicio como completado. hogarSOS retiene una comisión sobre el precio final del servicio; el resto se transfiere al profesional. Los precios los fija el profesional o se acuerdan entre ambas partes por chat.',
      },
      {
        titulo: '4. Cancelaciones y reembolsos',
        texto: 'El cliente puede cancelar una solicitud sin coste mientras esté pendiente o recién aceptada y el trabajo todavía no haya empezado. Si ya se autorizó un pago, se reembolsa automáticamente al cancelar. Una vez el profesional marca el servicio como "en curso", ya no se puede cancelar desde la app — en ese caso, contacta con nosotros para resolverlo.',
      },
      {
        titulo: '5. Disputas',
        texto: 'Si algo no fue como se esperaba, cliente o profesional pueden abrir una disputa. Un administrador revisa el caso y decide si el pago se libera al profesional o se reembolsa al cliente.',
      },
      {
        titulo: '6. Responsabilidad',
        texto: 'hogarSOS facilita el contacto y el pago entre cliente y profesional, pero no supervisa ni garantiza la calidad del trabajo realizado — la relación de servicio es directamente entre ambas partes. Recomendamos revisar las valoraciones de un profesional antes de contratarlo.',
      },
      {
        titulo: '7. Conducta de los profesionales',
        texto: 'Los profesionales verificados deben prestar el servicio con la diligencia y competencia propias de su oficio. hogarSOS puede suspender o revocar una cuenta que reciba valoraciones reiteradamente negativas, incumpla estos términos, o cuya verificación resulte fraudulenta.',
      },
      {
        titulo: '8. Cambios en estos términos',
        texto: 'Podemos actualizar estos términos; los cambios relevantes se notificarán dentro de la app antes de entrar en vigor. Seguir usando hogarSOS después de un cambio implica aceptarlo.',
      },
      {
        titulo: '9. Ley aplicable',
        texto: 'Estos términos se rigen por la legislación española.',
      },
    ], '/terminos')
  );
});

router.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITIO_URL}/sitemap.xml`);
});

router.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITIO_URL}/</loc></url>
  <url><loc>${SITIO_URL}/privacidad</loc></url>
  <url><loc>${SITIO_URL}/terminos</loc></url>
</urlset>`
  );
});

export default router;

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

function pagina(titulo: string, secciones: { titulo: string; texto: string }[]): string {
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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titulo} — hogarSOS</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; color: #1a1a2e; line-height: 1.6; }
    h1 { color: #3D4FE0; font-size: 26px; }
    h2 { font-size: 17px; margin-top: 32px; }
    p { font-size: 15px; color: #333; }
    a { color: #3D4FE0; }
    header { border-bottom: 1px solid #e5e5f0; padding-bottom: 16px; margin-bottom: 24px; }
  </style>
</head>
<body>
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
    ])
  );
});

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
    ])
  );
});

export default router;

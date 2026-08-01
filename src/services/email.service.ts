import { mailer } from '../config/mailer';

/**
 * Envío de correos vía SMTP (IONOS, soporte@hogarsos.es). Aísla el resto
 * del backend del proveedor concreto de correo.
 */
export async function enviarEmail(
  to: string,
  subject: string,
  html: string
): Promise<void> {
  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    html,
  });
}

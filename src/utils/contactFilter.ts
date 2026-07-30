/**
 * Espejo en servidor de frontend_wizard/lib/utils/contact_filter.dart —
 * solo detecta teléfono/email (nada de enlaces ni redes sociales, ver
 * comentario en el original). Se usa aquí porque el mensaje de una
 * postulación sí pasa por nuestra propia API (a diferencia del chat,
 * que va directo a Firestore), así que aquí SÍ se puede validar en
 * servidor de forma fiable.
 */
const TELEFONO = /(?:(?:\+|00)\s?34[\s.-]?)?\b(?:\d[\s.-]?){8}\d\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/;
const EMAIL_EN_PALABRAS = /\b\w+\s*(arroba|\(at\))\s*\w+\s*(punto|\(dot\))\s*(com|es|net|org)\b/i;

export function razonBloqueoTexto(texto: string): 'telefono' | 'email' | null {
  if (TELEFONO.test(texto)) return 'telefono';
  if (EMAIL.test(texto) || EMAIL_EN_PALABRAS.test(texto)) return 'email';
  return null;
}

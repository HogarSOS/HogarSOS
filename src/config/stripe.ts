import Stripe from 'stripe';

// .trim(): un salto de línea o espacio sobrante al pegar la clave en el
// dashboard de Render pasa la validación de arranque (sigue empezando por
// "sk_live") pero Node rechaza la cabecera Authorization en la primera
// petición real con ERR_INVALID_CHAR. Ver validateEnv.ts para la
// comprobación que ahora también detecta esto en el arranque.
export const stripe = new Stripe((process.env.STRIPE_SECRET_KEY as string).trim(), {
  apiVersion: '2024-04-10',
});

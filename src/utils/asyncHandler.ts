import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 NO captura automáticamente los rechazos de promesas dentro
 * de handlers `async`. Sin esto, tu manejador de errores global en
 * index.ts nunca se activa para errores de controladores async — la
 * promesa queda rechazada sin gestionar y, en Node 15+ (incluido tu
 * Node 22), eso TERMINA EL PROCESO completo por defecto, tumbando toda
 * la API, no solo la petición que falló.
 *
 * Envuelve cualquier controlador async y reenvía el error a `next(err)`,
 * para que lo recoja tu manejador de errores ya existente en index.ts.
 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

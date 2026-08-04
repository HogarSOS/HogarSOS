jest.mock('../../config/prisma', () => ({
  prisma: { archivoSubido: { findUnique: jest.fn() }, serviceRequest: { findUnique: jest.fn() } },
}));

import { Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { servirArchivo } from '../archivo.controller';

const mockPrisma = prisma as any;
const UUID = '11111111-2222-3333-4444-555555555555';

function respuestaFalsa() {
  const res: Partial<Response> & Record<string, any> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.sendFile = jest.fn();
  res.headersSent = false;
  return res as Response & Record<string, any>;
}

function peticion(archivo: string, userId = 'u-1', role = 'cliente') {
  return { params: { archivo }, user: { userId, role } } as unknown as Request;
}

function fila(overrides: Record<string, unknown> = {}) {
  return {
    id: 'arch-1',
    nombreArchivo: `${UUID}.jpg`,
    tipo: 'documento_identidad',
    propietarioId: 'prof-1',
    serviceRequestId: null,
    eliminadoAt: null,
    ...overrides,
  };
}

describe('servirArchivo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('sirve el archivo a quien tiene permiso', async () => {
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(fila());
    const res = respuestaFalsa();

    await servirArchivo(peticion(`${UUID}.jpg`, 'prof-1', 'profesional'), res);

    expect(res.sendFile).toHaveBeenCalled();
  });

  /**
   * 404 y no 403 en los sensibles: un 403 le confirmaría a un tercero
   * que ese documento existe, que ya es información de más.
   */
  it('devuelve 404 (no 403) al pedir un documento sensible ajeno, para no confirmar que existe', async () => {
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(fila());
    const res = respuestaFalsa();

    await servirArchivo(peticion(`${UUID}.jpg`, 'atacante', 'cliente'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('devuelve 403 en un archivo NO sensible sin permiso (ahí no hay nada que ocultar)', async () => {
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(
      fila({ tipo: 'foto_solicitud', propietarioId: 'cli-1', serviceRequestId: 'sr-1' })
    );
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ clienteId: 'cli-1', profesionalId: 'prof-1' });
    const res = respuestaFalsa();

    await servirArchivo(peticion(`${UUID}.jpg`, 'tercero', 'cliente'), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rechaza el path traversal antes incluso de consultar la base de datos', async () => {
    const res = respuestaFalsa();

    await servirArchivo(peticion('../../.env'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockPrisma.archivoSubido.findUnique).not.toHaveBeenCalled();
  });

  /**
   * Ficheros de antes de esta tabla que la migración no pudo clasificar
   * (subidas abandonadas). Sin saber qué son no se puede autorizar, así
   * que dejan de servirse — que es justo lo que se quiere para un DNI
   * huérfano.
   */
  it('devuelve 404 si el archivo no tiene fila (no se puede clasificar, no se sirve)', async () => {
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(null);
    const res = respuestaFalsa();

    await servirArchivo(peticion(`${UUID}.jpg`, 'prof-1', 'profesional'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  /** El acceso se corta al MARCAR el borrado, sin esperar a la tarea de limpieza. */
  it('devuelve 404 en cuanto el archivo está marcado como eliminado, incluso a su propietario', async () => {
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(fila({ eliminadoAt: new Date() }));
    const res = respuestaFalsa();

    await servirArchivo(peticion(`${UUID}.jpg`, 'prof-1', 'profesional'), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('un documento sensible nunca se cachea; una foto normal sí', async () => {
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(fila());
    const res1 = respuestaFalsa();
    await servirArchivo(peticion(`${UUID}.jpg`, 'prof-1', 'profesional'), res1);
    expect(res1.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0');

    mockPrisma.archivoSubido.findUnique.mockResolvedValue(fila({ tipo: 'foto_perfil' }));
    const res2 = respuestaFalsa();
    await servirArchivo(peticion(`${UUID}.jpg`, 'cualquiera', 'cliente'), res2);
    expect(res2.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=86400');
  });

  it('un admin accede a cualquier documento (es para lo que se suben)', async () => {
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(fila());
    const res = respuestaFalsa();

    await servirArchivo(peticion(`${UUID}.jpg`, 'admin-1', 'admin'), res);

    expect(res.sendFile).toHaveBeenCalled();
  });
});

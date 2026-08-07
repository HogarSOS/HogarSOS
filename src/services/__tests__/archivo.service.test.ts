jest.mock('../../config/prisma', () => ({
  prisma: {
    archivoSubido: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
    },
    serviceRequest: { findUnique: jest.fn() },
  },
}));

jest.mock('fs/promises', () => ({
  unlink: jest.fn(),
  readdir: jest.fn(),
  stat: jest.fn(),
}));

import fs from 'fs/promises';
import { prisma } from '../../config/prisma';
import {
  normalizarNombreArchivo,
  puedeVerArchivo,
  esArchivoSensible,
  marcarArchivosDeUsuarioParaBorrado,
  asociarArchivosASolicitud,
  limpiarArchivos,
} from '../archivo.service';

const mockPrisma = prisma as any;
const mockFs = fs as any;

const UUID = '11111111-2222-3333-4444-555555555555';

function archivo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'arch-1',
    nombreArchivo: `${UUID}.jpg`,
    tipo: 'documento_identidad',
    propietarioId: 'prof-1',
    serviceRequestId: null,
    bytes: 1000,
    createdAt: new Date(),
    eliminadoAt: null,
    ...overrides,
  } as any;
}

/**
 * AUDITORÍA B4. Antes de esto, /uploads era `express.static` sin
 * autenticación y por ahí se servían los DOCUMENTOS DE IDENTIDAD de los
 * profesionales: cualquiera con la URL leía un DNI escaneado, para
 * siempre y sin sesión.
 */
describe('normalizarNombreArchivo — path traversal', () => {
  it('acepta un nombre con la forma exacta que genera uploadPhoto', () => {
    expect(normalizarNombreArchivo(`${UUID}.jpg`)).toBe(`${UUID}.jpg`);
  });

  it('extrae el nombre de una URL completa (las URLs guardadas llevan dominio)', () => {
    expect(normalizarNombreArchivo(`https://hogarsos.es/uploads/${UUID}.png`)).toBe(`${UUID}.png`);
  });

  it.each([
    '../../.env',
    '/etc/passwd',
    '..%2f..%2f.env',
    'no-es-un-uuid.jpg',
    `${UUID}.jpg.exe.sh.bak.zip`,
    '',
  ])('rechaza %s', (entrada) => {
    expect(normalizarNombreArchivo(entrada)).toBeNull();
  });

  /**
   * `path.basename` deja el nombre final, así que aunque alguien meta
   * componentes de directorio no se sale del directorio de subidas — y
   * el patrón descarta lo que quede si no tiene forma de UUID.
   */
  it('no permite escapar del directorio de subidas aunque el nombre final sea válido', () => {
    expect(normalizarNombreArchivo(`../../../${UUID}.jpg`)).toBe(`${UUID}.jpg`);
  });
});

describe('puedeVerArchivo — documentos sensibles', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['documento_identidad', 'certificado', 'seguro_rc'])('%s: los marca como sensibles', (tipo) => {
    expect(esArchivoSensible(tipo as any)).toBe(true);
  });

  it('el propietario puede ver su propio documento de identidad', async () => {
    const puede = await puedeVerArchivo(archivo(), { userId: 'prof-1', role: 'profesional' });
    expect(puede).toBe(true);
  });

  it('un admin puede verlo (es para lo que se sube: verificar al profesional)', async () => {
    const puede = await puedeVerArchivo(archivo(), { userId: 'admin-1', role: 'admin' });
    expect(puede).toBe(true);
  });

  /** EL bloqueante B4: antes esto era accesible para cualquiera, incluso sin sesión. */
  it('OTRO profesional NO puede ver el documento de identidad ajeno', async () => {
    const puede = await puedeVerArchivo(archivo(), { userId: 'prof-2', role: 'profesional' });
    expect(puede).toBe(false);
  });

  it('un cliente cualquiera NO puede ver un documento de identidad ajeno', async () => {
    const puede = await puedeVerArchivo(archivo(), { userId: 'cli-1', role: 'cliente' });
    expect(puede).toBe(false);
  });

  it('tampoco el cliente con el que ese profesional trabajó', async () => {
    const puede = await puedeVerArchivo(
      archivo({ serviceRequestId: 'sr-1' }),
      { userId: 'cli-1', role: 'cliente' }
    );
    expect(puede).toBe(false);
    // Ni siquiera se consulta la solicitud: los sensibles no dependen de eso.
    expect(mockPrisma.serviceRequest.findUnique).not.toHaveBeenCalled();
  });

  it.each(['certificado', 'seguro_rc'])('%s ajeno tampoco es visible', async (tipo) => {
    const puede = await puedeVerArchivo(archivo({ tipo }), { userId: 'otro', role: 'profesional' });
    expect(puede).toBe(false);
  });
});

describe('puedeVerArchivo — fotos de solicitud y reclamación', () => {
  beforeEach(() => jest.clearAllMocks());

  const fotoSolicitud = archivo({ tipo: 'foto_solicitud', propietarioId: 'cli-1', serviceRequestId: 'sr-1' });

  it('el profesional asignado puede verla', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ clienteId: 'cli-1', profesionalId: 'prof-1' });

    expect(await puedeVerArchivo(fotoSolicitud, { userId: 'prof-1', role: 'profesional' })).toBe(true);
  });

  /** Son fotos del interior de la casa de alguien. */
  it('un tercero que no participa en esa solicitud NO puede verla', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ clienteId: 'cli-1', profesionalId: 'prof-1' });

    expect(await puedeVerArchivo(fotoSolicitud, { userId: 'prof-9', role: 'profesional' })).toBe(false);
  });

  /**
   * Sin asociación no se puede comprobar nada, así que se deniega. Es el
   * caso de una foto subida y nunca usada en ninguna solicitud.
   */
  it('sin serviceRequestId asociado se deniega a cualquiera que no sea el propietario', async () => {
    const suelta = archivo({ tipo: 'foto_solicitud', propietarioId: 'cli-1', serviceRequestId: null });

    expect(await puedeVerArchivo(suelta, { userId: 'prof-1', role: 'profesional' })).toBe(false);
  });

  it('una foto de reclamación la ven las dos partes', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ clienteId: 'cli-1', profesionalId: 'prof-1' });
    const prueba = archivo({ tipo: 'foto_disputa', propietarioId: 'cli-1', serviceRequestId: 'sr-1' });

    expect(await puedeVerArchivo(prueba, { userId: 'prof-1', role: 'profesional' })).toBe(true);
  });
});

describe('puedeVerArchivo — fotos de perfil', () => {
  beforeEach(() => jest.clearAllMocks());

  /** Los perfiles de profesional son navegables por diseño (searchProfessionals). */
  it('cualquier usuario autenticado puede ver una foto de perfil', async () => {
    const foto = archivo({ tipo: 'foto_perfil', propietarioId: 'prof-1' });

    expect(await puedeVerArchivo(foto, { userId: 'cli-cualquiera', role: 'cliente' })).toBe(true);
  });
});

describe('marcarArchivosDeUsuarioParaBorrado (RGPD Art. 17)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marca todos los archivos del usuario y devuelve cuántos', async () => {
    mockPrisma.archivoSubido.updateMany.mockResolvedValue({ count: 3 });

    const marcados = await marcarArchivosDeUsuarioParaBorrado('u-1');

    expect(marcados).toBe(3);
    expect(mockPrisma.archivoSubido.updateMany).toHaveBeenCalledWith({
      where: { propietarioId: 'u-1', eliminadoAt: null },
      data: { eliminadoAt: expect.any(Date) },
    });
  });
});

describe('asociarArchivosASolicitud', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asocia por nombre de fichero extraído de la URL completa', async () => {
    mockPrisma.archivoSubido.updateMany.mockResolvedValue({ count: 1 });

    await asociarArchivosASolicitud([`https://hogarsos.es/uploads/${UUID}.jpg`], 'sr-1', 'foto_solicitud', 'u-1');

    expect(mockPrisma.archivoSubido.updateMany).toHaveBeenCalledWith({
      where: { nombreArchivo: { in: [`${UUID}.jpg`] }, propietarioId: 'u-1' },
      data: { serviceRequestId: 'sr-1', tipo: 'foto_solicitud' },
    });
  });

  it('descarta URLs con forma inválida sin lanzar', async () => {
    await asociarArchivosASolicitud(['https://evil.com/../../.env'], 'sr-1', 'foto_solicitud', 'u-1');

    expect(mockPrisma.archivoSubido.updateMany).not.toHaveBeenCalled();
  });
});

describe('limpiarArchivos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([]);
    mockPrisma.archivoSubido.findMany.mockResolvedValue([]);
    mockPrisma.archivoSubido.delete.mockResolvedValue({});
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(null);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('borra del disco los archivos de cuentas eliminadas y quita su fila', async () => {
    mockPrisma.archivoSubido.findMany.mockResolvedValue([
      archivo({ id: 'arch-1', eliminadoAt: new Date() }),
    ]);

    const resultado = await limpiarArchivos();

    expect(mockFs.unlink).toHaveBeenCalled();
    expect(mockPrisma.archivoSubido.delete).toHaveBeenCalledWith({ where: { id: 'arch-1' } });
    expect(resultado.borradosMarcados).toBe(1);
  });

  /**
   * Un DNI subido por alguien que no llegó a enviar el formulario queda
   * en disco sin fila. Ya es inaccesible (servirArchivo no puede
   * clasificarlo), pero conservarlo "por si acaso" es conservación sin
   * base legal.
   */
  it('borra huérfanos: ficheros en disco sin ninguna fila que los describa', async () => {
    mockFs.readdir.mockResolvedValue([`${UUID}.jpg`]);
    mockFs.stat.mockResolvedValue({ mtimeMs: Date.now() - 48 * 60 * 60 * 1000 });
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(null);

    const resultado = await limpiarArchivos();

    expect(resultado.huerfanosBorrados).toBe(1);
  });

  /** Carrera real: fichero recién escrito cuya fila aún no se ha creado. */
  it('NO toca un fichero reciente aunque no tenga fila todavía', async () => {
    mockFs.readdir.mockResolvedValue([`${UUID}.jpg`]);
    mockFs.stat.mockResolvedValue({ mtimeMs: Date.now() - 60 * 1000 });

    const resultado = await limpiarArchivos();

    expect(resultado.huerfanosBorrados).toBe(0);
    expect(mockFs.unlink).not.toHaveBeenCalled();
  });

  it('NO borra un fichero antiguo que SÍ tiene fila (está en uso)', async () => {
    mockFs.readdir.mockResolvedValue([`${UUID}.jpg`]);
    mockFs.stat.mockResolvedValue({ mtimeMs: Date.now() - 48 * 60 * 60 * 1000 });
    mockPrisma.archivoSubido.findUnique.mockResolvedValue(archivo());

    const resultado = await limpiarArchivos();

    expect(resultado.huerfanosBorrados).toBe(0);
    expect(mockFs.unlink).not.toHaveBeenCalled();
  });

  it('ignora ficheros que no tienen forma de subida nuestra (.gitkeep)', async () => {
    mockFs.readdir.mockResolvedValue(['.gitkeep', 'README.md']);

    await limpiarArchivos();

    expect(mockFs.unlink).not.toHaveBeenCalled();
  });
});

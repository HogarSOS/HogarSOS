jest.mock('../../config/prisma', () => ({
  prisma: {
    adminAction: { create: jest.fn(), findMany: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { registrarAccionAdmin, listarAccionesAdmin } from '../adminAction.service';

const mockPrisma = prisma as any;

describe('registrarAccionAdmin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('crea la fila con los campos dados, null en los opcionales ausentes', async () => {
    mockPrisma.adminAction.create.mockResolvedValue({});

    await registrarAccionAdmin({
      adminId: 'admin-1',
      accion: 'bloquear_usuario',
      entidadTipo: 'user',
      entidadId: 'user-1',
      estadoAnterior: 'true',
      estadoNuevo: 'false',
    });

    expect(mockPrisma.adminAction.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        accion: 'bloquear_usuario',
        entidadTipo: 'user',
        entidadId: 'user-1',
        estadoAnterior: 'true',
        estadoNuevo: 'false',
        detalle: null,
      },
    });
  });

  // La acción real (ya aplicada antes de llamar aquí) no debe reportarse
  // como fallida solo porque la auditoría no se pudo escribir.
  it('no relanza si prisma.adminAction.create falla', async () => {
    mockPrisma.adminAction.create.mockRejectedValue(new Error('db caída'));

    await expect(
      registrarAccionAdmin({ adminId: 'admin-1', accion: 'x', entidadTipo: 'user', entidadId: 'user-1' })
    ).resolves.toBeUndefined();
  });
});

describe('listarAccionesAdmin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('filtra solo por los campos dados y ordena por fecha descendente', async () => {
    mockPrisma.adminAction.findMany.mockResolvedValue([]);

    await listarAccionesAdmin({ entidadTipo: 'user', entidadId: 'user-1' });

    expect(mockPrisma.adminAction.findMany).toHaveBeenCalledWith({
      where: { entidadTipo: 'user', entidadId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('limita el máximo a 200 aunque se pida más', async () => {
    mockPrisma.adminAction.findMany.mockResolvedValue([]);

    await listarAccionesAdmin({ limite: 5000 });

    expect(mockPrisma.adminAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 })
    );
  });
});

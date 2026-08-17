import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceCategory: { findMany: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { listCategories, invalidarCacheCategorias } from '../category.controller';

const mockPrisma = prisma as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('listCategories (caché en memoria de 60s)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidarCacheCategorias();
  });

  it('la segunda llamada dentro del TTL sirve del caché sin tocar la BD', async () => {
    const catalogo = [{ id: 1, nombre: 'Electricista', activo: true }];
    mockPrisma.serviceCategory.findMany.mockResolvedValue(catalogo);

    const res1 = fakeRes();
    await listCategories({} as Request, res1);
    const res2 = fakeRes();
    await listCategories({} as Request, res2);

    expect(mockPrisma.serviceCategory.findMany).toHaveBeenCalledTimes(1);
    expect(res1.json).toHaveBeenCalledWith(catalogo);
    expect(res2.json).toHaveBeenCalledWith(catalogo);
  });

  it('tras invalidar, vuelve a consultar la BD', async () => {
    mockPrisma.serviceCategory.findMany.mockResolvedValue([]);

    await listCategories({} as Request, fakeRes());
    invalidarCacheCategorias();
    await listCategories({} as Request, fakeRes());

    expect(mockPrisma.serviceCategory.findMany).toHaveBeenCalledTimes(2);
  });

  it('sigue filtrando por activo y ordenando por nombre (el contrato del catálogo no cambia)', async () => {
    mockPrisma.serviceCategory.findMany.mockResolvedValue([]);

    await listCategories({} as Request, fakeRes());

    expect(mockPrisma.serviceCategory.findMany).toHaveBeenCalledWith({
      where: { activo: true },
      orderBy: { nombre: 'asc' },
    });
  });
});

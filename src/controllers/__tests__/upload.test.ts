import { Request, Response } from 'express';
import sharp from 'sharp';

jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

import { writeFile } from 'fs/promises';
import { uploadPhoto } from '../upload.controller';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('uploadPhoto', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_BASE_URL = 'https://hogarsos.es';
  });

  it('devuelve 400 si no llega ningún archivo', async () => {
    const req = { file: undefined } as unknown as Request;
    const res = mockRes();

    await uploadPhoto(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('redimensiona una imagen grande al lado máximo (1920px) y la recomprime a JPEG', async () => {
    // 3000x2000 — más grande que cualquier pantalla de la app, similar a
    // una foto de móvil real sin comprimir.
    const original = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    const req = {
      file: { buffer: original, mimetype: 'image/jpeg', originalname: 'foto.jpg' },
    } as unknown as Request;
    const res = mockRes();

    await uploadPhoto(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ url: expect.stringMatching(/^https:\/\/hogarsos\.es\/uploads\/.+\.jpg$/) });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const bufferGuardado = (writeFile as jest.Mock).mock.calls[0][1] as Buffer;
    const metadata = await sharp(bufferGuardado).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(1920);
    expect(metadata.height).toBeLessThanOrEqual(1920);
    // La recompresión de un archivo sintético igual de "simple" no
    // garantiza reducción de tamaño en bytes siempre, pero el
    // redimensionado de 3000x2000 a como mucho 1920 de lado sí es
    // determinista y es lo que de verdad importa para el ancho de banda.
    expect(bufferGuardado.length).toBeLessThan(original.length);
  });

  it('no agranda una imagen que ya es más pequeña que el límite', async () => {
    const original = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();

    const req = {
      file: { buffer: original, mimetype: 'image/jpeg', originalname: 'pequena.jpg' },
    } as unknown as Request;
    const res = mockRes();

    await uploadPhoto(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const bufferGuardado = (writeFile as jest.Mock).mock.calls[0][1] as Buffer;
    const metadata = await sharp(bufferGuardado).metadata();
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(300);
  });

  it('responde 400 si el buffer no es una imagen válida', async () => {
    const req = {
      file: { buffer: Buffer.from('esto no es una imagen'), mimetype: 'image/jpeg', originalname: 'raro.jpg' },
    } as unknown as Request;
    const res = mockRes();

    await uploadPhoto(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(writeFile).not.toHaveBeenCalled();
  });
});

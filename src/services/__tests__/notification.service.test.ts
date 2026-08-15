const mockPrisma = {
  user: { findUnique: jest.fn() },
  userFcmToken: { findMany: jest.fn(), deleteMany: jest.fn() },
};

jest.mock('../../config/prisma', () => ({ prisma: mockPrisma }));

const mockSendEachForMulticast = jest.fn();
jest.mock('firebase-admin', () => ({
  messaging: () => ({ sendEachForMulticast: mockSendEachForMulticast }),
}));

import { enviarNotificacion } from '../notification.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFcmToken.deleteMany.mockResolvedValue({ count: 0 });
});

const TIPO = 'nueva_postulacion' as const;

describe('despachar (vía enviarNotificacion) — P2 #5', () => {
  it('usuario con 0 tokens no llama a Firebase', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ idioma: 'es' });
    mockPrisma.userFcmToken.findMany.mockResolvedValue([]);

    await enviarNotificacion('user-1', TIPO);

    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });

  it('usuario con N tokens envía a todos en una sola llamada multicast', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ idioma: 'es' });
    mockPrisma.userFcmToken.findMany.mockResolvedValue([{ token: 'A' }, { token: 'B' }, { token: 'C' }]);
    mockSendEachForMulticast.mockResolvedValue({
      responses: [{ success: true }, { success: true }, { success: true }],
    });

    await enviarNotificacion('user-1', TIPO);

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(mockSendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({ tokens: ['A', 'B', 'C'] }));
  });

  // Caso central del hallazgo P2 #5: un token inválido no puede tumbar
  // el resto de dispositivos del usuario.
  it('borra SOLO el token que Firebase rechazó como inválido, deja los demás intactos', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ idioma: 'es' });
    mockPrisma.userFcmToken.findMany.mockResolvedValue([{ token: 'A' }, { token: 'B' }, { token: 'C' }]);
    mockSendEachForMulticast.mockResolvedValue({
      responses: [
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: true },
        { success: true },
      ],
    });

    await enviarNotificacion('user-1', TIPO);

    expect(mockPrisma.userFcmToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.userFcmToken.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ['A'] } } });
  });

  it('reconoce ambos códigos de token inválido ya usados antes de P2 #5', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ idioma: 'es' });
    mockPrisma.userFcmToken.findMany.mockResolvedValue([{ token: 'A' }, { token: 'B' }]);
    mockSendEachForMulticast.mockResolvedValue({
      responses: [
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
      ],
    });

    await enviarNotificacion('user-1', TIPO);

    expect(mockPrisma.userFcmToken.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ['A', 'B'] } } });
  });

  // Un error transitorio (cuota, red) de Firebase no debe borrar un
  // token sano — solo los dos códigos que significan "de verdad inválido".
  it('un error de Firebase NO relacionado con validez del token no borra nada', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ idioma: 'es' });
    mockPrisma.userFcmToken.findMany.mockResolvedValue([{ token: 'A' }]);
    mockSendEachForMulticast.mockResolvedValue({
      responses: [{ success: false, error: { code: 'messaging/internal-error' } }],
    });

    await enviarNotificacion('user-1', TIPO);

    expect(mockPrisma.userFcmToken.deleteMany).not.toHaveBeenCalled();
  });

  it('un fallo inesperado (excepción) no se propaga — fire and forget', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('DB caída'));

    await expect(enviarNotificacion('user-1', TIPO)).resolves.toBeUndefined();
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });
});

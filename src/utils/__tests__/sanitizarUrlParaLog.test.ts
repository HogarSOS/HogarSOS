import { sanitizarUrlParaLog } from '../sanitizarUrlParaLog';

describe('sanitizarUrlParaLog', () => {
  it('URL normal sin query string vuelve idéntica', () => {
    expect(sanitizarUrlParaLog('/api/professionals')).toBe('/api/professionals');
  });

  it('URL con parámetros normales los conserva tal cual', () => {
    expect(sanitizarUrlParaLog('/api/professionals?categoria=fontaneria&page=2')).toBe(
      '/api/professionals?categoria=fontaneria&page=2'
    );
  });

  it('URL con oobCode: el valor original desaparece de la salida', () => {
    const resultado = sanitizarUrlParaLog(
      '/auth/reset-password?mode=resetPassword&oobCode=ABC123SECRETO'
    );
    expect(resultado).not.toContain('ABC123SECRETO');
  });

  it('path y el resto de parámetros permanecen junto al oobCode redactado', () => {
    const resultado = sanitizarUrlParaLog(
      '/auth/reset-password?mode=resetPassword&oobCode=ABC123'
    );
    expect(resultado.startsWith('/auth/reset-password?')).toBe(true);
    expect(resultado).toContain('mode=resetPassword');
    expect(resultado).toContain('oobCode=%5BREDACTED%5D');
  });

  it('oobCode vacío se redacta igualmente si el parámetro está presente', () => {
    const resultado = sanitizarUrlParaLog('/auth/reset-password?mode=resetPassword&oobCode=');
    expect(resultado).toContain('oobCode=%5BREDACTED%5D');
  });

  it('parámetros repetidos no se rompen (solo se redacta oobCode)', () => {
    const resultado = sanitizarUrlParaLog('/x?tag=a&tag=b&oobCode=SECRETO');
    expect(resultado).toContain('tag=a');
    expect(resultado).toContain('tag=b');
    expect(resultado).not.toContain('SECRETO');
  });

  it('URL sin query string no añade un "?" al resultado', () => {
    const resultado = sanitizarUrlParaLog('/auth/reset-password');
    expect(resultado).toBe('/auth/reset-password');
    expect(resultado).not.toContain('?');
  });
});

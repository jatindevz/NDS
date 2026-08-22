import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests under vitest', () => {
    const greeting: string = 'ok';
    expect(greeting).toBe('ok');
  });
});

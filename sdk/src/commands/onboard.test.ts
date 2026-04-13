// Unit tests for the onboard command's wallet-name derivation. The
// helper is the load-bearing piece that fixes the "second agent reuses
// the first agent's OWS wallet" bug — the test exists to keep that
// behaviour locked in across future edits.

import { describe, it, expect } from 'vitest';
import { _deriveDefaultWalletName } from './onboard';

describe('deriveDefaultWalletName', () => {
  const claimA = 'c402_a1b2c3d4e5f607080910111213141516171819202122232425262728293031';
  const claimB = 'c402_ff00112233445566778899aabbccddeeff00112233445566778899aabbccdd';

  it('produces a name prefixed with cards402-', () => {
    expect(_deriveDefaultWalletName(claimA, 'research-bot')).toMatch(/^cards402-/);
  });

  it('includes a slugified version of the label', () => {
    expect(_deriveDefaultWalletName(claimA, 'Research Bot v2!')).toContain('research-bot-v2');
  });

  it('falls back to "agent" when the label is null', () => {
    expect(_deriveDefaultWalletName(claimA, null)).toContain('agent');
  });

  it('falls back to "agent" when the label is empty', () => {
    expect(_deriveDefaultWalletName(claimA, '')).toContain('agent');
  });

  it('produces different names for different claims — even with the same label', () => {
    const a = _deriveDefaultWalletName(claimA, 'research-bot');
    const b = _deriveDefaultWalletName(claimB, 'research-bot');
    expect(a).not.toBe(b);
  });

  it('is deterministic — same inputs always yield the same name', () => {
    expect(_deriveDefaultWalletName(claimA, 'research-bot')).toBe(
      _deriveDefaultWalletName(claimA, 'research-bot'),
    );
  });

  it('accepts a claim without the c402_ prefix', () => {
    const raw = _deriveDefaultWalletName(claimA, 'x');
    const noPrefix = _deriveDefaultWalletName(claimA.replace(/^c402_/, ''), 'x');
    expect(raw).toBe(noPrefix);
  });

  it('caps the label slug so a long label does not blow out the path', () => {
    const long = 'a'.repeat(200);
    const name = _deriveDefaultWalletName(claimA, long);
    // cards402- + slug (<=24) + - + 8-hex = ~42 chars max
    expect(name.length).toBeLessThanOrEqual(48);
  });

  it('never contains characters unsafe for a filesystem vault path', () => {
    const name = _deriveDefaultWalletName(claimA, '../../evil/$(whoami)');
    expect(name).toMatch(/^cards402-[a-z0-9-]+$/);
  });
});

'use client';
/**
 * What this phone remembers (Slice 11): the account it manages, its account token (S11-1: reaches
 * only that account, got with one Face ID signature) and the passkey's id. Per device only; the
 * app works without it (the passkey is discoverable, and the account can be opened by address).
 */
export type Session = { account: string | null; token: string | null; credentialId: string | null };

const KEY = 'countersign.session';
const EMPTY: Session = { account: null, token: null, credentialId: null };

export function loadSession(): Session {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Session>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function saveSession(next: Partial<Session>): Session {
  const merged = { ...loadSession(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // private mode: the session lasts this page only
  }
  return merged;
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing kept
  }
}

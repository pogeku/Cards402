// Client-side agent group storage. Groups are operator-local for now
// (kept in localStorage) so we can ship the UX without a backend
// migration. A future backend `agent_groups` column can replace
// this file without touching consumer components.
//
// Shape: { [agentId: string]: string } — one group name per agent.

'use client';

import { useEffect, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'cards402.agent_groups';

type Groups = Record<string, string>;

// Cached snapshot — `useSyncExternalStore`'s `getSnapshot` contract is
// that it MUST return a stable reference while the underlying data
// hasn't changed. Returning `{ ...read() }` on every call (which we
// used to do) makes React see "new reference" every tick and triggers
// React error #185 (Maximum update depth exceeded). Instead we cache
// the last returned object and only invalidate it when `notify()`
// fires — i.e. when someone actually calls setAgentGroup() or when a
// cross-tab storage event arrives.
const EMPTY: Groups = Object.freeze({}) as Groups;
let cached: Groups = EMPTY;
let cacheLoaded = false;

const listeners = new Set<() => void>();

function loadFromStorage(): Groups {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Groups;
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

function invalidate() {
  cached = loadFromStorage();
  cacheLoaded = true;
  for (const l of listeners) l();
}

function ensureLoaded() {
  if (!cacheLoaded) {
    cached = loadFromStorage();
    cacheLoaded = true;
  }
}

export function setAgentGroup(agentId: string, group: string | null) {
  if (typeof window === 'undefined') return;
  ensureLoaded();
  const next: Groups = { ...cached };
  if (group && group.trim()) {
    next[agentId] = group.trim();
  } else {
    delete next[agentId];
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota exceeded or unavailable — still update in-memory cache so
       consumers see the change within the current session */
  }
  cached = next;
  cacheLoaded = true;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Groups {
  ensureLoaded();
  return cached;
}

function getServerSnapshot(): Groups {
  return EMPTY;
}

export function useAgentGroups(): Groups {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useAgentGroup(agentId: string): string | null {
  const groups = useAgentGroups();
  return groups[agentId] ?? null;
}

// Cross-tab sync: storage event fires when another tab updates the key.
// Mount-once listener lives alongside the hook.
export function useGroupsStorageSync() {
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) invalidate();
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
}

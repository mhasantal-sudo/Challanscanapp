import { handleLocalApiRequest } from './localFallbackApi.ts';

const TOKEN_KEY = 'challan_auth_token';

export function getAuthToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAuthToken(token: string): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage restriction errors
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore
  }
}

const SERVER_URL_KEY = 'challan_server_url';
const ENV_API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

function getApiBase(): string {
  try {
    const custom = localStorage.getItem(SERVER_URL_KEY) || '';
    if (custom.trim()) return custom.trim().replace(/\/+$/, '');
  } catch {
    // ignore
  }
  return ENV_API_BASE;
}

export function isCapacitorRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
  };
  if (w.Capacitor?.isNativePlatform?.()) return true;
  if (window.location.protocol === 'capacitor:' || window.location.protocol === 'file:') {
    return true;
  }
  return (
    window.location.hostname === 'localhost' &&
    window.location.protocol === 'https:' &&
    !window.location.port
  );
}

let remoteApiUnavailableInApk = false;

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const apiBase = getApiBase();
  const isApiRoute = input.startsWith('/api/');
  const inApk = isCapacitorRuntime();

  if (inApk && isApiRoute && (!apiBase || remoteApiUnavailableInApk)) {
    return handleLocalApiRequest(input, { ...init, headers });
  }

  const url = input.startsWith('/') && apiBase ? `${apiBase}${input}` : input;

  try {
    const controller =
      inApk && isApiRoute && !init.signal ? new AbortController() : null;
    const timer = controller
      ? window.setTimeout(() => controller.abort(), 7000)
      : null;

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers,
        signal: init.signal || controller?.signal,
        credentials: apiBase ? 'omit' : 'include',
      });
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }

    if (inApk && isApiRoute) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json') || res.status === 404) {
        remoteApiUnavailableInApk = true;
        return handleLocalApiRequest(input, { ...init, headers });
      }
    }

    if (res.status === 401 && !input.includes('/api/auth/')) {
      clearAuthToken();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('challan-auth-expired'));
      }
    }
    return res;
  } catch (err) {
    if (inApk && isApiRoute) {
      remoteApiUnavailableInApk = true;
      return handleLocalApiRequest(input, { ...init, headers });
    }
    throw err;
  }
}

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';

const AuthContext = createContext();

const TOKEN_KEY = 'pulseroom_token';

// Auth sessions are kept in sessionStorage (per-tab), NOT localStorage
// (shared across every tab of the browser). This lets you run multiple
// accounts at once - one per tab - without one login clobbering another.
const storage = () => (typeof sessionStorage !== 'undefined' ? sessionStorage : localStorage);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => storage().getItem(TOKEN_KEY) || null);
  const [loading, setLoading] = useState(true);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const logout = () => {
    storage().removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY); // cleanup any legacy shared token
    setToken(null);
    setUser(null);
  };

  const fetchProfile = async () => {
    const res = await fetch('/api/users/me', {
      headers: { Authorization: `Bearer ${tokenRef.current}` }
    });
    if (res.ok) {
      const data = await res.json();
      setUser(data);
      return true;
    }
    if (res.status === 401 || res.status === 403) {
      logout();
      return false;
    }
    throw new Error(`Profile fetch failed with status ${res.status}`);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'signup') {
      storage().removeItem(TOKEN_KEY);
      setToken(null);
      setUser(null);
      setLoading(false);
      return;
    }

    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const restoreSession = async () => {
      // After a PC restart the backend may still be booting, so retry a few
      // times on transient network errors instead of giving up and logging out.
      let attempt = 0;
      while (!cancelled) {
        try {
          const restored = await fetchProfile();
          if (restored) return;
          return; // handled by fetchProfile (logout) already
        } catch (e) {
          attempt += 1;
          if (cancelled) return;
          if (attempt >= 5) {
            console.error('Failed to restore session after retries:', e);
            return;
          }
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    };

    restoreSession().finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [token]);

  const login = async (email, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed.');

    if (data.token) {
      storage().setItem(TOKEN_KEY, data.token);
      localStorage.removeItem(TOKEN_KEY); // drop any stale shared token
      setToken(data.token);
      setUser(data.user);
    }
    return data.user;
  };

  const register = async (userData) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed.');
    return data;
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';

const ThemeContext = createContext();

const DEFAULT_THEME = {
  bubbleColorSender: '#6366f1',
  bubbleColorReceiver: '#1e293b',
  chatBarShape: 'floating-pill', // 'floating-pill' | 'sleek-docked' | 'rounded-glass'
  fontFamily: 'Plus Jakarta Sans',
  fontSize: 'medium',
  backgroundWallpaper: 'wallpaper-mesh-dark', // 'wallpaper-mesh-dark' | 'wallpaper-gradient-glow' | 'wallpaper-minimal-slate' | 'wallpaper-cyberpunk'
  sendButtonStyle: 'gradient-circle' // 'gradient-circle' | 'minimal-icon' | 'neon-glow'
};

export function ThemeProvider({ children }) {
  const { user, token } = useAuth();
  const [theme, setTheme] = useState(DEFAULT_THEME);

  // Sync user saved theme when logged in
  useEffect(() => {
    if (user?.theme_preferences) {
      setTheme(prev => ({ ...prev, ...user.theme_preferences }));
    }
  }, [user]);

  // Apply CSS root variables whenever theme state updates
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--bubble-sender', theme.bubbleColorSender);
    root.style.setProperty('--bubble-receiver', theme.bubbleColorReceiver);

    const fontScaleMap = { small: '0.9rem', medium: '1rem', large: '1.1rem' };
    root.style.setProperty('--font-scale', fontScaleMap[theme.fontSize] || '1rem');
  }, [theme]);

  const updateTheme = async (newThemeProps) => {
    const updated = { ...theme, ...newThemeProps };
    setTheme(updated);

    if (token) {
      try {
        await fetch('/api/users/theme', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(updated)
        });
      } catch (err) {
        console.error('Failed to sync theme preferences:', err);
      }
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, updateTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);

import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { MessageSquare, Sparkles, User, Mail, Lock, ArrowLeft, MailCheck, CheckCircle, Zap } from 'lucide-react';

export default function AuthModal() {
  const { login } = useAuth();
  
  // Modes: 'login' | 'register' | 'email-sent' | 'forgot' | 'reset-success'
  const [mode, setMode] = useState('login');
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [avatarSeed, setAvatarSeed] = useState('PulseUser1');
  
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const avatarUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=${avatarSeed}`;

  // 1. Direct Email & Password Login
  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 2. Register Account & Send Resend Email Confirmation Link
  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          email: email.trim(),
          password,
          avatarUrl,
          bio
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create account.');

      setSuccessMsg(`A confirmation link has been sent to ${email}`);
      setMode('email-sent');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 3. Confirm Email Shortcut from Screen
  const handleInstantConfirm = async () => {
    setConfirming(true);
    setError('');
    try {
      const res = await fetch(`/api/auth/confirm-email?email=${encodeURIComponent(email.trim())}`);
      if (!res.ok) throw new Error('Failed to confirm email.');

      // Email confirmed! Log in directly
      await login(email.trim(), password);
    } catch (err) {
      setError(err.message);
      setConfirming(false);
    }
  };

  // 4. Password Reset
  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), newPassword })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reset password.');

      setSuccessMsg(data.message);
      setMode('reset-success');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel" style={{ maxWidth: '440px' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div className="brand-icon" style={{ margin: '0 auto 1rem', width: '52px', height: '52px' }}>
            <MessageSquare size={28} />
          </div>
          <h2 style={{ fontFamily: 'Outfit', fontSize: '1.75rem', fontWeight: '800' }}>
            {mode === 'register' ? 'Create PulseRoom Account' :
             mode === 'email-sent' ? 'Confirm Your Email' :
             mode === 'forgot' ? 'Forgot Password?' :
             mode === 'reset-success' ? 'Password Reset Successful' : 'Welcome Back'}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
            {mode === 'register' ? 'Sign up to receive your Email Confirmation Link' :
             mode === 'email-sent' ? `We sent a confirmation link to ${email}` :
             mode === 'forgot' ? 'Enter your email and new password to reset' :
             mode === 'reset-success' ? 'You can now sign in with your new password' :
             'Sign in with your Email & Password'}
          </p>
        </div>

        {error && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            padding: '0.75rem 1rem',
            borderRadius: '12px',
            fontSize: '0.85rem',
            marginBottom: '1rem',
            textAlign: 'center'
          }}>
            {error}
          </div>
        )}

        {/* 1. LOGIN MODE */}
        {mode === 'login' && (
          <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="search-box" style={{ padding: 0 }}>
              <Mail size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="email"
                placeholder="Email Address"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="search-box" style={{ padding: 0 }}>
              <Lock size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="password"
                placeholder="Password"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <div style={{ textAlign: 'right', marginTop: '-0.25rem' }}>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--primary-accent)', fontSize: '0.8rem', cursor: 'pointer' }}
              >
                Forgot Password?
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="send-btn-gradient-circle"
              style={{ width: '100%', borderRadius: '12px', height: '48px', fontWeight: '700', fontSize: '1rem', marginTop: '0.5rem' }}
            >
              {loading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>
        )}

        {/* 2. REGISTER MODE */}
        {mode === 'register' && (
          <form onSubmit={handleRegisterSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
              <img
                src={avatarUrl}
                alt="Avatar Preview"
                style={{ width: '72px', height: '72px', borderRadius: '20px', background: '#1e293b', border: '2px solid var(--primary-accent)' }}
              />
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setAvatarSeed(Math.random().toString(36).substring(7))}
                >
                  <Sparkles size={12} style={{ display: 'inline', marginRight: '4px' }} /> Randomize Avatar
                </button>
              </div>
            </div>

            <div className="search-box" style={{ padding: 0 }}>
              <User size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="text"
                placeholder="Username"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="search-box" style={{ padding: 0 }}>
              <Mail size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="email"
                placeholder="Email Address"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="search-box" style={{ padding: 0 }}>
              <Lock size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="password"
                placeholder="Password"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <div className="search-box" style={{ padding: 0 }}>
              <input
                type="text"
                placeholder="Bio (e.g. Developer, Available for chat)"
                className="search-input"
                style={{ paddingLeft: '1rem' }}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="send-btn-gradient-circle"
              style={{ width: '100%', borderRadius: '12px', height: '48px', fontWeight: '700', fontSize: '1rem', marginTop: '0.5rem' }}
            >
              {loading ? 'Creating Account...' : 'Create Account & Send Link'}
            </button>
          </form>
        )}

        {/* 3. EMAIL SENT SCREEN (Resend Email Link + Screen Shortcut) */}
        {mode === 'email-sent' && (
          <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
            <div style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'rgba(16, 185, 129, 0.15)',
              border: '2px solid #10b981',
              color: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1rem'
            }}>
              <MailCheck size={32} />
            </div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '700', color: 'white', marginBottom: '0.5rem' }}>
              Confirmation Email Dispatched!
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: '1.5', maxWidth: '360px', margin: '0 auto 1.25rem' }}>
              We dispatched an email via Resend to <strong style={{ color: 'white' }}>{email}</strong>. Open your email inbox and click <strong>Confirm Email Address</strong> to activate your account!
            </p>

            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); }}
              className="send-btn-gradient-circle"
              style={{ width: '100%', borderRadius: '12px', height: '48px', fontWeight: '700', fontSize: '1rem', marginTop: '0.5rem' }}
            >
              Go to Sign In
            </button>
          </div>
        )}

        {/* 4. FORGOT PASSWORD MODE */}
        {mode === 'forgot' && (
          <form onSubmit={handleForgotSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="search-box" style={{ padding: 0 }}>
              <Mail size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="email"
                placeholder="Registered Email Address"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="search-box" style={{ padding: 0 }}>
              <Lock size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="password"
                placeholder="New Password"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="send-btn-gradient-circle"
              style={{ width: '100%', borderRadius: '12px', height: '48px', fontWeight: '700', fontSize: '1rem', marginTop: '0.5rem' }}
            >
              {loading ? 'Resetting Password...' : 'Reset Password'}
            </button>
          </form>
        )}

        {/* 5. RESET SUCCESS SCREEN */}
        {mode === 'reset-success' && (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <div style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'rgba(16, 185, 129, 0.15)',
              border: '2px solid #10b981',
              color: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.25rem'
            }}>
              <CheckCircle size={32} />
            </div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: '700', color: 'white', marginBottom: '0.5rem' }}>
              Password Reset!
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: '1.5', maxWidth: '340px', margin: '0 auto 1.5rem' }}>
              {successMsg || 'Your password has been updated successfully.'}
            </p>

            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); }}
              className="send-btn-gradient-circle"
              style={{ width: '100%', borderRadius: '12px', height: '48px', fontWeight: '700', fontSize: '1rem' }}
            >
              Return to Sign In
            </button>
          </div>
        )}

        {/* Footer Navigation */}
        <div style={{ textAlign: 'center', marginTop: '1.25rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
          {mode === 'login' ? (
            <>Don't have an account?{' '}
              <button
                type="button"
                onClick={() => { setMode('register'); setError(''); setSuccessMsg(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--primary-accent)', fontWeight: '700', cursor: 'pointer' }}
              >
                Sign Up
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); setSuccessMsg(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--primary-accent)', fontWeight: '700', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
            >
              <ArrowLeft size={14} /> Back to Sign In
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

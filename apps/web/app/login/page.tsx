'use client';

import { useState } from 'react';
import { api, ApiError } from '../../lib/api';

interface Me {
  mfa: { required: boolean; enrolled: boolean; verified: boolean };
}

export default function Login() {
  const [tenantId, setTenantId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'credentials' | 'enrol' | 'code'>('credentials');
  const [secret, setSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [error, setError] = useState('');

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'Something went wrong');
  const done = () => {
    window.location.href = '/';
  };

  async function signIn() {
    setError('');
    try {
      const r = await api<Me>('POST', '/auth/sign-in', { tenantId, email, password });
      if (!r.mfa.required || r.mfa.verified) return done();
      if (r.mfa.enrolled) setStep('code');
      else {
        setSecret(await api('POST', '/auth/totp/enroll'));
        setStep('enrol');
      }
    } catch (e) {
      fail(e);
    }
  }
  async function verify() {
    setError('');
    try {
      await api('POST', '/auth/totp/verify', { code });
      done();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <main style={{ maxWidth: '24rem' }}>
      <h1>Sign in</h1>
      {step === 'credentials' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void signIn();
          }}
          style={{ display: 'grid', gap: '0.75rem' }}
        >
          <label>
            Tenant id{' '}
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              required
              style={{ width: '100%' }}
            />
          </label>
          <label>
            Email{' '}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: '100%' }}
            />
          </label>
          <label>
            Password{' '}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: '100%' }}
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
      )}
      {step !== 'credentials' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          style={{ display: 'grid', gap: '0.75rem' }}
        >
          {step === 'enrol' && secret && (
            <p>
              Add this key to your authenticator app, then enter the 6-digit code:{' '}
              <code>{secret.secret}</code>
              <br />
              <a href={secret.otpauthUri}>Open in an authenticator app</a>
            </p>
          )}
          <label>
            6-digit code{' '}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              pattern="\d{6}"
              required
            />
          </label>
          <button type="submit">Verify</button>
        </form>
      )}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </main>
  );
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { AuthProvider } from '@/modules/auth/context/AuthContext';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

type StubbedReply = { status: number; body: unknown };

// The ceremony routes hand every failure to the global error middleware, which
// answers with the structured AppError envelope.
const envelope = (code: string, message: string) => ({ success: false, error: { code, message } });

// `api.auth.*` calls the global fetch directly, so stubbing it drives the
// real AuthProvider without any module mocks.
function stubAuthApi(replies: Record<string, StubbedReply>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const reply = replies[url] ?? { status: 404, body: { error: 'Not found' } };
      return new Response(
        typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
        { status: reply.status, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

// WebAuthn support is detected by the presence of PublicKeyCredential.
const supportPasskeys = () => vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});

async function signIn() {
  render(
    <AuthProvider>
      <LoginForm />
    </AuthProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with passkey' }));
}

async function submitSetup(token: string) {
  render(
    <AuthProvider>
      <SetupForm />
    </AuthProvider>,
  );
  fireEvent.change(await screen.findByLabelText('Setup token'), { target: { value: token } });
  fireEvent.click(screen.getByRole('button', { name: 'Create passkey' }));
}

describe('auth screens surface server errors as text', () => {
  beforeEach(() => {
    localStorage.clear();
    supportPasskeys();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the message of the structured envelope when sign-in cannot start, and keeps the screen', async () => {
    stubAuthApi({
      '/api/auth/status': { status: 200, body: { needsSetup: false, isAuthenticated: false } },
      '/api/auth/login/options': {
        status: 429,
        body: envelope('AUTH_RATE_LIMITED', 'Too many attempts. Try again later.'),
      },
    });

    await signIn();

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Too many attempts. Try again later.');
    expect(screen.getByRole('button', { name: 'Sign in with passkey' })).toBeTruthy();
  });

  it('shows the message of the structured envelope when the setup token is rejected', async () => {
    stubAuthApi({
      '/api/auth/status': { status: 200, body: { needsSetup: true, isAuthenticated: false } },
      '/api/auth/register/options': {
        status: 401,
        body: envelope('AUTH_BOOTSTRAP_INVALID', 'A valid, unexpired bootstrap token is required.'),
      },
    });

    await submitSetup('not-the-real-token');

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'A valid, unexpired bootstrap token is required.',
    );
    expect(document.querySelectorAll('form')).toHaveLength(1);
  });

  it('asks for the setup token before contacting the server', async () => {
    stubAuthApi({ '/api/auth/status': { status: 200, body: { needsSetup: true, isAuthenticated: false } } });

    await submitSetup('   ');

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Enter the setup token printed on the server console.',
    );
  });

  it('falls back to the localized message when the envelope carries no usable message', async () => {
    stubAuthApi({
      '/api/auth/status': { status: 200, body: { needsSetup: false, isAuthenticated: false } },
      '/api/auth/login/options': { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: '  ' } } },
    });

    await signIn();

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Login failed');
  });

  it('falls back to the localized message when the body is not JSON', async () => {
    stubAuthApi({
      '/api/auth/status': { status: 200, body: { needsSetup: false, isAuthenticated: false } },
      '/api/auth/login/options': { status: 502, body: '<html>Bad Gateway</html>' },
    });

    await signIn();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Login failed');
    });
  });

  it('tells the user when the browser has no passkey support', async () => {
    vi.unstubAllGlobals();
    stubAuthApi({ '/api/auth/status': { status: 200, body: { needsSetup: false, isAuthenticated: false } } });

    await signIn();

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This browser does not support passkeys.');
  });
});

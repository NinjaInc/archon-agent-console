import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Fingerprint, Loader2 } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

/**
 * Passkey sign-in screen.
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 * There is no username or password: the browser offers the discoverable passkey.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { error: sessionError, loginWithPasskey } = useAuth();

  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignIn = useCallback(async () => {
    setErrorMessage('');
    setIsSubmitting(true);
    const result = await loginWithPasskey();
    if (!result.success) {
      setErrorMessage(result.error);
    }
    setIsSubmitting(false);
  }, [loginWithPasskey]);

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description')}
      footerText={t('login.footerText')}
    >
      <div className="space-y-4">
        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="button"
          onClick={handleSignIn}
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 font-medium text-primary-foreground shadow-[0_8px_30px_-10px_hsl(var(--primary))] transition-all duration-200 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('login.passkeyLoading')}
            </>
          ) : (
            <>
              <Fingerprint className="h-5 w-5" />
              {t('login.passkeySubmit')}
            </>
          )}
        </button>
      </div>
    </AuthScreenLayout>
  );
}

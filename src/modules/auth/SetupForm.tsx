import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Tag } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

/**
 * First-run setup screen.
 * Rendered by the auth module's ProtectedRoute while no passkey exists. Registering
 * the first passkey requires the one-time token the server prints on its console.
 */
export default function SetupForm() {
  const { t } = useTranslation('auth');
  const { setupWithPasskey } = useAuth();

  const [bootstrapToken, setBootstrapToken] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      if (!bootstrapToken.trim()) {
        setErrorMessage(t('register.errors.tokenRequired'));
        return;
      }

      setIsSubmitting(true);
      const result = await setupWithPasskey(bootstrapToken, passkeyName);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [bootstrapToken, passkeyName, setupWithPasskey, t],
  );

  return (
    <AuthScreenLayout
      title={t('register.title')}
      description={t('register.description')}
      footerText={t('register.footerText')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="bootstrap-token"
          label={t('register.bootstrapToken')}
          value={bootstrapToken}
          onChange={setBootstrapToken}
          placeholder={t('register.bootstrapTokenPlaceholder')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="off"
          icon={KeyRound}
        />
        <p className="text-xs text-muted-foreground">{t('register.bootstrapHint')}</p>

        <AuthInputField
          id="passkey-name"
          isRequired={false}
          label={t('register.passkeyName')}
          value={passkeyName}
          onChange={setPasskeyName}
          placeholder={t('register.passkeyNamePlaceholder')}
          isDisabled={isSubmitting}
          autoComplete="off"
          icon={Tag}
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 font-medium text-primary-foreground shadow-[0_8px_30px_-10px_hsl(var(--primary))] transition-all duration-200 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('register.passkeyLoading')}
            </>
          ) : (
            t('register.passkeySubmit')
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}

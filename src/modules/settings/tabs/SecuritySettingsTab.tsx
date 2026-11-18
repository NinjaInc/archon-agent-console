import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startRegistration } from '@simplewebauthn/browser';
import { Fingerprint, Loader2, LogOut, Trash2 } from 'lucide-react';

import { api, readApiErrorMessage } from '@/shared/api';
import { expireAuthSession } from '@/shared/authToken';
import SettingsCard from '@/modules/settings/SettingsCard';

type PasskeySummary = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  deviceType: string | null;
  backedUp: boolean;
  isCurrent: boolean;
};

const formatTime = (timestamp: number | null) => (timestamp ? new Date(timestamp).toLocaleString() : '-');

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Rendered by Settings for the "security" tab: lists, adds and revokes the passkeys that protect this console. */
export default function SecuritySettingsTab() {
  const { t } = useTranslation('settings');
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [name, setName] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const load = useCallback(async () => {
    const response = await api.auth.listPasskeys();
    const payload = await readJson<{ passkeys?: PasskeySummary[] }>(response);
    setPasskeys(payload?.passkeys ?? []);
  }, []);

  useEffect(() => {
    void load().catch(() => setMessage({ kind: 'error', text: t('security.loadFailed', { defaultValue: 'Could not load passkeys.' }) }));
  }, [load, t]);

  const addPasskey = useCallback(async () => {
    setIsBusy(true);
    setMessage(null);
    try {
      const optionsResponse = await api.auth.registerOptions();
      const begin = await readJson<{ challengeId?: string; options?: unknown }>(optionsResponse);
      if (!optionsResponse.ok || !begin?.challengeId || !begin.options) {
        throw new Error(readApiErrorMessage(begin) ?? 'Could not start passkey registration.');
      }
      const attestation = await startRegistration({
        optionsJSON: begin.options as Parameters<typeof startRegistration>[0]['optionsJSON'],
      });
      const verifyResponse = await api.auth.registerVerify({
        challengeId: begin.challengeId,
        response: attestation,
        name: name.trim() || undefined,
      });
      if (!verifyResponse.ok) {
        throw new Error(readApiErrorMessage(await readJson(verifyResponse)) ?? 'Passkey registration failed.');
      }
      setName('');
      setMessage({ kind: 'ok', text: t('security.added', { defaultValue: 'Passkey added.' }) });
      await load();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsBusy(false);
    }
  }, [load, name, t]);

  const revoke = useCallback(async (passkey: PasskeySummary) => {
    const confirmed = window.confirm(
      t('security.confirmRevoke', {
        defaultValue: 'Revoke "{{name}}"? Sessions it created are signed out immediately.',
        name: passkey.name,
      }),
    );
    if (!confirmed) {
      return;
    }
    setIsBusy(true);
    setMessage(null);
    try {
      const response = await api.auth.revokePasskey(passkey.id);
      const payload = await readJson<{ revokedCurrentSession?: boolean }>(response);
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload) ?? 'Could not revoke the passkey.');
      }
      if (payload?.revokedCurrentSession) {
        expireAuthSession();
        return;
      }
      await load();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsBusy(false);
    }
  }, [load, t]);

  const signOutEverywhere = useCallback(async () => {
    setIsBusy(true);
    try {
      await api.auth.revokeAllSessions();
    } finally {
      setIsBusy(false);
      expireAuthSession();
    }
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{t('security.title', { defaultValue: 'Passkeys' })}</h3>
        <p className="text-sm text-muted-foreground">
          {t('security.description', {
            defaultValue: 'Passkeys are the only way to sign in. Keep at least two registered; if you lose all of them, run `npm run passkey:reset` on the server.',
          })}
        </p>
      </div>

      <SettingsCard divided>
        {passkeys.map((passkey) => (
          <div key={passkey.id} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Fingerprint className="h-4 w-4 text-primary" />
                <span className="truncate">{passkey.name}</span>
                {passkey.isCurrent && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                    {t('security.current', { defaultValue: 'This session' })}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t('security.created', { defaultValue: 'Added' })} {formatTime(passkey.createdAt)} ·{' '}
                {t('security.lastUsed', { defaultValue: 'Last used' })} {formatTime(passkey.lastUsedAt)}
                {passkey.backedUp ? ` · ${t('security.synced', { defaultValue: 'synced' })}` : ''}
              </div>
            </div>
            <button
              type="button"
              disabled={isBusy || passkeys.length <= 1}
              onClick={() => void revoke(passkey)}
              title={passkeys.length <= 1 ? t('security.lastPasskey', { defaultValue: 'Add another passkey before removing the last one.' }) : undefined}
              className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {t('security.revoke', { defaultValue: 'Revoke' })}
            </button>
          </div>
        ))}
      </SettingsCard>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('security.namePlaceholder', { defaultValue: 'Name (e.g. YubiKey)' })}
          maxLength={64}
          className="rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void addPasskey()}
          className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-[0_8px_30px_-10px_hsl(var(--primary))] disabled:opacity-60"
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          {t('security.add', { defaultValue: 'Add passkey' })}
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void signOutEverywhere()}
          className="ml-auto flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-foreground hover:bg-accent disabled:opacity-60"
        >
          <LogOut className="h-4 w-4" />
          {t('security.signOutEverywhere', { defaultValue: 'Sign out everywhere' })}
        </button>
      </div>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-primary'}>
          {message.text}
        </p>
      )}
    </div>
  );
}

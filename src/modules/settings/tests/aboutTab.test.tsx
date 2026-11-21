import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import AboutTab from '@/modules/settings/tabs/AboutTab';

vi.mock('@/shared/hooks/useVersionCheck', () => ({ useVersionCheck: () => ({ currentVersion: '1.2.3' }) }));

test('About shows the banner, the version, and what the console does, including the Local LLM', () => {
  render(<AboutTab />);

  assert.ok(screen.getByAltText('Archon Agent Console by Archon Tech'));
  assert.ok(screen.getByText('v1.2.3'));
  for (const title of ['Passkey sign-in', 'Claude Chat', 'Agy Chat', 'Local LLM', 'Terminals', 'Repos and worktrees', 'Skills', 'Phone alerts']) {
    assert.ok(screen.getByText(title), title);
  }
  assert.ok(screen.getByText(/no tools, nothing written or run/i));
});

test('About links to this project, the upstream and Archon Tech, and shows the screenshot strip', () => {
  render(<AboutTab />);

  const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
  assert.ok(hrefs.includes('https://github.com/NinjaInc/archon-agent-console'));
  assert.ok(hrefs.includes('https://github.com/siteboon/claudecodeui'));
  assert.ok(hrefs.includes('https://archontech.au'));
  assert.equal(screen.getAllByRole('img').filter((image) => image.getAttribute('src')?.startsWith('/about/')).length, 3);
});

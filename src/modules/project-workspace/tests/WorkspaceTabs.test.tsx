import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { useImagesStatus } from '@/modules/images';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import type * as ApiModule from '@/shared/api';
import type { AppTab } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return {
    ...original,
    api: {
      ...original.api,
      images: {
        ...original.api.images,
        status: mocks.status,
      },
    },
  };
});

function ImagesTabHarness() {
  // Tracks which workspace tab the user clicked inside the test tab strip.
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  const images = useImagesStatus();

  return (
    <I18nextProvider i18n={i18n}>
      <WorkspaceTabs
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        shouldShowBrowserTab={false}
        shouldShowProdTab={false}
        shouldShowImagesTab={images.configured}
        imagesOnline={images.online}
      />
      <div data-testid="active-tab">{activeTab}</div>
    </I18nextProvider>
  );
}

beforeEach(() => {
  mocks.status.mockReset();
});

test('hides the Images tab when /api/images/status says ComfyUI is not configured', async () => {
  mocks.status.mockResolvedValue(
    Response.json({ configured: false, online: false, state: 'idle', leases: [] }),
  );

  render(<ImagesTabHarness />);

  await waitFor(() => {
    assert.equal(mocks.status.mock.calls.length, 1);
  });
  assert.equal(screen.queryByRole('tab', { name: 'Images' }), null);
});

test('shows the Images tab when configured and switches activeTab to images on click', async () => {
  mocks.status.mockResolvedValue(
    Response.json({ configured: true, online: true, state: 'idle', leases: [] }),
  );

  render(<ImagesTabHarness />);

  const imagesTab = await screen.findByRole('tab', { name: 'Images' });
  assert.ok(screen.getByRole('img', { name: 'Images online' }));

  fireEvent.click(imagesTab);
  assert.equal(screen.getByTestId('active-tab').textContent, 'images');
});

test('places the Pair tab directly after Claude Chat and Agy Chat and activates pair on click', async () => {
  mocks.status.mockResolvedValue(
    Response.json({ configured: false, online: false, state: 'idle', leases: [] }),
  );

  render(<ImagesTabHarness />);

  const tabs = await screen.findAllByRole('tab');
  const labels = tabs.map((tab) => tab.getAttribute('aria-label'));
  assert.deepEqual(labels.slice(0, 3), ['Claude Chat', 'Agy Chat', 'Pair']);

  fireEvent.click(screen.getByRole('tab', { name: 'Pair' }));
  assert.equal(screen.getByTestId('active-tab').textContent, 'pair');
});

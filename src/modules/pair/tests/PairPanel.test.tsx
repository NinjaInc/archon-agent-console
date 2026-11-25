import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import PairPanel from '@/modules/pair/PairPanel';
import type * as ApiModule from '@/shared/api';
import type { PairRun, PairRunSummary, Project } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  planUsage: vi.fn(),
  models: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  approvePlan: vi.fn(),
  approveDiff: vi.fn(),
  keep: vi.fn(),
  discard: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return {
    ...original,
    api: {
      ...original.api,
      planUsage: mocks.planUsage,
      agyChat: {
        ...original.api.agyChat,
        models: mocks.models,
      },
      pair: {
        list: mocks.list,
        start: mocks.start,
        get: mocks.get,
        approvePlan: mocks.approvePlan,
        approveDiff: mocks.approveDiff,
        keep: mocks.keep,
        discard: mocks.discard,
        stop: mocks.stop,
      },
    },
  };
});

const projectOne = {
  projectId: 'p1',
  displayName: 'Alpha',
  fullPath: '/work/alpha',
} as unknown as Project;

const projectTwo = {
  projectId: 'p2',
  displayName: 'Beta',
  fullPath: '/work/beta',
} as unknown as Project;

const ok = (body: object) => Response.json(body);
const fail = (code: string, message: string, status = 409) =>
  Response.json({ success: false, error: { code, message } }, { status });

function makeRun(overrides: Partial<PairRun> = {}): PairRun {
  return {
    id: 'aabbccddeeff',
    projectId: 'p1',
    task: 'Add rate limiting',
    model: 'gemini-4-carbon-medium',
    status: 'planning',
    createdAt: '2026-11-25T10:00:00.000Z',
    round: 0,
    testCommand: ['npm', 'test'],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<PairRunSummary> = {}): PairRunSummary {
  return {
    id: 'aabbccddeeff',
    title: 'Add rate limiting',
    status: 'plan-ready',
    createdAt: '2026-11-25T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  for (const mockFn of Object.values(mocks)) {
    mockFn.mockReset();
  }
  // A Response body can be read only once, so every call (each project switch asks again) gets a new one.
  mocks.planUsage.mockImplementation(async () => ok({ limits: [] }));
  mocks.models.mockImplementation(async () => ok({ models: ['gemini-4-flash', 'gemini-4-carbon-medium', 'gemini-4-pro'] }));
  mocks.list.mockImplementation(async () => ok({ runs: [] }));
});

test('start flow defaults model to carbon-medium, disables buttons in flight, shows Stop, and polls until plan-ready', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let resolveStart!: (value: Response) => void;
    mocks.start.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveStart = resolve;
      }),
    );
    mocks.get.mockResolvedValueOnce(
      ok({
        run: makeRun({
          status: 'plan-ready',
          plan: '1. Edit rate.ts\n<b>literal tag</b>',
        }),
      }),
    );

    render(<PairPanel selectedProject={projectOne} />);

    const modelSelect = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => {
      assert.equal(modelSelect.value, 'gemini-4-carbon-medium');
    });

    for (const stepLabel of ['Plan', 'Edit', 'Approve change', 'Test', 'Review', 'Done']) {
      assert.ok(screen.getByText(stepLabel));
    }

    fireEvent.change(screen.getByLabelText('Task'), {
      target: { value: '  Add rate limiting  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      assert.equal(
        (screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled,
        true,
      );
      assert.equal(
        (screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement).disabled,
        true,
      );
    });

    resolveStart(ok({ run: makeRun({ status: 'planning' }) }));

    const stopButton = await screen.findByRole('button', { name: 'Stop' });
    assert.ok(stopButton);
    assert.deepEqual(mocks.start.mock.calls[0], [
      {
        projectId: 'p1',
        task: 'Add rate limiting',
        model: 'gemini-4-carbon-medium',
      },
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    assert.deepEqual(mocks.get.mock.calls[0], ['aabbccddeeff']);
    await screen.findByRole('button', { name: 'Approve plan' });
    assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);
    assert.ok(screen.getByText(/<b>literal tag<\/b>/));
  } finally {
    vi.useRealTimers();
  }
});

test('approve plan sends POST /:id/approve-plan and transitions run to executing', async () => {
  mocks.list.mockResolvedValue(ok({ runs: [makeSummary({ status: 'plan-ready' })] }));
  mocks.get.mockResolvedValue(
    ok({
      run: makeRun({
        status: 'plan-ready',
        plan: 'Update middleware and add tests.',
      }),
    }),
  );
  mocks.approvePlan.mockResolvedValue(
    ok({
      run: makeRun({
        status: 'executing',
        plan: 'Update middleware and add tests.',
      }),
    }),
  );

  render(<PairPanel selectedProject={projectOne} />);

  await screen.findByText('Update middleware and add tests.');
  assert.ok(screen.getByRole('button', { name: 'Discard' }));

  fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));

  await screen.findByRole('button', { name: 'Stop' });
  assert.deepEqual(mocks.approvePlan.mock.calls[0], ['aabbccddeeff']);
});

test('diff-ready displays warnings, files, coloured diff lines, sends diff.hash, and reloads after PAIR_DIFF_CHANGED', async () => {
  const initialDiffRun = makeRun({
    status: 'diff-ready',
    round: 1,
    testCommand: ['npm', 'test'],
    diff: {
      hash: 'hash-old-111',
      files: ['src/rate.ts', 'links/current'],
      hasSymlinks: true,
      text: [
        'diff --git a/src/rate.ts b/src/rate.ts',
        '--- a/src/rate.ts',
        '+++ b/src/rate.ts',
        '@@ -1,2 +1,2 @@',
        '-const max = 100;',
        '+const max = 20;',
        ' export default max;',
      ].join('\n'),
    },
  });

  const reloadedDiffRun = makeRun({
    status: 'diff-ready',
    round: 1,
    testCommand: null,
    diff: {
      hash: 'hash-new-222',
      files: ['src/rate.ts'],
      hasSymlinks: false,
      text: '+const max = 10;\n',
    },
  });

  mocks.list.mockResolvedValue(ok({ runs: [makeSummary({ status: 'diff-ready' })] }));
  mocks.get
    .mockResolvedValueOnce(ok({ run: initialDiffRun }))
    .mockResolvedValueOnce(ok({ run: reloadedDiffRun }));
  mocks.approveDiff
    .mockResolvedValueOnce(
      fail('PAIR_DIFF_CHANGED', 'The change is not the one you looked at. Review the new version.'),
    )
    .mockResolvedValueOnce(ok({ run: makeRun({ status: 'testing' }) }));

  render(<PairPanel selectedProject={projectOne} />);

  await screen.findByText('Approving runs this code on the server as your user');
  assert.ok(screen.getByText('Round 2 (fix 1)'));
  assert.ok(screen.getByText('src/rate.ts'));
  assert.ok(screen.getByText('links/current'));
  assert.ok(screen.getByText('npm test'));
  assert.ok(screen.getByText(/Symbolic links detected/i));

  const addedLine = screen.getByText('+const max = 20;');
  const removedLine = screen.getByText('-const max = 100;');
  assert.equal(addedLine.getAttribute('data-diff-line'), 'added');
  assert.equal(removedLine.getAttribute('data-diff-line'), 'removed');

  fireEvent.click(screen.getByRole('button', { name: 'Approve and run tests' }));

  await screen.findByText('The change is not the one you looked at. Review the new version.');
  assert.deepEqual(mocks.approveDiff.mock.calls[0], ['aabbccddeeff', 'hash-old-111']);

  await screen.findByText('No tests found');
  assert.equal(mocks.get.mock.calls.length, 2);
  assert.equal(screen.queryByText(/Symbolic links detected/i), null);

  fireEvent.click(screen.getByRole('button', { name: 'Approve and run tests' }));

  await screen.findByRole('button', { name: 'Stop' });
  assert.deepEqual(mocks.approveDiff.mock.calls[1], ['aabbccddeeff', 'hash-new-222']);
});

test('done shows verdict badge, review text, collapsible test output, and keeps on branch', async () => {
  mocks.list.mockResolvedValue(
    ok({ runs: [makeSummary({ status: 'done', verdict: 'ready' })] }),
  );
  mocks.get.mockResolvedValue(
    ok({
      run: makeRun({
        status: 'done',
        verdict: 'ready',
        review: 'Clean implementation with full coverage.\nVERDICT: READY',
        tests: {
          passed: true,
          output: 'PASS src/rate.test.ts (4 tests)',
        },
        diff: {
          hash: 'hash-done',
          files: ['src/rate.ts'],
          hasSymlinks: false,
          text: '+export const rateLimit = 20;\n',
        },
      }),
    }),
  );
  mocks.keep.mockResolvedValue(
    ok({
      run: makeRun({
        status: 'kept',
        verdict: 'ready',
        branch: 'pair/aabbccddeeff',
      }),
    }),
  );

  render(<PairPanel selectedProject={projectOne} />);

  await screen.findByText('ready');
  assert.ok(screen.getByText(/Clean implementation with full coverage/));
  assert.ok(screen.getByText('Tests passed'));
  assert.ok(screen.getByText('PASS src/rate.test.ts (4 tests)'));
  assert.ok(screen.getByText('+export const rateLimit = 20;'));

  fireEvent.click(screen.getByRole('button', { name: 'Keep on branch' }));

  await screen.findByText('Nothing was merged or pushed');
  assert.ok(screen.getByText('pair/aabbccddeeff'));
  assert.deepEqual(mocks.keep.mock.calls[0], ['aabbccddeeff']);
});

test('displays API errors, renders failed run notes with Discard, and resets state across project switch while ignoring stale responses', async () => {
  mocks.start.mockResolvedValueOnce(
    fail('PAIR_SECRETS_REFUSED', 'Not started: the task looks like it contains an API key.', 422),
  );

  const { rerender } = render(<PairPanel selectedProject={projectOne} />);

  await screen.findByLabelText('Model');
  await waitFor(() => {
    assert.equal((screen.getByLabelText('Model') as HTMLSelectElement).value, 'gemini-4-carbon-medium');
  });

  fireEvent.change(screen.getByLabelText('Task'), {
    target: { value: 'Use key sk-secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));

  await screen.findByText('Not started: the task looks like it contains an API key.');

  // Simulate opening a slow run on projectOne, then switching to projectTwo before it settles.
  let resolveStaleList!: (value: Response) => void;
  mocks.list
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveStaleList = resolve;
      }),
    );

  rerender(<PairPanel selectedProject={projectTwo} />);

  // Project switch immediately clears projectOne's error and task draft.
  assert.equal(
    screen.queryByText('Not started: the task looks like it contains an API key.'),
    null,
  );
  assert.equal((screen.getByLabelText('Task') as HTMLTextAreaElement).value, '');

  // Now test switching to a third project when projectTwo's list resolves AFTER unmount.
  const projectThree = {
    projectId: 'p3',
    displayName: 'Gamma',
    fullPath: '/work/gamma',
  } as unknown as Project;

  const failedRun = makeRun({
    id: '112233445566',
    projectId: 'p3',
    status: 'failed',
    error: 'Antigravity changed no files. Its notes may say why.',
    agentNotes: 'Blocked because target directory did not exist.',
  });

  mocks.list.mockResolvedValueOnce(
    ok({ runs: [makeSummary({ id: '112233445566', title: 'Gamma task', status: 'failed' })] }),
  );
  mocks.get.mockResolvedValueOnce(ok({ run: failedRun }));
  mocks.discard.mockResolvedValueOnce(
    ok({ run: { ...failedRun, status: 'discarded' } }),
  );

  rerender(<PairPanel selectedProject={projectThree} />);

  // Resolving projectTwo's stale list with a completely different run must be ignored.
  resolveStaleList(
    ok({ runs: [makeSummary({ id: '999999999999', title: 'Stale beta run', status: 'done' })] }),
  );

  await screen.findByText('Antigravity changed no files. Its notes may say why.');
  assert.ok(screen.getByText('Blocked because target directory did not exist.'));
  assert.equal(screen.queryByText(/Stale beta run/), null);

  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

  await screen.findByText('This run was discarded.');
  assert.deepEqual(mocks.discard.mock.calls[0], ['112233445566']);
});

test('falls back to first model without carbon-medium, skips polling while hidden, calls stop, and formats needs-work verdict', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    mocks.models.mockResolvedValueOnce(ok({ models: ['gemini-4-flash', 'gemini-4-pro'] }));
    mocks.start.mockResolvedValueOnce(
      ok({ run: makeRun({ model: 'gemini-4-flash', status: 'reviewing' }) }),
    );
    mocks.stop.mockResolvedValueOnce(
      ok({ run: makeRun({ status: 'done', verdict: 'needs-work', review: 'Fix edge case.' }) }),
    );

    render(<PairPanel selectedProject={projectOne} />);

    const modelSelect = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => {
      assert.equal(modelSelect.value, 'gemini-4-flash');
    });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Check edge cases' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    const stopBtn = await screen.findByRole('button', { name: 'Stop' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    assert.equal(mocks.get.mock.calls.length, 0);

    fireEvent.click(stopBtn);

    await screen.findByText('needs work');
    assert.deepEqual(mocks.stop.mock.calls[0], ['aabbccddeeff']);
  } finally {
    if (originalVisibility) {
      Object.defineProperty(document, 'visibilityState', originalVisibility);
    } else {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    vi.useRealTimers();
  }
});

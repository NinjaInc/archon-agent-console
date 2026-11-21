import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createSkillsImportService } from '../skills-import.service.js';

const SKILL = `---
name: code-review
description: Reviews a diff for bugs and style.
---

# Code review

Do the thing.
`;

function setup(options: { symlinks?: string[] } = {}) {
  const files = new Map<string, Buffer>();
  const removed: string[] = [];
  const links = new Set(options.symlinks ?? []);
  const service = createSkillsImportService({
    homeDir: '/home/u',
    resolveProjectDir: async (id) => (id === 'p1' ? '/work/app' : null),
    fileSystem: {
      exists: async (p) => files.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`)),
      readFile: async (p) => files.get(p)?.toString('utf8') ?? null,
      writeFile: async (p, data, o) => {
        if (o.exclusive && files.has(p)) throw new Error('EEXIST');
        files.set(p, data);
      },
      listDirectories: async (dir) => [...new Set([...files.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1).split('/')[0]))],
      removeDirectory: async (d) => { removed.push(d); for (const f of [...files.keys()]) if (f.startsWith(`${d}/`)) files.delete(f); },
      isSymlink: async (p) => (links.has(p) ? true : [...files.keys()].some((f) => f === p || f.startsWith(`${p}/`)) ? false : null),
    },
  });
  return { service, files, removed };
}

const text = (files: Map<string, Buffer>, p: string) => files.get(p)?.toString('utf8');

test('imports a single SKILL.md for both agents at user scope', async () => {
  const { service, files } = setup();
  const result = await service.importSkill({ content: SKILL, targets: ['claude', 'agy'], scope: 'user' });
  assert.equal(result.name, 'code-review');
  assert.equal(text(files, '/home/u/.claude/skills/code-review/SKILL.md'), SKILL);
  assert.equal(text(files, '/home/u/.gemini/config/skills/code-review/SKILL.md'), SKILL);
});

test('imports a bundle with extra files, unwrapping a folder named after the skill', async () => {
  const { service, files } = setup();
  const result = await service.importSkill({
    files: [
      { path: 'code-review/SKILL.md', content: SKILL },
      { path: 'code-review/docs/checklist.md', content: '# list' },
      { path: 'code-review/assets/logo.png', content: Buffer.from([137, 80, 78, 71]).toString('base64'), encoding: 'base64' },
    ],
    targets: ['claude'], scope: 'user',
  });
  assert.equal(result.files, 3);
  assert.equal(text(files, '/home/u/.claude/skills/code-review/docs/checklist.md'), '# list');
  assert.deepEqual([...files.get('/home/u/.claude/skills/code-review/assets/logo.png')!], [137, 80, 78, 71]);
});

test('project scope writes under the project, never elsewhere', async () => {
  const { service, files } = setup();
  await service.importSkill({ content: SKILL, targets: ['claude', 'agy'], scope: 'project', projectId: 'p1' });
  assert.deepEqual([...files.keys()].sort(), ['/work/app/.agents/skills/code-review/SKILL.md', '/work/app/.claude/skills/code-review/SKILL.md']);
});

test('an existing skill is refused unless overwrite is set; a conflict writes nothing; overwrite replaces the whole folder', async () => {
  const { service, files, removed } = setup();
  files.set('/home/u/.gemini/config/skills/code-review/SKILL.md', Buffer.from('old'));
  files.set('/home/u/.gemini/config/skills/code-review/stale.md', Buffer.from('stale'));
  await assert.rejects(service.importSkill({ content: SKILL, targets: ['claude', 'agy'], scope: 'user' }), { code: 'SKILLS_EXISTS' });
  assert.equal(files.has('/home/u/.claude/skills/code-review/SKILL.md'), false);
  await service.importSkill({ content: SKILL, targets: ['claude', 'agy'], scope: 'user', overwrite: true });
  assert.equal(text(files, '/home/u/.gemini/config/skills/code-review/SKILL.md'), SKILL);
  assert.equal(files.has('/home/u/.gemini/config/skills/code-review/stale.md'), false, 'files the new version lacks do not linger');
  assert.deepEqual(removed, ['/home/u/.gemini/config/skills/code-review']);
});

test('rejects bad skills: empty, no description, bad or traversal names, oversized, bad YAML, no SKILL.md', async () => {
  const { service, files } = setup();
  const bad: unknown[] = [
    '', '   ', 'no frontmatter at all',
    '---\nname: x\n---\nbody',
    '---\ndescription: d\n---\nbody',
    ...['../evil', 'Evil', 'a/b', '..', '.hidden', 'x'.repeat(65), 'has space', 'a\\b'].map((n) => `---\nname: ${JSON.stringify(n)}\ndescription: d\n---\nbody`),
    `---\nname: big\ndescription: d\n---\n${'x'.repeat(256 * 1024)}`,
    '---\nname: [unclosed\ndescription: d\n---\nbody',
  ];
  for (const content of bad) {
    await assert.rejects(service.importSkill({ content, targets: ['claude'], scope: 'user' }), (e: { statusCode?: number }) => e.statusCode === 400, String(content).slice(0, 40));
  }
  await assert.rejects(service.importSkill({ files: [{ path: 'README.md', content: 'x' }], targets: ['claude'], scope: 'user' }), { code: 'SKILLS_NO_SKILL_MD' });
  assert.equal(files.size, 0);
});

test('bundle paths and types are locked down', async () => {
  const { service, files } = setup();
  const skill = { path: 'SKILL.md', content: SKILL };
  const rejected = async (extra: { path: string; content: string }[], code: string) => {
    await assert.rejects(service.importSkill({ files: [skill, ...extra], targets: ['claude'], scope: 'user' }), { code }, extra.map((f) => f.path).join());
  };
  for (const evil of ['../x.md', '/etc/passwd.md', 'a/../../x.md', 'a\\b.md', '.hidden.md', 'a//b.md', 'a/./b.md', 'x'.repeat(101) + '.md', 'sp ace.md', 'deep/1/2/3/4/5/6.md']) {
    await rejected([{ path: evil, content: 'x' }], 'SKILLS_PATH_INVALID');
  }
  for (const type of ['bin.exe', 'lib.so', 'archive.zip', 'x.bat', 'noext']) await rejected([{ path: type, content: 'x' }], 'SKILLS_FILE_TYPE');
  await rejected([{ path: 'a.md', content: 'x' }, { path: 'A.md', content: 'y' }], 'SKILLS_DUPLICATE_FILE');
  await rejected([{ path: 'big.md', content: 'x'.repeat(512 * 1024 + 1) }], 'SKILLS_TOO_LARGE');
  await assert.rejects(service.importSkill({ files: [skill, ...Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.md`, content: 'x' }))], targets: ['claude'], scope: 'user' }), { code: 'SKILLS_TOO_MANY_FILES' });
  const chunk = 'x'.repeat(500 * 1024);
  await assert.rejects(service.importSkill({ files: [skill, ...[0, 1, 2, 3, 4].map((i) => ({ path: `c${i}.md`, content: chunk }))], targets: ['claude'], scope: 'user' }), { code: 'SKILLS_TOO_LARGE' });
  assert.equal(files.size, 0);
});

test('skills that can make an agent run commands need an explicit acknowledgement', async () => {
  const { service, files } = setup();
  const risky = {
    files: [
      { path: 'SKILL.md', content: '---\nname: deploy\ndescription: Deploys.\nallowed-tools: Bash(*)\nhooks:\n  PreToolUse: []\n---\n\n!`git status`\n' },
      { path: 'scripts/run.sh', content: 'echo hi' },
    ],
    targets: ['claude'], scope: 'user',
  };
  const preview = service.preview(risky);
  assert.equal(preview.warnings.length, 4);
  assert.match(preview.warnings.join('\n'), /Pre-approves tools/);
  assert.match(preview.warnings.join('\n'), /hooks/);
  assert.match(preview.warnings.join('\n'), /shell commands/);
  assert.match(preview.warnings.join('\n'), /scripts\/run\.sh/);
  await assert.rejects(service.importSkill(risky), { code: 'SKILLS_NEEDS_CONFIRMATION' });
  assert.equal(files.size, 0);
  await service.importSkill({ ...risky, acknowledgeRisk: true });
  assert.ok(files.has('/home/u/.claude/skills/deploy/scripts/run.sh'));
  assert.deepEqual(service.preview({ content: SKILL }).warnings, []);
});

test('a project whose .claude or .agents is a symlink (for example to ~/.claude) is refused for import and removal', async () => {
  for (const link of ['/work/app/.claude', '/work/app/.claude/skills', '/work/app/.agents']) {
    const { service, files } = setup({ symlinks: [link] });
    await assert.rejects(service.importSkill({ content: SKILL, targets: ['claude', 'agy'], scope: 'project', projectId: 'p1' }), { code: 'SKILLS_PATH_REJECTED' }, link);
    await assert.rejects(service.remove({ target: link.includes('agents') ? 'agy' : 'claude', scope: 'project', name: 'code-review', projectId: 'p1' }), { code: 'SKILLS_PATH_REJECTED' }, link);
    assert.equal(files.size, 0);
  }
});

test('a skill folder that is itself a symlink is never written through or deleted', async () => {
  const { service, files } = setup({ symlinks: ['/home/u/.claude/skills/code-review'] });
  await assert.rejects(service.importSkill({ content: SKILL, targets: ['claude'], scope: 'user', overwrite: true }), { code: 'SKILLS_PATH_REJECTED' });
  await assert.rejects(service.remove({ target: 'claude', scope: 'user', name: 'code-review' }), { code: 'SKILLS_PATH_REJECTED' });
  assert.equal(files.size, 0);
});

test('requires a valid agent, scope and project', async () => {
  const { service } = setup();
  await assert.rejects(service.importSkill({ content: SKILL, targets: [], scope: 'user' }), { code: 'SKILLS_TARGET_REQUIRED' });
  await assert.rejects(service.importSkill({ content: SKILL, targets: ['gemini'], scope: 'user' }), { code: 'SKILLS_TARGET_INVALID' });
  await assert.rejects(service.importSkill({ content: SKILL, targets: ['claude'], scope: 'everywhere' }), { code: 'SKILLS_SCOPE_INVALID' });
  await assert.rejects(service.importSkill({ content: SKILL, targets: ['claude'], scope: 'project' }), { code: 'SKILLS_PROJECT_REQUIRED' });
  await assert.rejects(service.importSkill({ content: SKILL, targets: ['claude'], scope: 'project', projectId: 'nope' }), { code: 'SKILLS_PROJECT_UNKNOWN' });
});

test('lists installed skills with their descriptions', async () => {
  const { service } = setup();
  await service.importSkill({ content: SKILL, targets: ['claude'], scope: 'user' });
  await service.importSkill({ content: SKILL.replace('code-review', 'other').replace('Reviews a diff', 'Other thing'), targets: ['agy'], scope: 'user' });
  const skills = await service.list();
  assert.deepEqual(skills.map((s) => [s.name, s.target, s.scope]), [['code-review', 'claude', 'user'], ['other', 'agy', 'user']]);
  assert.match(skills[1].description, /Other thing/);
});

test('removes only the named skill folder, and rejects traversal names', async () => {
  const { service, files, removed } = setup();
  await service.importSkill({ content: SKILL, targets: ['claude'], scope: 'user' });
  await assert.rejects(service.remove({ target: 'claude', scope: 'user', name: '../..' }), { code: 'SKILLS_NAME_INVALID' });
  await assert.rejects(service.remove({ target: 'claude', scope: 'user', name: 'missing' }), { code: 'SKILLS_NOT_FOUND' });
  await service.remove({ target: 'claude', scope: 'user', name: 'code-review' });
  assert.deepEqual(removed, [path.join('/home/u/.claude/skills', 'code-review')]);
  assert.equal(files.size, 0);
});

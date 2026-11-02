// 从同一份源码生成 npm 分发包，保留仓库的 @local 安装方式。
// 使用 npm run pack:npm；本脚本只打包，不登录、不发布。
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const originalName = manifest.name;
const npmName = '@starplume/dsh-chat-mode';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请通过 npm run pack:npm 执行。');
const output = mkdtempSync(join(tmpdir(), 'dsh-chat-mode-npm-'));
const packageDir = join(output, 'package');
mkdirSync(packageDir);
for (const file of [...manifest.files, 'README.md', 'LICENSE', 'CHANGELOG.md']) {
  mkdirSync(dirname(join(packageDir, file)), { recursive: true });
  copyFileSync(join(root, file), join(packageDir, file));
}
// 包名、bundle 引用、浏览器模块 id 三者必须一致。
for (const file of ['client.js', 'cordis.patch.yml']) {
  const text = readFileSync(join(packageDir, file), 'utf8').replaceAll(originalName, npmName);
  writeFileSync(join(packageDir, file), text);
}
manifest.name = npmName;
manifest.files = [...manifest.files, 'CHANGELOG.md'];
delete manifest.private;
delete manifest.scripts;
manifest.license = 'MIT';
manifest.repository = { type: 'git', url: 'git+https://github.com/Starp1ume/dsh-chat-mode.git' };
manifest.homepage = 'https://github.com/Starp1ume/dsh-chat-mode#readme';
manifest.bugs = { url: 'https://github.com/Starp1ume/dsh-chat-mode/issues' };
manifest.keywords = ['dsh-plugin', 'deepseek-harness', 'deepseek', 'chat'];
manifest.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
const readme = readFileSync(join(packageDir, 'README.md'), 'utf8');
writeFileSync(join(packageDir, 'README.md'),
  '# @starplume/dsh-chat-mode — npm 分发包\n\n' +
  '与 Starp1ume/dsh-chat-mode 的 GitHub 源码分发并行，使用相同功能代码。\n\n' +
  '安装：`dsh plugin --profile desktop add @starplume/dsh-chat-mode`。已有 GitHub / @local 安装可继续使用原渠道；切换渠道前先移除旧安装，避免重复加载。\n\n' +
  readme.replaceAll('(assets/screenshots/', '(https://raw.githubusercontent.com/Starp1ume/dsh-chat-mode/v' + manifest.version + '/assets/screenshots/'));
const packed = Object.values(JSON.parse(execFileSync(process.execPath,
  [npmCli, 'pack', packageDir, '--pack-destination', output, '--ignore-scripts', '--json'],
  { encoding: 'utf8' })))[0];
console.log(JSON.stringify({ name: manifest.name, version: manifest.version,
  packageDir, tarball: join(output, packed.filename),
  integrity: packed.integrity, files: packed.files.map(file => file.path) }, null, 2));

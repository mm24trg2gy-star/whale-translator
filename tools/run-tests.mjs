// 跑单测的统一入口。
// 背景：`--test-isolation=none` 是 Node 24 才有的写法，Node 22 只有实验版
// `--experimental-test-isolation=none`，直接写死会让 CI 在 22 上挂掉。
// 这里按运行时探测，挑一个当前 Node 认识的参数。
import { spawnSync } from 'node:child_process';

const FILES = ['tests/lib.test.mjs', 'tests/background.test.mjs'];

function supports(flag) {
  const r = spawnSync(process.execPath, [flag, '-e', '0'], { stdio: 'ignore' });
  return r.status === 0;
}

const flags = [];
if (supports('--test-isolation=none')) flags.push('--test-isolation=none');
else if (supports('--experimental-test-isolation=none')) flags.push('--experimental-test-isolation=none');

const args = ['--test', ...flags, ...FILES];
console.log(`· Node ${process.versions.node} 跑单测，参数：${flags.join(' ') || '（默认隔离）'}`);

const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);

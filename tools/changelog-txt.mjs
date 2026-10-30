// 把 CHANGELOG.md 转成记事本能直接看的纯文本（带 BOM，中文不乱码）
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'CHANGELOG.md');
const outDir = path.join(root, 'dist');
const out = path.join(outDir, '更新日志.txt');

const md = fs.readFileSync(src, 'utf8');

const text = md
  .replace(/^# (.+)$/gm, (_m, t) => `${t}\n${'='.repeat(Math.min(40, t.length * 2))}`)
  .replace(/^## (.+)$/gm, (_m, t) => `\n${t}\n${'-'.repeat(Math.min(40, t.length * 2))}`)
  .replace(/^### (.+)$/gm, (_m, t) => `\n${t}`)
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/^[-*] (.+)$/gm, '  · $1')
  .replace(/\n{3,}/g, '\n\n')
  .trim() + '\n';

fs.mkdirSync(outDir, { recursive: true });
// UTF-8 + BOM：记事本、写字板都能正确识别中文
fs.writeFileSync(out, '\uFEFF' + text, 'utf8');

console.log('已生成', out, `${Buffer.byteLength(text)} 字节`);

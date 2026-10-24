/**
 * 生成 dist/ —— 只包含需要上传到 Cloudflare Pages 的文件
 * （避免把 node_modules、.git、.wrangler 一起传上去）
 */
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const files = ['index.html', '_routes.json'];
const dirs = ['assets', 'vendor'];

for (const f of files) {
  cpSync(path.join(root, f), path.join(dist, f));
}
for (const d of dirs) {
  cpSync(path.join(root, d), path.join(dist, d), { recursive: true });
}

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('构建失败：dist/index.html 不存在');
  process.exit(1);
}

console.log('构建完成 → dist/');

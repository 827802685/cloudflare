#!/usr/bin/env node
/**
 * 用 gateway 里已经装好的 sharp（wrangler 的传递依赖）把 icon.svg 渲染成 PWA/Capacitor 需要的 PNG。
 * 刻意不给 console 再加图像依赖：node_modules 已经在 gateway 里了，复用即可。
 * 输出：app/console/public/icon-{180,192,512}.png
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("F:/Documents/work/cloudflare/app/gateway/package.json");
const sharp = require("sharp");

const src = readFileSync("F:/Documents/work/cloudflare/app/console/public/icon.svg");
const outDir = "F:/Documents/work/cloudflare/app/console/public/";

for (const size of [180, 192, 512]) {
  const file = `${outDir}icon-${size}.png`;
  await sharp(src, { density: 300 }).resize(size, size).png({ compress: true }).toFile(file);
  console.log(existsSync(file) ? `✓ ${file}` : `✗ ${file}`);
}
console.log("180 = apple-touch-icon，192 = manifest（兼作 maskable），512 = manifest 大图标");

#!/usr/bin/env node
/**
 * 文生图统一入口，支持两个厂商：
 *   openai -> gpt-image 系列（默认 gpt-image-2.5-sunburst，支持 webp/jpeg/quality）
 *   qwen   -> 阿里云百炼 Qwen-Image 系列（默认 qwen-image-3.0，另有 qwen-image-3.0-pro；仅输出 PNG）
 *
 * 厂商选择优先级：--provider > 环境变量 T2I_PROVIDER > openai
 *
 * 用法：
 *   node generate.mjs "提示词" [--provider openai|qwen] [--model NAME] [--size WxH]
 *       [--quality low] [--format webp] [--n 1] [--out DIR]
 *
 * 环境变量：
 *   OPENAI_API_KEY / OPENAI_BASE_URL        openai 厂商
 *   DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL  qwen 厂商（默认 https://dashscope.aliyuncs.com，
 *                                           注意模型、Key、URL 必须同地域）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDERS = {
  openai: { model: "gpt-image-2.5-sunburst", format: "webp", keyEnv: "OPENAI_API_KEY" },
  qwen: { model: "qwen-image-3.0", format: "png", keyEnv: "DASHSCOPE_API_KEY" },
};
const FORMATS = ["webp", "png", "jpeg"];
const QUALITIES = ["low", "medium", "high", "auto"];
const OPENAI_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const opts = { size: "1536x1024", n: "1", out: "generated-images" };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-h" || argv[i] === "--help") {
    console.log(
      '用法: node generate.mjs "提示词" [--provider openai|qwen] [--model NAME] [--size WxH]' +
        " [--quality low|medium|high|auto] [--format webp|png|jpeg] [--n N] [--out DIR]"
    );
    process.exit(0);
  }
  if (argv[i].startsWith("--")) {
    const name = argv[i].slice(2);
    if (!["provider", "model", "size", "quality", "format", "n", "out"].includes(name)) fail(`未知选项 --${name}`);
    opts[name] = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}

const prompt = positional.join(" ").trim();
if (!prompt) fail('缺少提示词，用法: node generate.mjs "提示词" [选项]（-h 查看全部）');

const provider = opts.provider ?? process.env.T2I_PROVIDER ?? "openai";
if (!(provider in PROVIDERS)) fail(`--provider 仅支持 openai|qwen，收到 ${provider}`);
const cfg = PROVIDERS[provider];

const model = opts.model ?? cfg.model;
const format = opts.format ?? cfg.format;
if (!FORMATS.includes(format)) fail(`--format 仅支持 ${FORMATS.join("|")}，收到 ${format}`);
if (provider === "qwen" && format !== "png") fail("Qwen-Image 接口只输出 PNG；需要 webp/jpeg 请用 --provider openai");
if (opts.quality && !QUALITIES.includes(opts.quality)) fail(`--quality 仅支持 ${QUALITIES.join("|")}，收到 ${opts.quality}`);
if (provider === "qwen" && opts.quality) console.error("提示: --quality 仅 openai 厂商生效，已忽略");
const n = Number.parseInt(opts.n, 10);
const nMax = provider === "qwen" ? 6 : 10;
if (!Number.isInteger(n) || n < 1 || n > nMax) fail(`--n 需为 1-${nMax} 的整数，收到 ${opts.n}`);

const key = process.env[cfg.keyEnv];
if (!key) fail(`厂商 ${provider} 需要环境变量 ${cfg.keyEnv}`);

// ---------- HTTP ----------
async function postJson(url, body) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    const baseEnv = provider === "qwen" ? "DASHSCOPE_BASE_URL" : "OPENAI_BASE_URL";
    fail(`请求失败 ${url}\n${e.cause?.message ?? e.message}\n网络受限时可设置 ${baseEnv} 指向可达的中转地址`);
  }
  const data = await resp.json().catch(() => fail(`HTTP ${resp.status}，响应不是 JSON`));
  if (!resp.ok || data.code) fail(`HTTP ${resp.status} ${data.code ?? ""}\n${JSON.stringify(data.error ?? data).slice(0, 800)}`);
  return data;
}

async function download(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch((e) =>
    fail(`下载图片失败：${e.cause?.message ?? e.message}`)
  );
  if (!resp.ok) fail(`下载图片失败 HTTP ${resp.status}: ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ---------- 厂商实现 ----------
async function genOpenAI() {
  // 中转地址习惯带 /v1 后缀，去掉避免拼成 /v1/v1
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
  let apiSize;
  if (opts.size === "auto") {
    apiSize = "auto";
  } else {
    const m = /^(\d+)x(\d+)$/.exec(opts.size) ?? fail(`--size 需为 WxH（如 1536x1024）或 auto，收到 ${opts.size}`);
    const [w, h] = [+m[1], +m[2]];
    apiSize =
      w === h ? "1024x1024" : w > h ? "1536x1024" : "1024x1536"; // 官方仅三档，按形状就近取
    if (OPENAI_SIZES.has(opts.size)) apiSize = opts.size;
  }
  const data = await postJson(`${base}/v1/images/generations`, {
    model,
    prompt,
    size: apiSize,
    quality: opts.quality ?? "low",
    n,
    output_format: format,
  });
  const items = data.data ?? [];
  if (!items.length || !items[0].b64_json) fail(`未返回图片：${JSON.stringify(data).slice(0, 600)}`);
  return items.map((it) => Buffer.from(it.b64_json, "base64"));
}

async function genQwen() {
  const m = /^(\d+)x(\d+)$/.exec(opts.size) ?? fail(`Qwen-Image 的 --size 需为 WxH 像素（如 1536x1024），收到 ${opts.size}`);
  const [w, h] = [+m[1], +m[2]];
  if (w * h < 512 * 512 || w * h > 2048 * 2048) fail(`尺寸 ${w}x${h} 超出范围：总像素需在 512*512 与 2048*2048 之间`);
  const base = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com").replace(/\/+$/, "");
  const data = await postJson(`${base}/api/v1/services/aigc/multimodal-generation/generation`, {
    model,
    input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
    parameters: { n, size: `${w}*${h}`, watermark: false },
  });
  // 响应给的是 24 小时有效期的 PNG URL，立即下载落盘
  const urls = (data.output?.choices ?? [])
    .map((c) => (c.message?.content ?? []).find((x) => x.image)?.image)
    .filter(Boolean);
  if (!urls.length) fail(`未返回图片：${JSON.stringify(data).slice(0, 600)}`);
  return Promise.all(urls.map(download));
}

// ---------- 保存 ----------
const buffers = await (provider === "qwen" ? genQwen() : genOpenAI());

const slug =
  prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "image";
const d = new Date();
const p2 = (x) => String(x).padStart(2, "0");
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

mkdirSync(opts.out, { recursive: true });
buffers.forEach((buf, i) => {
  const path = join(opts.out, `${slug}-${stamp}-${i + 1}.${format}`);
  writeFileSync(path, buf);
  console.log(path);
});

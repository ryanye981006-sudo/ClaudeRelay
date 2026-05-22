// 视觉模型检测 — 基于 aichat vision.ts 正则移植
// 用于代理层在非视觉模型上过滤图片内容块

// 提取模型名（去掉 provider 前缀 goplan/ deepseek/ 等）
function getBaseModelId(modelName) {
  const id = (modelName || '').toLowerCase();
  const idx = id.lastIndexOf('/');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

// 白名单
const visionAllowedModels = [
  'llava',
  'moondream',
  'minicpm',
  'gemini-1\\.5',
  'gemini-2\\.0',
  'gemini-2\\.5',
  'gemini-3(?:\\.\\d)?(?:-[\\w-]+)?',
  'gemini-(flash|pro|flash-lite)-latest',
  'gemini-exp',
  'claude-3',
  'claude-haiku-4',
  'claude-sonnet-4',
  'claude-opus-4',
  'vision',
  'glm-4(?:\\.\\d+)?v(?:-[\\w-]+)?',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'qwen3\\.[5-9](?:-[\\w-]+)?',
  'qwen2.5-omni',
  'qwen3-omni(?:-[\\w-]+)?',
  'qvq',
  'internvl2',
  'grok-vision-beta',
  'grok-4(?:-[\\w-]+)?',
  'pixtral',
  'gpt-4(?:-[\\w-]+)',
  'gpt-4.1(?:-[\\w-]+)?',
  'gpt-4o(?:-[\\w-]+)?',
  'gpt-4.5(?:-[\\w-]+)',
  'gpt-5(?:-[\\w-]+)?',
  'chatgpt-4o(?:-[\\w-]+)?',
  'o1(?:-[\\w-]+)?',
  'o3(?:-[\\w-]+)?',
  'o4(?:-[\\w-]+)?',
  'deepseek-vl(?:[\\w-]+)?',
  'kimi-k2\\.[56](?:-[\\w-]+)?',
  'kimi-latest',
  'gemma-?[3-4](?:[-.\\w]+)?',
  'doubao-seed-1[.-][68](?:-[\\w-]+)?',
  'doubao-seed-2[.-]0(?:-[\\w-]+)?',
  'doubao-seed-code(?:-[\\w-]+)?',
  'kimi-thinking-preview',
  'gemma3(?:[-:\\w]+)?',
  'kimi-vl-a3b-thinking(?:-[\\w-]+)?',
  'llama-guard-4(?:-[\\w-]+)?',
  'llama-4(?:-[\\w-]+)?',
  'step-1o(?:.*vision)?',
  'step-1v(?:-[\\w-]+)?',
  'qwen-omni(?:-[\\w-]+)?',
  'mistral-large-(2512|latest)',
  'mistral-medium-(2508|latest)',
  'mistral-small',
  'mimo-v2\\.5$',
  'mimo-v2-omni(?:-[\\w-]+)?',
  'glm-5v-turbo',
];

// 黑名单（被白名单误匹配但不支持视觉的模型）
const visionExcludedModels = [
  'gpt-4-\\d+-preview',
  'gpt-4-turbo-preview',
  'gpt-4-32k',
  'gpt-4-\\d+',
  'o1-mini',
  'o3-mini',
  'o1-preview',
  'AIDC-AI/Marco-o1',
];

const VISION_REGEX = new RegExp(
  `\\b(?!(?:${visionExcludedModels.join('|')})\\b)(${visionAllowedModels.join('|')})\\b`,
  'i'
);

// embedding / rerank 模型不是视觉模型
function isNonVisionModel(modelId) {
  return modelId.includes('embedding') || modelId.includes('rerank');
}

/**
 * 判断模型是否支持视觉（图片输入）
 * @param {string} modelName - 模型名（可含 provider 前缀）
 */
function isVisionModel(modelName) {
  if (!modelName) return false;
  const modelId = getBaseModelId(modelName);
  if (isNonVisionModel(modelId)) return false;
  return VISION_REGEX.test(modelId);
}

module.exports = { isVisionModel };

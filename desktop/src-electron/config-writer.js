// 配置文件写入：Codex CLI 的 ~/.codex/config.toml

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// 异步设置 NO_PROXY，不阻塞主流程
// Codex (Go) 的 net/http 默认读取系统代理，NO_PROXY 让它对本地地址直连
function ensureNoProxy() {
  if (process.platform !== 'win32') return;
  // 先设进程级环境变量，影响当前 Electron 进程及其子进程
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  // 通过注册表检查系统级持久化 NO_PROXY，避免重复写入
  exec('reg query HKCU\\Environment /v NO_PROXY', (err, stdout) => {
    if (!err && stdout.includes('localhost,127.0.0.1')) return;
    // 系统级未设或值不对，setx 持久化写入用户环境变量
    exec('setx NO_PROXY "localhost,127.0.0.1"');
  });
}

// Codex CLI 配置文件路径
function getCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

// 默认模板（文件不存时创建）
const DEFAULT_TOML = `model_provider = "custom"
model = ""
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = false
base_url = "http://127.0.0.1:18889"
`;

function ensureConfigFile() {
  const configPath = getCodexConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_TOML, 'utf-8');
  }
  return configPath;
}

// 写入 Codex 配置：修改 model 和 base_url
// routingKey: "API源名称/模型名称"
// proxyPort: 代理端口
function writeCodexConfig(routingKey, proxyPort) {
  const configPath = ensureConfigFile();
  let content = fs.readFileSync(configPath, 'utf-8');

  // 替换 model 字段
  content = content.replace(/^model\s*=\s*".*"$/m, `model = "${routingKey}"`);

  // 替换 base_url 字段
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  content = content.replace(/^base_url\s*=\s*".*"$/m, `base_url = "${baseUrl}"`);

  // 原子写入
  const tmpFile = configPath + '.tmp';
  fs.writeFileSync(tmpFile, content, 'utf-8');
  fs.renameSync(tmpFile, configPath);

  // 设置 NO_PROXY，让本地请求绕过系统代理（Clash 等）
  ensureNoProxy();

  return { path: configPath, baseUrl, routingKey };
}

// 读取 Codex 配置
function readCodexConfig() {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    return fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
}

module.exports = { writeCodexConfig, readCodexConfig, getCodexConfigPath, ensureConfigFile };

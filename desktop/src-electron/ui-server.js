// REST API + 静态文件服务 — 供 standalone 和 Electron 模式共用

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
  getProviders, addProvider, updateProvider, deleteProvider,
  getModels, addModel, deleteModel,
  getContextModels, addContextModel, removeContextModel,
  addConfig, deleteConfig, renameConfig,
  addModelToConfig, removeModelFromConfig,
  setActiveConfig, getConfigs, getActiveConfig,
  buildApiUrl, getUsage, getUsageDetail,
  modelRoutingKey, getModelWithProvider,
} = require('./data-store');
const { writeCodexConfig, ensureConfigFile } = require('./config-writer');
const { writeCCConfig, ensureCCConfigFile } = require('./cc-config-writer');

const REQUEST_TIMEOUT = 15000;

function safeRequest(options, body, timeoutMs) {
  const isHttps = options.url.startsWith('https:');
  const transport = isHttps ? https : http;

  return new Promise((resolve) => {
    const done = (result) => { clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => {
      req.destroy();
      done({ error: options.timeoutMsg || '请求超时', status: 504 });
    }, timeoutMs);

    const req = transport.request(options.url, {
      method: options.method || 'POST',
      headers: options.headers || {},
      rejectUnauthorized: false,
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        try {
          done({ status: proxyRes.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          done({ status: proxyRes.statusCode, body: data, raw: data });
        }
      });
    });
    req.on('error', (err) => done({ error: err.message, status: 502 }));
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function apiRouter(req, res, url, method, body, codexPort, ccPort) {
  const pathname = url.pathname;

  // Provider CRUD
  if (method === 'GET' && pathname === '/api/providers') {
    return { data: getProviders() };
  }
  if (method === 'POST' && pathname === '/api/providers') {
    return { data: addProvider(body) };
  }
  if (method === 'PUT' && pathname.startsWith('/api/providers/')) {
    return { data: updateProvider(pathname.split('/').pop(), body) };
  }
  if (method === 'DELETE' && pathname.startsWith('/api/providers/')) {
    deleteProvider(pathname.split('/').pop());
    return { data: { ok: true } };
  }

  // Model CRUD
  if (method === 'GET' && pathname.startsWith('/api/models/')) {
    return { data: getModels(pathname.split('/').pop()) };
  }
  if (method === 'POST' && pathname === '/api/models') {
    return { data: addModel(body.providerId, body.name) };
  }
  if (method === 'DELETE' && pathname.startsWith('/api/models/')) {
    deleteModel(pathname.split('/').pop());
    return { data: { ok: true } };
  }

  // Context Models CRUD（1M 上下文模型管理）
  if (method === 'GET' && pathname === '/api/context-models') {
    return { data: getContextModels() };
  }
  if (method === 'POST' && pathname === '/api/context-models') {
    addContextModel(body.modelId);
    return { data: { ok: true } };
  }
  if (method === 'DELETE' && pathname.startsWith('/api/context-models/')) {
    removeContextModel(pathname.split('/').pop());
    return { data: { ok: true } };
  }

  // Config CRUD
  if (method === 'GET' && pathname.startsWith('/api/config/')) {
    return { data: getConfigs(pathname.split('/').pop()) };
  }
  if (method === 'POST' && pathname === '/api/config/add') {
    const cfg = addConfig(body.category, body.name);
    if (body.category === 'codex') ensureConfigFile();
    else if (body.category === 'claude') ensureCCConfigFile();
    return { data: cfg };
  }
  if (method === 'POST' && pathname === '/api/config/delete') {
    deleteConfig(body.category, body.configId);
    return { data: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/config/rename') {
    return { data: renameConfig(body.category, body.configId, body.name) };
  }
  if (method === 'POST' && pathname === '/api/config/add-model') {
    addModelToConfig(body.category, body.configId, body.modelId, body.slotIndex);
    if (body.category === 'codex') {
      const activeCfg = getActiveConfig('codex');
      if (activeCfg && activeCfg.id === body.configId && activeCfg.models.length > 0) {
        writeCodexConfig(modelRoutingKey(activeCfg.models[0]), codexPort);
      }
    } else if (body.category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg && activeCfg.id === body.configId) {
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) {
          const contextRoutingKeys = new Set(getContextModels().map(m => modelRoutingKey(m)));
          writeCCConfig(routingKeys, ccPort, undefined, contextRoutingKeys);
        }
      }
    }
    return { data: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/config/remove-model') {
    removeModelFromConfig(body.category, body.configId, body.modelId, body.slotIndex);
    return { data: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/config/set-active') {
    setActiveConfig(body.category, body.configId);
    if (body.category === 'codex') {
      const activeCfg = getActiveConfig('codex');
      if (activeCfg && activeCfg.models.length > 0) {
        writeCodexConfig(modelRoutingKey(activeCfg.models[0]), codexPort);
      }
    } else if (body.category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg) {
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) {
          const contextRoutingKeys = new Set(getContextModels().map(m => modelRoutingKey(m)));
          writeCCConfig(routingKeys, ccPort, undefined, contextRoutingKeys);
        }
      }
    }
    return { data: { ok: true } };
  }

  // Fetch / Verify models
  if (method === 'POST' && pathname === '/api/fetch-models') {
    const providers = getProviders();
    const provider = providers.find(p => p.id === body.providerId);
    if (!provider) return { error: 'API 源不存在', status: 404 };
    if (provider.protocol === 'anthropic') {
      return { data: { models: [], hint: 'Anthropic 协议不支持获取模型列表，请手动输入模型名验证' } };
    }
    if (provider.protocol === 'google') {
      return { data: { models: [], hint: 'Google (Gemini) 协议暂不支持获取模型列表，请手动输入模型名' } };
    }
    const modelsUrl = buildApiUrl(provider.apiBaseUrl, '/v1/models');
    return (async () => {
      const result = await safeRequest({
        url: modelsUrl, method: 'GET',
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        timeoutMsg: '获取模型列表超时 (15s)',
      }, null, REQUEST_TIMEOUT);
      if (result.error) return result;
      try {
        return { data: { models: (result.body.data || []).map(m => m.id) } };
      } catch {
        return { error: '解析模型列表失败', status: 502 };
      }
    })();
  }

  if (method === 'POST' && pathname === '/api/verify-model') {
    const providers = getProviders();
    const provider = providers.find(p => p.id === body.providerId);
    if (!provider) return { error: 'API 源不存在', status: 404 };
    let chatUrl, headers, verifyBody;
    if (provider.protocol === 'google') {
      chatUrl = buildApiUrl(provider.apiBaseUrl, `/v1/models/${body.modelName}:generateContent`);
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': provider.apiKey };
      verifyBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    } else {
      chatUrl = buildApiUrl(provider.apiBaseUrl,
        provider.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` };
      verifyBody = { model: body.modelName, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    }
    return (async () => {
      const result = await safeRequest({
        url: chatUrl, method: 'POST',
        headers,
        timeoutMsg: '验证请求超时 (15s)',
      }, verifyBody, REQUEST_TIMEOUT);
      if (result.error) return { data: { ok: false, error: `验证请求失败: ${result.error}` } };
      if (result.status === 200) return { data: { ok: true } };
      let errMsg = `模型 "${body.modelName}" 不存在或不可用 (HTTP ${result.status})`;
      if (result.body?.error?.message) errMsg = result.body.error.message;
      return { data: { ok: false, error: errMsg } };
    })();
  }

  // Proxy status
  if (method === 'GET' && pathname === '/api/proxy-status') {
    return { data: { running: true, codexPort: codexPort, ccPort: ccPort } };
  }

  // Usage
  if (method === 'GET' && pathname === '/api/usage') {
    const range = url.searchParams.get('range') || 'today';
    const records = getUsage(range);
    const modelMap = {};
    for (const r of records) {
      if (!modelMap[r.model]) {
        modelMap[r.model] = {
          model: r.model, callCount: 0, totalTokens: 0,
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, lastUsed: 0
        };
      }
      modelMap[r.model].callCount++;
      modelMap[r.model].inputTokens += r.inputTokens;
      modelMap[r.model].cachedInputTokens += r.cachedInputTokens || 0;
      modelMap[r.model].outputTokens += r.outputTokens;
      modelMap[r.model].totalTokens += r.inputTokens + r.outputTokens;
      if (r.timestamp > modelMap[r.model].lastUsed) modelMap[r.model].lastUsed = r.timestamp;
    }
    const models = Object.values(modelMap);
    models.sort((a, b) => b.lastUsed - a.lastUsed);
    return { data: { models, total: {
      callCount: models.reduce((s, m) => s + m.callCount, 0),
      inputTokens: models.reduce((s, m) => s + m.inputTokens, 0),
      cachedInputTokens: models.reduce((s, m) => s + m.cachedInputTokens, 0),
      outputTokens: models.reduce((s, m) => s + m.outputTokens, 0),
      totalTokens: models.reduce((s, m) => s + m.totalTokens, 0)
    } } };
  }

  if (method === 'GET' && pathname.startsWith('/api/usage/')) {
    const modelKey = decodeURIComponent(pathname.replace('/api/usage/', ''));
    const range = url.searchParams.get('range') || 'today';
    const page = parseInt(url.searchParams.get('page')) || 1;
    const pageSize = parseInt(url.searchParams.get('pageSize')) || 100;
    return { data: getUsageDetail(modelKey, range, page, pageSize) };
  }

  // Test connection
  if (method === 'POST' && pathname === '/api/test-connection') {
    const providers = getProviders();
    const provider = providers.find(p => p.id === body.providerId);
    if (!provider) return { error: 'API 源不存在', status: 404 };
    let chatUrl, headers, testBody;
    if (provider.protocol === 'google') {
      chatUrl = buildApiUrl(provider.apiBaseUrl, '/v1/models/test:generateContent');
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': provider.apiKey };
      testBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    } else {
      chatUrl = buildApiUrl(provider.apiBaseUrl,
        provider.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` };
      testBody = { model: 'test', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    }
    return (async () => {
      const result = await safeRequest({
        url: chatUrl, method: 'POST',
        headers,
        timeoutMsg: '连接超时 (15s)',
      }, testBody, REQUEST_TIMEOUT);
      if (result.error) return { data: { ok: false, error: result.error } };
      const ok = (result.status >= 200 && result.status < 500);
      return { data: { ok, status: result.status, detail: ok ? 'API 服务可达' : '无法连接' } };
    })();
  }

  return null;
}

function serveStatic(req, res, url) {
  const distDir = path.join(__dirname, '..', 'dist-renderer');
  let filePath = path.join(distDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(distDir, 'index.html');
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

function createUIServer(uiPort, codexPort, ccPort) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${uiPort}`);

    if (url.pathname.startsWith('/api/')) {
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => { data += chunk; });
            req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
            req.on('error', reject);
          });
        } catch (e) { body = {}; }
      }

      let result;
      try {
        result = await apiRouter(req, res, url, req.method, body, codexPort, ccPort);
      } catch (e) {
        result = { error: e.message, status: 400 };
      }
      if (result) {
        if (result.error) {
          res.writeHead(result.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.data));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API 不存在' }));
      }
      return;
    }

    serveStatic(req, res, url);
  });

  return server;
}

module.exports = { createUIServer };

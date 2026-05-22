// 代理引擎：基于 ClaudeRelay 源码，按 model 名前缀路由到不同后端

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// 打包兼容：优先使用 src-shared（打包后），回退到项目根 src（开发模式）
function resolveSrc(moduleName) {
  const packagedPath = path.join(__dirname, '..', 'src-shared', moduleName);
  try { return require.resolve(packagedPath); } catch {}
  return require.resolve(path.join(__dirname, '..', '..', 'src', moduleName));
}

const { responsesToAnthropic } = require(resolveSrc('responses-anthropic'));
const { anthropicToOpenAI } = require(resolveSrc('request'));
const { openaiToAnthropic } = require(resolveSrc('response'));
const { StreamTransformer } = require(resolveSrc('stream'));
const { responsesToChat } = require(resolveSrc('responses'));
const { chatToResponses } = require(resolveSrc('responses-response'));
const { ResponsesStreamTransformer } = require(resolveSrc('responses-stream'));
const { openaiToGoogle, googleToOpenAI } = require(resolveSrc('google-request'));
const { GoogleStreamTransformer } = require(resolveSrc('google-stream'));
const { estimateTokens, countTokens } = require(resolveSrc('server'));
const { resolveRoutingKey, getCategoryRoutingKeys, findProviderByName, getModels, buildApiUrl, logUsage } = require('./data-store');

// ====== 文件日志（写入 ~/.ccrelay-desktop/proxy.log） ======
const LOG_DIR = path.join(os.homedir(), '.ccrelay-desktop');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');
const MAX_LOG_SIZE = 512 * 1024; // 512KB 轮转

function initLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}
function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
function proxyLog(msg) {
  initLogDir();
  const line = `[${ts()}] ${msg}`;
  try {
    // 轮转
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      const old = LOG_FILE + '.old';
      try { fs.unlinkSync(old); } catch {}
      fs.renameSync(LOG_FILE, old);
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {}
}

// ====== 工具函数 ======

function errorResponse(type, message, statusCode) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'error', error: { type, message } }),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

// 解析请求中的 model 名：providerName/modelName → { provider, model }
function resolveBackend(modelRoutingKey, category) {
  if (!modelRoutingKey) return null;
  const resolved = resolveRoutingKey(modelRoutingKey, category);
  if (!resolved) return null;
  return {
    apiBaseUrl: resolved.provider.apiBaseUrl,
    apiKey: resolved.provider.apiKey,
    modelName: resolved.model.name,
    protocol: resolved.provider.protocol || 'openai',
  };
}

// ====== 后端请求 ======

function fetchBackend(backend, openaiBody) {
  let endpointPath, bodyToSend;
  if (backend.protocol === 'google') {
    endpointPath = `/v1/models/${backend.modelName}:generateContent`;
    bodyToSend = openaiToGoogle(openaiBody);
  } else if (backend.protocol === 'anthropic') {
    endpointPath = '/v1/messages';
    bodyToSend = { ...openaiBody, model: backend.modelName };
  } else {
    endpointPath = '/v1/chat/completions';
    bodyToSend = { ...openaiBody, model: backend.modelName };
  }
  const chatUrl = buildApiUrl(backend.apiBaseUrl, endpointPath);
  const url = new URL(chatUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const body = JSON.stringify(bodyToSend);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  if (backend.protocol === 'google') {
    headers['x-goog-api-key'] = backend.apiKey;
  } else {
    headers['Authorization'] = `Bearer ${backend.apiKey}`;
  }
  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers,
    timeout: 120000,
    rejectUnauthorized: false,
  };
  proxyLog(`[proxy] → POST ${url.hostname}${options.path} model=${backend.modelName} protocol=${backend.protocol}`);

  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        proxyLog(`[proxy] ← ${proxyRes.statusCode} (${data.length} bytes)`);
        try {
          let parsed = JSON.parse(data);
          // Google 协议响应转回 OpenAI 格式
          if (backend.protocol === 'google' && proxyRes.statusCode === 200) {
            parsed = googleToOpenAI(parsed);
          }
          resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: parsed });
        }
        catch { resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: data }); }
      });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(body);
    proxyReq.end();
  });
}

function streamFetchBackend(backend, openaiBody, res, createTransformer, routingKey, category) {
  // Google 协议走专用的 streamGoogleRelay
  if (backend.protocol === 'google') {
    return streamGoogleRelay(backend, openaiBody, res, createTransformer, routingKey, category);
  }
  const endpointPath = backend.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const chatUrl = buildApiUrl(backend.apiBaseUrl, endpointPath);
  const url = new URL(chatUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const bodyToSend = { ...openaiBody, model: backend.modelName };
  const body = JSON.stringify(bodyToSend);
  // 诊断：打印关键请求参数
  proxyLog(`[stream] 请求参数: enable_prompt_cache=${bodyToSend.enable_prompt_cache} model=${bodyToSend.model} stream=${bodyToSend.stream} tools=${bodyToSend.tools?.length || 0} keys=${Object.keys(bodyToSend).join(',')}`);
  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${backend.apiKey}`, 'Accept': 'text/event-stream' },
    timeout: 0,  // 流式请求不设超时，由心跳保活
    rejectUnauthorized: false,
  };
  const streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  proxyLog(`[stream ${streamId}] 开始 model=${backend.modelName}`);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });

  const transformer = createTransformer();
  const modelKey = routingKey || backend.modelName;
  let buffer = '';
  let clientDisconnected = false;
  let streamEnded = false;
  let firstDataTime = 0;
  // 独立 usage 行 fallback（dashscope 把 usage 放在没有 choices 的独立 SSE 行）
  let fallbackUsage = null;

  // SSE 心跳：发送标准 ping 事件，确保所有 SSE 解析器都能识别
  const heartbeat = setInterval(() => {
    if (!streamEnded) {
      try { res.write('event: ping\ndata: {}\n\n'); } catch { /* 客户端已断开 */ }
    }
  }, 15000);

  // 安全结束流：确保无论如何都触发 transformer 完成事件（response.completed / message_stop）
  const endStream = (reason, incomplete) => {
    if (streamEnded) {
      proxyLog(`[stream ${streamId}] endStream 重复调用, reason=${reason}, ignored`);
      return;
    }
    streamEnded = true;
    clearInterval(heartbeat);
    proxyLog(`[stream ${streamId}] endStream reason=${reason} incomplete=${incomplete} finished=${transformer.finished} started=${transformer.started} firstData=${firstDataTime > 0 ? (Date.now() - firstDataTime) + 'ms ago' : 'never'}`);
    // 如果 transformer 未完成（后端没发 [DONE] 就关闭了连接），强制触发完成
    if (!transformer.finished) {
      proxyLog(`[stream ${streamId}] 强制完成, 注入 finish_reason=${incomplete ? 'error' : 'stop'}`);
      try {
        const events = transformer.processChunk({ choices: [{ delta: {}, finish_reason: incomplete ? 'error' : 'stop' }] });
        proxyLog(`[stream ${streamId}] 强制完成产生 ${events.length} 个事件`);
        for (const evt of events) res.write(evt);
      } catch (e) { proxyLog(`[stream ${streamId}] 强制完成异常: ${e.message}`); }
    }
    // 记录用量
    let stats = transformer.getStats();
    // fallback：某些后端（如 dashscope）把 usage 放在独立的 SSE 行
    if (fallbackUsage) {
      if (stats.inputTokens === 0) stats.inputTokens = fallbackUsage.inputTokens;
      if (stats.outputTokens === 0) stats.outputTokens = fallbackUsage.outputTokens;
      if (stats.cachedInputTokens === 0) stats.cachedInputTokens = fallbackUsage.cachedInputTokens;
      proxyLog(`[stream ${streamId}] fallback 合并 usage=${JSON.stringify(fallbackUsage)}`);
    }
    if (stats && (stats.inputTokens > 0 || stats.outputTokens > 0)) {
      logUsage({
        model: modelKey,
        category: category,
        inputTokens: stats.inputTokens,
        cachedInputTokens: stats.cachedInputTokens || 0,
        outputTokens: stats.outputTokens,
        incomplete: !!(incomplete || clientDisconnected)
      });
    }
    try { res.end(); } catch { /* 客户端可能已断开 */ }
    proxyLog(`[stream ${streamId}] 流结束`);
  };

  // 客户端断开 → 中止上游请求
  res.on('close', () => {
    clientDisconnected = true;
    proxyLog(`[stream ${streamId}] 客户端关闭连接, streamEnded=${streamEnded}`);
    if (!streamEnded) {
      try { proxyReq.destroy(); } catch {}
      endStream('client-close', true);
    }
  });

  const proxyReq = transport.request(options, (proxyRes) => {
    proxyLog(`[stream ${streamId}] 后端响应 status=${proxyRes.statusCode}`);
    // TCP keep-alive：防止上游连接被路由器/防火墙因空闲断开
    if (proxyReq.socket) {
      proxyReq.socket.setKeepAlive(true, 60000);
    }

    if (proxyRes.statusCode !== 200) {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        proxyLog(`[stream ${streamId}] 后端错误响应: ${data.substring(0, 300)}`);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端返回 ${proxyRes.statusCode}` } })}\n\n`);
        endStream('backend-non200', true);
      });
      return;
    }

    proxyRes.on('data', (chunk) => {
      if (firstDataTime === 0) {
        firstDataTime = Date.now();
        proxyLog(`[stream ${streamId}] 首个数据块 (${chunk.length} bytes)`);
      }
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          proxyLog(`[stream ${streamId}] 收到 [DONE]`);
          const events = transformer.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          for (const evt of events) res.write(evt);
          // 立即结束流，确保 response.completed 事件被刷新到 socket
          // 不等 proxyRes.on('end')，避免客户端先断开导致事件丢失
          endStream('done-received', false);
          continue;
        }
        try {
          const parsed = JSON.parse(dataStr);
          // 独立 usage 行（dashscope 把 usage 放在没有 choices 的独立 SSE 行）
          if (parsed.usage && !parsed.choices?.[0]) {
            fallbackUsage = {
              inputTokens: parsed.usage.prompt_tokens || 0,
              outputTokens: parsed.usage.completion_tokens || 0,
              cachedInputTokens: parsed.usage.prompt_tokens_details?.cached_tokens || parsed.usage.prompt_cache_hit_tokens || 0,
            };
            proxyLog(`[stream ${streamId}] 独立 usage 行: prompt_tokens=${fallbackUsage.inputTokens} completion_tokens=${fallbackUsage.outputTokens} cached_tokens=${fallbackUsage.cachedInputTokens} details=${JSON.stringify(parsed.usage.prompt_tokens_details)}`);
          }
          const events = transformer.processChunk(parsed);
          for (const evt of events) res.write(evt);
        } catch { /* ignore */ }
      }
    });

    proxyRes.on('end', () => {
      proxyLog(`[stream ${streamId}] 后端流结束 (proxyRes.end) bufferLen=${buffer.length} hasDone=${buffer.includes('[DONE]')} finished=${transformer.finished}`);
      // 处理残留 buffer（后端可能未发送 [DONE] 就关闭连接）
      if (buffer.trim() && !buffer.trim().includes('[DONE]')) {
        try {
          const dataStr = buffer.trim().slice(5).trim();
          if (dataStr) {
            const parsed = JSON.parse(dataStr);
            const events = transformer.processChunk(parsed);
            for (const evt of events) res.write(evt);
          }
        } catch { /* ignore */ }
      }
      // 强制完成：确保 response.completed / message_stop 一定被发出
      endStream('backend-end', !transformer.finished && !buffer.includes('[DONE]'));
    });

    proxyRes.on('error', (err) => {
      proxyLog(`[stream ${streamId}] 后端流错误: ${err.message}`);
      endStream('backend-error', true);
    });
  });

  proxyReq.on('error', (err) => {
    proxyLog(`[stream ${streamId}] 上游连接失败: ${err.message}`);
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端连接失败: ${err.message}` } })}\n\n`);
      endStream('upstream-error', true);
    }
  });
  proxyReq.on('timeout', () => {
    proxyLog(`[stream ${streamId}] 上游超时`);
    proxyReq.destroy();
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '后端请求超时' } })}\n\n`);
      endStream('upstream-timeout', true);
    }
  });
  proxyReq.write(body);
  proxyReq.end();
}

// Anthropic 协议 SSE 透传（Claude Code 路径，不转 OpenAI 格式）
function streamAnthropicRelay(backend, anthropicBody, res, routingKey, category) {
  const endpointPath = '/v1/messages';
  const chatUrl = buildApiUrl(backend.apiBaseUrl, endpointPath);
  const url = new URL(chatUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const bodyToSend = { ...anthropicBody, model: backend.modelName };
  const body = JSON.stringify(bodyToSend);
  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${backend.apiKey}`, 'Accept': 'text/event-stream' },
    timeout: 0,
    rejectUnauthorized: false,
  };
  const streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const msgDetail = (bodyToSend.messages || []).map((m, i) => {
    const ct = Array.isArray(m.content) ? m.content.map(c => c.type).join(',') : typeof m.content;
    return `[${i}]${m.role}:${ct}`;
  }).join(' ');
  // 只打印结构，不打印内容以避免污染日志
  const firstMsgSample = bodyToSend.messages?.[0] ? JSON.stringify(bodyToSend.messages[0]).substring(0, 120) : 'none';
  proxyLog(`[stream ${streamId}] Anthropic relay: model=${backend.modelName} msgs=${bodyToSend.messages?.length || 0}(${msgDetail}) firstMsg=${firstMsgSample} keys=${Object.keys(bodyToSend).join(',')}`);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });

  let buffer = '';
  let streamEnded = false;
  let sseBuffer = '';
  let currentEvent = '';
  let usageStats = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, baseInputTokens: 0 };

  const heartbeat = setInterval(() => {
    if (!streamEnded) {
      try { res.write('event: ping\ndata: {}\n\n'); } catch {}
    }
  }, 15000);

  const endStream = (reason) => {
    if (streamEnded) return;
    streamEnded = true;
    clearInterval(heartbeat);
    // 归一化 inputTokens：Anthropic 协议 input_tokens 仅计非缓存部分，需加上 cache_read 才是总输入
    // OpenAI 协议 prompt_tokens 已含缓存，无需额外处理
    const totalInput = usageStats.baseInputTokens + usageStats.cachedInputTokens;
    if (totalInput > 0) usageStats.inputTokens = totalInput;
    // 记录用量
    if (usageStats.inputTokens > 0 || usageStats.outputTokens > 0) {
      logUsage({
        model: routingKey || backend.modelName,
        category: category,
        inputTokens: usageStats.inputTokens,
        cachedInputTokens: usageStats.cachedInputTokens,
        outputTokens: usageStats.outputTokens,
      });
    }
    proxyLog(`[stream ${streamId}] 结束 reason=${reason} usage=${JSON.stringify(usageStats)}`);
    try { res.end(); } catch {}
  };

  res.on('close', () => {
    if (!streamEnded) {
      try { proxyReq.destroy(); } catch {}
      endStream('client-close');
    }
  });

  const proxyReq = transport.request(options, (proxyRes) => {
    proxyLog(`[stream ${streamId}] 后端响应 status=${proxyRes.statusCode}`);

    if (proxyRes.statusCode !== 200) {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        proxyLog(`[stream ${streamId}] 后端错误 status=${proxyRes.statusCode} body=${data.substring(0, 500)} headers=${JSON.stringify(proxyRes.headers)}`);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端返回 ${proxyRes.statusCode}: ${data.substring(0, 200)}` } })}\n\n`);
        endStream('backend-non200');
      });
      return;
    }

    // 透传 SSE 数据 + 解析 Anthropic 事件提取 usage
    proxyRes.on('data', (chunk) => {
      try { res.write(chunk); } catch {}

      // 解析 Anthropic SSE 事件提取 usage 用于 logUsage
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.substring(6);
        } else if (trimmed.startsWith('data:')) {
          try {
            const data = JSON.parse(trimmed.substring(5));
            if (currentEvent === 'message_start' && data.message?.usage) {
              // DashScope Anthropic 端点: input_tokens 仅计非缓存部分（不含 cache_read）
              usageStats.baseInputTokens = data.message.usage.input_tokens || 0;
              usageStats.inputTokens = usageStats.baseInputTokens;
              proxyLog(`[stream ${streamId}] Anthropic SSE message_start: input_tokens=${data.message.usage.input_tokens} cache_creation=${data.message.usage.cache_creation_input_tokens} cache_read=${data.message.usage.cache_read_input_tokens}`);
            }
            if (currentEvent === 'message_delta' && data.usage) {
              usageStats.outputTokens = data.usage.output_tokens || usageStats.outputTokens;
              usageStats.cachedInputTokens = data.usage.cache_read_input_tokens || usageStats.cachedInputTokens;
              proxyLog(`[stream ${streamId}] Anthropic SSE message_delta: output_tokens=${data.usage.output_tokens} input_tokens=${data.usage.input_tokens} cache_read=${data.usage.cache_read_input_tokens}`);
              // 如果 message_delta 更新了 input_tokens，同步更新基数
              if (data.usage.input_tokens && data.usage.input_tokens > usageStats.baseInputTokens) {
                usageStats.baseInputTokens = data.usage.input_tokens;
              }
            }
          } catch {}
        }
      }
    });

    proxyRes.on('end', () => {
      endStream('backend-end');
    });

    proxyRes.on('error', (err) => {
      proxyLog(`[stream ${streamId}] 后端流错误: ${err.message}`);
      endStream('backend-error');
    });
  });

  proxyReq.on('error', (err) => {
    proxyLog(`[stream ${streamId}] 上游连接失败: ${err.message}`);
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端连接失败: ${err.message}` } })}\n\n`);
      endStream('upstream-error');
    }
  });
  proxyReq.write(body);
  proxyReq.end();
}

// ====== Google Gemini 流式转发 ======

function streamGoogleRelay(backend, openaiBody, res, createTransformer, routingKey, category) {
  const googleBody = openaiToGoogle(openaiBody);
  const endpointPath = `/v1/models/${backend.modelName}:streamGenerateContent?alt=sse`;
  const chatUrl = buildApiUrl(backend.apiBaseUrl, endpointPath);
  const url = new URL(chatUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const body = JSON.stringify(googleBody);
  const streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  proxyLog(`[stream ${streamId}] Google relay: model=${backend.modelName} contents=${googleBody.contents?.length || 0}`);
  // 调试：检查 contents 中是否有 functionCall 带 thoughtSignature
  if (googleBody.contents) {
    for (let i = 0; i < googleBody.contents.length; i++) {
      const c = googleBody.contents[i];
      if (c.role === 'model' && c.parts) {
        for (const p of c.parts) {
          if (p.functionCall) {
            proxyLog(`[stream ${streamId}] Google content[${i}] functionCall=${p.functionCall.name} hasThoughtSig=${!!p.thoughtSignature}`);
          }
        }
      }
    }
  }

  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-goog-api-key': backend.apiKey, 'Accept': 'text/event-stream' },
    timeout: 0,
    rejectUnauthorized: false,
  };

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });

  const googleTransformer = new GoogleStreamTransformer(backend.modelName);
  googleTransformer._debugLog = (msg) => proxyLog(`[stream ${streamId}] GoogleTransformer: ${msg}`);
  const outerTransformer = createTransformer();
  let buffer = '';
  let streamEnded = false;

  const heartbeat = setInterval(() => {
    if (!streamEnded) {
      try { res.write(': heartbeat\n\n'); } catch {}
    }
  }, 15000);

  const endStream = (reason) => {
    if (streamEnded) return;
    streamEnded = true;
    clearInterval(heartbeat);
    // 强制完成外层 transformer
    if (!outerTransformer.finished) {
      try {
        const events = outerTransformer.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        for (const evt of events) res.write(evt);
      } catch {}
    }
    const stats = googleTransformer.getStats();
    if (stats.inputTokens > 0 || stats.outputTokens > 0) {
      logUsage({
        model: routingKey || backend.modelName, category,
        inputTokens: stats.inputTokens,
        cachedInputTokens: stats.cachedInputTokens,
        outputTokens: stats.outputTokens,
      });
    }
    proxyLog(`[stream ${streamId}] Google end reason=${reason} usage=${JSON.stringify(stats)}`);
    try { res.end(); } catch {}
  };

  res.on('close', () => {
    if (!streamEnded) {
      try { proxyReq.destroy(); } catch {}
      endStream('client-close');
    }
  });

  const proxyReq = transport.request(options, (proxyRes) => {
    proxyLog(`[stream ${streamId}] Google 后端响应 status=${proxyRes.statusCode}`);
    if (proxyRes.statusCode !== 200) {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        proxyLog(`[stream ${streamId}] Google 错误: ${data.substring(0, 500)}`);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Google 后端返回 ${proxyRes.statusCode}: ${data.substring(0, 200)}` } })}\n\n`);
        endStream('backend-non200');
      });
      return;
    }

    if (proxyReq.socket) proxyReq.socket.setKeepAlive(true, 60000);

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        // Google 不发 [DONE]，跳过
        if (dataStr === '[DONE]') continue;
        try {
          const googleChunk = JSON.parse(dataStr);
          // Google → OpenAI chunk 对象
          const openaiChunks = googleTransformer.processChunk(googleChunk);
          for (const oc of openaiChunks) {
            // 喂入外层 transformer（如 ResponsesStreamTransformer）
            try {
              const events = outerTransformer.processChunk(oc);
              for (const evt of events) res.write(evt);
            } catch {}
          }
        } catch {}
      }
    });

    proxyRes.on('end', () => {
      // 处理残留 buffer
      if (buffer.trim() && buffer.trim().startsWith('data:')) {
        try {
          const dataStr = buffer.trim().slice(5).trim();
          const googleChunk = JSON.parse(dataStr);
          const openaiChunks = googleTransformer.processChunk(googleChunk);
          for (const oc of openaiChunks) {
            try {
              const events = outerTransformer.processChunk(oc);
              for (const evt of events) res.write(evt);
            } catch {}
          }
        } catch {}
      }
      endStream('backend-end');
    });

    proxyRes.on('error', (err) => {
      proxyLog(`[stream ${streamId}] Google 流错误: ${err.message}`);
      endStream('backend-error');
    });
  });

  proxyReq.on('error', (err) => {
    proxyLog(`[stream ${streamId}] Google 连接失败: ${err.message}`);
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Google 后端连接失败: ${err.message}` } })}\n\n`);
      endStream('upstream-error');
    }
  });

  proxyReq.write(body);
  proxyReq.end();
}

// ====== 创建代理服务 ======

function createCodexServer(port) {
  const category = 'codex';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    proxyLog(`[codex ${reqId}] ${req.method} ${req.url}`);
    // 追踪客户端连接何时关闭
    req.on('close', () => { proxyLog(`[codex ${reqId}] 客户端连接关闭`); });
    const reqPath = req.url.split('?')[0];

    // 健康检查
    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', type: 'codex' }));
      return;
    }

    // 根路径探测
    if ((req.method === 'GET' || req.method === 'HEAD') && reqPath === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 模型列表 — 返回路由键格式：providerName/modelName
    if (req.method === 'GET' && (reqPath === '/v1/models' || reqPath === '/models')) {
      const routingKeys = getCategoryRoutingKeys('codex');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: routingKeys.map(id => ({ id, object: 'model', created: 1, owned_by: 'clauderelay' })),
      }));
      return;
    }

    // Codex 路由：/v1/responses、/responses、/v1/chat/completions
    if (req.method === 'POST' && (reqPath === '/v1/responses' || reqPath === '/responses' || reqPath === '/v1/chat/completions')) {
      try {
        const responsesBody = await readBody(req);

        // 按 model 名前缀路由到对应后端（剥离 [1m] 后缀）
        const codexModelForRouting = responsesBody.model?.replace('[1m]', '') || '';
        const backend = resolveBackend(codexModelForRouting, category);
        if (!backend) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `未知模型: ${codexModelForRouting}，可用模型见 /v1/models` } }));
          return;
        }

        const isResponses = responsesBody.input !== undefined || responsesBody.instructions !== undefined;
        proxyLog(`[codex] ← ${isResponses ? 'Responses' : 'Chat'} routing=${responsesBody.model} → ${backend.apiBaseUrl} model=${backend.modelName} stream=${responsesBody.stream}`);

        if (backend.protocol === 'anthropic') {
          // Codex 需要 Responses API 格式响应，Anthropic 后端不支持
          proxyLog(`[codex] 拒绝 Anthropic 后端: ${backend.apiBaseUrl}`);
          const err = errorResponse('invalid_request_error',
            `Codex 不支持 Anthropic 协议的后端（${backend.modelName}）。请在设置中将该模型的供应商协议改为 OpenAI，或使用 Claude Code 客户端。`,
            400);
          res.writeHead(err.statusCode, err.headers); res.end(err.body);
          return;
        }

        // Responses → Chat Completions 转换（OpenAI 和 Google 协议共用）
        {
          let openaiBody;
          if (isResponses) {
            openaiBody = responsesToChat(responsesBody);
            const msgDump = openaiBody.messages.map((m, idx) => {
              const tc = m.tool_calls ? ` tool_calls=[${m.tool_calls.map(t => t.id).join(',')}]` : '';
              const rc = m.reasoning_content ? ` reasoning=${m.reasoning_content.length}chars` : '';
              const ct = m.content ? ` content=${typeof m.content === 'string' ? m.content.substring(0, 60) : JSON.stringify(m.content).substring(0, 60)}` : '';
              return `[${idx}] ${m.role}${tc}${rc}${ct}`;
            });
            proxyLog(`[codex] 转换后消息 (${openaiBody.messages.length}): ${msgDump.join(' | ')}`);
          } else {
            openaiBody = responsesBody;
          }

          if (responsesBody.stream || openaiBody.stream) {
            await streamFetchBackend(backend, openaiBody, res, () => new ResponsesStreamTransformer(openaiBody.model), responsesBody.model, category);
          } else {
            const result = await fetchBackend(backend, openaiBody);
            if (result.status === 200) {
              if (result.body && result.body.usage) {
                logUsage({
                  model: responsesBody.model, category: 'codex',
                  inputTokens: result.body.usage.prompt_tokens || 0,
                  cachedInputTokens: result.body.usage.prompt_tokens_details?.cached_tokens || result.body.usage.prompt_cache_hit_tokens || 0,
                  outputTokens: result.body.usage.completion_tokens || 0
                });
              }
              const responsesResponse = chatToResponses(result.body);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(responsesResponse));
            } else {
              const errMsg = typeof result.body === 'object' && result.body.error ? result.body.error.message : `后端返回 ${result.status}`;
              proxyLog(`[codex] 非流式后端错误 status=${result.status} body=${JSON.stringify(result.body).substring(0, 300)}`);
              const err = errorResponse('api_error', errMsg, 502);
              res.writeHead(err.statusCode, err.headers); res.end(err.body);
            }
          }
        }
      } catch (e) {
        proxyLog(`[codex] 请求异常: ${e.message}`);
        const err = errorResponse(e.message === 'invalid_json' ? 'invalid_request_error' : 'api_error', e.message, e.message === 'invalid_json' ? 400 : 500);
        res.writeHead(err.statusCode, err.headers); res.end(err.body);
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `未知路径: ${reqPath}` } }));
  });

  // 禁用 server 超时：SSE 长连接不能因空闲被断开
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      proxyLog(`[codex] 代理已启动 → http://127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ====== CC 代理服务（Anthropic Messages → Chat Completions） ======

function createCCServer(port) {
  const category = 'claude';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    proxyLog(`[claude] ${req.method} ${req.url}`);
    const reqPath = req.url.split('?')[0];

    // 健康检查
    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', type: 'claude' }));
      return;
    }

    // 根路径探测
    if ((req.method === 'GET' || req.method === 'HEAD') && reqPath === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 模型列表 — 返回 Anthropic 格式（CC 需要 context_window 等信息才能追踪上下文用量）
    if (req.method === 'GET' && (reqPath === '/v1/models' || reqPath === '/models')) {
      const routingKeys = getCategoryRoutingKeys('claude');
      const models = routingKeys.map(m => ({
        id: m,
        display_name: m,
        type: 'model',
        created_at: '2025-01-01T00:00:00Z',
        context_window: 950000,  // DeepSeek V4 支持 1000K，预留余量
        max_output_tokens: 8192,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: models,
        has_more: false,
        first_id: models[0]?.id || '',
        last_id: models[models.length - 1]?.id || '',
      }));
      return;
    }

    // Token 计数
    if (req.method === 'POST' && reqPath === '/v1/messages/count_tokens') {
      try {
        const body = await readBody(req);
        const count = countTokens(body);
        proxyLog(`[claude] count_tokens → ${count}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: count }));
      } catch (e) {
        const err = errorResponse(e.message === 'invalid_json' ? 'invalid_request_error' : 'api_error', e.message, e.message === 'invalid_json' ? 400 : 500);
        res.writeHead(err.statusCode, err.headers); res.end(err.body);
      }
      return;
    }

    // Anthropic Messages → Chat Completions
    if (req.method === 'POST' && reqPath === '/v1/messages') {
      try {
        const anthropicBody = await readBody(req);

        // 按 model 名前缀路由（剥离 [1m] 后缀后再匹配路由键）
        const modelForRouting = anthropicBody.model?.replace('[1m]', '') || '';
        const backend = resolveBackend(modelForRouting, category);
        if (!backend) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `未知模型: ${anthropicBody.model}，可用模型见 /v1/models` } }));
          return;
        }

        proxyLog(`[claude] ← Anthropic routing=${anthropicBody.model} → ${backend.apiBaseUrl} model=${backend.modelName} stream=${anthropicBody.stream}`);

        if (backend.protocol === 'google') {
          // Google 协议暂不支持 Claude Code
          proxyLog(`[claude] 拒绝 Google 后端: ${backend.apiBaseUrl}`);
          const err = errorResponse('invalid_request_error',
            `Google (Gemini) 协议暂不支持 Claude Code 客户端（${backend.modelName}），请使用 Codex 客户端。`,
            400);
          res.writeHead(err.statusCode, err.headers); res.end(err.body);
          return;
        }

        if (backend.protocol === 'anthropic') {
          // Anthropic 后端：原样透传，不做格式转换
          if (anthropicBody.stream) {
            await streamAnthropicRelay(backend, anthropicBody, res, anthropicBody.model, category);
          } else {
            const result = await fetchBackend(backend, anthropicBody);
            if (result.status === 200) {
              if (result.body && result.body.usage) {
                logUsage({
                  model: anthropicBody.model, category: 'claude',
                  // Anthropic 协议 input_tokens 仅计非缓存部分，归一化为总输入
                  inputTokens: (result.body.usage.input_tokens || 0) + (result.body.usage.cache_read_input_tokens || 0),
                  cachedInputTokens: result.body.usage.cache_read_input_tokens || 0,
                  outputTokens: result.body.usage.output_tokens || 0
                });
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result.body));
            } else {
              const errMsg = typeof result.body === 'object' && result.body.error ? result.body.error.message : `后端返回 ${result.status}`;
              const err = errorResponse('api_error', errMsg, 502);
              res.writeHead(err.statusCode, err.headers); res.end(err.body);
            }
          }
        } else {
          // OpenAI 后端：Anthropic → Chat Completions 转换
          const openaiBody = anthropicToOpenAI(anthropicBody);
          proxyLog(`[claude] 转换后消息 (${openaiBody.messages.length}): ${openaiBody.messages.map((m, idx) => {
            const tc = m.tool_calls ? ` tool_calls=[${m.tool_calls.map(t => t.id).join(',')}]` : '';
            const rc = m.reasoning_content ? ` reasoning=${m.reasoning_content.length}chars` : ' reasoning=MISSING';
            const ct = m.content ? ` content=${typeof m.content === 'string' ? m.content.substring(0, 80) : JSON.stringify(m.content).substring(0, 80)}` : ' content=null';
            return `[${idx}] ${m.role}${tc}${rc}${ct}`;
          }).join(' | ')}`);

          if (anthropicBody.stream) {
            const inputTokens = countTokens(anthropicBody);
            await streamFetchBackend(backend, openaiBody, res, () => new StreamTransformer(openaiBody.model, inputTokens), anthropicBody.model, category);
          } else {
            const result = await fetchBackend(backend, openaiBody);
            if (result.status === 200) {
              if (result.body && result.body.usage) {
                logUsage({
                  model: anthropicBody.model, category: 'claude',
                  inputTokens: result.body.usage.prompt_tokens || 0,
                  cachedInputTokens: result.body.usage.prompt_tokens_details?.cached_tokens || result.body.usage.prompt_cache_hit_tokens || 0,
                  outputTokens: result.body.usage.completion_tokens || 0
                });
              }
              const anthropicResponse = openaiToAnthropic(result.body);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(anthropicResponse));
            } else {
              const errMsg = typeof result.body === 'object' && result.body.error ? result.body.error.message : `后端返回 ${result.status}`;
              const err = errorResponse('api_error', errMsg, 502);
              res.writeHead(err.statusCode, err.headers); res.end(err.body);
            }
          }
        }
      } catch (e) {
        const err = errorResponse(e.message === 'invalid_json' ? 'invalid_request_error' : 'api_error', e.message, e.message === 'invalid_json' ? 400 : 500);
        res.writeHead(err.statusCode, err.headers); res.end(err.body);
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `未知路径: ${reqPath}` } }));
  });

  // 禁用 server 超时：SSE 长连接不能因空闲被断开
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      proxyLog(`[claude] 代理已启动 → http://127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    // 强制关闭所有活跃连接（SSE 长连接有心跳保活，不会自然断开）
    // server.close() 只拒绝新连接，不关闭已有连接
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
    // 超时兜底：1 秒后无论如何 resolve
    setTimeout(resolve, 1000);
  });
}

module.exports = { createCodexServer, createCCServer, stopServer };

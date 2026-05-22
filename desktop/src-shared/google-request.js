// OpenAI Chat Completions 请求体 → Google Gemini generateContent 请求体转换

const { getThoughtSig, clearThoughtSig } = require('./google-stream');

// 清理 JSON Schema 中 Google Gemini 不支持的字段
// Google 只支持: type, description, properties, required, items, enum, nullable
const SKIP_KEYWORDS = ['additionalProperties', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'pattern', 'format', 'default', 'examples', 'title', 'oneOf', 'anyOf', 'allOf',
  'uniqueItems', 'minProperties', 'maxProperties'];

function cleanSchema(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    // 跳过 $ 前缀字段（$schema 等）
    if (key.startsWith('$')) continue;
    // 跳过 propertyNames
    if (key === 'propertyNames') continue;
    // 跳过 Google 不支持的 schema 约束字段
    if (SKIP_KEYWORDS.includes(key)) continue;

    // properties 内的 key 是属性名，不做关键字过滤，只递归清理 value（即属性 schema）
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = cleanSchema(propSchema);
      }
      cleaned.properties = props;
    } else {
      cleaned[key] = cleanSchema(value);
    }
  }
  return cleaned;
}

function openaiToGoogle(openaiBody) {
  const result = {};

  // 系统指令
  const systemParts = [];
  const nonSystemMessages = [];
  for (const msg of (openaiBody.messages || [])) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) systemParts.push({ text });
    } else {
      nonSystemMessages.push(msg);
    }
  }
  if (systemParts.length > 0) {
    result.systemInstruction = { parts: systemParts };
  }

  // 维护 tool_call_id → function_name 映射，用于 tool 角色消息解析函数名
  const callIdToName = new Map();

  // 消息转换
  const contents = [];
  for (const msg of nonSystemMessages) {
    // 跳过 reasoning_content，Gemini 有自己的思考机制
    if (msg.role === 'assistant' && msg.reasoning_content) {
      // 仅当有 reasoning_content 但无实际内容也无 tool_calls 时跳过
      if (!msg.content && !msg.tool_calls?.length) continue;
    }

    if (msg.role === 'user') {
      const parts = convertUserContent(msg.content);
      if (parts.length > 0) contents.push({ role: 'user', parts });
    } else if (msg.role === 'assistant') {
      const parts = [];

      // 文本内容
      if (msg.content) {
        parts.push({ text: msg.content });
      }

      // 工具调用
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || tc;
          const name = fn.name || '';
          // 记录 id → name 映射
          if (tc.id) callIdToName.set(tc.id, name);
          // 解析 arguments 字符串为 args 对象
          let args = {};
          try { args = JSON.parse(fn.arguments || '{}'); } catch { args = {}; }
          const fcPart = { functionCall: { name, args } };
          // 回注 thoughtSignature（从缓存中查找，不清除——同一会话中历史会反复发送）
          if (tc.id) {
            const sig = getThoughtSig(tc.id);
            if (sig) {
              fcPart.thoughtSignature = sig;
            }
          }
          parts.push(fcPart);
        }
      }

      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else if (msg.role === 'tool') {
      // tool 消息在 Google 中转为 user 角色 + functionResponse
      const name = callIdToName.get(msg.tool_call_id) || 'unknown';
      let response = {};
      try {
        const parsed = JSON.parse(msg.content || '{}');
        // Google API 要求 functionResponse.response 必须是 object，数组不行
        if (Array.isArray(parsed)) {
          response = { result: parsed };
        } else if (typeof parsed === 'object' && parsed !== null) {
          response = parsed;
        } else {
          response = { result: msg.content || '' };
        }
      } catch {
        response = { result: msg.content || '' };
      }
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] });
    }
  }
  result.contents = contents;

  // 工具定义转换
  if (openaiBody.tools?.length) {
    result.tools = [{
      functionDeclarations: openaiBody.tools.map(t => {
        const fn = t.function || t;
        const decl = { name: fn.name || '' };
        if (fn.description) decl.description = fn.description;
        if (fn.parameters) decl.parameters = cleanSchema(fn.parameters);
        return decl;
      }),
    }];

    // 工具选择策略
    if (openaiBody.tool_choice) {
      const tc = openaiBody.tool_choice;
      if (tc === 'auto' || tc === 'required') {
        result.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      } else if (tc === 'none') {
        // 不设置 toolConfig，Google 默认不调用工具
      } else if (typeof tc === 'object' && tc.function?.name) {
        result.toolConfig = {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] },
        };
      }
    }
  }

  // 生成配置
  const genConfig = {};
  if (openaiBody.max_tokens) genConfig.maxOutputTokens = openaiBody.max_tokens;
  if (openaiBody.temperature !== undefined) genConfig.temperature = openaiBody.temperature;
  if (openaiBody.top_p !== undefined) genConfig.topP = openaiBody.top_p;
  if (Object.keys(genConfig).length > 0) result.generationConfig = genConfig;

  return result;
}

// 用户内容转为 parts[]
function convertUserContent(content) {
  if (!content) return [];
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === 'image_url' && block.image_url?.url) {
        const url = block.image_url.url;
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        } else {
          // 非 base64 的 URL 图片，用 text 引用
          parts.push({ text: `[image: ${url}]` });
        }
      }
    }
    return parts;
  }
  return [];
}

// Google Gemini 响应 → OpenAI Chat Completions 响应（非流式）
function googleToOpenAI(googleBody) {
  if (!googleBody || !googleBody.candidates?.length) {
    return { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop', index: 0 }] };
  }

  const candidate = googleBody.candidates[0];
  const parts = candidate.content?.parts || [];
  let text = '';
  const toolCalls = [];

  for (const part of parts) {
    if (part.text !== undefined && part.text !== null) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const finishReasonMap = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' };
  const finishReason = finishReasonMap[candidate.finishReason] || 'stop';

  const result = {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    model: googleBody.modelVersion || '',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: googleBody.usageMetadata?.promptTokenCount || 0,
      completion_tokens: googleBody.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: googleBody.usageMetadata?.totalTokenCount || 0,
      prompt_tokens_details: {
        cached_tokens: googleBody.usageMetadata?.cachedContentTokenCount || 0,
      },
    },
  };
  return result;
}

module.exports = { openaiToGoogle, googleToOpenAI };

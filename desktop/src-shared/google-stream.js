// Google Gemini SSE → OpenAI Chat Completions SSE 流转换器
// 输出 OpenAI 格式的 chunk 对象，供外层 ResponsesStreamTransformer 消费

const { randomBytes } = require('crypto');

// thoughtSignature 缓存：callId → thoughtSignature，供 openaiToGoogle 回注
const thoughtSigCache = new Map();
function cacheThoughtSig(callId, sig) { if (sig) thoughtSigCache.set(callId, sig); }
function getThoughtSig(callId) { return thoughtSigCache.get(callId); }
function clearThoughtSig(callId) { thoughtSigCache.delete(callId); }

class GoogleStreamTransformer {
  constructor(model) {
    this.model = model;
    this.started = false;
    this.finished = false;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cachedInputTokens = 0;
    this.toolCallIndex = 0;
  }

  // 处理一个 Google SSE JSON 对象，返回 OpenAI chunk 对象数组
  processChunk(googleObj) {
    if (!googleObj || typeof googleObj !== 'object') return [];
    // 跳过 OpenCode Zen 心跳行 {"type":"ping","cost":"..."}
    if (googleObj.type === 'ping') return [];

    // 提取 usage（可能在独立行中，没有 candidates，必须提前读取）
    if (googleObj.usageMetadata) {
      const meta = googleObj.usageMetadata;
      if (meta.promptTokenCount) this.inputTokens = meta.promptTokenCount;
      if (meta.candidatesTokenCount) this.outputTokens = meta.candidatesTokenCount;
      if (meta.cachedContentTokenCount) this.cachedInputTokens = meta.cachedContentTokenCount;
    }

    // 跳过无 candidates 的行
    if (!googleObj.candidates?.length) return [];

    // 处理 finishReason
    const finishReason = candidate.finishReason;
    const finishMap = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' };

    // 处理 parts
    for (const part of parts) {
      // 文本内容
      if (part.text !== undefined && part.text !== null) {
        // 跳过空文本 + thoughtSignature（思考签名，无实际内容），但缓存签名供下一个 functionCall 使用
        if (!part.text && part.thoughtSignature && !part.functionCall) {
          this._lastStandaloneSig = part.thoughtSignature;
          continue;
        }
        // 跳过完全空的文本（非最后一块）
        if (!part.text && !finishReason) continue;

        const delta = { content: part.text };
        if (!this.started) {
          delta.role = 'assistant';
          this.started = true;
        }
        chunks.push(this._chunk(delta));
      }

      // 函数调用
      if (part.functionCall) {
        if (!this.started) {
          chunks.push(this._chunk({ role: 'assistant' }));
          this.started = true;
        }
        const callId = `call_${randomBytes(4).toString('hex')}`;
        // 调试：记录 functionCall part 的所有字段
        const partKeys = Object.keys(part).filter(k => k !== 'functionCall');
        this._debugLog && this._debugLog(`functionCall keys=[${partKeys.join(',')}] hasThoughtSig=${!!part.thoughtSignature} lastSig=${!!this._lastStandaloneSig}`);
        // 缓存 thoughtSignature（与 functionCall 在同一 part 上）
        if (part.thoughtSignature) {
          cacheThoughtSig(callId, part.thoughtSignature);
        } else if (this._lastStandaloneSig) {
          // 使用前一个独立的 thoughtSignature part
          cacheThoughtSig(callId, this._lastStandaloneSig);
          this._lastStandaloneSig = null;
        }
        chunks.push(this._chunk({
          tool_calls: [{
            index: this.toolCallIndex++,
            id: callId,
            type: 'function',
            function: {
              name: part.functionCall.name || '',
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          }],
        }));
      }
    }

    // 发送 finish_reason
    if (finishReason) {
      chunks.push(this._chunk({}, finishMap[finishReason] || 'stop'));
      this.finished = true;
    }

    return chunks;
  }

  _chunk(delta, finishReason) {
    return {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion.chunk',
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
    };
  }

  getStats() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
    };
  }
}

module.exports = { GoogleStreamTransformer, getThoughtSig, clearThoughtSig, cacheThoughtSig };

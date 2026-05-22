// OpenAI SSE 流 → Anthropic SSE 事件流转换（核心状态机）

const crypto = require('crypto');
const { mapFinishReason } = require('./response');

function randomHex(len) {
  return crypto.randomBytes(len / 2).toString('hex');
}

// 构造 Anthropic SSE 事件字符串
function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Anthropic SSE 生成器
function eventMessageStart(msgId, model, inputTokens, cachedInputTokens) {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
        cache_read_input_tokens: cachedInputTokens || 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function eventContentBlockStart(index, block) {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: block,
  });
}

function eventContentBlockDelta(index, delta) {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta,
  });
}

function eventContentBlockStop(index) {
  return sseEvent('content_block_stop', {
    type: 'content_block_stop',
    index,
  });
}

function eventMessageDelta(stopReason, outputTokens, inputTokens, cachedInputTokens) {
  return sseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens,
      cache_read_input_tokens: cachedInputTokens || 0,
      cache_creation_input_tokens: 0,
    },
  });
}

function eventMessageStop() {
  return sseEvent('message_stop', { type: 'message_stop' });
}

class StreamTransformer {
  constructor(model, inputTokens) {
    this.msgId = `msg_${randomHex(32)}`;
    this.model = model;
    this.inputTokens = inputTokens || 0;
    this.started = false;
    this.finished = false;
    this.blockIndex = 0;
    this.currentBlockType = null; // 'thinking' | 'text' | 'tool_use'
    this.outputTokens = 0;
    this.cachedInputTokens = 0;
    // tool_use 缓冲区: toolCallIndex → { id, name, argsStr }
    this.toolUseBuf = {};
    // toolCallIndex → blockIndex 映射
    this.toolBlockIdx = {};
    // think 标签剥离状态: 0=查找<think>, 1=在think内部, 2=已闭合
    this._thinkState = 0;
    this._thinkBuf = '';
  }

  // 关闭当前 content block（如果有）
  _closeCurrentBlock() {
    const events = [];
    if (this.currentBlockType !== null) {
      events.push(eventContentBlockStop(this.blockIndex - 1));
      this.currentBlockType = null;
    }
    return events;
  }

  // 主力方法：处理一个 OpenAI SSE 解析后的 chunk，返回 Anthropic SSE 字符串数组
  processChunk(chunk) {
    if (this.finished) return [];

    // 先从顶层提取 usage（某些后端如 dashscope 把 usage 放在独立的 SSE 行，不含 choices）
    const usage = chunk.usage;
    if (usage) {
      this.inputTokens = usage.prompt_tokens || 0;
      this.outputTokens = usage.completion_tokens || 0;
      this.cachedInputTokens = usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return [];

    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;

    // 预处理器：从 delta.content 剥离 <think> 标签，转为 delta.reasoning_content
    if (delta.content) {
      if (this._thinkState < 2) {
        this._thinkBuf += delta.content;
        delta.content = undefined;

        // 状态 0 → 1: 检测 <think> 开始
        if (this._thinkState === 0) {
          const idx = this._thinkBuf.indexOf('<think>');
          if (idx >= 0) {
            const before = this._thinkBuf.substring(0, idx);
            this._thinkBuf = this._thinkBuf.substring(idx + 7).replace(/^\n/, '');
            this._thinkState = 1;
            if (before) delta.content = before;
          } else {
            delta.content = this._thinkBuf;
            this._thinkBuf = '';
          }
        }

        // 状态 1 → 2: 检测 </think> 闭合
        if (this._thinkState === 1) {
          const idx = this._thinkBuf.indexOf('</think>');
          if (idx >= 0) {
            if (idx > 0) delta.reasoning_content = this._thinkBuf.substring(0, idx);
            this._thinkBuf = this._thinkBuf.substring(idx + 8).replace(/^\n/, '');
            this._thinkState = 2;
            if (this._thinkBuf) {
              delta.content = (delta.content || '') + this._thinkBuf;
              this._thinkBuf = '';
            }
          } else {
            delta.reasoning_content = this._thinkBuf;
            this._thinkBuf = '';
          }
        }
      }
    }

    const events = [];

    // 首条有效 chunk → message_start
    if (!this.started && (delta.role || delta.content !== undefined || delta.reasoning_content !== undefined || delta.tool_calls)) {
      this.started = true;
      events.push(eventMessageStart(this.msgId, this.model, this.inputTokens, this.cachedInputTokens));
    }
    if (!this.started) return events;

    // 获取各 delta 类型
    const hasReasoning = delta.reasoning_content !== undefined && delta.reasoning_content !== null;
    const hasContent = delta.content !== undefined && delta.content !== null;
    const hasToolCalls = delta.tool_calls && delta.tool_calls.length > 0;

    // --- reasoning_content → thinking 块 ---
    if (hasReasoning) {
      if (this.currentBlockType !== 'thinking') {
        events.push(...this._closeCurrentBlock());
        const idx = this.blockIndex;
        events.push(eventContentBlockStart(idx, {
          type: 'thinking',
          thinking: '',
        }));
        events.push(eventContentBlockDelta(idx, {
          type: 'thinking_delta',
          thinking: delta.reasoning_content,
        }));
        this.currentBlockType = 'thinking';
        this.blockIndex++;
      } else {
        events.push(eventContentBlockDelta(this.blockIndex - 1, {
          type: 'thinking_delta',
          thinking: delta.reasoning_content,
        }));
      }
    }

    // --- content → text 块 ---
    if (hasContent && delta.content !== '') {
      if (this.currentBlockType !== 'text') {
        events.push(...this._closeCurrentBlock());
        const idx = this.blockIndex;
        events.push(eventContentBlockStart(idx, {
          type: 'text',
          text: '',
        }));
        events.push(eventContentBlockDelta(idx, {
          type: 'text_delta',
          text: delta.content,
        }));
        console.log(`[stream] text block #${idx} start (text='') + first delta: "${delta.content.substring(0, 60)}"`);
        this.currentBlockType = 'text';
        this.blockIndex++;
      } else {
        events.push(eventContentBlockDelta(this.blockIndex - 1, {
          type: 'text_delta',
          text: delta.content,
        }));
      }
    }

    // --- tool_calls → tool_use 块 ---
    if (hasToolCalls) {
      for (const tc of delta.tool_calls) {
        const tcIdx = tc.index;
        if (!this.toolUseBuf[tcIdx]) {
          // 新 tool_call
          events.push(...this._closeCurrentBlock());
          this.toolUseBuf[tcIdx] = {
            id: tc.id || '',
            name: tc.function?.name || '',
            argsStr: tc.function?.arguments || '',
          };
          this.toolBlockIdx[tcIdx] = this.blockIndex;
          events.push(eventContentBlockStart(this.blockIndex, {
            type: 'tool_use',
            id: this.toolUseBuf[tcIdx].id,
            name: this.toolUseBuf[tcIdx].name,
            input: {},
          }));
          if (this.toolUseBuf[tcIdx].argsStr) {
            events.push(eventContentBlockDelta(this.blockIndex, {
              type: 'input_json_delta',
              partial_json: this.toolUseBuf[tcIdx].argsStr,
            }));
          }
          this.currentBlockType = 'tool_use';
          this.blockIndex++;
        } else {
          // 已有 tool_call，追加 arguments
          const entry = this.toolUseBuf[tcIdx];
          const frag = tc.function?.arguments || '';
          if (frag) {
            entry.argsStr += frag;
            events.push(eventContentBlockDelta(this.toolBlockIdx[tcIdx], {
              type: 'input_json_delta',
              partial_json: frag,
            }));
          }
        }
      }
    }

    // --- finish_reason → 结束 ---
    if (finishReason) {
      this.finished = true;
      events.push(...this._closeCurrentBlock());
      events.push(eventMessageDelta(mapFinishReason(finishReason), this.outputTokens, this.inputTokens, this.cachedInputTokens));
      events.push(eventMessageStop());
    }

    return events;
  }

  // 获取最终 token 统计（流结束后调用）
  getStats() {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens, cachedInputTokens: this.cachedInputTokens };
  }

  // Google 路径专用：用后端返回的实际 token 覆盖本地估算
  updateStats(inputTokens, outputTokens, cachedInputTokens) {
    this.inputTokens = inputTokens || this.inputTokens;
    this.outputTokens = outputTokens || this.outputTokens;
    this.cachedInputTokens = cachedInputTokens || 0;
  }
}

module.exports = { StreamTransformer };

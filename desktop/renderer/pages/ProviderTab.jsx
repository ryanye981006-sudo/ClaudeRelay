import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

const PROTOCOLS = [
  { value: 'openai', label: 'OpenAI (Chat Completions)' },
  { value: 'anthropic', label: 'Anthropic (Messages)' },
  { value: 'google', label: 'Google (Gemini)' },
];

const s = {
  page: { maxWidth: 720 },
  title: { fontSize: 18, fontWeight: 600, marginBottom: 16 },
  card: { background: '#1f2133', borderRadius: 8, border: '1px solid #2f3346', marginBottom: 12, overflow: 'hidden' },
  cardHd: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #2f3346' },
  cardBd: { padding: '12px 16px' },
  pName: { fontSize: 15, fontWeight: 600, color: '#7dcfff' },
  pUrl: { fontSize: 12, color: '#787c99', marginTop: 2 },
  modelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #252837' },
  btn: { padding: '6px 14px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  btnPri: { background: '#7dcfff', color: '#1a1b26' },
  btnDgr: { background: 'transparent', color: '#f7768e', border: '1px solid #f7768e' },
  btnOut: { background: 'transparent', color: '#7dcfff', border: '1px solid #7dcfff' },
  btnSm: { padding: '3px 8px', fontSize: 11, background: 'transparent', color: '#f7768e', border: '1px solid #3b3f5c', borderRadius: 3, cursor: 'pointer' },
  btnSmPri: { padding: '3px 8px', fontSize: 11, background: '#7dcfff', color: '#1a1b26', border: 'none', borderRadius: 3, cursor: 'pointer' },
  btnSmOut: { padding: '3px 8px', fontSize: 11, background: 'transparent', color: '#7dcfff', border: '1px solid #7dcfff', borderRadius: 3, cursor: 'pointer' },
  input: { width: '100%', padding: '8px 10px', background: '#16161e', border: '1px solid #2f3346', borderRadius: 4, color: '#c0caf5', fontSize: 13, marginBottom: 10, outline: 'none' },
  select: { width: '100%', padding: '8px 10px', background: '#16161e', border: '1px solid #2f3346', borderRadius: 4, color: '#c0caf5', fontSize: 13, marginBottom: 10, outline: 'none' },
  label: { fontSize: 12, color: '#787c99', marginBottom: 4, display: 'block' },
  modalOver: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: '#1f2133', borderRadius: 10, border: '1px solid #2f3346', padding: 24, width: 440, maxHeight: '80vh', overflow: 'auto' },
  modalTl: { fontSize: 16, fontWeight: 600, marginBottom: 16 },
  hint: { fontSize: 11, color: '#787c99', marginTop: 4 },
  btnGrp: { display: 'flex', gap: 8 },
  checkbox: { marginRight: 8, cursor: 'pointer' },
  fetchBtn: { padding: '3px 10px', fontSize: 11, background: 'transparent', color: '#bb9af7', border: '1px solid #bb9af7', borderRadius: 3, cursor: 'pointer' },
  verifying: { fontSize: 11, color: '#e0af68', marginLeft: 8 },
};

export default function ProviderTab() {
  const [providers, setProviders] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: '', apiBaseUrl: '', apiKey: '', protocol: 'openai' });
  const [newModelName, setNewModelName] = useState('');
  const [testResults, setTestResults] = useState({});
  const [expandedId, setExpandedId] = useState(null);
  const [expandedModels, setExpandedModels] = useState([]);

  // 模型获取弹窗
  const [showFetchDialog, setShowFetchDialog] = useState(false);
  const [fetchProviderId, setFetchProviderId] = useState(null);
  const [fetchedModels, setFetchedModels] = useState([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [selectedModels, setSelectedModels] = useState(new Set());

  // 模型验证状态
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);

  const loadProviders = useCallback(async () => {
    const list = await api.getProviders();
    setProviders(list);
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const openAddForm = () => {
    setEditingId(null);
    setForm({ name: '', apiBaseUrl: '', apiKey: '', protocol: 'openai' });
    setShowForm(true);
  };

  const openEditForm = (p) => {
    setEditingId(p.id);
    setForm({ name: p.name, apiBaseUrl: p.apiBaseUrl, apiKey: p.apiKey, protocol: p.protocol });
    setShowForm(true);
  };

  const saveForm = async () => {
    if (!form.name || !form.apiBaseUrl || !form.apiKey) return;
    if (editingId) {
      await api.updateProvider(editingId, form);
    } else {
      await api.addProvider(form);
    }
    setShowForm(false);
    loadProviders();
  };

  const deleteProvider = async (id) => {
    await api.deleteProvider(id);
    setExpandedId(null);
    loadProviders();
  };

  const toggleExpand = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      const models = await api.getModels(id);
      setExpandedModels(models);
      setVerifyResult(null);
    }
  };

  // 手动添加模型（带验证）
  const addModel = async (providerId) => {
    const name = newModelName.trim();
    if (!name) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await api.verifyModel(providerId, name);
      if (res.ok) {
        await api.addModel(providerId, name);
        setNewModelName('');
        setVerifyResult(null);
        const models = await api.getModels(providerId);
        setExpandedModels(models);
        loadProviders();
      } else {
        setVerifyResult({ error: res.error || '模型验证失败' });
      }
    } catch (e) {
      setVerifyResult({ error: e.message });
    }
    setVerifying(false);
  };

  // 从 API 获取模型列表
  const openFetchModels = async (providerId) => {
    setFetchProviderId(providerId);
    setFetchedModels([]);
    setSelectedModels(new Set());
    setFetchLoading(true);
    setFetchError('');
    setShowFetchDialog(true);

    try {
      const res = await api.fetchModels(providerId);
      if (res.models && res.models.length > 0) {
        setFetchedModels(res.models);
      } else {
        setFetchError(res.hint || '无法获取模型列表');
      }
    } catch (e) {
      setFetchError(e.message);
    }
    setFetchLoading(false);
  };

  // 勾选/取消模型
  const toggleModelSelect = (modelName) => {
    const next = new Set(selectedModels);
    if (next.has(modelName)) next.delete(modelName); else next.add(modelName);
    setSelectedModels(next);
  };

  // 批量添加选中模型
  const batchAddModels = async () => {
    const existingNames = new Set(expandedModels.map(m => m.name));
    for (const name of selectedModels) {
      if (!existingNames.has(name)) {
        try { await api.addModel(fetchProviderId, name); } catch {}
      }
    }
    setShowFetchDialog(false);
    const models = await api.getModels(fetchProviderId);
    setExpandedModels(models);
    loadProviders();
  };

  const deleteModel = async (modelId, providerId) => {
    await api.deleteModel(modelId);
    const models = await api.getModels(providerId);
    setExpandedModels(models);
    loadProviders();
  };

  const testConnection = async (providerId) => {
    setTestResults(prev => ({ ...prev, [providerId]: { testing: true } }));
    const result = await api.testConnection(providerId);
    setTestResults(prev => ({ ...prev, [providerId]: result }));
  };

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={s.title}>API 源管理</div>
        <button style={{ ...s.btn, ...s.btnPri }} onClick={openAddForm}>+ 添加 API 源</button>
      </div>

      {providers.length === 0 && (
        <div style={{ color: '#787c99', textAlign: 'center', padding: 40 }}>暂无 API 源，点击上方按钮添加</div>
      )}

      {providers.map(p => (
        <div key={p.id} style={s.card}>
          <div style={s.cardHd}>
            <div>
              <div style={s.pName}>{p.name}</div>
              <div style={s.pUrl}>{p.apiBaseUrl}</div>
            </div>
            <div style={s.btnGrp}>
              <button style={{ ...s.btn, ...s.btnOut }} onClick={() => toggleExpand(p.id)}>
                {expandedId === p.id ? '收起' : '管理模型'}
              </button>
              <button style={{ ...s.btn, ...s.btnOut }} onClick={() => openEditForm(p)}>编辑</button>
              <button style={{ ...s.btn, ...s.btnDgr }} onClick={() => deleteProvider(p.id)}>删除</button>
            </div>
          </div>

          {expandedId === p.id && (
            <div style={s.cardBd}>
              <div style={{ fontSize: 12, color: '#787c99', marginBottom: 8 }}>
                <span>协议: {p.protocol} &nbsp;|&nbsp; 端点: {
                  p.protocol === 'anthropic' ? `${p.apiBaseUrl.replace(/\/$/, '')}/v1/messages`
                  : p.protocol === 'google' ? `${p.apiBaseUrl.replace(/\/$/, '')}/v1/models/<模型名>:streamGenerateContent`
                  : `${p.apiBaseUrl.replace(/\/$/, '')}/v1/chat/completions`
                }</span>
                <button style={{ ...s.btn, ...s.btnSmOut, marginLeft: 12 }} onClick={() => testConnection(p.id)}>
                  {testResults[p.id]?.testing ? '测试中...' : '测试连接'}
                </button>
                {testResults[p.id] && !testResults[p.id].testing && (
                  <span style={{ marginLeft: 8, color: testResults[p.id].ok ? '#9ece6a' : '#f7768e', fontSize: 11 }}>
                    {testResults[p.id].ok ? '✓ 连通' : `✗ ${testResults[p.id].error}`}
                  </span>
                )}
              </div>

              <div style={{ marginBottom: 10 }}>
                {expandedModels.length === 0 && <div style={{ color: '#5a5f7f', fontSize: 12 }}>暂无模型</div>}
                {expandedModels.map(m => (
                  <div key={m.id} style={s.modelRow}>
                    <span style={{ fontSize: 13 }}>{m.name}</span>
                    <button style={s.btnSm} onClick={() => deleteModel(m.id, p.id)}>删除</button>
                  </div>
                ))}
              </div>

              {/* 手动添加模型（带验证） */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  style={{ ...s.input, marginBottom: 0, flex: 1 }}
                  placeholder="输入模型名，回车验证并添加"
                  value={newModelName}
                  onChange={e => { setNewModelName(e.target.value); setVerifyResult(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') addModel(p.id); }}
                />
                <button style={{ ...s.btn, ...s.btnPri }} onClick={() => addModel(p.id)} disabled={verifying}>
                  {verifying ? '验证中...' : '添加'}
                </button>
              </div>
              {verifyResult && verifyResult.error && (
                <div style={{ color: '#f7768e', fontSize: 11, marginBottom: 8 }}>✗ {verifyResult.error}</div>
              )}

              {/* 从 API 获取模型列表（仅 OpenAI） */}
              {p.protocol === 'openai' && (
                <button style={s.fetchBtn} onClick={() => openFetchModels(p.id)}>
                  从 API 获取模型列表
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {/* 添加/编辑 API 源弹窗 */}
      {showForm && (
        <div style={s.modalOver} onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div style={s.modal}>
            <div style={s.modalTl}>{editingId ? '编辑 API 源' : '添加 API 源'}</div>
            <label style={s.label}>名称</label>
            <input style={s.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="如 DeepSeek API" />
            <label style={s.label}>API Base URL</label>
            <input style={s.input} value={form.apiBaseUrl} onChange={e => setForm({ ...form, apiBaseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
            <div style={s.hint}>填入 API 根地址，程序会根据协议自动拼接 /chat/completions 或 /messages</div>
            <label style={s.label}>API Key</label>
            <input style={s.input} type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-xxx" />
            <label style={s.label}>协议</label>
            <select style={s.select} value={form.protocol} onChange={e => setForm({ ...form, protocol: e.target.value })}>
              {PROTOCOLS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            <div style={{ ...s.hint, marginBottom: 16 }}>
              OpenAI: 自动拼接 /chat/completions，支持获取模型列表<br />
              Anthropic: 自动拼接 /messages，需手动输入模型名验证<br />
              Google (Gemini): 自动拼接 /v1/models/&lt;模型名&gt;:streamGenerateContent
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={{ ...s.btn, ...s.btnOut }} onClick={() => setShowForm(false)}>取消</button>
              <button style={{ ...s.btn, ...s.btnPri }} onClick={saveForm}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 获取模型列表弹窗 */}
      {showFetchDialog && (
        <div style={s.modalOver} onClick={(e) => { if (e.target === e.currentTarget) setShowFetchDialog(false); }}>
          <div style={s.modal}>
            <div style={s.modalTl}>从 API 获取模型列表</div>
            {fetchLoading ? (
              <div style={{ color: '#787c99', textAlign: 'center', padding: 30 }}>获取中...</div>
            ) : fetchError ? (
              <div style={{ color: '#f7768e', textAlign: 'center', padding: 30 }}>{fetchError}</div>
            ) : fetchedModels.length === 0 ? (
              <div style={{ color: '#787c99', textAlign: 'center', padding: 30 }}>未获取到模型</div>
            ) : (
              <div style={{ maxHeight: 400, overflow: 'auto' }}>
                {fetchedModels.map(name => (
                  <div key={name} style={{ ...s.modelRow, cursor: 'pointer' }} onClick={() => toggleModelSelect(name)}>
                    <input type="checkbox" style={s.checkbox} checked={selectedModels.has(name)} onChange={() => toggleModelSelect(name)} />
                    <span style={{ fontSize: 13, flex: 1 }}>{name}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={{ ...s.btn, ...s.btnOut }} onClick={() => setShowFetchDialog(false)}>取消</button>
              <button style={{ ...s.btn, ...s.btnPri }} onClick={batchAddModels} disabled={selectedModels.size === 0}>
                添加选中 ({selectedModels.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

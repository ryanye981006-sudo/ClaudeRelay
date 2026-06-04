import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import { modelDisplayName } from '../App';

const s = {
  page: { maxWidth: 720 },
  title: { fontSize: 18, fontWeight: 600, marginBottom: 16 },
  // 配置卡片
  cfgCard: { background: '#1f2133', borderRadius: 8, border: '1px solid #2f3346', marginBottom: 12, overflow: 'hidden' },
  cfgCardActive: { background: '#1f2133', borderRadius: 8, border: '2px solid #7dcfff', marginBottom: 12, overflow: 'hidden' },
  cfgHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' },
  cfgName: { fontSize: 15, fontWeight: 600, color: '#c0caf5' },
  cfgMeta: { fontSize: 12, color: '#787c99', marginTop: 2 },
  activeBadge: { display: 'inline-block', background: '#7dcfff', color: '#1a1b26', padding: '1px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600, marginLeft: 8 },
  cfgBody: { padding: '0 16px 12px 16px', borderTop: '1px solid #2f3346' },
  // 模型行
  modelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #252837' },
  modelName: { fontSize: 13, color: '#c0caf5' },
  modelProvider: { fontSize: 11, color: '#787c99', marginTop: 1 },
  // 按钮
  btn: { padding: '6px 14px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  btnPri: { background: '#7dcfff', color: '#1a1b26' },
  btnOut: { background: 'transparent', color: '#7dcfff', border: '1px solid #7dcfff' },
  btnDgr: { background: 'transparent', color: '#f7768e', border: '1px solid #f7768e' },
  btnSm: { padding: '3px 10px', fontSize: 11, background: 'transparent', color: '#f7768e', border: '1px solid #3b3f5c', borderRadius: 3, cursor: 'pointer' },
  btnSmPri: { padding: '3px 10px', fontSize: 11, background: '#7dcfff', color: '#1a1b26', border: 'none', borderRadius: 3, cursor: 'pointer' },
  btnSmOut: { padding: '3px 10px', fontSize: 11, background: 'transparent', color: '#7dcfff', border: '1px solid #7dcfff', borderRadius: 3, cursor: 'pointer' },
  btnGroup: { display: 'flex', gap: 6 },
  // 其他
  hint: { fontSize: 12, color: '#787c99', marginTop: 16, fontStyle: 'italic' },
  portHint: { fontSize: 11, color: '#bb9af7', marginTop: 8, padding: '8px 12px', background: '#1f1a33', borderRadius: 4, border: '1px solid #2f3346' },
  empty: { color: '#787c99', textAlign: 'center', padding: 40 },
  successMsg: { background: '#1a3a2a', border: '1px solid #3d6b4f', color: '#9ece6a', padding: '10px 14px', borderRadius: 6, fontSize: 13, marginTop: 12 },
  // 弹窗
  modalOver: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: '#1f2133', borderRadius: 10, border: '1px solid #2f3346', padding: 24, width: 460, maxHeight: '70vh', overflow: 'auto' },
  modalTl: { fontSize: 16, fontWeight: 600, marginBottom: 16 },
  pickItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#252837', borderRadius: 6, marginBottom: 6, cursor: 'pointer' },
  pickItemName: { fontSize: 13, color: '#c0caf5' },
  pickItemProvider: { fontSize: 11, color: '#787c99' },
  input: { width: '100%', padding: '8px 10px', background: '#16161e', border: '1px solid #2f3346', borderRadius: 4, color: '#c0caf5', fontSize: 13, marginBottom: 10, outline: 'none' },
  label: { fontSize: 12, color: '#787c99', marginBottom: 4, display: 'block' },
};

export default function CodexTab() {
  const [configs, setConfigs] = useState([]);
  const [allProviders, setAllProviders] = useState([]);
  const [expandedId, setExpandedId] = useState(null);

  // 新建配置弹窗
  const [showNewCfg, setShowNewCfg] = useState(false);
  const [newCfgName, setNewCfgName] = useState('');

  // 添加模型弹窗
  const [showAddModel, setShowAddModel] = useState(false);
  const [addTargetCfgId, setAddTargetCfgId] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);

  // 错误提示
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadData = useCallback(async () => {
    const [cfgs, providers] = await Promise.all([
      api.getConfigs('codex'),
      api.getProviders(),
    ]);
    setConfigs(cfgs);
    setAllProviders(providers);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // 新建配置
  const handleAddConfig = async () => {
    if (!newCfgName.trim()) return;
    setErrorMsg('');
    try {
      await api.addConfig('codex', newCfgName.trim());
      setNewCfgName('');
      setShowNewCfg(false);
      loadData();
    } catch (e) {
      setErrorMsg(`创建配置失败: ${e.message || '未知错误'}`);
    }
  };

  // 删除配置
  const handleDeleteConfig = async (configId) => {
    await api.deleteConfig('codex', configId);
    if (expandedId === configId) setExpandedId(null);
    loadData();
  };

  // 启用配置 → 写入配置文件
  const handleActivate = async (configId) => {
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await api.setActiveConfig('codex', configId);
      setSuccessMsg('配置已启用，config.toml 写入成功，重启 Codex 后生效');
    } catch (e) {
      setErrorMsg(`写入 Codex 配置失败: ${e.message || '未知错误'}。请检查 ~/.codex/config.toml 权限，或手动写入。`);
    }
    loadData();
  };

  // 切换展开
  const toggleExpand = (configId) => {
    setExpandedId(expandedId === configId ? null : configId);
  };

  // 打开添加模型弹窗
  const openAddModel = async (configId) => {
    setAddTargetCfgId(configId);
    const providers = await api.getProviders();
    const cfgs = await api.getConfigs('codex');
    const cfg = cfgs.find(c => c.id === configId);
    const cfgModelIds = new Set(cfg?.models?.map(m => m.id) || []);

    const all = [];
    for (const p of providers) {
      const models = await api.getModels(p.id);
      for (const m of models) {
        if (!cfgModelIds.has(m.id)) {
          all.push({ ...m, provider: p });
        }
      }
    }
    setAvailableModels(all);
    setShowAddModel(true);
  };

  // 添加模型到配置
  const handleAddModelToConfig = async (modelId) => {
    await api.addModelToConfig('codex', addTargetCfgId, modelId);
    setShowAddModel(false);
    loadData();
  };

  // 从配置移除模型
  const handleRemoveModel = async (configId, modelId) => {
    await api.removeModelFromConfig('codex', configId, modelId);
    loadData();
  };

  const activeCfg = configs.find(c => c.isActive);

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={s.title}>Codex 配置</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ ...s.btn, ...s.btnOut }} onClick={() => setShowNewCfg(true)}>+ 新建配置</button>
        </div>
      </div>

      {/* 当前激活配置提示 */}
      {activeCfg ? (
        <div style={{ ...s.cfgCardActive, padding: 12, marginBottom: 16 }}>
          <span style={s.activeBadge}>当前使用</span>
          <span style={{ fontSize: 14, color: '#c0caf5', marginLeft: 8 }}>{activeCfg.name}</span>
          <span style={{ fontSize: 12, color: '#787c99', marginLeft: 8 }}>({activeCfg.models?.length || 0} 个模型)</span>
        </div>
      ) : (
        <div style={{ ...s.cfgCard, padding: 16, marginBottom: 16, textAlign: 'center' }}>
          <span style={{ color: '#787c99' }}>暂无配置，请新建配置</span>
        </div>
      )}

      {/* 错误/成功提示 */}
      {errorMsg && (
        <div style={{ background: '#3a1a1a', border: '1px solid #6b3d3d', color: '#f7768e', padding: '10px 14px', borderRadius: 6, fontSize: 13, marginBottom: 12, whiteSpace: 'pre-wrap' }}>{errorMsg}</div>
      )}
      {successMsg && (
        <div style={s.successMsg}>{successMsg}</div>
      )}

      {/* 配置列表 */}
      {configs.map(cfg => (
        <div key={cfg.id} style={cfg.isActive ? s.cfgCardActive : s.cfgCard}>
          <div style={s.cfgHeader}>
            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => toggleExpand(cfg.id)}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span style={s.cfgName}>{cfg.name}</span>
                {cfg.isActive && <span style={s.activeBadge}>使用中</span>}
              </div>
              <div style={s.cfgMeta}>{cfg.models?.length || 0} 个模型</div>
            </div>
            <div style={s.btnGroup}>
              {!cfg.isActive && (
                <button style={s.btnSmPri} onClick={() => handleActivate(cfg.id)}>启用</button>
              )}
              <button style={s.btnSmOut} onClick={() => openAddModel(cfg.id)}>
                {cfg.models && cfg.models.length > 0 ? '替换模型' : '+ 模型'}
              </button>
              <button style={s.btnSm} onClick={() => handleDeleteConfig(cfg.id)}>删除</button>
            </div>
          </div>

          {/* 展开：模型列表 */}
          {expandedId === cfg.id && (
            <div style={s.cfgBody}>
              {(!cfg.models || cfg.models.length === 0) ? (
                <div style={{ color: '#5a5f7f', fontSize: 12, padding: '12px 0', textAlign: 'center' }}>
                  暂无模型，点击「+ 模型」添加
                </div>
              ) : (
                cfg.models.map(m => (
                  <div key={m.id} style={s.modelRow}>
                    <div>
                      <div style={s.modelName}>{modelDisplayName(m)}</div>
                      <div style={s.modelProvider}>{m.provider?.apiBaseUrl}</div>
                    </div>
                    <button style={s.btnSm} onClick={() => handleRemoveModel(cfg.id, m.id)}>移除</button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}

      {configs.length === 0 && (
        <div style={s.empty}>暂无配置，点击「+ 新建配置」创建一个模型组合方案</div>
      )}

      <div style={s.hint}>
        提示: 新建配置 → 添加一个模型 → 点击「启用」自动写入 Codex 配置文件，重启 Codex 后生效。每个配置只能添加一个模型。
      </div>
      <div style={s.portHint}>
        Codex 代理地址: http://127.0.0.1:18889 — 启用配置后，base_url 自动指向此地址，重启 Codex 后生效
      </div>

      {/* 新建配置弹窗 */}
      {showNewCfg && (
        <div style={s.modalOver} onClick={(e) => { if (e.target === e.currentTarget) setShowNewCfg(false); }}>
          <div style={s.modal}>
            <div style={s.modalTl}>新建 Codex 配置</div>
            <label style={s.label}>配置名称</label>
            <input
              style={s.input}
              placeholder="如 日常工作、重度推理"
              value={newCfgName}
              onChange={e => setNewCfgName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddConfig(); }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button style={{ ...s.btn, ...s.btnOut }} onClick={() => setShowNewCfg(false)}>取消</button>
              <button style={{ ...s.btn, ...s.btnPri }} onClick={handleAddConfig}>创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 添加模型弹窗 */}
      {showAddModel && (
        <div style={s.modalOver} onClick={(e) => { if (e.target === e.currentTarget) setShowAddModel(false); }}>
          <div style={s.modal}>
            <div style={s.modalTl}>添加模型到配置</div>
            {availableModels.length === 0 ? (
              <div style={{ color: '#787c99', padding: 20, textAlign: 'center' }}>
                没有可添加的模型，请先在「API 源」中添加
              </div>
            ) : (
              availableModels.map(m => (
                <div key={m.id} style={s.pickItem} onClick={() => handleAddModelToConfig(m.id)}>
                  <div>
                    <div style={s.pickItemName}>{modelDisplayName(m)}</div>
                    <div style={s.pickItemProvider}>{m.provider.apiBaseUrl}</div>
                  </div>
                  <span style={{ color: '#7dcfff', fontSize: 18 }}>+</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

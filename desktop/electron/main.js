// Electron 主进程入口

process.env.NO_PROXY = 'localhost,127.0.0.1';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const {
  getProviders, addProvider, updateProvider, deleteProvider,
  getModels, addModel, deleteModel,
  getConfigs, addConfig, deleteConfig, renameConfig,
  addModelToConfig, removeModelFromConfig, setActiveConfig, getActiveConfig,
  getCategoryModels, addModelToCategory, removeModelFromCategory, setActiveModel, getActiveModel,
  modelRoutingKey, getContextModels,
} = require('../src-electron/data-store');
const { writeCodexConfig, ensureConfigFile } = require('../src-electron/config-writer');
const { writeCCConfig, ensureCCConfigFile } = require('../src-electron/cc-config-writer');
const { createCodexServer, createCCServer, stopServer } = require('../src-electron/proxy-engine');
const { createUIServer } = require('../src-electron/ui-server');

const CODEX_PORT = 18889;
const CC_PORT = 18888;
const UI_PORT = 18900;

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return;
}

let mainWindow = null;
let codexServer = null;
let ccServer = null;
let uiServer = null;
let tray = null;
let isQuitting = false;

app.on('second-instance', () => {
  // 用户尝试启动第二个实例 → 显示已有窗口
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// 启动代理和 UI 服务
async function startProxies() {
  try {
    codexServer = await createCodexServer(CODEX_PORT);
    console.log(`[main] Codex 代理已启动 :${CODEX_PORT}`);
  } catch (e) {
    console.error(`[main] Codex 代理启动失败: ${e.message}`);
  }
  try {
    ccServer = await createCCServer(CC_PORT);
    console.log(`[main] CC 代理已启动 :${CC_PORT}`);
  } catch (e) {
    console.error(`[main] CC 代理启动失败: ${e.message}`);
  }
  try {
    uiServer = createUIServer(UI_PORT, CODEX_PORT, CC_PORT);
    await new Promise((resolve) => uiServer.listen(UI_PORT, '127.0.0.1', resolve));
    console.log(`[main] UI 服务已启动 :${UI_PORT}`);
  } catch (e) {
    console.error(`[main] UI 服务启动失败: ${e.message}`);
  }
}

// 注册所有 IPC 处理器
function registerIpcHandlers() {
  // Provider CRUD
  ipcMain.handle('get-providers', () => getProviders());
  ipcMain.handle('add-provider', (_, data) => addProvider(data));
  ipcMain.handle('update-provider', (_, id, data) => updateProvider(id, data));
  ipcMain.handle('delete-provider', (_, id) => { deleteProvider(id); });

  // Model CRUD
  ipcMain.handle('get-models', (_, providerId) => getModels(providerId));
  ipcMain.handle('add-model', (_, providerId, name) => addModel(providerId, name));
  ipcMain.handle('delete-model', (_, id) => { deleteModel(id); });

  // Config CRUD
  ipcMain.handle('get-configs', (_, category) => getConfigs(category));
  ipcMain.handle('add-config', (_, category, name) => {
    const cfg = addConfig(category, name);
    if (category === 'codex') ensureConfigFile();
    else if (category === 'claude') ensureCCConfigFile();
    return cfg;
  });
  ipcMain.handle('delete-config', (_, category, configId) => deleteConfig(category, configId));
  ipcMain.handle('rename-config', (_, category, configId, name) => renameConfig(category, configId, name));
  ipcMain.handle('add-model-to-config', (_, category, configId, modelId, slotIndex) => {
    addModelToConfig(category, configId, modelId, slotIndex);
    if (category === 'codex') {
      const activeCfg = getActiveConfig('codex');
      if (activeCfg && activeCfg.id === configId && activeCfg.models.length > 0) {
        writeCodexConfig(modelRoutingKey(activeCfg.models[0]), CODEX_PORT);
      }
    } else if (category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg && activeCfg.id === configId) {
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const { getModelWithProvider } = require('../src-electron/data-store');
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) {
          const contextRoutingKeys = new Set(getContextModels().map(m => modelRoutingKey(m)));
          writeCCConfig(routingKeys, CC_PORT, undefined, contextRoutingKeys);
        }
      }
    }
  });
  ipcMain.handle('remove-model-from-config', (_, category, configId, modelId, slotIndex) => removeModelFromConfig(category, configId, modelId, slotIndex));
  ipcMain.handle('set-active-config', (_, category, configId) => {
    // 先写入配置文件，成功后再更新 data.json
    if (category === 'codex') {
      const cfgs = getConfigs('codex') || [];
      const cfg = cfgs.find(c => c.id === configId);
      if (cfg && cfg.models && cfg.models.length > 0) {
        writeCodexConfig(modelRoutingKey(cfg.models[0]), CODEX_PORT);
      }
    }
    setActiveConfig(category, configId);
    if (category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg) {
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const { getModelWithProvider } = require('../src-electron/data-store');
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) {
          const contextRoutingKeys = new Set(getContextModels().map(m => modelRoutingKey(m)));
          writeCCConfig(routingKeys, CC_PORT, undefined, contextRoutingKeys);
        }
      }
    }
  });

  // 配置写入
  ipcMain.handle('apply-codex-config', () => {
    const activeCfg = getActiveConfig('codex');
    if (!activeCfg || activeCfg.models.length === 0) throw new Error('Codex 分类下没有激活的配置');
    const routingKey = modelRoutingKey(activeCfg.models[0]);
    const result = writeCodexConfig(routingKey, CODEX_PORT);
    return { ...result, configName: activeCfg.name, routingKey };
  });

  // 代理状态
  ipcMain.handle('get-proxy-status', () => ({
    running: codexServer !== null || ccServer !== null,
    codexPort: CODEX_PORT,
    ccPort: CC_PORT,
  }));

  // 测试连接：发一个最小请求到 Provider
  ipcMain.handle('test-connection', async (_, providerId) => {
    const providers = getProviders();
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return { ok: false, error: 'API 源不存在' };

    const url = new URL(provider.apiBaseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? require('https') : http;
    const body = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });

    return new Promise((resolve) => {
      const req = transport.request({
        hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
        timeout: 10000,
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 401 || res.statusCode === 403) {
            resolve({ ok: true, status: res.statusCode });
          } else {
            resolve({ ok: false, error: `后端返回 ${res.statusCode}: ${data.substring(0, 200)}` });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '连接超时' }); });
      req.write(body);
      req.end();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 500,
    title: 'ClaudeRelay Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const distIndex = path.join(__dirname, '..', 'dist-renderer', 'index.html');
  const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(distIndex);
  }

  // 关闭窗口 → 最小化到托盘
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// 创建系统托盘
function createTray() {
  const size = 16;
  const rawBuffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const cx = 8, cy = 8;
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d <= 6.5) {
        rawBuffer[idx] = 60;
        rawBuffer[idx + 1] = 160;
        rawBuffer[idx + 2] = 210;
        rawBuffer[idx + 3] = 255;
      }
    }
  }
  const pngBuffer = encodePNG(rawBuffer, size, size);
  const trayIcon = nativeImage.createFromBuffer(pngBuffer);

  tray = new Tray(trayIcon);
  tray.setToolTip('ClaudeRelay Desktop');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        if (mainWindow) mainWindow.close();
        cleanupAndQuit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 最小 PNG 编码器（不依赖第三方库）
function encodePNG(rgba, width, height) {
  const zlib = require('zlib');

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    rgba.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const deflated = zlib.deflateSync(rawData);

  function crc32(buf) {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c;
    }
    c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeB = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
    return Buffer.concat([len, typeB, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 清理服务并退出
async function cleanupAndQuit() {
  if (uiServer) uiServer.close();
  if (codexServer) await stopServer(codexServer);
  if (ccServer) await stopServer(ccServer);
  app.quit();
  // 兜底：2 秒后强制退出，确保托盘退出不残留进程
  setTimeout(() => process.exit(0), 2000);
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await startProxies();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 不退出，保持托盘运行
});

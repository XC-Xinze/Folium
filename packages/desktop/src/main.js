import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const devProjectRoot = resolve(__dirname, '..', '..', '..');
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const apiToken = process.env.FOLIUM_API_TOKEN ?? randomBytes(32).toString('hex');

let backendProcess = null;
let backendPort = process.env.PORT ?? '8000';
let backendUrl = `http://127.0.0.1:${backendPort}`;
let backendLogPath = '';

function projectRoot() {
  return app.isPackaged ? app.getAppPath() : devProjectRoot;
}

function findAvailablePort(preferredPort) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.on('error', () => {
      const fallback = createServer();
      fallback.unref();
      fallback.listen(0, '127.0.0.1', () => {
        const address = fallback.address();
        const port = typeof address === 'object' && address ? address.port : Number(preferredPort);
        fallback.close(() => resolvePort(String(port)));
      });
    });
    server.listen(Number(preferredPort), '127.0.0.1', () => {
      server.close(() => resolvePort(String(preferredPort)));
    });
  });
}

async function startBackend() {
  if (process.env.ELECTRON_SKIP_BACKEND === '1') return;

  backendPort = await findAvailablePort(backendPort);
  backendUrl = `http://127.0.0.1:${backendPort}`;
  process.env.FOLIUM_BACKEND_ORIGIN = backendUrl;
  backendLogPath = join(app.getPath('userData'), 'backend.log');
  const backendLog = createWriteStream(backendLogPath, { flags: 'a' });
  backendLog.write(`\n[${new Date().toISOString()}] Starting Folium backend at ${backendUrl}\n`);

  const root = projectRoot();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: backendPort,
    DB_PATH: process.env.DB_PATH ?? join(app.getPath('userData'), 'index.db'),
    FOLIUM_CONFIG_DIR: process.env.FOLIUM_CONFIG_DIR ?? app.getPath('userData'),
    FOLIUM_API_TOKEN: apiToken,
    CORS_ORIGINS: rendererUrl ?? 'http://localhost:5173,http://127.0.0.1:5173',
    FOLIUM_DISABLE_EXAMPLE_VAULT: app.isPackaged ? '1' : (process.env.FOLIUM_DISABLE_EXAMPLE_VAULT ?? ''),
  };

  if (app.isPackaged) {
    backendProcess = spawn(process.execPath, [join(root, 'packages', 'backend', 'dist', 'index.js')], {
      cwd: root,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProcess.stdout?.pipe(backendLog, { end: false });
    backendProcess.stderr?.pipe(backendLog, { end: false });
    backendProcess.on('error', (err) => {
      backendLog.write(`[${new Date().toISOString()}] Backend process error: ${err.stack ?? err.message}\n`);
    });
    backendProcess.on('exit', (code, signal) => {
      backendLog.write(`[${new Date().toISOString()}] Backend exited with code=${code} signal=${signal}\n`);
    });
    return;
  }

  backendProcess = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start', '--workspace=backend'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backendProcess.stdout?.pipe(process.stdout);
  backendProcess.stderr?.pipe(process.stderr);
  backendProcess.stdout?.pipe(backendLog, { end: false });
  backendProcess.stderr?.pipe(backendLog, { end: false });
}

function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
  backendProcess = null;
}

async function openBackendFailureWindow(message) {
  const win = new BrowserWindow({
    width: 720,
    height: 360,
    title: 'Folium',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px; color: #1c1b1b; background: #fdf8f8;">
          <h2>Folium backend failed to start</h2>
          <p>${message}</p>
          <p style="color: #747878;">Backend log: ${backendLogPath || 'not available'}</p>
          <p style="color: #747878;">Please quit and reopen the app. If this keeps happening, send the backend log with the bug report.</p>
        </body>
      </html>
    `)}`,
  );
}

async function waitForBackend(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${backendUrl}/api/health`, {
        headers: { 'X-Folium-Token': apiToken },
      });
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Backend did not become ready at ${backendUrl}`);
}

async function createWindow() {
  await startBackend();
  try {
    await waitForBackend();
  } catch (err) {
    await openBackendFailureWindow((err instanceof Error ? err.message : String(err)));
    return;
  }

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Folium',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (rendererUrl) {
    await win.loadURL(rendererUrl);
  } else {
    await win.loadFile(join(projectRoot(), 'packages', 'frontend', 'dist', 'index.html'));
  }
}

ipcMain.handle('vault:select-directory', async (_event, opts = {}) => {
  const properties = ['openDirectory'];
  if (opts.createDirectory) properties.push('createDirectory');
  const result = await dialog.showOpenDialog({
    title: opts.title ?? 'Choose vault folder',
    buttonLabel: opts.buttonLabel ?? 'Choose',
    properties,
  });
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
});

ipcMain.handle('app:get-api-token', () => apiToken);

app.whenReady().then(() => {
  void createWindow().catch((err) => {
    console.error(err);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});

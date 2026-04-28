import { app, BrowserWindow, shell } from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..', '..');
const backendPort = process.env.PORT ?? '8000';
const backendUrl = `http://127.0.0.1:${backendPort}`;
const rendererUrl = process.env.ELECTRON_RENDERER_URL;

let backendProcess = null;

function startBackend() {
  if (process.env.ELECTRON_SKIP_BACKEND === '1') return;

  backendProcess = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'start', '--workspace=backend'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: backendPort,
        CORS_ORIGINS: rendererUrl ?? 'http://localhost:5173,http://127.0.0.1:5173',
      },
      stdio: 'inherit',
    },
  );
}

async function waitForBackend(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${backendUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Backend did not become ready at ${backendUrl}`);
}

async function createWindow() {
  startBackend();
  await waitForBackend();

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Zettelkasten Card',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (rendererUrl) {
    await win.loadURL(rendererUrl);
  } else {
    await win.loadFile(join(projectRoot, 'packages', 'frontend', 'dist', 'index.html'));
  }
}

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
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
});

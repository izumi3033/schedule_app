const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const DATA_FILE = path.join(app.getPath('userData'), 'schedule-data.json');
const GCAL_CRED_FILE = path.join(app.getPath('userData'), 'google-credentials.json');
const GCAL_TOKEN_FILE = path.join(app.getPath('userData'), 'google-token.json');

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return { tasks: [], labels: [] };
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('data:load', () => {
  return loadData();
});

ipcMain.handle('data:save', (_event, data) => {
  saveData(data);
  return true;
});

// ---------- Googleカレンダー連携（読み取り専用） ----------
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

async function refreshAccessToken() {
  const cred = readJson(GCAL_CRED_FILE);
  const tok = readJson(GCAL_TOKEN_FILE);
  if (!cred || !tok || !tok.refresh_token) throw new Error('Google未連携です');
  if (tok.access_token && Date.now() < (tok.expiry_ms || 0) - 60000) return tok.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: tok.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error('トークン更新に失敗しました。再ログインしてください（' + (data.error_description || data.error) + '）');
  tok.access_token = data.access_token;
  tok.expiry_ms = Date.now() + (data.expires_in || 3600) * 1000;
  writeJson(GCAL_TOKEN_FILE, tok);
  return tok.access_token;
}

function oauthFlow(cred) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const timer = setTimeout(() => {
      try { server.close(); } catch {}
      reject(new Error('認証がタイムアウトしました'));
    }, 180000);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const state = crypto.randomBytes(16).toString('hex');
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: cred.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      shell.openExternal(authUrl);
      server.on('request', async (req, res) => {
        const url = new URL(req.url, redirectUri);
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<p style="font-family:sans-serif">認証が完了しました。このタブを閉じてアプリに戻ってください。</p>');
        clearTimeout(timer);
        server.close();
        if (!code || gotState !== state) {
          reject(new Error('認証がキャンセルされました'));
          return;
        }
        try {
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id: cred.client_id,
              client_secret: cred.client_secret,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
            }),
          });
          const data = await tokenRes.json();
          if (data.error) {
            reject(new Error(data.error_description || data.error));
            return;
          }
          writeJson(GCAL_TOKEN_FILE, {
            refresh_token: data.refresh_token,
            access_token: data.access_token,
            expiry_ms: Date.now() + (data.expires_in || 3600) * 1000,
          });
          resolve(true);
        } catch (e) {
          reject(e);
        }
      });
    });
  });
}

ipcMain.handle('gcal:status', () => {
  const cred = readJson(GCAL_CRED_FILE);
  const tok = readJson(GCAL_TOKEN_FILE);
  return { hasCredentials: !!(cred && cred.client_id), connected: !!(tok && tok.refresh_token) };
});

ipcMain.handle('gcal:connect', async (_event, clientId, clientSecret) => {
  const cred = { client_id: (clientId || '').trim(), client_secret: (clientSecret || '').trim() };
  if (cred.client_id && cred.client_secret) {
    writeJson(GCAL_CRED_FILE, cred);
  } else {
    const saved = readJson(GCAL_CRED_FILE);
    if (!saved || !saved.client_id) return { ok: false, error: 'クライアントIDとシークレットを入力してください' };
    cred.client_id = saved.client_id;
    cred.client_secret = saved.client_secret;
  }
  try {
    await oauthFlow(cred);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('gcal:disconnect', () => {
  try { fs.unlinkSync(GCAL_TOKEN_FILE); } catch {}
  return true;
});

ipcMain.handle('gcal:events', async (_event, timeMin, timeMax) => {
  try {
    const token = await refreshAccessToken();
    const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
      timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message || 'Calendar APIエラー' };
    const events = (data.items || []).map((ev) => ({
      id: ev.id,
      title: ev.summary || '(無題)',
      start: (ev.start && (ev.start.date || ev.start.dateTime)) || '',
      end: (ev.end && (ev.end.date || ev.end.dateTime)) || '',
      allDay: !!(ev.start && ev.start.date),
    }));
    return { ok: true, events };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

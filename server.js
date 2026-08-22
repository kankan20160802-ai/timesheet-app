require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "20mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
const MODEL = "claude-sonnet-4-6";

// ---- 簡易認証(共通パスワード + 3時間セッション) ----
const SESSION_DURATION_MS = 3 * 60 * 60 * 1000; // 3時間
const sessions = new Map(); // token -> expiresAt

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return true; // パスワード未設定時は認証をスキップ(開発用)
  const token = parseCookies(req).session;
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ログイン - 週次勤務時間集計システム</title>
<style>
  body { font-family: -apple-system, "Noto Sans JP", sans-serif; background: #F4F2EC; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #fff; border: 1px solid #DAD4C4; border-radius: 10px; padding: 32px; width: 300px; }
  h1 { font-size: 16px; margin: 0 0 20px; color: #24302A; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #DAD4C4; border-radius: 6px; font-size: 14px; margin-bottom: 12px; }
  button { width: 100%; padding: 10px; border: none; border-radius: 6px; background: #2F5D50; color: #fff; font-weight: 600; cursor: pointer; }
  #err { color: #A6432A; font-size: 13px; margin-bottom: 10px; display: none; }
</style></head>
<body>
  <form id="f">
    <h1>週次勤務時間集計システム</h1>
    <div id="err">パスワードが違います</div>
    <input type="password" id="pw" placeholder="パスワード" autofocus />
    <button type="submit">ログイン</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      const res = await fetch('/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) });
      if (res.ok) { location.reload(); } else { document.getElementById('err').style.display = 'block'; }
    });
  </script>
</body></html>`;

app.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (!APP_PASSWORD || password !== APP_PASSWORD) {
    return res.status(401).json({ error: "パスワードが違います" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_DURATION_MS);
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}; SameSite=Lax`);
  res.json({ ok: true });
});

app.post("/logout", (req, res) => {
  const token = parseCookies(req).session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (req.path === "/login" || req.path === "/logout") return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "認証が必要です(セッション切れの可能性があります)。ページを再読み込みしてください。" });
  return res.status(200).send(LOGIN_PAGE);
});
// ---- 認証ここまで ----

app.use(express.static(path.join(__dirname, "public")));

// ---- レート制限(セッション単位で短時間の連打を防止) ----
const OCR_RATE_LIMIT = 6; // 直近5分間に許可する読み取り回数
const OCR_RATE_WINDOW_MS = 5 * 60 * 1000;
const ocrCallLog = new Map(); // token(またはip) -> [timestamp, ...]

function checkOcrRateLimit(key) {
  const now = Date.now();
  const timestamps = (ocrCallLog.get(key) || []).filter((t) => now - t < OCR_RATE_WINDOW_MS);
  if (timestamps.length >= OCR_RATE_LIMIT) {
    ocrCallLog.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  ocrCallLog.set(key, timestamps);
  return true;
}
// ---- レート制限ここまで ----

function buildPrompt(targetMonth) {
  return `この画像は手書きの出勤簿です。次のJSONオブジェクトのみを出力してください(説明文やコードブロック記号は不要、JSON以外の文字は一切出力しないこと)。

{"employeeName": "氏名欄の内容", "workplaceName": "就業先・就業事業所名欄の内容", "rows": [{"day": 21, "checkin": "13:17", "breakStart": "", "breakEnd": "", "checkout": "18:30"}]}

ルール:
- employeeNameは書類内の「氏名」欄、workplaceNameは「就業事業所名」など就業先を表す欄から読み取ること。読み取れなければ空文字("")にすること。
- rowsの出社・退社の時刻はすべて24時間表記(HH:MM)にすること。この職場の勤務は13:30開始が基本のため、出社時刻が1〜9時台に見える場合は12時間を加算した午後の時刻として解釈すること(例: 手書きが「1:17」なら13:17)。
- 空欄または判読不能なマスは空文字("")にすること。数字を推測で埋めないこと。
- dayには日付欄の「日」の数字のみを整数で入れること(曜日や月は不要)。
- 対象期間はおおよそ ${targetMonth} 前後です。
- 出力はJSONオブジェクトのみとし、前後に説明文やマークダウンのコードブロックを付けないこと。`;
}

app.post("/api/ocr", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "サーバーにANTHROPIC_API_KEYが設定されていません。" });
    }

    const rateKey = parseCookies(req).session || req.ip;
    if (!checkOcrRateLimit(rateKey)) {
      return res.status(429).json({ error: `短時間に読み取りが集中しています。${Math.ceil(OCR_RATE_WINDOW_MS / 60000)}分ほど時間を置いてから再試行してください。` });
    }

    const { imageBase64, mimeType, isPdf, targetMonth } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "画像データがありません。" });
    }

    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [contentBlock, { type: "text", text: buildPrompt(targetMonth || "") }],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok || data.type === "error") {
      const msg = (data.error && data.error.message) || `Anthropic API HTTP ${response.status}`;
      return res.status(502).json({ error: msg });
    }

    const text = (data.content || []).map((b) => b.text || "").join("\n");
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      return res.status(502).json({ error: "AIの応答からJSONを検出できませんでした。" });
    }

    let parsed;
    try {
      parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch (e) {
      return res.status(502).json({ error: "AIの応答を解析できませんでした(出力が途中で切れた可能性があります)。" });
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "不明なサーバーエラー" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Timesheet app listening on port ${PORT}`);
});

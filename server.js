require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "20mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const MODEL = "claude-sonnet-4-6";

// ---- 簡易認証(共通パスワード + 3時間セッション) ----
// セッションはサーバーのメモリに持たず、署名付きトークンで表現する。
// これにより Render の無料プランがスリープ・再起動しても全員ログアウトにならない。
const SESSION_DURATION_MS = 3 * 60 * 60 * 1000; // 3時間
const SESSION_SECRET = process.env.SESSION_SECRET || (APP_PASSWORD ? `derived:${APP_PASSWORD}` : "dev-secret");

function signSession(expiresAt) {
  const payload = String(expiresAt);
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return false;
  const idx = token.lastIndexOf(".");
  if (idx === -1) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

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
  return verifySession(parseCookies(req).session);
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
  const token = signSession(Date.now() + SESSION_DURATION_MS);
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}; SameSite=Lax`);
  res.json({ ok: true });
});

app.post("/logout", (req, res) => {
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

// 古いエントリが溜まり続けないよう定期的に掃除する
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of ocrCallLog) {
    const kept = times.filter((t) => now - t < OCR_RATE_WINDOW_MS);
    if (kept.length === 0) ocrCallLog.delete(key);
    else ocrCallLog.set(key, kept);
  }
}, OCR_RATE_WINDOW_MS).unref();
// ---- レート制限ここまで ----

function buildPrompt(targetMonth) {  return `この画像は手書きの出勤簿です。次のJSONオブジェクトのみを出力してください(説明文やコードブロック記号は不要、JSON以外の文字は一切出力しないこと)。

{"employeeName": "氏名欄の内容", "workplaceName": "就業先・就業事業所名欄の内容", "rows": [{"day": 21, "checkin": "13:17", "breakStart": "", "breakEnd": "", "checkout": "18:30"}]}

ルール:
- employeeNameは書類内の「氏名」欄、workplaceNameは「就業事業所名」など就業先を表す欄から読み取ること。読み取れなければ空文字("")にすること。
- rowsの出社・退社の時刻はすべて24時間表記(HH:MM)にすること。この職場の勤務は13:30開始が基本のため、出社時刻が1〜9時台に見える場合は12時間を加算した午後の時刻として解釈すること(例: 手書きが「1:17」なら13:17)。
- 空欄または判読不能なマスは空文字("")にすること。数字を推測で埋めないこと。
- dayには日付欄の「日」の数字のみを整数で入れること(曜日や月は不要)。
- 対象期間はおおよそ ${targetMonth} 前後です。
- 出力はJSONオブジェクトのみとし、前後に説明文やマークダウンのコードブロックを付けないこと。`;
}

// ---- Anthropic による読み取り ----
async function runAnthropicOcr({ imageBase64, mimeType, isPdf, targetMonth }) {
  if (!ANTHROPIC_API_KEY) {
    return { status: 500, body: { error: "サーバーにANTHROPIC_API_KEYが設定されていません。" } };
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
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: buildPrompt(targetMonth || "") }] }],
    }),
  });

  const data = await response.json();

  if (!response.ok || data.type === "error") {
    const msg = (data.error && data.error.message) || `Anthropic API HTTP ${response.status}`;
    return { status: 502, body: { error: msg } };
  }

  const text = (data.content || []).map((b) => b.text || "").join("\n");
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    return { status: 502, body: { error: "AIの応答からJSONを検出できませんでした。" } };
  }

  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return { status: 200, body: { ...parsed, provider: "anthropic" } };
  } catch (e) {
    return { status: 502, body: { error: "AIの応答を解析できませんでした(出力が途中で切れた可能性があります)。" } };
  }
}

// ---- Google Cloud Vision による読み取り ----
// Vision は「文字と座標」しか返さないため、表の構造を座標から推定する必要がある。

// 各トークンを1文字ずつに展開し、文字ごとにおおよそのX座標を持たせる。
// これにより「13:17」がどの列にあるかを正確に判定できる。
function expandTokenToChars(token) {
  const chars = [];
  const len = token.text.length;
  if (len === 0) return chars;
  const step = (token.xMax - token.xMin) / len;
  for (let i = 0; i < len; i++) {
    chars.push({ ch: token.text[i], x: token.xMin + step * (i + 0.5) });
  }
  return chars;
}

// Y座標でクラスタリングして行にまとめる。
// 重心を更新しながら判定するため、多少の傾きがあっても崩れにくい。
function groupTokensIntoRows(tokens, medianHeight) {
  const tolerance = medianHeight * 0.8;
  const sorted = [...tokens].sort((a, b) => a.yCenter - b.yCenter);
  const rows = [];

  sorted.forEach((tok) => {
    const last = rows[rows.length - 1];
    if (last && Math.abs(tok.yCenter - last.centroid) <= tolerance) {
      last.tokens.push(tok);
      // 重心を更新(行が右下がりでも追従できる)
      last.centroid = last.tokens.reduce((s, t) => s + t.yCenter, 0) / last.tokens.length;
    } else {
      rows.push({ centroid: tok.yCenter, tokens: [tok] });
    }
  });

  return rows.map((r) => r.tokens.sort((a, b) => a.xMin - b.xMin));
}

// 1行分の文字列を組み立て、時刻とその位置(X座標)を取り出す
function findTimesInRow(rowTokens) {
  const chars = [];
  rowTokens.forEach((t) => chars.push(...expandTokenToChars(t)));

  // 全角を半角に寄せてから探す
  const normalized = chars.map((c) => {
    let ch = c.ch;
    if (ch >= "０" && ch <= "９") ch = String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    if ("：；;．。・".includes(ch)) ch = ":";
    return { ch, x: c.x };
  });

  const joined = normalized.map((c) => c.ch).join("");
  const results = [];
  const re = /(\d{1,2}):(\d{2})/g;
  let m;
  while ((m = re.exec(joined)) !== null) {
    const h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (h > 23 || mm > 59) continue;
    const startIdx = m.index;
    const endIdx = m.index + m[0].length - 1;
    const xCenter = (normalized[startIdx].x + normalized[endIdx].x) / 2;
    results.push({ time: `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, x: xCenter });
  }
  return { joined, times: results };
}

// 行頭付近の数字を日付として取り出す。
// 「21火」のように曜日と結合して認識される場合があるため、完全一致ではなく数字を抽出する。
function findDayInRow(rowTokens, leftBoundaryX) {
  for (const t of rowTokens) {
    // 出社列より右側は日付ではないので打ち切る
    if (leftBoundaryX != null && t.xMin >= leftBoundaryX) break;
    const norm = t.text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const m = /(\d{1,2})/.exec(norm);
    if (m) {
      const d = parseInt(m[1], 10);
      if (d >= 1 && d <= 31) return d;
    }
  }
  return null;
}

// 表ヘッダー(出社・休憩・退社)を見つけ、列のX位置の基準にする。
// 決まった様式なので、これが取れれば列判定が安定する。
function findHeaderAnchors(tokens) {
  const anchors = {};
  let headerY = null;

  tokens.forEach((t) => {
    const txt = t.text;
    const xc = (t.xMin + t.xMax) / 2;
    if (/出社|出勤/.test(txt) && anchors.checkin == null) {
      anchors.checkin = xc;
      headerY = t.yCenter;
    } else if (/休憩/.test(txt) && anchors.breakCenter == null) {
      anchors.breakCenter = xc;
      anchors.breakWidth = t.xMax - t.xMin;
    } else if (/退社|退勤/.test(txt) && anchors.checkout == null) {
      anchors.checkout = xc;
      if (headerY == null) headerY = t.yCenter;
    }
  });

  if (anchors.checkin == null || anchors.checkout == null) return null;
  return { ...anchors, headerY };
}

function extractRowsFromVision(annotations) {
  const tokens = annotations.slice(1).map((a) => {
    const xs = a.boundingPoly.vertices.map((v) => v.x || 0);
    const ys = a.boundingPoly.vertices.map((v) => v.y || 0);
    return {
      text: a.description,
      xMin: Math.min(...xs),
      xMax: Math.max(...xs),
      yCenter: (Math.min(...ys) + Math.max(...ys)) / 2,
      height: Math.max(...ys) - Math.min(...ys),
    };
  });

  if (tokens.length === 0) return { rows: [], debug: { tokenCount: 0 } };

  const heights = tokens.map((t) => t.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;

  const header = findHeaderAnchors(tokens);
  const rowGroups = groupTokensIntoRows(tokens, medianHeight);

  // ヘッダーより上の行(タイトルや注意書き)は集計対象から除外する
  const dataRowGroups = rowGroups.filter((rowTokens) => {
    if (!header || header.headerY == null) return true;
    const y = rowTokens.reduce((s, t) => s + t.yCenter, 0) / rowTokens.length;
    return y > header.headerY + medianHeight * 0.5;
  });

  // 出社列の左端を日付列との境界とする
  const leftBoundaryX = header ? header.checkin - medianHeight * 2 : null;

  const perRow = dataRowGroups.map((rowTokens) => {
    const { joined, times } = findTimesInRow(rowTokens);
    const day = findDayInRow(rowTokens, leftBoundaryX);
    return { rowTokens, joined, times, day };
  });

  // 列の基準:ヘッダーが取れていればそれを使い、なければ時刻のX座標から推定する
  let assignField;
  let columnCount;

  if (header) {
    const bStart = header.breakCenter != null ? header.breakCenter - (header.breakWidth || 0) * 0.25 : null;
    const bEnd = header.breakCenter != null ? header.breakCenter + (header.breakWidth || 0) * 0.25 : null;
    const anchorList = [
      { field: "checkin", x: header.checkin },
      ...(bStart != null ? [{ field: "breakStart", x: bStart }] : []),
      ...(bEnd != null ? [{ field: "breakEnd", x: bEnd }] : []),
      { field: "checkout", x: header.checkout },
    ];
    columnCount = anchorList.length;
    assignField = (x) => {
      let best = anchorList[0];
      let bestDist = Infinity;
      anchorList.forEach((a) => {
        const d = Math.abs(x - a.x);
        if (d < bestDist) {
          bestDist = d;
          best = a;
        }
      });
      // 退社列より大きく右にある時刻(残業時間欄など)は無視する
      if (x > header.checkout + (header.checkout - header.checkin) * 0.5) return null;
      return best.field;
    };
  } else {
    const allTimeXs = [];
    perRow.forEach((r) => r.times.forEach((t) => allTimeXs.push(t.x)));
    const columns = clusterColumns(allTimeXs, 4);
    columnCount = columns.length;
    assignField = (x) => {
      if (columns.length === 0) return null;
      let bestIdx = 0;
      let bestDist = Infinity;
      columns.forEach((c, i) => {
        const d = Math.abs(x - c.center);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      });
      if (columns.length === 1) return "checkin";
      if (columns.length === 2) return bestIdx === 0 ? "checkin" : "checkout";
      if (columns.length === 3) return ["checkin", "breakStart", "checkout"][bestIdx];
      return ["checkin", "breakStart", "breakEnd", "checkout"][bestIdx];
    };
  }

  let timeCount = 0;
  const out = [];
  perRow.forEach((r) => {
    if (r.day == null) return;
    const entry = { day: r.day, checkin: "", breakStart: "", breakEnd: "", checkout: "" };
    r.times.forEach((t) => {
      const field = assignField(t.x);
      if (field && !entry[field]) {
        entry[field] = t.time;
        timeCount++;
      }
    });
    out.push(entry);
  });

  return {
    rows: out,
    debug: {
      tokenCount: tokens.length,
      rowCount: dataRowGroups.length,
      rowsWithDay: out.length,
      timeCount,
      columnCount,
      headerFound: !!header,
    },
  };
}

// 時刻のX座標をクラスタリングして「列」を割り出す
function clusterColumns(xValues, expectedMax = 4) {
  if (xValues.length === 0) return [];
  const sorted = [...xValues].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  if (span <= 0) return [{ min: sorted[0], max: sorted[0], center: sorted[0] }];

  // 隣り合う値の差が大きい箇所で区切る
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push({ idx: i, gap: sorted[i] - sorted[i - 1] });
  }
  gaps.sort((a, b) => b.gap - a.gap);

  const cutCount = Math.min(expectedMax - 1, gaps.length);
  const cutIndices = gaps
    .slice(0, cutCount)
    .filter((g) => g.gap > span * 0.12) // 小さすぎる隙間では区切らない
    .map((g) => g.idx)
    .sort((a, b) => a - b);

  const clusters = [];
  let start = 0;
  [...cutIndices, sorted.length].forEach((cut) => {
    const slice = sorted.slice(start, cut);
    if (slice.length > 0) {
      clusters.push({
        min: slice[0],
        max: slice[slice.length - 1],
        center: slice.reduce((s, v) => s + v, 0) / slice.length,
      });
    }
    start = cut;
  });

  return clusters;
}

async function runGoogleVisionOcr({ imageBase64, isPdf }) {
  if (!GOOGLE_VISION_API_KEY) {
    return { status: 500, body: { error: "サーバーにGOOGLE_VISION_API_KEYが設定されていません。" } };
  }
  if (isPdf) {
    return { status: 400, body: { error: "Google Vision方式ではPDFに対応していません。画像(JPEG/PNG)を添付してください。" } };
  }

  const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(GOOGLE_VISION_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          image: { content: imageBase64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["ja"] },
        },
      ],
    }),
  });

  const data = await response.json();

  if (!response.ok || (data.responses && data.responses[0] && data.responses[0].error)) {
    const msg =
      (data.error && data.error.message) ||
      (data.responses && data.responses[0] && data.responses[0].error && data.responses[0].error.message) ||
      `Google Vision API HTTP ${response.status}`;
    return { status: 502, body: { error: msg } };
  }

  const annotations = (data.responses && data.responses[0] && data.responses[0].textAnnotations) || [];
  if (annotations.length === 0) {
    return { status: 200, body: { rows: [], employeeName: "", workplaceName: "", provider: "google", note: "文字を検出できませんでした。" } };
  }

  const { rows, debug } = extractRowsFromVision(annotations);
  return {
    status: 200,
    body: {
      rows,
      employeeName: "",
      workplaceName: "",
      provider: "google",
      note: `解析内訳: 検出文字${debug.tokenCount}個 / 行${debug.rowCount} / 日付付き行${debug.rowsWithDay} / 時刻${debug.timeCount}個 / 列${debug.columnCount}。氏名・就業先の自動判別は行いません。`,
    },
  };
}

app.post("/api/ocr", async (req, res) => {
  try {
    const rateKey = parseCookies(req).session || req.ip;
    if (!checkOcrRateLimit(rateKey)) {
      return res.status(429).json({ error: `短時間に読み取りが集中しています。${Math.ceil(OCR_RATE_WINDOW_MS / 60000)}分ほど時間を置いてから再試行してください。` });
    }

    const { imageBase64, mimeType, isPdf, targetMonth, provider } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "画像データがありません。" });
    }

    const result =
      provider === "google"
        ? await runGoogleVisionOcr({ imageBase64, isPdf })
        : await runAnthropicOcr({ imageBase64, mimeType, isPdf, targetMonth });

    res.status(result.status).json(result.body);
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

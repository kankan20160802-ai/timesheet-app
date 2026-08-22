require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

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

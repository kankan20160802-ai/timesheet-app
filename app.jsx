const { useState, useMemo } = React;

const UNIT_OPTIONS = [5, 10, 15, 30];
const DIR_LABEL = { up: "切り上げ", down: "切り捨て", nearest: "四捨五入" };
const DOW_LABEL = ["日", "月", "火", "水", "木", "金", "土"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d;
}

function daysInMonth(y, m) {
  // m: 1-12
  return new Date(y, m, 0).getDate();
}

function getPeriodRange(closingDay, targetMonth) {
  const [yy, mm] = targetMonth.split("-").map(Number);
  if (closingDay === "endOfMonth") {
    const start = `${yy}-${pad2(mm)}-01`;
    const end = `${yy}-${pad2(mm)}-${pad2(daysInMonth(yy, mm))}`;
    return { start, end };
  }
  const cutoff = Number(closingDay);
  const end = `${yy}-${pad2(mm)}-${pad2(Math.min(cutoff, daysInMonth(yy, mm)))}`;
  let py = yy;
  let pm = mm - 1;
  if (pm === 0) {
    pm = 12;
    py = yy - 1;
  }
  const startDay = Math.min(cutoff + 1, daysInMonth(py, pm));
  const start = `${py}-${pad2(pm)}-${pad2(startDay)}`;
  return { start, end };
}

function buildWeeksFromRange(startStr, endStr) {
  const startD = new Date(startStr + "T00:00:00");
  const endD = new Date(endStr + "T00:00:00");
  const order = [];
  const groups = new Map();
  const cur = new Date(startD);
  while (cur <= endD) {
    const dow = cur.getDay();
    const sunday = new Date(cur);
    sunday.setDate(sunday.getDate() - dow);
    const key = toDateStr(sunday);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push({ dateStr: toDateStr(cur), dow });
    cur.setDate(cur.getDate() + 1);
  }
  return order.map((k) => groups.get(k));
}

function parseTimeToMinutes(str) {
  if (!str) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(mm) || mm > 59) return null;
  return h * 60 + mm;
}

function formatClock(minutes) {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function formatDuration(minutes) {
  if (minutes == null) return "—";
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}時間${pad2(m)}分`;
}

function roundToUnit(minutes, unit, direction) {
  if (minutes == null) return null;
  if (direction === "up") return Math.ceil(minutes / unit) * unit;
  if (direction === "down") return Math.floor(minutes / unit) * unit;
  return Math.round(minutes / unit) * unit;
}

function WeeklyTimesheetCalculator() {
  const [startDate, setStartDate] = useState("2026-07-19");
  const [numWeeks, setNumWeeks] = useState(4);
  const [unit, setUnit] = useState(15);
  const [target, setTarget] = useState("punch"); // punch | daily | weekly
  const [checkinDir, setCheckinDir] = useState("up");
  const [checkoutDir, setCheckoutDir] = useState("down");
  const [genericDir, setGenericDir] = useState("down");
  const [weeklyLimitH, setWeeklyLimitH] = useState(28);
  const [entries, setEntries] = useState({});

  const [periodMode, setPeriodMode] = useState("profile"); // 'profile' | 'manual'
  const [targetMonth, setTargetMonth] = useState("2026-08");
  const [profiles, setProfiles] = useState([
    { id: "p1", name: "会社A(20日締め)", closingDay: "20", unit: 5, target: "punch", checkinDir: "up", checkoutDir: "down", genericDir: "down", weeklyLimitH: 28 },
    { id: "p2", name: "会社B(末日締め)", closingDay: "endOfMonth", unit: 15, target: "daily", checkinDir: "up", checkoutDir: "down", genericDir: "down", weeklyLimitH: 28 },
  ]);
  const [selectedProfileId, setSelectedProfileId] = useState("p1");
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileClosing, setNewProfileClosing] = useState("20");
  const [attachments, setAttachments] = useState([]);
  const [activeAttachmentId, setActiveAttachmentId] = useState(null);
  const [ocrStatus, setOcrStatus] = useState("idle"); // idle | loading | done | error
  const [ocrMessage, setOcrMessage] = useState("");
  const [previewMode, setPreviewMode] = useState(false);
  const [employeeName, setEmployeeName] = useState("");
  const [workplaceName, setWorkplaceName] = useState("");
  const [autoName, setAutoName] = useState({ employeeName: false, workplaceName: false });

  function compressImage(dataUrl, maxDim = 1600, quality = 0.85) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width <= maxDim && height <= maxDim) {
          resolve(dataUrl);
          return;
        }
        const scale = Math.min(maxDim / width, maxDim / height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function handleFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const id = `a${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const isPdf = file.type === "application/pdf";
        let finalDataUrl = reader.result;
        let mimeType = file.type || "image/jpeg";
        if (!isPdf) {
          finalDataUrl = await compressImage(reader.result);
          mimeType = "image/jpeg";
        }
        setAttachments((prev) => [...prev, { id, name: file.name, dataUrl: finalDataUrl, isPdf, mimeType }]);
        setActiveAttachmentId((prev) => prev || id);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  }

  function removeAttachment(id) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setActiveAttachmentId((prev) => (prev === id ? null : prev));
  }

  const activeAttachment = attachments.find((a) => a.id === activeAttachmentId);

  function applyProfile(p) {
    setSelectedProfileId(p.id);
    setUnit(p.unit);
    setTarget(p.target);
    setCheckinDir(p.checkinDir);
    setCheckoutDir(p.checkoutDir);
    setGenericDir(p.genericDir);
    setWeeklyLimitH(p.weeklyLimitH);
  }

  function saveCurrentAsProfile() {
    if (!newProfileName.trim()) return;
    const p = {
      id: `p${Date.now()}`,
      name: newProfileName.trim(),
      closingDay: newProfileClosing,
      unit,
      target,
      checkinDir,
      checkoutDir,
      genericDir,
      weeklyLimitH,
    };
    setProfiles((prev) => [...prev, p]);
    setSelectedProfileId(p.id);
    setNewProfileName("");
  }

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) || profiles[0];
  const period =
    periodMode === "profile" && selectedProfile ? getPeriodRange(selectedProfile.closingDay, targetMonth) : null;

  const weeks = useMemo(() => {
    if (periodMode === "manual") {
      const out = [];
      for (let w = 0; w < numWeeks; w++) {
        const days = [];
        for (let d = 0; d < 7; d++) {
          const dt = addDays(startDate, w * 7 + d);
          days.push({ dateStr: toDateStr(dt), dow: dt.getDay() });
        }
        out.push(days);
      }
      return out;
    }
    if (!selectedProfile) return [];
    const { start, end } = getPeriodRange(selectedProfile.closingDay, targetMonth);
    return buildWeeksFromRange(start, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodMode, startDate, numWeeks, selectedProfileId, targetMonth, profiles]);

  function updateEntry(dateStr, field, value) {
    setEntries((prev) => {
      const cur = prev[dateStr] || {};
      const auto = { ...(cur.auto || {}), [field]: false };
      return { ...prev, [dateStr]: { ...cur, [field]: value, auto } };
    });
  }

  function confirmAutoField(dateStr, field) {
    setEntries((prev) => {
      const cur = prev[dateStr];
      if (!cur || !cur.auto || !cur.auto[field]) return prev;
      return { ...prev, [dateStr]: { ...cur, auto: { ...cur.auto, [field]: false } } };
    });
  }

  function getEntry(dateStr) {
    return entries[dateStr] || { checkin: "", breakStart: "", breakEnd: "", checkout: "", auto: {} };
  }

  const allPeriodDays = useMemo(() => weeks.flat(), [weeks]);

  function findDateStrForDay(day) {
    const match = allPeriodDays.find((d) => parseInt(d.dateStr.split("-")[2], 10) === day);
    return match ? match.dateStr : null;
  }

  async function runOcrForActiveAttachment() {
    if (!activeAttachment) return;
    setOcrStatus("loading");
    setOcrMessage("");
    try {
      const base64 = activeAttachment.dataUrl.split(",")[1];

      const response = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: activeAttachment.mimeType || "image/jpeg",
          isPdf: !!activeAttachment.isPdf,
          targetMonth,
        }),
      });

      const parsed = await response.json();

      if (!response.ok || parsed.error) {
        throw new Error(parsed.error || `HTTP ${response.status}`);
      }

      const rows = Array.isArray(parsed) ? parsed : parsed.rows || [];

      if (!Array.isArray(parsed)) {
        if (parsed.employeeName) {
          setEmployeeName(parsed.employeeName);
          setAutoName((prev) => ({ ...prev, employeeName: true }));
        }
        if (parsed.workplaceName) {
          setWorkplaceName(parsed.workplaceName);
          setAutoName((prev) => ({ ...prev, workplaceName: true }));
        }
      }

      let filledCount = 0;
      setEntries((prev) => {
        const next = { ...prev };
        rows.forEach((r) => {
          const dateStr = findDateStrForDay(r.day);
          if (!dateStr) return;
          const cur = next[dateStr] || { checkin: "", breakStart: "", breakEnd: "", checkout: "", auto: {} };
          const updated = { ...cur, auto: { ...(cur.auto || {}) } };
          ["checkin", "breakStart", "breakEnd", "checkout"].forEach((field) => {
            const val = r[field];
            if (val) {
              updated[field] = val;
              updated.auto[field] = true;
              filledCount++;
            }
          });
          next[dateStr] = updated;
        });
        return next;
      });
      setOcrStatus("done");
      setOcrMessage(`${rows.length}日分を読み取り、${filledCount}件のマスに自動反映しました。黄色い欄は必ず原本と照合して確認してください。`);
    } catch (err) {
      setOcrStatus("error");
      const isNetworkErr = err instanceof TypeError || (err && /fetch/i.test(err.message || ""));
      setOcrMessage(
        isNetworkErr
          ? "サーバーとの通信に失敗しました。サーバーが起動しているか、通信環境を確認してください。"
          : `読み取りに失敗しました: ${err && err.message ? err.message : "不明なエラー"}`
      );
    }
  }

  // per-day raw calculation
  function computeDay(dateStr) {
    const e = getEntry(dateStr);
    const inMin = parseTimeToMinutes(e.checkin);
    const outMin = parseTimeToMinutes(e.checkout);
    const bs = parseTimeToMinutes(e.breakStart);
    const be = parseTimeToMinutes(e.breakEnd);
    const breakMin = bs != null && be != null && be > bs ? be - bs : 0;

    if (inMin == null || outMin == null || outMin <= inMin) {
      return { hasData: false, roundedIn: null, roundedOut: null, breakMin, workMin: null };
    }

    let roundedIn = inMin;
    let roundedOut = outMin;
    let workMin;

    if (target === "punch") {
      roundedIn = roundToUnit(inMin, unit, checkinDir);
      roundedOut = roundToUnit(outMin, unit, checkoutDir);
      workMin = Math.max(0, roundedOut - roundedIn - breakMin);
    } else if (target === "daily") {
      const raw = Math.max(0, outMin - inMin - breakMin);
      workMin = roundToUnit(raw, unit, genericDir);
    } else {
      // weekly target: keep raw here, round at week level
      workMin = Math.max(0, outMin - inMin - breakMin);
    }

    return { hasData: true, roundedIn, roundedOut, breakMin, workMin };
  }

  const weekSummaries = useMemo(() => {
    const limitMin = Math.round(weeklyLimitH * 60);
    return weeks.map((days) => {
      const dayResults = days.map((d) => ({ ...d, calc: computeDay(d.dateStr) }));
      let rawTotal = 0;
      let anyData = false;
      dayResults.forEach(({ calc }) => {
        if (calc.hasData) {
          anyData = true;
          rawTotal += calc.workMin;
        }
      });
      const total = target === "weekly" ? roundToUnit(rawTotal, unit, genericDir) : rawTotal;
      const overtime = Math.max(0, total - limitMin);
      const regular = Math.min(total, limitMin);
      return { dayResults, total, overtime, regular, anyData, limitMin };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks, entries, unit, target, checkinDir, checkoutDir, genericDir, weeklyLimitH]);

  const grandOvertime = weekSummaries.reduce((a, w) => a + w.overtime, 0);
  const grandTotal = weekSummaries.reduce((a, w) => a + w.total, 0);

  return (
    <div style={{ background: "var(--bg)", minHeight: "100%", fontFamily: "var(--font-body)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@500;600;700&family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        :root {
          --bg: #F4F2EC;
          --surface: #FFFFFF;
          --ink: #24302A;
          --ink-soft: #5B6660;
          --line: #DAD4C4;
          --accent: #2F5D50;
          --accent-soft: #E4ECE7;
          --warn: #A6432A;
          --warn-soft: #F3E1DA;
          --font-display: 'Zilla Slab', serif;
          --font-body: 'Noto Sans JP', sans-serif;
          --font-mono: 'IBM Plex Mono', monospace;
        }
        .ts-input {
          width: 64px;
          font-family: var(--font-mono);
          font-size: 13px;
          border: 1px solid var(--line);
          border-radius: 4px;
          padding: 4px 6px;
          background: var(--surface);
          color: var(--ink);
          text-align: center;
        }
        .ts-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .stamp {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 46px;
          height: 46px;
          border-radius: 999px;
          border: 2px solid currentColor;
          font-family: var(--font-display);
          font-weight: 700;
          font-size: 11px;
          letter-spacing: 0.02em;
          transform: rotate(-6deg);
        }
        .print-only { display: none; }
        .force-print-preview .no-print { display: none !important; }
        .force-print-preview .print-only { display: block !important; }
        .preview-toolbar { display: flex; }
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block; }
          .preview-toolbar { display: none !important; }
          body, html { background: #fff !important; }
          .week-block { page-break-inside: avoid; border-color: #999 !important; }
          .ts-input { border: none !important; padding: 2px !important; }
          table { font-size: 11px !important; }
        }
      `}</style>

      <div
        className="preview-toolbar"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 24px",
          background: "#fff",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
          {previewMode ? "PDF出力プレビュー中(実際に印刷される内容の見た目です)" : "編集モード"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setPreviewMode((v) => !v)}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              border: "1px solid var(--accent)",
              background: previewMode ? "var(--accent)" : "var(--accent-soft)",
              color: previewMode ? "#fff" : "var(--accent)",
              cursor: "pointer",
            }}
          >
            {previewMode ? "編集に戻る" : "PDF出力プレビュー"}
          </button>
          {previewMode && (
            <button
              onClick={() => window.print()}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                border: "1px solid var(--ink)",
                background: "var(--ink)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              この内容をPDF出力(印刷)
            </button>
          )}
        </div>
      </div>

      <div className={previewMode ? "force-print-preview" : ""} style={{ maxWidth: 980, margin: "0 auto", padding: "40px 24px 64px" }}>
        <div className="print-only" style={{ marginBottom: 18, borderBottom: "2px solid var(--ink)", paddingBottom: 12 }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, color: "var(--ink)" }}>
            勤務時間集計表　{periodMode === "profile" && selectedProfile ? selectedProfile.name : ""}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
            対象期間　{period ? `${period.start} 〜 ${period.end}` : `${startDate} から ${numWeeks}週間`}
          </div>
          {(employeeName || workplaceName) && (
            <div style={{ display: "flex", gap: 24, marginTop: 8, fontSize: 13, color: "var(--ink)" }}>
              {employeeName && <div>氏名　<strong>{employeeName}</strong></div>}
              {workplaceName && <div>就業先　<strong>{workplaceName}</strong></div>}
            </div>
          )}
        </div>

        <div className="no-print" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 24px", marginBottom: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>氏名</label>
            <input
              type="text"
              placeholder="例: 山田 太郎"
              value={employeeName}
              onChange={(e) => {
                setEmployeeName(e.target.value);
                setAutoName((prev) => ({ ...prev, employeeName: false }));
              }}
              onClick={() => setAutoName((prev) => (prev.employeeName ? { ...prev, employeeName: false } : prev))}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 6,
                padding: "7px 10px",
                fontSize: 14,
                width: "100%",
                background: autoName.employeeName ? "#FDF3D9" : undefined,
                borderColor: autoName.employeeName ? "#C9A227" : undefined,
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>就業先(派遣先)</label>
            <input
              type="text"
              placeholder="例: 株式会社サスイチ"
              value={workplaceName}
              onChange={(e) => {
                setWorkplaceName(e.target.value);
                setAutoName((prev) => ({ ...prev, workplaceName: false }));
              }}
              onClick={() => setAutoName((prev) => (prev.workplaceName ? { ...prev, workplaceName: false } : prev))}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 6,
                padding: "7px 10px",
                fontSize: 14,
                width: "100%",
                background: autoName.workplaceName ? "#FDF3D9" : undefined,
                borderColor: autoName.workplaceName ? "#C9A227" : undefined,
              }}
            />
          </div>
        </div>

        <div className="no-print" style={{ marginBottom: 28 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.08em", color: "var(--accent)", marginBottom: 6 }}>
            TIMESHEET PROTOTYPE — 週28時間チェック
          </div>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 700, color: "var(--ink)", margin: 0 }}>
            週次勤務時間 集計プロトタイプ
          </h1>
          <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: 8, lineHeight: 1.6 }}>
            手書き出勤簿の内容を想定して出社・休憩・退社を入力すると、丸め処理を適用した上で
            日曜〜土曜の週単位に集計します。時刻は24時間表記(例: 13:17)で入力してください。
          </p>
        </div>

        {/* Attachments: source scans/photos */}
        <div className="no-print" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: "20px 24px", marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>
                原本(出勤簿の写真・スキャン)
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 2 }}>
                期間分をまとめて添付し、「読み込んで自動反映」でAIに手書き文字を読み取らせて下表に自動入力できます(黄色い欄=未確認のAI入力)
              </div>
            </div>
            <label
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                fontSize: 13,
                border: "1px solid var(--accent)",
                background: "var(--accent-soft)",
                color: "var(--accent)",
                cursor: "pointer",
              }}
            >
              画像/PDFを追加
              <input type="file" accept="image/*,application/pdf" multiple onChange={handleFilesSelected} style={{ display: "none" }} />
            </label>
          </div>

          {attachments.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: activeAttachment ? 14 : 0 }}>
              {attachments.map((a) => (
                <div
                  key={a.id}
                  onClick={() => setActiveAttachmentId(a.id)}
                  style={{
                    position: "relative",
                    width: 64,
                    height: 64,
                    borderRadius: 6,
                    overflow: "hidden",
                    border: `2px solid ${activeAttachmentId === a.id ? "var(--accent)" : "var(--line)"}`,
                    cursor: "pointer",
                    background: "#F0EEE6",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  title={a.name}
                >
                  {a.isPdf ? (
                    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>PDF</span>
                  ) : (
                    <img src={a.dataUrl} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )}
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      removeAttachment(a.id);
                    }}
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      width: 16,
                      height: 16,
                      lineHeight: "14px",
                      borderRadius: 999,
                      border: "none",
                      background: "rgba(36,48,42,0.75)",
                      color: "#fff",
                      fontSize: 10,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeAttachment && (
            <div
              style={{
                position: "sticky",
                top: 16,
                border: "1px solid var(--line)",
                borderRadius: 8,
                background: "#F0EEE6",
                padding: 10,
                textAlign: "center",
              }}
            >
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
                <button
                  onClick={runOcrForActiveAttachment}
                  disabled={ocrStatus === "loading"}
                  style={{
                    padding: "9px 16px",
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    border: "1px solid var(--accent)",
                    background: ocrStatus === "loading" ? "var(--accent-soft)" : "var(--accent)",
                    color: ocrStatus === "loading" ? "var(--accent)" : "#fff",
                    cursor: ocrStatus === "loading" ? "default" : "pointer",
                  }}
                >
                  {ocrStatus === "loading" ? "読み取り中…" : "この原本を読み込んで自動反映"}
                </button>
              </div>
              {ocrMessage && (
                <div style={{ fontSize: 12, color: ocrStatus === "error" ? "var(--warn)" : "var(--accent)", marginBottom: 10, lineHeight: 1.6 }}>
                  {ocrMessage}
                </div>
              )}
              {ocrStatus === "error" && (
                <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10, lineHeight: 1.6 }}>
                  サーバーのログ(Renderのダッシュボード)にエラー詳細が出力されている場合があります。ANTHROPIC_API_KEYの設定も確認してください。
                </div>
              )}
              {activeAttachment.isPdf ? (
                <a href={activeAttachment.dataUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 13 }}>
                  {activeAttachment.name}(PDFを新しいタブで開く)
                </a>
              ) : (
                <img
                  src={activeAttachment.dataUrl}
                  alt={activeAttachment.name}
                  style={{ maxWidth: "100%", maxHeight: 620, objectFit: "contain", borderRadius: 4 }}
                />
              )}
            </div>
          )}
        </div>

        {/* Company profile / period panel */}
        <div className="no-print" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: "20px 24px", marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>
              会社・締め日
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { v: "profile", l: "締め日から自動生成" },
                { v: "manual", l: "開始日を手動指定" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => setPeriodMode(opt.v)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    fontSize: 12,
                    border: `1px solid ${periodMode === opt.v ? "var(--accent)" : "var(--line)"}`,
                    background: periodMode === opt.v ? "var(--accent-soft)" : "var(--surface)",
                    color: periodMode === opt.v ? "var(--accent)" : "var(--ink-soft)",
                    cursor: "pointer",
                  }}
                >
                  {opt.l}
                </button>
              ))}
            </div>
          </div>

          {periodMode === "profile" ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => applyProfile(p)}
                    style={{
                      padding: "7px 12px",
                      borderRadius: 8,
                      fontSize: 13,
                      border: `1px solid ${selectedProfileId === p.id ? "var(--accent)" : "var(--line)"}`,
                      background: selectedProfileId === p.id ? "var(--accent-soft)" : "var(--surface)",
                      color: selectedProfileId === p.id ? "var(--accent)" : "var(--ink)",
                      cursor: "pointer",
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>対象年月</label>
                  <input
                    type="month"
                    value={targetMonth}
                    onChange={(e) => setTargetMonth(e.target.value)}
                    style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 13, width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>算出された期間</label>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink)", padding: "6px 0" }}>
                    {period ? `${period.start} 〜 ${period.end}` : "—"}
                  </div>
                </div>
              </div>

              <div style={{ borderTop: "1px dashed var(--line)", paddingTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>新しい会社名</label>
                  <input
                    type="text"
                    placeholder="例: 会社C"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>締め日</label>
                  <select
                    value={newProfileClosing}
                    onChange={(e) => setNewProfileClosing(e.target.value)}
                    style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}
                  >
                    <option value="endOfMonth">末日締め</option>
                    {[5, 10, 15, 20, 25].map((d) => (
                      <option key={d} value={String(d)}>{d}日締め</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={saveCurrentAsProfile}
                  style={{
                    padding: "7px 14px",
                    borderRadius: 6,
                    fontSize: 13,
                    border: "1px solid var(--accent)",
                    background: "var(--accent)",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  現在の丸め設定で会社を追加
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>開始日(日曜)</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 13, width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>週数</label>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={numWeeks}
                  onChange={(e) => setNumWeeks(Math.max(1, Math.min(6, parseInt(e.target.value || "1", 10))))}
                  style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 13, width: "100%" }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Config panel */}
        <div className="no-print" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: "20px 24px", marginBottom: 16 }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, color: "var(--ink)", marginBottom: 14 }}>
            集計ルール設定 {periodMode === "profile" && selectedProfile ? `(${selectedProfile.name})` : ""}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>丸め単位</label>
              <select value={unit} onChange={(e) => setUnit(parseInt(e.target.value, 10))} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 13, width: "100%" }}>
                {UNIT_OPTIONS.map((u) => (
                  <option key={u} value={u}>{u}分単位</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>週の上限時間</label>
              <input
                type="number"
                step="0.5"
                value={weeklyLimitH}
                onChange={(e) => setWeeklyLimitH(parseFloat(e.target.value || "0"))}
                style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 13, width: "100%" }}
              />
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 6 }}>丸めを適用する対象</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                { v: "punch", l: "出社・退社の打刻ごと" },
                { v: "daily", l: "日ごとの勤務時間" },
                { v: "weekly", l: "週ごとの合計時間" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => setTarget(opt.v)}
                  style={{
                    padding: "7px 12px",
                    borderRadius: 999,
                    fontSize: 13,
                    border: `1px solid ${target === opt.v ? "var(--accent)" : "var(--line)"}`,
                    background: target === opt.v ? "var(--accent-soft)" : "var(--surface)",
                    color: target === opt.v ? "var(--accent)" : "var(--ink-soft)",
                    cursor: "pointer",
                  }}
                >
                  {opt.l}
                </button>
              ))}
            </div>
          </div>

          {target === "punch" ? (
            <div style={{ display: "flex", gap: 24, marginTop: 16, flexWrap: "wrap" }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>出社の丸め方向</label>
                <select value={checkinDir} onChange={(e) => setCheckinDir(e.target.value)} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}>
                  {Object.entries(DIR_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>退社の丸め方向</label>
                <select value={checkoutDir} onChange={(e) => setCheckoutDir(e.target.value)} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}>
                  {Object.entries(DIR_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>丸め方向</label>
              <select value={genericDir} onChange={(e) => setGenericDir(e.target.value)} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}>
                {Object.entries(DIR_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginBottom: 24 }}>
          <button
            onClick={() => window.print()}
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              border: "1px solid var(--ink)",
              background: "var(--ink)",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            PDFとして出力(印刷ダイアログを開く)
          </button>
        </div>

        <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, marginBottom: 20, overflow: "hidden" }}>
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--line)", fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>
            週集計サマリ
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                {["週", "期間", "週合計", "上限内", "残業(超過)", "判定"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "center", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((days, wi) => {
                const summary = weekSummaries[wi];
                const isOver = summary.overtime > 0;
                return (
                  <tr key={wi} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "6px 10px", textAlign: "center" }}>第{wi + 1}週</td>
                    <td style={{ padding: "6px 10px", textAlign: "center", fontFamily: "var(--font-mono)" }}>
                      {days[0].dateStr} 〜 {days[days.length - 1].dateStr}
                    </td>
                    <td style={{ padding: "6px 10px", textAlign: "center", fontFamily: "var(--font-mono)" }}>{formatDuration(summary.total)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "center", fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{formatDuration(summary.regular)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "center", fontFamily: "var(--font-mono)", fontWeight: 700, color: isOver ? "var(--warn)" : "var(--ink-soft)" }}>{formatDuration(summary.overtime)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "center", color: isOver ? "var(--warn)" : "var(--accent)", fontWeight: 600 }}>{summary.anyData ? (isOver ? "超過" : "適正") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Weeks */}
        {weeks.map((days, wi) => {
          const summary = weekSummaries[wi];
          const isOver = summary.overtime > 0;
          return (
            <div key={wi} className="week-block" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, marginBottom: 20, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--line)" }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>
                  第{wi + 1}週　{days[0].dateStr} 〜 {days[days.length - 1].dateStr}
                </div>
                {summary.anyData && (
                  <div
                    className="stamp"
                    style={{ color: isOver ? "var(--warn)" : "var(--accent)" }}
                    title={isOver ? "28時間超過" : "上限内"}
                  >
                    {isOver ? "超過" : "適正"}
                  </div>
                )}
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                      {["日付", "曜", "出社", "休憩開始", "休憩終了", "退社", "丸め後", "実働"].map((h) => (
                        <th key={h} style={{ padding: "8px 10px", textAlign: "center", fontWeight: 600, fontFamily: "var(--font-body)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {days.map(({ dateStr, dow }) => {
                      const e = getEntry(dateStr);
                      const calc = computeDay(dateStr);
                      const dayNum = parseInt(dateStr.split("-")[2], 10);
                      const dowColor = dow === 0 ? "var(--warn)" : dow === 6 ? "var(--accent)" : "var(--ink)";
                      return (
                        <tr key={dateStr} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>{dayNum}日</td>
                          <td style={{ padding: "6px 10px", textAlign: "center", color: dowColor, fontWeight: 600 }}>{DOW_LABEL[dow]}</td>
                          <td style={{ padding: "6px 8px", textAlign: "center" }}>
                            <input
                              className="ts-input"
                              placeholder="13:17"
                              value={e.checkin}
                              onChange={(ev) => updateEntry(dateStr, "checkin", ev.target.value)}
                              onClick={() => confirmAutoField(dateStr, "checkin")}
                              style={e.auto && e.auto.checkin ? { background: "#FDF3D9", borderColor: "#C9A227" } : undefined}
                            />
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "center" }}>
                            <input
                              className="ts-input"
                              placeholder="—"
                              value={e.breakStart}
                              onChange={(ev) => updateEntry(dateStr, "breakStart", ev.target.value)}
                              onClick={() => confirmAutoField(dateStr, "breakStart")}
                              style={e.auto && e.auto.breakStart ? { background: "#FDF3D9", borderColor: "#C9A227" } : undefined}
                            />
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "center" }}>
                            <input
                              className="ts-input"
                              placeholder="—"
                              value={e.breakEnd}
                              onChange={(ev) => updateEntry(dateStr, "breakEnd", ev.target.value)}
                              onClick={() => confirmAutoField(dateStr, "breakEnd")}
                              style={e.auto && e.auto.breakEnd ? { background: "#FDF3D9", borderColor: "#C9A227" } : undefined}
                            />
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "center" }}>
                            <input
                              className="ts-input"
                              placeholder="18:30"
                              value={e.checkout}
                              onChange={(ev) => updateEntry(dateStr, "checkout", ev.target.value)}
                              onClick={() => confirmAutoField(dateStr, "checkout")}
                              style={e.auto && e.auto.checkout ? { background: "#FDF3D9", borderColor: "#C9A227" } : undefined}
                            />
                          </td>
                          <td style={{ padding: "6px 10px", textAlign: "center", fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>
                            {calc.hasData ? `${formatClock(calc.roundedIn)}〜${formatClock(calc.roundedOut)}` : "—"}
                          </td>
                          <td style={{ padding: "6px 10px", textAlign: "center", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--ink)" }}>
                            {formatDuration(calc.workMin)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 28, padding: "12px 20px", background: isOver ? "var(--warn-soft)" : "var(--accent-soft)" }}>
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  週合計　<span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--ink)" }}>{formatDuration(summary.total)}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  上限内　<span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--accent)" }}>{formatDuration(summary.regular)}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  超過(残業)　<span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: isOver ? "var(--warn)" : "var(--ink-soft)" }}>{formatDuration(summary.overtime)}</span>
                </div>
              </div>
            </div>
          );
        })}

        {/* Grand total */}
        <div style={{ background: "var(--ink)", borderRadius: 10, padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div style={{ color: "#F4F2EC", fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15 }}>期間合計</div>
          <div style={{ display: "flex", gap: 28 }}>
            <div style={{ color: "#CFE3DA", fontSize: 13 }}>
              総勤務時間　<span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "#FFFFFF" }}>{formatDuration(grandTotal)}</span>
            </div>
            <div style={{ color: "#E9C6B8", fontSize: 13 }}>
              総残業時間　<span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "#FFFFFF" }}>{formatDuration(grandOvertime)}</span>
            </div>
          </div>
        </div>

        <p style={{ marginTop: 20, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.7 }}>
          ※ このプロトタイプは24時間表記(例: 13:17)での入力を前提としています。手書き出勤簿にある
          「1桁時台の表記(例: 1:00 = 13:00の意)」の自動補正は、OCR連携時に別途組み込みます。
        </p>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
ReactDOM.createRoot(rootEl).render(<WeeklyTimesheetCalculator />);

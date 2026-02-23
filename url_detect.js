function looksLikeUrl(value) {
    if (typeof value !== "string") return false;
    const s = value.trim();
    if (!s) return false;
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }
  
  function urlColumnNameScore(key) {
    const k = String(key || "").toLowerCase();
    if (k === "deck") return 40;
    if (k === "first_aha_deck") return 35;
    if (k.includes("presentation")) return 30;
    if (k.includes("deck")) return 25;
    if (k.includes("url")) return 20;
    if (k.includes("link")) return 15;
    return 0;
  }

  export function detectUrlColumn(rows) {
    const keys = Object.keys(rows[0] || {});
    const scored = keys.map((k) => {
      let total = 0;
      let ok = 0;
      for (const r of rows) {
        const v = r[k];
        if (v == null) continue;
        const s = String(v).trim();
        if (!s) continue;
        total += 1;
        if (looksLikeUrl(s)) ok += 1;
      }
      const ratio = total ? ok / total : 0;
      const nameScore = urlColumnNameScore(k);
      return { key: k, ratio, ok, total, nameScore };
    });
  
    scored.sort((a, b) => {
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      if (b.ok !== a.ok) return b.ok - a.ok;
      if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
      return a.key.localeCompare(b.key);
    });
    return scored;
  }
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
      return { key: k, ratio, ok, total };
    });
  
    scored.sort((a, b) => b.ratio - a.ratio);
    return scored;
  }
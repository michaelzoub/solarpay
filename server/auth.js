import { safeEqual } from "./crypto.js";

export function laptopAuth(apiKeys) {
  return (req, res, next) => {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    let laptopId = null;
    for (const [key, id] of apiKeys) if (safeEqual(token, key)) laptopId = id;
    if (!laptopId) return res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
    req.laptopId = laptopId;
    next();
  };
}

export function adminAuth(adminKey) {
  return (req, res, next) => {
    const provided = req.get("x-admin-key") || "";
    if (!safeEqual(provided, adminKey)) return res.status(403).json({ error: "Admin access required", code: "FORBIDDEN" });
    next();
  };
}

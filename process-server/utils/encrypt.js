const crypto = require("crypto");

// کلید مخفی خودت (حداقل ۳۲ کاراکتر - خیلی مهم است)
const SECRET_KEY = "12345678901234567890123456789012"; // دقیقاً ۳۲ کاراکتر

// تبدیل آبجکت به رشته رمزنگاری شده
function encrypt(data) {
  const iv = crypto.randomBytes(16); // Initialization Vector
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(SECRET_KEY),
    iv,
  );

  let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
  encrypted += cipher.final("hex");

  // iv را هم با داده برگردان (برای دیکریپت لازم است)
  return iv.toString("hex") + ":" + encrypted;
}

module.exports = { encrypt };

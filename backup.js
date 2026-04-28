const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "shop.db");
const backupDir = path.join(__dirname, "backups");

if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const now = new Date();
const ts = now.getFullYear()
  + String(now.getMonth() + 1).padStart(2, "0")
  + String(now.getDate()).padStart(2, "0")
  + String(now.getHours()).padStart(2, "0")
  + String(now.getMinutes()).padStart(2, "0")
  + String(now.getSeconds()).padStart(2, "0");

const backupPath = path.join(backupDir, "shop_" + ts + ".db");

try {
  fs.copyFileSync(dbPath, backupPath);
  const size = fs.statSync(backupPath).size;
  console.log("Backup created: " + backupPath + " (" + (size / 1024).toFixed(1) + "KB)");

  // Keep only last 30 backups
  const files = fs.readdirSync(backupDir)
    .filter(f => f.endsWith(".db"))
    .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (files.length > 30) {
    files.slice(30).forEach(f => {
      fs.unlinkSync(path.join(backupDir, f.name));
      console.log("Cleaned old backup: " + f.name);
    });
  }
} catch (err) {
  console.error("Backup failed:", err.message);
  process.exit(1);
}

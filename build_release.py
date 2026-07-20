import os
import stat
import zipfile

ROOT = r"D:\Ideas\LinkedIn Opera Applets"
OUT = os.path.join(ROOT, "dist", "LinkedIn-Opera-Applets.zip")
TOP = "LinkedIn Opera Applets"

# Explicit allowlist - do NOT just glob everything, so the user's real
# application tracker (Трекер откликов - AB тест.xlsx and its .backup.xlsx),
# personal CVs, ARCHITECTURE.md, and the dist/ folder itself never end up
# inside the release archive. server/tracker-template.xlsx *is* included -
# it's a blank template with no personal data, needed so a fresh install
# can bootstrap its own tracker file on first use.
FILES = [
    "manifest.json",
    "README.md",
    "README.ru.md",
    "src/content.js",
    "src/content.css",
    "src/indeedContent.js",
    "src/indeedContent.css",
    "src/genericContent.js",
    "src/genericContent.css",
    "src/background.js",
    "src/zip.js",
    "src/popup.html",
    "src/popup.js",
    "src/popup.css",
    "server/save-server.js",
    "server/start-server.bat",
    "server/start-server.command",
    "server/tracker-template.xlsx",
]

EXECUTABLE = {"server/start-server.command"}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
if os.path.exists(OUT):
    os.remove(OUT)

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for rel in FILES:
        src_path = os.path.join(ROOT, rel.replace("/", os.sep))
        arcname = f"{TOP}/{rel}"
        info = zipfile.ZipInfo(arcname)
        info.compress_type = zipfile.ZIP_DEFLATED
        # Unix mode bits go in the top 16 bits of external_attr; set them
        # explicitly so start-server.command keeps its executable bit when
        # extracted on macOS/Linux (Windows-built zips default to non-exec).
        mode = 0o755 if rel in EXECUTABLE else 0o644
        info.external_attr = (mode | stat.S_IFREG) << 16
        with open(src_path, "rb") as f:
            data = f.read()
        zf.writestr(info, data)

print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes, {len(FILES)} files)")

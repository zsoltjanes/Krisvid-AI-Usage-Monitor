"use strict";

// Dev-only screenshot helper. Stays in the tree permanently (guarded by env
// vars) so verifying the UI from Claude Code's shell no longer means pasting a
// hook into main.js and deleting it afterwards. It is a complete no-op unless
// AI_USAGE_SCREENSHOT is set, so it can never affect the shipped app.
//
// Env vars:
//   AI_USAGE_SCREENSHOT        - output PNG path (required to arm the helper)
//   AI_USAGE_SCREENSHOT_DELAY  - ms to wait for data before capture (default 12000)
//   AI_USAGE_SCREENSHOT_CLICK  - JS evaluated in the renderer before capture
//                                (e.g. open settings, toggle a section); its
//                                return value is logged as CLICK_RESULT
//
// See CLAUDE.md → "Running / verifying the app" for the full recipe.
const fs = require("fs");

function maybeCaptureScreenshot(app, panel) {
  const outPath = process.env.AI_USAGE_SCREENSHOT;
  if (!outPath) return;

  const delay = Number(process.env.AI_USAGE_SCREENSHOT_DELAY) || 12000;
  setTimeout(async () => {
    try {
      if (process.env.AI_USAGE_SCREENSHOT_CLICK) {
        const result = await panel.webContents.executeJavaScript(process.env.AI_USAGE_SCREENSHOT_CLICK);
        console.log("CLICK_RESULT", JSON.stringify(result));
        await new Promise((r) => setTimeout(r, 500));
      }
      const img = await panel.webContents.capturePage();
      fs.writeFileSync(outPath, img.toPNG());
      console.log("SCREENSHOT_WRITTEN", outPath);
    } catch (err) {
      console.log("SCREENSHOT_ERROR", err && err.message);
    } finally {
      app.quit();
    }
  }, delay);
}

module.exports = { maybeCaptureScreenshot };

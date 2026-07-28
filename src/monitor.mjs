import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const cwd = process.cwd();
const stateDir = path.join(cwd, "state");
const snapshotsDir = path.join(cwd, "snapshots");
const authFile = path.join(stateDir, "auth.json");
const reauthRequiredFile = path.join(stateDir, "reauth-required.json");
const lastFile = path.join(stateDir, "last.json");
const schedulerLockFile = path.join(stateDir, "scheduler.lock");
const discordOutboxFile = path.join(stateDir, "discord-outbox.jsonl");
const configFile = path.join(cwd, "config.local.json");
const exampleConfigFile = path.join(cwd, "config.example.json");

const LOGIN_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[name*="username" i]',
  'input[id*="username" i]',
  'input[id*="email" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="username" i]',
  'input[autocomplete="username"]',
  'input[type="text"]',
];

const LOGIN_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name*="password" i]',
  'input[autocomplete="current-password"]',
];

const OTP_INPUT_SELECTORS = [
  '#secure-verification-code',
  '[data-testid="test-secure-verification-code"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[inputmode="numeric"]',
  'input[type="tel"]',
];

const BUTTON_TEXTS = [/sign in/i, /log in/i, /submit/i, /continue/i, /verify/i];

function ensureDirs() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSchedulerLock() {
  ensureDirs();

  try {
    const existing = JSON.parse(fs.readFileSync(schedulerLockFile, "utf8"));
    if (processIsAlive(Number(existing.pid))) {
      throw new Error(`Another scheduler is already running (PID ${existing.pid})`);
    }
    fs.unlinkSync(schedulerLockFile);
    console.warn(`Removed stale scheduler lock from PID ${existing.pid || "unknown"}`);
  } catch (error) {
    if (error.code !== "ENOENT" && !error.message?.includes("Unexpected")) {
      throw error;
    }
    if (error.message?.includes("Unexpected")) {
      fs.unlinkSync(schedulerLockFile);
      console.warn("Removed invalid scheduler lock file");
    }
  }

  const fd = fs.openSync(schedulerLockFile, "wx");
  fs.writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    startedAtEt: formatEtTimestamp(),
  }, null, 2) + "\n", "utf8");
  fs.closeSync(fd);

  const release = () => {
    try {
      const current = JSON.parse(fs.readFileSync(schedulerLockFile, "utf8"));
      if (Number(current.pid) === process.pid) {
        fs.unlinkSync(schedulerLockFile);
      }
    } catch {
      // Best-effort cleanup only.
    }
  };

  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      release();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function loadConfig() {
  const source = fs.existsSync(configFile) ? configFile : exampleConfigFile;
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function discordWebhookUrl(config) {
  return (
    config?.discordWebhookUrl ||
    process.env.USCIS_MONITOR_DISCORD_WEBHOOK_URL
  );
}

function notificationMode(config) {
  // Supports: "discord", "macos", "both", or null/undefined (auto-detect)
  const mode = config?.notificationMode || process.env.USCIS_MONITOR_NOTIFICATION_MODE;
  if (mode) {
    return mode.toLowerCase();
  }
  // Auto-detect: if on macOS and no Discord URL, default to macOS
  if (process.platform === "darwin" && !discordWebhookUrl(config)) {
    return "macos";
  }
  // Otherwise default to discord if URL is set
  return discordWebhookUrl(config) ? "discord" : null;
}

async function sendMacOsNotification(title, message, subtitle = null) {
  if (process.platform !== "darwin") {
    console.warn("macOS notifications only available on macOS");
    return false;
  }

  try {
    const subtitleArg = subtitle ? ` subtitle "${subtitle.replace(/"/g, '\\"')}"` : "";
    const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"${subtitleArg}`;

    await new Promise((resolve, reject) => {
      const child = spawn("osascript", ["-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`osascript failed: ${stderr}`));
        } else {
          resolve();
        }
      });

      child.on("error", reject);
    });

    return true;
  } catch (error) {
    console.error(`macOS notification failed: ${error.message}`);
    return false;
  }
}

function authMtimeMs() {
  try {
    return fs.statSync(authFile).mtimeMs;
  } catch {
    return 0;
  }
}

function loadReauthRequired() {
  try {
    return JSON.parse(fs.readFileSync(reauthRequiredFile, "utf8"));
  } catch {
    return null;
  }
}

function clearReauthRequired() {
  if (fs.existsSync(reauthRequiredFile)) {
    fs.unlinkSync(reauthRequiredFile);
    console.log(`✓ Cleared manual reauth state: ${reauthRequiredFile}`);
  }
}

function activeReauthRequired() {
  const state = loadReauthRequired();
  if (!state) {
    return null;
  }

  if (authMtimeMs() > Number(state.authMtimeMs || 0)) {
    clearReauthRequired();
    return null;
  }

  return state;
}

function markReauthRequired(reason) {
  const now = new Date().toISOString();
  const existing = activeReauthRequired();
  const state = {
    requiredAt: existing?.requiredAt || now,
    lastNotifiedAt: existing?.lastNotifiedAt || null,
    authMtimeMs: authMtimeMs(),
    reason,
  };
  fs.writeFileSync(reauthRequiredFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

function reauthReminderIntervalMs(config) {
  const hours = Number(config?.scheduler?.reauthReminderHours ?? 6);
  if (!Number.isFinite(hours) || hours <= 0) {
    return 6 * 60 * 60 * 1000;
  }
  return Math.max(hours * 60 * 60 * 1000, 60 * 60 * 1000);
}

function shouldNotifyReauthRequired(config, state) {
  if (!state?.lastNotifiedAt) {
    return true;
  }
  return Date.now() - Date.parse(state.lastNotifiedAt) >= reauthReminderIntervalMs(config);
}

async function notifyReauthRequired(config, state, message) {
  if (!shouldNotifyReauthRequired(config, state)) {
    console.log("Manual reauth reminder suppressed by cooldown.");
    return;
  }

  const webhookUrl = discordWebhookUrl(config);
  if (webhookUrl) {
    await notifyDiscord(webhookUrl, {
      content: `⚠️ \`${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC\` ${message}`,
    }).catch((error) => console.error(`Discord notify failed: ${error.message}`));
  }

  const updated = {
    ...state,
    lastNotifiedAt: new Date().toISOString(),
  };
  fs.writeFileSync(reauthRequiredFile, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

function loginIdentifier(config) {
  return config.uscisUsername || config.uscisEmail;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isVerificationPageUrl(url) {
  const lower = url.toLowerCase();
  return lower.includes("verification") || lower.includes("two-factor") || lower.includes("2fa");
}

async function firstVisible(page, selectors, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        const visible = await locator.isVisible().catch(() => false);
        if (visible) {
          return locator;
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function firstVisibleInPageOrFrames(page, selectors, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const fromPage = await firstVisible(page, selectors, 500);
    if (fromPage) {
      return fromPage;
    }
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        if (await locator.count()) {
          const visible = await locator.isVisible().catch(() => false);
          if (visible) {
            return locator;
          }
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function clickButton(page, regexes) {
  const preferredSelectors = [
    '[data-testid="sign-in-btn"]',
    '#sign-in-btn',
    'button[id="sign-in-btn"]',
  ];
  
  // Try preferred selectors first
  for (const selector of preferredSelectors) {
    const button = page.locator(selector).first();
    if (await button.count() && await button.isVisible().catch(() => false)) {
      if (!(await button.isEnabled().catch(() => true))) {
        console.log(`    Found disabled button: ${selector}`);
        continue;
      }
      console.log(`    Found button: ${selector}`);
      await button.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  
  // Try by text/role
  for (const regex of regexes) {
    const button = page.getByRole("button", { name: regex }).first();
    if (await button.count()) {
      if (!(await button.isEnabled().catch(() => true))) {
        console.log(`    Found disabled button by role: ${regex}`);
        continue;
      }
      console.log(`    Found button by role: ${regex}`);
      await button.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
    
    const input = page.locator('input[type="submit"], button').filter({ hasText: regex }).first();
    if (await input.count()) {
      if (!(await input.isEnabled().catch(() => true))) {
        console.log(`    Found disabled submit by text: ${regex}`);
        continue;
      }
      console.log(`    Found submit by text: ${regex}`);
      await input.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  
  return false;
}

async function waitForPostSubmitChange(page, timeout = 5000) {
  const startUrl = page.url();
  const startHtml = await page.content().catch(() => "");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const currentUrl = page.url();
    if (currentUrl !== startUrl) {
      return true;
    }
    const currentHtml = await page.content().catch(() => "");
    if (currentHtml !== startHtml) {
      return true;
    }
  }
  return false;
}

function readOtp(otpConfig) {
  const mode = otpConfig?.mode || "imap";
  
  if (mode === "imap") {
    // Use IMAP email mode
    if (!otpConfig) {
      throw new Error("OTP config required for IMAP mode");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        "python3",
        [path.join("src", "email_otp.py"), "--config-json", JSON.stringify(otpConfig)],
        {
          cwd,
          stdio: ["ignore", "pipe", "inherit"],
        },
      );

      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("Failed to read OTP from email"));
          return;
        }
        resolve(stdout.trim());
      });
    });
  } else if (mode === "sms-imessage") {
    // Use macOS Messages (iMessage) mode
    if (!otpConfig) {
      throw new Error("OTP config required for SMS/iMessage mode");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        "python3",
        [path.join("src", "sms_imessage.py"), "--config-json", JSON.stringify(otpConfig)],
        {
          cwd,
          stdio: ["ignore", "pipe", "inherit"],
        },
      );

      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("Failed to read OTP from SMS/iMessage"));
          return;
        }
        resolve(stdout.trim());
      });
    });
  } else {
    throw new Error(`Unsupported OTP mode: ${mode}`);
  }
}

// Legacy function for backward compatibility
function readOtpFromConfiguredSource(otpConfig) {
  return readOtp(otpConfig);
}

function normalizeOtp(rawCode) {
  const digitsOnly = String(rawCode || "").replace(/\D+/g, "");
  if (digitsOnly.length >= 6) {
    return digitsOnly.slice(0, 6);
  }
  return String(rawCode || "").trim();
}

async function typeLikeHuman(locator, value) {
  await locator.focus().catch(() => {});
  await locator.click({ clickCount: 3 }).catch(() => {});
  await locator.press("Backspace").catch(() => {});
  for (const char of String(value)) {
    await locator.type(char, { delay: 90 + Math.floor(Math.random() * 80) }).catch(async () => {
      await locator.fill(String(value)).catch(() => {});
    });
  }

  // Some React forms only validate after input/change/blur events.
  await locator.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.dispatchEvent(new Event("blur", { bubbles: true }));
  }).catch(() => {});
}

async function waitForOtpPostSubmit(page, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const stillOnOtp = await firstVisibleInPageOrFrames(page, OTP_INPUT_SELECTORS, 300);
    if (!stillOnOtp) {
      return true;
    }
  }
  return false;
}

async function looksLoggedOut(page) {
  const url = page.url().toLowerCase();
  if (isVerificationPageUrl(url)) {
    return false;
  }
  if (url.includes("/oidc/login") || url.includes("/oauth/authorize")) {
    return true;
  }
  for (const selector of [...LOGIN_EMAIL_SELECTORS, ...LOGIN_PASSWORD_SELECTORS]) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        return true;
      }
    }
  }
  return false;
}

async function fillFirst(page, selectors, value) {
  const input = await firstVisibleInPageOrFrames(page, selectors);
  if (!input) {
    const summary = await pageSummary(page);
    await writeDebugSnapshot(page, "missing-input");
    throw new Error(
      `Could not find input for selectors: ${selectors.join(", ")}\nURL: ${summary.url}\nTitle: ${summary.title}\nHeading: ${summary.heading}\nAlert: ${summary.alert}\nText: ${summary.text.slice(0, 300)}`,
    );
  }
  await typeLikeHuman(input, value);
}

async function pageSummary(page) {
  const summary = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    const heading = document.querySelector("h1,h2,h3")?.textContent?.trim() || "";
    const alert =
      document.querySelector('[role="alert"], .usa-alert, .alert, .error, [data-testid*="error" i]')?.textContent?.trim() || "";
    return {
      title: document.title,
      heading,
      alert,
      text,
    };
  });
  return {
    url: page.url(),
    ...summary,
  };
}

async function writeDebugSnapshot(page, label) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const base = path.join(snapshotsDir, `${stamp}-${label}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) {
    fs.writeFileSync(`${base}.html`, html, "utf8");
  }
  return base;
}

async function maybeHandleOtp(page, config) {
  console.log("  Finding OTP input field...");
  const otpInput = page.locator(OTP_INPUT_SELECTORS.join(", ")).first();
  const visible = await otpInput.isVisible().catch(() => false);
  if (!visible) {
    console.log("  No OTP input field found");
    return false;
  }

  try {
    const mode = config.otp?.mode || "imap";
    const modeLabel = mode === "sms-imessage" ? "SMS/iMessage" : "email";
    console.log(`  Mode: ${modeLabel}`);
    
    // Validate OTP config exists
    if (!config.otp) {
      throw new Error("OTP configuration not found");
    }
    
    console.log(`  Reading OTP code from ${modeLabel}...`);
    const rawCode = await readOtp(config.otp);
    const code = normalizeOtp(rawCode);
    console.log(`  ✓ Code retrieved: ${code.substring(0, 2)}***`);

    console.log(`  Filling code into input...`);
    await otpInput.fill(code).catch(() => {});
    await otpInput.evaluate((node) => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }).catch(() => {});
    
    await page.waitForTimeout(500);
    await writeDebugSnapshot(page, "otp-filled");

    // Try multiple submit methods
    console.log(`  Submitting code...`);
    
    // Method 1: Look for explicit submit button
    const submitBtn = page.locator('button, input[type="submit"]').filter({ hasText: /submit|verify|continue/i }).first();
    if (await submitBtn.count()) {
      console.log("    Clicking submit button...");
      await submitBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      
      if (await waitForOtpPostSubmit(page, 8000)) {
        console.log("  ✓ OTP accepted");
        return true;
      }
    }

    // Method 2: Press Enter
    console.log("    Trying Enter key...");
    await otpInput.press("Enter").catch(() => {});
    await page.waitForTimeout(1000);
    
    if (await waitForOtpPostSubmit(page, 8000)) {
      console.log("  ✓ OTP accepted");
      return true;
    }

    console.log("  ✓ OTP submitted (may still be processing)");
    return true;
  } catch (error) {
    console.error(`  ✗ OTP error: ${error.message}`);
    throw error;
  }
}

async function submitLogin(page) {
  console.log("Attempting to submit login form...");
  const startUrl = page.url();

  // Try clicking login button (single click only)
  console.log("  Trying to click login button...");
  const clicked = await clickButton(page, [/(sign|log)\s*in/i, /continue/i, /next/i]);
  
  if (!clicked) {
    // Fallback: press Enter on password field
    console.log("  No button found, pressing Enter...");
    const passwordInput = await firstVisibleInPageOrFrames(page, LOGIN_PASSWORD_SELECTORS, 3000);
    if (passwordInput) {
      await passwordInput.press("Enter").catch(() => {});
    } else {
      throw new Error("Cannot find login button or password field to submit");
    }
  }

  // Wait for page navigation or OTP page (up to 15s)
  console.log("  Waiting for page response...");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    
    // Check URL changed
    if (page.url() !== startUrl) {
      console.log("  ✓ Page navigated");
      return;
    }
    
    // Check if OTP input appeared (same URL but different content)
    const otpVisible = await page.locator(OTP_INPUT_SELECTORS.join(", ")).first().isVisible().catch(() => false);
    if (otpVisible) {
      console.log("  ✓ OTP page detected");
      return;
    }
  }

  // First attempt timed out — try Enter key fallback and wait another 15s
  console.log("  ⚠️ No navigation after 15s, trying Enter key fallback...");
  const passwordInput = await firstVisibleInPageOrFrames(page, LOGIN_PASSWORD_SELECTORS, 2000);
  if (passwordInput) {
    await passwordInput.press("Enter").catch(() => {});
  }

  const deadline2 = Date.now() + 15000;
  while (Date.now() < deadline2) {
    await page.waitForTimeout(500);
    if (page.url() !== startUrl) {
      console.log("  ✓ Page navigated after Enter fallback");
      return;
    }
    const otpVisible = await page.locator(OTP_INPUT_SELECTORS.join(", ")).first().isVisible().catch(() => false);
    if (otpVisible) {
      console.log("  ✓ OTP page detected after Enter fallback");
      return;
    }
  }

  console.log("  ⚠️ No navigation detected after extended wait — login form submit may have failed");
}

async function browserWithState(useSavedState) {
  const storageState = useSavedState && fs.existsSync(authFile) ? authFile : undefined;
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      // Disable detection of being automated
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  const context = await browser.newContext({
    storageState,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
  });
  
  // Stealth mode: hide webdriver property
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    // Hide chrome detection
    if (window.chrome === undefined) {
      window.chrome = {};
    }
    Object.defineProperty(window, 'chrome', {
      get: () => ({
        runtime: {}
      }),
    });
  });
  
  return { browser, context, page };
}

async function login(config) {
  const { browser, context, page } = await browserWithState(false);
  try {
    console.log("Starting login process...");
    console.log(`Navigating to ${config.loginUrl}`);
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000); // Allow time for JavaScript to load
    
    console.log("Filling email/username...");
    await fillFirst(page, LOGIN_EMAIL_SELECTORS, loginIdentifier(config));
    await page.waitForTimeout(500);
    
    console.log("Filling password...");
    await fillFirst(page, LOGIN_PASSWORD_SELECTORS, config.uscisPassword);
    await page.waitForTimeout(500);
    
    await writeDebugSnapshot(page, "login-form-filled");
    console.log("✓ Login form filled");

    console.log("Submitting login form...");
    await submitLogin(page);
    
    console.log("Waiting for page to load after login...");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(3000);
    await writeDebugSnapshot(page, "after-primary-submit");

    console.log("Checking for OTP requirement...");
    try {
      console.log("Looking for OTP input (checking for 12 seconds)...");
      const otpInput = await firstVisibleInPageOrFrames(page, OTP_INPUT_SELECTORS, 12000).catch(() => null);
      
      if (otpInput) {
        console.log("✓ OTP input found, proceeding with OTP handling...");
        const handledOtp = await maybeHandleOtp(page, config);
        if (handledOtp) {
          console.log("✓ OTP submitted");
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await page.waitForTimeout(3000);
          await writeDebugSnapshot(page, "after-otp-submit");
        }
      } else {
        console.log("No OTP input found - proceeding without OTP");
      }
    } catch (otpError) {
      console.error(`⚠️  OTP handling error: ${otpError.message}`);
      await writeDebugSnapshot(page, "otp-error");
      throw otpError;
    }

    console.log(`Waiting ${config.postLoginWaitMs ?? 5000}ms before navigating to monitor URL...`);
    await page.waitForTimeout(config.postLoginWaitMs ?? 5000);
    
    console.log(`Navigating to ${config.monitorUrl}`);
    await page.goto(config.monitorUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    
    console.log("Checking if logged in successfully...");
    if (await looksLoggedOut(page)) {
      const summary = await pageSummary(page);
      await writeDebugSnapshot(page, "login-failed");
      throw new Error(
        `Login did not stick. URL: ${summary.url}\nTitle: ${summary.title}\nHeading: ${summary.heading}\nAlert: ${summary.alert}\nText: ${summary.text.slice(0, 300)}`,
      );
    }
    
    console.log("✓ Successfully logged in!");

    // Validate the session actually works via a real API call before saving
    if (config.receiptNumbers?.length > 0) {
      console.log("Validating session via API...");
      const cookies = await context.cookies();
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      const testReceipt = config.receiptNumbers[0];
      try {
        const testRes = await fetch(`${config.apiUrl}/${testReceipt}`, {
          headers: {
            "Cookie": cookieHeader,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Referer": config.monitorUrl,
          },
        });
        if (testRes.status === 401) {
          throw new Error("API validation failed: 401 Unauthorized — session not actually established");
        }
        if (testRes.ok) {
          const data = await testRes.json().catch(() => null);
          if (data && data.data === null && data.error) {
            throw new Error("API validation failed: session token rejected by USCIS API");
          }
        }
        console.log("✓ API session validated");
      } catch (err) {
        if (err.message.startsWith("API validation failed")) {
          throw new Error(`Login appeared to succeed but auth is invalid: ${err.message}`);
        }
        // Network/timeout during validation — don't block, warn only
        console.warn(`⚠️ Could not validate API session: ${err.message} (saving anyway)`);
      }
    }

    await context.storageState({ path: authFile });
    console.log(`✓ Saved authenticated session to ${authFile}`);
    clearReauthRequired();
  } finally {
    await browser.close();
  }
}

async function extractMonitoredText(page, config) {
  await page.goto(config.monitorUrl, { waitUntil: "domcontentloaded" });
  if (await looksLoggedOut(page)) {
    await writeDebugSnapshot(page, "poll-session-expired");
    throw new Error("Session expired. Run `npm run reauth`.");
  }
  if (config.monitorReadySelector) {
    await page.locator(config.monitorReadySelector).first().waitFor({ timeout: 30000 });
  }
  const contentLocator = page.locator(config.contentSelector || "body").first();
  await contentLocator.waitFor({ timeout: 30000 });
  const text = (await contentLocator.innerText()).replace(/\s+/g, " ").trim();
  const html = await contentLocator.innerHTML();
  return { text, html };
}

function requireAuthState() {
  if (!fs.existsSync(authFile)) {
    throw new Error("Missing state/auth.json. Run `npm run login` first.");
  }
}

function saveSnapshot(prefix, text, html) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const textFile = path.join(snapshotsDir, `${stamp}-${prefix}.txt`);
  const htmlFile = path.join(snapshotsDir, `${stamp}-${prefix}.html`);
  fs.writeFileSync(textFile, `${text}\n`, "utf8");
  fs.writeFileSync(htmlFile, html, "utf8");
  return { textFile, htmlFile };
}

const caseHistoryFile = path.join(stateDir, "case-history.json");

function loadCaseHistory() {
  if (!fs.existsSync(caseHistoryFile)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(caseHistoryFile, "utf8"));
  } catch (e) {
    console.warn("Could not parse case history, starting fresh");
    return {};
  }
}

function saveCaseHistory(history) {
  fs.writeFileSync(caseHistoryFile, JSON.stringify(history, null, 2) + "\n", "utf8");
}

function deepHash(obj) {
  // Create a hash of the object for change detection
  return sha256(JSON.stringify(obj || {}));
}

function formatEtTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName") || "ET"}`;
}

function joinApiUrl(baseUrl, receiptNumber) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${encodeURIComponent(receiptNumber)}`;
}

function getCaseStatusApiUrl(config) {
  return config.caseStatusApiUrl || "https://my.uscis.gov/account/case-service/api/case_status";
}

function changedTopLevelFields(prevData, currData) {
  const keys = new Set([
    ...Object.keys(prevData || {}),
    ...Object.keys(currData || {}),
  ]);
  return [...keys]
    .filter((key) => deepHash(prevData?.[key]) !== deepHash(currData?.[key]))
    .sort();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shortValue(value) {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") return value || '""';
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (isPlainObject(value)) return "{...}";
  return String(value);
}

function summarizeFieldChanges(previous, current, fields, maxFields = 8) {
  const priority = [
    "updatedAt",
    "updatedAtTimestamp",
    "eventDateTime",
    "submissionDate",
    "formType",
    "formName",
    "closed",
    "actionRequired",
    "areAllGroupStatusesComplete",
    "areAllGroupMembersAuthorizedForTravel",
    "documents",
    "evidenceRequests",
    "notices",
    "events",
  ];
  const orderedFields = [
    ...priority.filter((field) => fields.includes(field)),
    ...fields.filter((field) => !priority.includes(field)),
  ];

  return orderedFields.slice(0, maxFields).map((field) => {
    const prevValue = previous?.[field];
    const currValue = current?.[field];
    if (field === "events" && (Array.isArray(prevValue) || Array.isArray(currValue))) {
      return `${field}: ${prevValue?.length || 0} → ${currValue?.length || 0}`;
    }
    return `${field}: ${shortValue(prevValue)} → ${shortValue(currValue)}`;
  });
}

function summarizeEventChanges(prevEvents, currEvents) {
  const prevById = new Map(prevEvents.map((event, index) => [event.eventId || `${event.eventCode}:${index}`, event]));
  const currById = new Map(currEvents.map((event, index) => [event.eventId || `${event.eventCode}:${index}`, event]));
  const newEvents = currEvents.filter((event, index) => !prevById.has(event.eventId || `${event.eventCode}:${index}`));
  const removedEvents = prevEvents.filter((event, index) => !currById.has(event.eventId || `${event.eventCode}:${index}`));
  const changedEvents = currEvents
    .map((event, index) => {
      const key = event.eventId || `${event.eventCode}:${index}`;
      const previous = prevById.get(key);
      if (!previous || deepHash(previous) === deepHash(event)) {
        return null;
      }
      return {
        eventId: event.eventId,
        eventCode: event.eventCode,
        changedFields: changedTopLevelFields(previous, event),
        fromUpdatedAtTimestamp: previous.updatedAtTimestamp,
        toUpdatedAtTimestamp: event.updatedAtTimestamp,
      };
    })
    .filter(Boolean);

  return { newEvents, removedEvents, changedEvents };
}

function getApiResponsesForDiff(caseData) {
  if (caseData?.apiResponses) {
    return caseData.apiResponses;
  }
  // Backward compatibility for history entries saved before multi-API support.
  return caseData ? { cases: caseData } : {};
}

function isUsableApiResponse(response) {
  return Boolean(response && typeof response === "object" && response.data);
}

function stableCaseBundle(record) {
  const current = record?.current || null;
  const previous = record?.previous || null;
  if (!current && !previous) {
    return null;
  }

  const apiResponses = {};
  for (const apiName of ["cases", "caseStatus"]) {
    const currentResponse = current?.apiResponses?.[apiName];
    const previousResponse = previous?.apiResponses?.[apiName];
    if (isUsableApiResponse(currentResponse)) {
      apiResponses[apiName] = currentResponse;
    } else if (isUsableApiResponse(previousResponse)) {
      apiResponses[apiName] = previousResponse;
    }
  }

  const data =
    apiResponses.cases?.data ||
    current?.data ||
    previous?.data ||
    apiResponses.caseStatus?.data ||
    null;

  if (!data) {
    return null;
  }

  return {
    data,
    apiResponses,
  };
}

function mergeFetchedBundle(previousBundle, fetchedBundle) {
  const apiResponses = { ...(previousBundle?.apiResponses || {}) };
  for (const [apiName, response] of Object.entries(fetchedBundle?.apiResponses || {})) {
    if (isUsableApiResponse(response)) {
      apiResponses[apiName] = response;
    }
  }

  const data =
    apiResponses.cases?.data ||
    previousBundle?.data ||
    apiResponses.caseStatus?.data ||
    null;

  return {
    data,
    apiResponses,
    apiErrors: fetchedBundle?.apiErrors || {},
  };
}

function summarizeApiResponseChange(previousResponse, currentResponse) {
  const prevData = previousResponse?.data || null;
  const currData = currentResponse?.data || null;
  const dataChangedFields = changedTopLevelFields(prevData || {}, currData || {});
  const responseChangedFields = changedTopLevelFields(previousResponse, currentResponse);
  const summary = [];

  if (!prevData && currData) {
    summary.push("data became available");
  } else if (prevData && !currData) {
    summary.push("data became unavailable");
  }

  if (dataChangedFields.length > 0) {
    summary.push(...summarizeFieldChanges(prevData || {}, currData || {}, dataChangedFields));
  } else if (responseChangedFields.length > 0) {
    summary.push(`response envelope changed: ${responseChangedFields.join(", ")}`);
  }

  const eventChanges =
    Array.isArray(prevData?.events) && Array.isArray(currData?.events)
      ? summarizeEventChanges(prevData.events, currData.events)
      : null;

  if (eventChanges?.newEvents?.length) {
    summary.push(`new events: ${eventChanges.newEvents.length}`);
  }
  if (eventChanges?.changedEvents?.length) {
    summary.push(
      `changed events: ${eventChanges.changedEvents
        .map((event) => `${event.eventCode || "event"} ${event.changedFields.join(", ")}`)
        .join("; ")}`,
    );
  }

  return {
    responseChangedFields,
    dataChangedFields,
    summary,
  };
}

function detectChanges(previousData, currentData) {
  const changes = {};
  
  if (!previousData) {
    return { isChanged: true, summary: "New case" };
  }
  
  const prevData = previousData.data || {};
  const currData = currentData.data || {};
  
  // Check key fields
  if (prevData.updatedAt !== currData.updatedAt) {
    changes.updatedAt = {
      from: prevData.updatedAt,
      to: currData.updatedAt,
    };
  }

  if (prevData.updatedAtTimestamp !== currData.updatedAtTimestamp) {
    changes.updatedAtTimestamp = {
      from: prevData.updatedAtTimestamp,
      to: currData.updatedAtTimestamp,
    };
  }
  
  // Check events
  const prevEvents = prevData.events || [];
  const currEvents = currData.events || [];
  const prevEventCount = prevEvents.length;
  const currEventCount = currEvents.length;
  if (prevEventCount !== currEventCount || deepHash(prevEvents) !== deepHash(currEvents)) {
    const eventChanges = summarizeEventChanges(prevEvents, currEvents);
    changes.events = {
      from: prevEventCount,
      to: currEventCount,
      ...eventChanges,
    };
  }
  
  // Check closed status
  if (prevData.closed !== currData.closed) {
    changes.closed = {
      from: prevData.closed,
      to: currData.closed,
    };
  }
  
  // Check if any important field changed
  if (prevData.actionRequired !== currData.actionRequired) {
    changes.actionRequired = {
      from: prevData.actionRequired,
      to: currData.actionRequired,
    };
  }

  const previousHash = deepHash(prevData);
  const currentHash = deepHash(currData);
  if (previousHash !== currentHash) {
    const changedFields = changedTopLevelFields(prevData, currData);
    changes.caseData = {
      fromHash: previousHash,
      toHash: currentHash,
      changedFields,
      summary: summarizeFieldChanges(prevData, currData, changedFields),
    };
  }

  const prevApiResponses = getApiResponsesForDiff(previousData);
  const currApiResponses = getApiResponsesForDiff(currentData);
  const apiNames = new Set([
    ...Object.keys(prevApiResponses),
    ...Object.keys(currApiResponses),
  ]);
  const apiResponseChanges = {};

  for (const apiName of apiNames) {
    const previousResponse = prevApiResponses[apiName] || null;
    const currentResponse = currApiResponses[apiName] || null;
    const fromHash = deepHash(previousResponse);
    const toHash = deepHash(currentResponse);
    if (fromHash !== toHash) {
      const apiSummary = summarizeApiResponseChange(previousResponse, currentResponse);
      apiResponseChanges[apiName] = {
        fromHash,
        toHash,
        changedFields: apiSummary.responseChangedFields,
        dataChangedFields: apiSummary.dataChangedFields,
        summary: apiSummary.summary,
      };
    }
  }

  if (Object.keys(apiResponseChanges).length > 0) {
    changes.apiResponses = apiResponseChanges;
  }
  
  const isChanged = Object.keys(changes).length > 0;
  
  return { isChanged, changes, summary: isChanged ? `Updated: ${Object.keys(changes).join(", ")}` : "No changes" };
}

async function getCookies(config) {
  // Read cookies from saved auth state
  let cookies = [];
  try {
    const authState = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (authState.cookies) {
      cookies = authState.cookies;
    }
  } catch (e) {
    console.warn("⚠️  Could not read cookies from auth state, trying without cookies...");
  }
  
  // Build Cookie header
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

async function fetchApiJson(baseUrl, receiptNumber, config, apiName) {
  const apiUrl = joinApiUrl(baseUrl, receiptNumber);
  const cookieHeader = await getCookies(config);
  
  try {
    let response;
    try {
      response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "Cookie": cookieHeader,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
          "Referer": config.monitorUrl,
        },
      });
    } catch (networkErr) {
      const err = new Error(`Network error from ${apiName}: ${networkErr.message}`);
      err.code = "NETWORK_ERROR";
      err.apiName = apiName;
      throw err;
    }
    
    // Check for auth failure: HTTP 401 OR API response with data: null + error object
    if (response.status === 401) {
      const error = new Error("SESSION_EXPIRED");
      error.code = "SESSION_EXPIRED";
      error.statusCode = 401;
      error.apiName = apiName;
      throw error;
    }
    
    if (!response.ok) {
      const error = new Error(`${apiName} HTTP ${response.status}: ${response.statusText}`);
      error.code = "API_FETCH_ERROR";
      error.statusCode = response.status;
      error.apiName = apiName;
      throw error;
    }
    
    const data = await response.json();
    
    // Also check for API-level auth failure: data is null with error object
    if (data.data === null && data.error) {
      const error = new Error("SESSION_EXPIRED");
      error.code = "SESSION_EXPIRED";
      error.apiError = data.error;
      error.apiName = apiName;
      throw error;
    }
    
    return data;
  } catch (error) {
    // Don't suppress structured API errors. The bundle layer decides whether they are fatal.
    if (error.code === "SESSION_EXPIRED" || error.code === "NETWORK_ERROR" || error.code === "API_FETCH_ERROR") {
      throw error;
    }
    const structured = new Error(error.message);
    structured.code = "API_FETCH_ERROR";
    structured.apiName = apiName;
    throw structured;
  }
}

async function fetchSingleCase(receiptNumber, config) {
  return fetchApiJson(config.apiUrl, receiptNumber, config, "cases");
}

async function fetchSingleCaseStatus(receiptNumber, config) {
  return fetchApiJson(getCaseStatusApiUrl(config), receiptNumber, config, "case_status");
}

async function fetchCaseBundle(receiptNumber, config) {
  const entries = await Promise.allSettled([
    fetchSingleCase(receiptNumber, config).then((data) => ["cases", data]),
    fetchSingleCaseStatus(receiptNumber, config).then((data) => ["caseStatus", data]),
  ]);

  const apiResponses = {};
  const apiErrors = {};
  const fatalErrors = [];

  for (const entry of entries) {
    if (entry.status === "fulfilled") {
      const [apiName, data] = entry.value;
      apiResponses[apiName] = data;
      continue;
    }

    const error = entry.reason;
    const apiName = error.apiName || "unknown";
    apiErrors[apiName] = error.message;
    if (error.code === "SESSION_EXPIRED") {
      fatalErrors.push(error);
    }
    console.error(`❌ Error fetching ${receiptNumber} via ${apiName}: ${error.message}`);
  }

  if (fatalErrors.length > 0) {
    throw fatalErrors[0];
  }

  if (!apiResponses.cases && !apiResponses.caseStatus) {
    const firstErrorMessage = Object.values(apiErrors)[0] || "Invalid API response";
    const error = new Error(firstErrorMessage);
    error.code = Object.keys(apiErrors).some((apiName) => apiErrors[apiName].includes("Network error"))
      ? "NETWORK_ERROR"
      : "API_FETCH_ERROR";
    throw error;
  }

  return {
    data: apiResponses.cases?.data || apiResponses.caseStatus?.data || null,
    apiResponses,
    apiErrors,
  };
}

async function sendDiscordWebhook(webhookUrl, payload, { retries = 2, delayMs = 3000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
      }
      return; // success
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

function enqueueDiscordWebhook(payload, error) {
  ensureDirs();
  const entry = {
    queuedAt: new Date().toISOString(),
    queuedAtEt: formatEtTimestamp(),
    lastError: error?.message || String(error || "unknown error"),
    payload,
  };
  fs.appendFileSync(discordOutboxFile, JSON.stringify(entry) + "\n", "utf8");
  console.error(`Discord notify queued for retry: ${entry.lastError}`);
}

function readDiscordOutbox() {
  if (!fs.existsSync(discordOutboxFile)) {
    return [];
  }

  return fs.readFileSync(discordOutboxFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeDiscordOutbox(entries) {
  if (!entries.length) {
    if (fs.existsSync(discordOutboxFile)) {
      fs.unlinkSync(discordOutboxFile);
    }
    return;
  }

  fs.writeFileSync(
    discordOutboxFile,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}

async function flushDiscordOutbox(webhookUrl, { maxMessages = 20 } = {}) {
  const entries = readDiscordOutbox();
  if (!entries.length) {
    return;
  }

  const remaining = [];
  let sent = 0;
  for (const entry of entries) {
    if (sent >= maxMessages) {
      remaining.push(entry);
      continue;
    }

    try {
      await sendDiscordWebhook(webhookUrl, entry.payload);
      sent += 1;
    } catch (error) {
      remaining.push({
        ...entry,
        lastError: error.message,
        lastAttemptAt: new Date().toISOString(),
        lastAttemptAtEt: formatEtTimestamp(),
      });
      remaining.push(...entries.slice(entries.indexOf(entry) + 1));
      writeDiscordOutbox(remaining);
      console.error(`Discord outbox flush stopped: ${error.message}`);
      return;
    }
  }

  writeDiscordOutbox(remaining);
  if (sent > 0) {
    console.log(`✓ Flushed ${sent} queued Discord notification(s)`);
  }
}

async function notifyDiscord(webhookUrl, payload) {
  await flushDiscordOutbox(webhookUrl).catch((error) => {
    console.error(`Discord outbox flush failed: ${error.message}`);
  });

  try {
    await sendDiscordWebhook(webhookUrl, payload);
    return true;
  } catch (error) {
    enqueueDiscordWebhook(payload, error);
    return false;
  }
}

function buildDiscordEmbed(receiptNumber, caseData, changes) {
  const data = caseData.data || {};
  const changedFields = Object.entries(changes || {});
  
  const fields = [
    { name: "Receipt Number", value: receiptNumber, inline: true },
    { name: "Applicant", value: data.applicantName || "N/A", inline: true },
    { name: "Updated At", value: data.updatedAt || "N/A", inline: true },
  ];
  
  for (const [key, detail] of changedFields) {
    if (key === "events" && detail.newEvents?.length) {
      for (const evt of detail.newEvents) {
        fields.push({
          name: `New Event`,
          value: `**${evt.actionCodeText || "Unknown"}**\n${evt.dispositionCodeText || ""}\n${evt.eventDate || ""}`,
        });
      }
      if (detail.changedEvents?.length) {
        fields.push({
          name: "Changed Events",
          value: detail.changedEvents
            .map((evt) => `${evt.eventCode || "event"} ${evt.eventId || ""}: ${evt.changedFields.join(", ")}`)
            .join("\n")
            .slice(0, 1024),
        });
      }
    } else if (key === "events" && detail.changedEvents?.length) {
      fields.push({
        name: "Changed Events",
        value: detail.changedEvents
          .map((evt) => `${evt.eventCode || "event"} ${evt.eventId || ""}: ${evt.changedFields.join(", ")}`)
          .join("\n")
          .slice(0, 1024),
      });
    } else if (key === "caseData") {
      fields.push({
        name: "Case Data Changed",
        value: [
          `Fields: ${(detail.changedFields || []).join(", ") || "unknown"}`,
          ...(detail.summary || []),
        ].join("\n").slice(0, 1024),
      });
    } else if (key === "apiResponses") {
      for (const [apiName, apiChange] of Object.entries(detail)) {
        const summaryLines = apiChange.summary?.length
          ? apiChange.summary
          : [`changed fields: ${(apiChange.changedFields || []).join(", ") || "unknown"}`];
        fields.push({
          name: `${apiName} API Changed`,
          value: summaryLines.join("\n").slice(0, 1024),
        });
      }
    } else {
      fields.push({
        name: key,
        value: `${detail.from ?? "—"} → ${detail.to ?? "—"}`,
        inline: true,
      });
    }
  }
  
  return {
    embeds: [{
      title: `🔄 Case Update: ${data.formName || receiptNumber}`,
      color: 0xff9900,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: "USCIS Case Monitor" },
    }],
  };
}

async function triggerNotification(receiptNumber, caseData, changes, config) {
  try {
    console.log(`\n🔔 [NOTIFICATION] Case ${receiptNumber} updated:`);
    console.log(`  Changes: ${JSON.stringify(changes)}`);

    const mode = notificationMode(config);
    const data = caseData.data || {};
    const formName = data.formName || receiptNumber;
    const changedFields = Object.keys(changes).join(", ");

    let notificationSent = false;

    // macOS notification
    if (mode === "macos" || mode === "both") {
      const title = `🔄 USCIS Case Update`;
      const subtitle = formName;
      const message = `Receipt: ${receiptNumber}\nChanged: ${changedFields}`;
      const sent = await sendMacOsNotification(title, message, subtitle);
      if (sent) {
        console.log("  ✓ macOS notification sent");
        notificationSent = true;
      }
    }

    // Discord notification
    if (mode === "discord" || mode === "both") {
      const webhookUrl = discordWebhookUrl(config);
      if (!webhookUrl) {
        console.log("  ⚠️ No Discord webhook URL configured (set discordWebhookUrl in config or USCIS_MONITOR_DISCORD_WEBHOOK_URL env var)");
      } else {
        const payload = buildDiscordEmbed(receiptNumber, caseData, changes);
        const sent = await notifyDiscord(webhookUrl, payload);
        console.log(sent ? "  ✓ Discord notification sent" : "  ⚠️ Discord notification queued for retry");
        if (sent) {
          notificationSent = true;
        }
      }
    }

    if (!notificationSent && !mode) {
      console.log("  ⚠️ No notification method configured. Add notificationMode: \"macos\" to config or set discordWebhookUrl");
    }
  } catch (error) {
    console.error(`  ✗ Notification failed: ${error.message}`);
  }
}

async function checkAllCases(config, options = {}) {
  const notifyNoChange = options.notifyNoChange ?? true;
  const notifyErrors = options.notifyErrors ?? true;
  const autoReauth = options.autoReauth ?? true;
  const startedAtDate = new Date();
  requireAuthState();
  
  const receiptNumbers = config.receiptNumbers || (config.receiptNumber ? [config.receiptNumber] : []);
  if (receiptNumbers.length === 0) {
    throw new Error("No receiptNumbers found in config. Please add receiptNumbers array to config.local.json");
  }
  
  let sessionExpired = false;
  let retryCount = 0;
  const maxRetries = autoReauth ? 1 : 0;
  
  while (retryCount <= maxRetries) {
    try {
      console.log(`\n📋 Checking ${receiptNumbers.length} case(s)...\n`);
      
      const history = loadCaseHistory();
      const results = [];
      
      for (const receiptNumber of receiptNumbers) {
        try {
          console.log(`⏳ Fetching ${receiptNumber}...`);
          const fetchedCaseData = await fetchCaseBundle(receiptNumber, config);
          const previousRecord = history[receiptNumber];
          const previousForDiff = stableCaseBundle(previousRecord);
          const caseData = mergeFetchedBundle(previousForDiff, fetchedCaseData);
          
          if (!caseData || !caseData.data) {
            console.log(`⚠️  Could not fetch ${receiptNumber} (invalid response), skipping...\n`);
            results.push({
              receiptNumber,
              isChanged: false,
              formName: null,
              updatedAt: null,
              error: "Invalid API response",
            });
            continue;
          }

          
          // Detect changes
          const { isChanged, changes } = detectChanges(previousForDiff, caseData);
          const apiErrors = fetchedCaseData.apiErrors || {};
          const apiErrorEntries = Object.entries(apiErrors);
          
          // Update history
          history[receiptNumber] = {
            lastFetchAt: new Date().toISOString(),
            lastHash: deepHash(caseData),
            current: caseData,
            previous: previousForDiff || previousRecord?.current || null,
            changes: isChanged ? changes : null,
            lastApiErrors: apiErrorEntries.length > 0 ? apiErrors : null,
          };
          
          // Print summary
          const data = caseData.data || {};
          console.log(`✓ ${data.formName || "N/A"}`);
          console.log(`  Receipt: ${receiptNumber}`);
          console.log(`  Name: ${data.applicantName || "N/A"}`);
          console.log(`  Updated: ${data.updatedAt || "N/A"}`);
          console.log(`  Events: ${(data.events || []).length}`);
          console.log(`  APIs: cases=${fetchedCaseData.apiResponses?.cases ? "ok" : (apiErrors.cases ? "failed" : "missing")}, case_status=${fetchedCaseData.apiResponses?.caseStatus ? "ok" : (apiErrors.caseStatus ? "failed" : "missing")}`);
          if (apiErrorEntries.length > 0) {
            console.log(`  API warnings: ${apiErrorEntries.map(([apiName, message]) => `${apiName}: ${message}`).join("; ")}`);
          }
          console.log(`  Status: ${isChanged ? "🔄 CHANGED" : "✓ No changes"}`);
          
          if (isChanged) {
            console.log(`  Changes: ${Object.keys(changes).join(", ")}`);

            // Trigger notification only if we have valid case data
            if (caseData && caseData.data) {
              await triggerNotification(receiptNumber, caseData, changes, config);
            } else {
              console.log(`  ⚠️  Skipping notification: invalid case data`);
            }
          }
          
          console.log();
          
          results.push({
            receiptNumber,
            isChanged,
            formName: data.formName || null,
            updatedAt: data.updatedAt || null,
            apiGroups: {
              cases: Boolean(fetchedCaseData.apiResponses?.cases),
              caseStatus: Boolean(fetchedCaseData.apiResponses?.caseStatus),
            },
            apiErrors: apiErrorEntries.length > 0 ? apiErrors : undefined,
          });
        } catch (error) {
          // Check if it's a session expired error
          if (error.code === "SESSION_EXPIRED") {
            console.error(`⚠️  Session expired while fetching ${receiptNumber}`);
            sessionExpired = true;
            throw error; // Bubble up to outer loop for retry
          }

          if (error.code === "NETWORK_ERROR") {
            console.error(`❌ Network error fetching ${receiptNumber}: ${error.message}\n`);
          } else {
            console.error(`❌ Error processing ${receiptNumber}: ${error.message}`);
            console.error(`   Stack: ${error.stack}\n`);
          }
          results.push({
            receiptNumber,
            isChanged: false,
            formName: null,
            updatedAt: null,
            error: String(error.message || error),
          });
        }
      }
      
      // Save updated history
      saveCaseHistory(history);
      console.log(`✓ History saved to ${caseHistoryFile}\n`);
      
      // Return summary
      const checkedAtDate = new Date();
      const summary = {
        startedAt: startedAtDate.toISOString(),
        startedAtEt: formatEtTimestamp(startedAtDate),
        checkedAt: checkedAtDate.toISOString(),
        checkedAtEt: formatEtTimestamp(checkedAtDate),
        totalCases: receiptNumbers.length,
        changedCases: results.filter(r => r.isChanged && !r.error).length,
        results,
      };
      
      console.log("📊 Summary:");
      console.log(JSON.stringify(summary, null, 2));
      
      // Send summary notifications
      const mode = notificationMode(config);
      const webhookUrl = discordWebhookUrl(config);
      const tsUtc = checkedAtDate.toISOString().replace("T", " ").slice(0, 19) + " UTC";
      const tsEt = formatEtTimestamp(checkedAtDate);
      const errorResults = summary.results.filter(r => r.error);
      const successResults = summary.results.filter(r => !r.error);
      const warningResults = summary.results.filter(r => r.apiErrors && Object.keys(r.apiErrors).length > 0);

      if (notifyErrors && errorResults.length === summary.totalCases) {
        // All cases failed — send error alert
        const firstError = errorResults[0]?.error || "Unknown error";
        const message = `All ${summary.totalCases} case checks failed — ${firstError}. Will retry next cycle.`;

        if (mode === "macos" || mode === "both") {
          await sendMacOsNotification("⚠️ USCIS Monitor Error", message, tsEt);
        }
        if ((mode === "discord" || mode === "both") && webhookUrl) {
          await notifyDiscord(webhookUrl, {
            content: `⚠️ \`${tsEt}\` (${tsUtc}) ${message}`,
          }).catch((e) => console.error(`Discord notify failed: ${e.message}`));
        }
      } else if (notifyErrors && errorResults.length > 0) {
        // Partial failure
        const failed = errorResults.map(r => r.receiptNumber).join(", ");
        const message = `Checked ${summary.totalCases} cases — ${successResults.length} OK, ${errorResults.length} failed (${failed}). Will retry next cycle.`;

        if (mode === "macos" || mode === "both") {
          await sendMacOsNotification("⚠️ USCIS Monitor Warning", message, tsEt);
        }
        if ((mode === "discord" || mode === "both") && webhookUrl) {
          await notifyDiscord(webhookUrl, {
            content: `⚠️ \`${tsEt}\` (${tsUtc}) ${message}`,
          }).catch((e) => console.error(`Discord notify failed: ${e.message}`));
        }
      } else if (notifyErrors && warningResults.length > 0 && summary.changedCases === 0) {
        const warningSummary = warningResults
          .map((result) => {
            const apiNames = Object.keys(result.apiErrors || {}).join(", ");
            return `${result.receiptNumber}: ${apiNames}`;
          })
          .join("; ");
        const message = `Checked ${summary.totalCases} cases — data stable, but auxiliary API warning(s): ${warningSummary}. Previous successful values were preserved.`;

        if (mode === "macos" || mode === "both") {
          await sendMacOsNotification("⚠️ USCIS Monitor Warning", message, tsEt);
        }
        if ((mode === "discord" || mode === "both") && webhookUrl) {
          await notifyDiscord(webhookUrl, {
            content: `⚠️ \`${tsEt}\` (${tsUtc}) ${message}`,
          }).catch((e) => console.error(`Discord notify failed: ${e.message}`));
        }
      } else if (summary.changedCases === 0 && notifyNoChange) {
        // All success, no changes
        const message = `Checked ${summary.totalCases} cases — no changes found.`;

        if (mode === "macos" || mode === "both") {
          await sendMacOsNotification("✓ USCIS Monitor", message, tsEt);
        }
        if ((mode === "discord" || mode === "both") && webhookUrl) {
          await notifyDiscord(webhookUrl, {
            content: `\`${tsEt}\` (${tsUtc}) ✓ ${message}`,
          }).catch((e) => console.error(`Discord notify failed: ${e.message}`));
        }
      } else if (summary.changedCases === 0) {
        console.log("No-change summary suppressed for this scheduled keepalive.");
      }
      // If changedCases > 0, individual notifications already sent via triggerNotification()
      
      return summary; // Success, exit loop
      
    } catch (error) {
      if (error.code === "SESSION_EXPIRED" && retryCount < maxRetries) {
        retryCount++;
        sessionExpired = true;
        // Immediately re-authenticate before next retry
        console.log("\n🔄 Session expired, re-authenticating...\n");
        await login(config);
        console.log("\n✓ Re-authentication successful, retrying case checks...\n");
        sessionExpired = false;
        // Loop will continue and try again
        continue;
      }
      
      // If we've exhausted retries or it's a different error, throw
      throw error;
    }
  }
}

// Legacy function for single case fetch (for backward compatibility)
async function fetchCaseJson(config) {
  requireAuthState();
  
  const receiptNumbers = config.receiptNumbers || (config.receiptNumber ? [config.receiptNumber] : []);
  if (receiptNumbers.length === 0) {
    throw new Error("receiptNumbers not found in config. Please add it to config.local.json");
  }
  
  const receiptNumber = receiptNumbers[0];
  const caseData = await fetchCaseBundle(receiptNumber, config);
  
  if (!caseData) {
    throw new Error(`Failed to fetch case ${receiptNumber}`);
  }
  
  // Save the JSON data
  const caseFile = path.join(stateDir, "case.json");
  fs.writeFileSync(caseFile, JSON.stringify(caseData, null, 2) + "\n", "utf8");
  console.log(`\n✓ Case data saved to ${caseFile}`);
  console.log(`\n📋 Case Summary:`);
  console.log(`   Receipt #: ${caseData.data?.receiptNumber}`);
  console.log(`   Status: ${caseData.data?.formName}`);
  console.log(`   Submitted: ${caseData.data?.submissionDate}`);
  console.log(`   Updated: ${caseData.data?.updatedAt}`);
  console.log(`   Events: ${caseData.data?.events?.length || 0}`);
  
  // Also print full JSON
  console.log(`\n📄 Full JSON:`);
  console.log(JSON.stringify(caseData, null, 2));
}

async function poll(config) {
  requireAuthState();
  const { browser, page } = await browserWithState(true);
  try {
    const { text, html } = await extractMonitoredText(page, config);
    const hash = sha256(text);
    const now = new Date().toISOString();
    const previous = fs.existsSync(lastFile) ? JSON.parse(fs.readFileSync(lastFile, "utf8")) : null;
    const changed = !previous || previous.hash !== hash;
    const snapshot = saveSnapshot("monitor", text, html);
    const state = {
      checkedAt: now,
      hash,
      changed,
      textPreview: text.slice(0, 400),
      snapshot,
    };
    if (previous && previous.hash) {
      state.previousHash = previous.hash;
    }
    fs.writeFileSync(lastFile, JSON.stringify(state, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(state, null, 2));
    if (changed) {
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
  }
}

// --- Scheduler ---

const SCHEDULE_START_HOUR_ET = 9;
const SCHEDULE_END_HOUR_ET = 21;
const DEFAULT_SCHEDULER_INTERVAL_HOURS = 3;

function getEtDate() {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(etStr);
}

function isWithinScheduleWindow() {
  // Run daily from 9:00am ET through the final 9:00pm ET slot.
  const et = getEtDate();
  const minutesSinceDayStart = et.getHours() * 60 + et.getMinutes();
  return (
    minutesSinceDayStart >= SCHEDULE_START_HOUR_ET * 60 &&
    minutesSinceDayStart <= SCHEDULE_END_HOUR_ET * 60
  );
}

function getSchedulerIntervalMs(config) {
  // Supports either config.scheduler.intervalHours or config.schedulerIntervalHours.
  const raw =
    config?.scheduler?.intervalHours ??
    config?.schedulerIntervalHours ??
    DEFAULT_SCHEDULER_INTERVAL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_SCHEDULER_INTERVAL_HOURS * 60 * 60 * 1000;
  }
  return Math.max(Math.round(hours * 60 * 60 * 1000), 60000);
}

function nextScheduledRun(intervalMs) {
  // Returns ms until the next valid clock-aligned slot in the ET daily window.
  const et = getEtDate();
  const hour = et.getHours();
  const minute = et.getMinutes();
  const second = et.getSeconds();
  const millisecond = et.getMilliseconds();
  const minutesSinceDayStart = hour * 60 + minute;
  const windowStartMinutes = SCHEDULE_START_HOUR_ET * 60;
  const windowEndMinutes = SCHEDULE_END_HOUR_ET * 60;
  const isWithinWindow =
    minutesSinceDayStart >= windowStartMinutes &&
    minutesSinceDayStart <= windowEndMinutes;

  if (isWithinWindow) {
    const intervalMinutes = Math.max(Math.round(intervalMs / 60000), 1);
    const minutesSinceWindowStart = minutesSinceDayStart - windowStartMinutes;
    const remainder = minutesSinceWindowStart % intervalMinutes;
    const minutesToNextSlot = remainder === 0 ? intervalMinutes : intervalMinutes - remainder;
    const nextSlotMinutesSinceWindowStart = minutesSinceWindowStart + minutesToNextSlot;
    const scheduleWindowMinutes = windowEndMinutes - windowStartMinutes;

    // Include the 9pm ET final slot, then roll to tomorrow 9am.
    if (nextSlotMinutesSinceWindowStart <= scheduleWindowMinutes) {
      const waitMs = minutesToNextSlot * 60000 - second * 1000 - millisecond;
      return Math.max(waitMs, 5000);
    }
  }

  const daysUntil = isWithinWindow || minutesSinceDayStart > windowEndMinutes ? 1 : 0;
  const next = new Date(et);
  next.setDate(next.getDate() + daysUntil);
  next.setHours(SCHEDULE_START_HOUR_ET, 0, 0, 0);
  return Math.max(next.getTime() - et.getTime(), 60000);
}

function scheduledSlotsLabel(config, intervalMs) {
  const intervalMinutes = Math.max(Math.round(intervalMs / 60000), 1);
  const slots = [];
  for (
    let minutes = SCHEDULE_START_HOUR_ET * 60;
    minutes <= SCHEDULE_END_HOUR_ET * 60;
    minutes += intervalMinutes
  ) {
    const hour = Math.floor(minutes / 60);
    const suffix = hour >= 12 ? "pm" : "am";
    const hour12 = ((hour + 11) % 12) + 1;
    slots.push(`${hour12}${suffix}`);
  }
  return slots.join(", ");
}

function schedulerAllowsAutoReauth(config) {
  return config?.scheduler?.autoReauth !== false;
}

async function scheduledCheck(config, options = {}) {
  const autoReauth = options.autoReauth ?? true;
  // Smart check: try API first, login only if needed
  const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  console.log(`\n⏰ Scheduled check at ${etStr} ET\n`);
  
  try {
    const pendingReauth = activeReauthRequired();
    if (pendingReauth && !autoReauth) {
      const message = "Scheduled check skipped: USCIS session is expired. Run manual reauth to resume monitoring.";
      console.error(`❌ ${message}`);
      await notifyReauthRequired(config, pendingReauth, message);
      return;
    }

    const hasAuth = fs.existsSync(authFile);
    if (!hasAuth) {
      if (autoReauth) {
        console.log("No auth state found, performing login...");
        await login(config);
      } else {
        const error = new Error("No auth state found. Manual reauth required.");
        error.code = "SESSION_EXPIRED";
        throw error;
      }
    }

    // Try fetching with existing token
    await checkAllCases(config, {
      notifyNoChange: true,
      autoReauth,
    });
  } catch (error) {
    if (error.code === "SESSION_EXPIRED" || error.message?.includes("SESSION_EXPIRED")) {
      const message = autoReauth
        ? `Scheduled check failed after re-authentication: ${error.message}`
        : "Scheduled check skipped: USCIS session expired. Run manual reauth before the next scheduled slot.";
      console.error(`❌ ${message}`);
      const state = markReauthRequired(error.message);
      await notifyReauthRequired(config, state, message);
    } else {
      throw error;
    }
  }
}

async function runScheduler(config) {
  acquireSchedulerLock();
  const intervalMs = getSchedulerIntervalMs(config);
  const intervalHours = Number((intervalMs / (60 * 60 * 1000)).toFixed(2));
  const intervalLabel = Number.isInteger(intervalHours)
    ? `${intervalHours} hour${intervalHours === 1 ? "" : "s"}`
    : `${intervalHours} hours`;

  console.log("🕐 USCIS Case Monitor Scheduler started");
  console.log(`   Schedule: Daily 9am–9pm ET, every ${intervalLabel}`);
  console.log(`   Slots: ${scheduledSlotsLabel(config, intervalMs)}`);
  console.log(`   Auto reauth: ${schedulerAllowsAutoReauth(config) ? "enabled" : "disabled"}`);
  console.log("   Press Ctrl+C to stop\n");
  
  const run = async () => {
    if (isWithinScheduleWindow()) {
      try {
        await scheduledCheck(config, {
          autoReauth: schedulerAllowsAutoReauth(config),
        });
      } catch (error) {
        console.error(`❌ Scheduled check error: ${error.message}`);
        const webhookUrl = discordWebhookUrl(config);
        if (webhookUrl) {
          await notifyDiscord(webhookUrl, {
            content: `❌ \`${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC\` Scheduled check crashed during login/navigation: ${error.message.split("\n")[0]}`,
          }).catch((notifyError) => {
            console.error(`Discord notify failed: ${notifyError.message}`);
          });
        }
      }
    } else {
      const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
      console.log(`⏸️  Outside schedule (${etStr} ET). Skipping.`);
    }
    
    const waitMs = nextScheduledRun(intervalMs);
    const waitMin = Math.round(waitMs / 60000);
    console.log(`⏳ Next check in ${waitMin} minutes\n`);
    setTimeout(run, waitMs);
  };
  
  // Run immediately on start
  await run();
}

async function main() {
  ensureDirs();
  const config = loadConfig();
  const command = process.argv[2] || "poll";
  if (command === "login" || command === "reauth") {
    await login(config);
    return;
  }
  if (command === "check-all-cases") {
    await checkAllCases(config);
    return;
  }
  if (command === "scheduled-check") {
    await scheduledCheck(config);
    return;
  }
  if (command === "scheduler") {
    await runScheduler(config);
    return;
  }
  if (command === "fetch-case-json") {
    await fetchCaseJson(config);
    return;
  }
  if (command === "otp-test") {
    const code = await readOtpFromConfiguredSource(config.otp);
    console.log(code);
    return;
  }
  if (command === "poll") {
    await poll(config);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

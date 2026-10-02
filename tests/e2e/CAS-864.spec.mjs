// CAS-864: Contact us — attach an image to a message. Mirrors CAS-838's fake-config/fake-supabase-js
// technique (see CAS740_FAKE_SUPABASE_GLOBAL in smoke.spec.mjs), extended here with a fake
// storage.from() alongside the existing fake from(), so the upload-then-insert flow can be exercised
// without touching a live project or a live bucket.
import { test, expect } from "@playwright/test";
import { gotoFresh } from "./helpers.mjs";

// A minimal valid 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const CAS864_FAKE_SUPABASE_GLOBAL = `
  window.__contactInserts = [];
  window.__contactUploads = [];
  window.__contactUploadShouldFail = false;
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithPassword: async () => ({ data: {}, error: null }),
        signUp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      storage: {
        from: (bucket) => ({
          upload: (path) => {
            if(window.__contactUploadShouldFail) return Promise.resolve({ data: null, error: { message: "upload failed" } });
            window.__contactUploads.push({ bucket, path });
            return Promise.resolve({ data: { path }, error: null });
          },
        }),
      },
      from: (table) => {
        if(table !== "contact_messages") return chain();
        return { insert: (rows) => {
          window.__contactInserts.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        } };
      },
    };
  } };
`;

async function configuredApp(page){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS864_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.enabled === true, null, { timeout: 5000 });
}

async function openFromSplash(page){
  await page.locator("#splashAbout").click();
  await expect(page.locator("#aboutPage")).toHaveClass(/open/);
  await page.locator("#aboutPageContact").click();
  await expect(page.locator("#contact")).toHaveClass(/open/);
}

async function fillMessage(page){
  await page.locator("#contactCatChips .chip", { hasText: "Bug" }).click();
  await page.locator("#contactEmail").fill("cas864@example.com");
  await page.locator("#contactMsg").fill("Here's a screenshot.");
}

// AC5a
test("CAS-864 a: choosing a 1x1 PNG shows filename + preview; sending performs exactly one upload then one insert whose attachment_path equals the uploaded path", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await fillMessage(page);
  await page.locator("#contactAttachInput").setInputFiles({
    name: "shot.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  });
  await expect(page.locator("#contactAttachName")).toHaveText("shot.png");
  await expect(page.locator("#contactAttachPreview")).toBeVisible();

  await page.locator("#contactSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const uploads = await page.evaluate(() => window.__contactUploads);
  const rows = await page.evaluate(() => window.__contactInserts);
  expect(uploads.length).toBe(1);
  expect(rows.length).toBe(1);
  expect(rows[0].attachment_path).toBe(uploads[0].path);
});

// AC5b
test("CAS-864 b: sending with no image performs no upload and inserts a row with a null attachment_path", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await fillMessage(page);
  // CAS-1149: WebKit swallows the very next real tap after a .fill() leaves a text field focused — the
  // tap lands on #contactSend (confirmed via elementFromPoint) but never fires its onclick, while a
  // programmatic .click() on the same element does. Blurring first, the same fix CAS-927's spec already
  // uses around this exact button, avoids it; test (a) above never hit this because setInputFiles()
  // already moves focus off #contactMsg before its own Send click.
  await page.locator("#contactMsg").blur();
  await page.locator("#contactSend").click();
  await page.waitForFunction(() => window.__contactInserts.length > 0, null, { timeout: 5000 });

  const uploads = await page.evaluate(() => window.__contactUploads);
  const rows = await page.evaluate(() => window.__contactInserts);
  expect(uploads.length).toBe(0);
  expect(rows[0].attachment_path).toBeNull();
});

// AC5c
test("CAS-864 c: a 6 MB file is rejected before any upload happens, with a visible reason naming the size rule", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await fillMessage(page);
  await page.locator("#contactAttachInput").setInputFiles({
    name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(6 * 1024 * 1024),
  });

  await expect(page.locator("#contactAttachErr")).toBeVisible();
  await expect(page.locator("#contactAttachErr")).toContainText("5 MB");
  await expect(page.locator("#contactAttachPreview")).toBeHidden();
  const uploads = await page.evaluate(() => window.__contactUploads);
  expect(uploads.length).toBe(0);
});

// AC5d
test("CAS-864 d: a non-image file is rejected before any upload happens, with a visible reason naming the type rule", async ({ page }) => {
  await configuredApp(page);
  await openFromSplash(page);
  await fillMessage(page);
  await page.locator("#contactAttachInput").setInputFiles({
    name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image"),
  });

  await expect(page.locator("#contactAttachErr")).toBeVisible();
  await expect(page.locator("#contactAttachErr")).toContainText("image");
  await expect(page.locator("#contactAttachPreview")).toBeHidden();
  const uploads = await page.evaluate(() => window.__contactUploads);
  expect(uploads.length).toBe(0);
});

// AC5e
test("CAS-864 e: when the upload rejects, no insert is performed at all, and the typed message stays in the textarea", async ({ page }) => {
  await configuredApp(page);
  await page.evaluate(() => { window.__contactUploadShouldFail = true; });
  await openFromSplash(page);
  await fillMessage(page);
  await page.locator("#contactAttachInput").setInputFiles({
    name: "shot.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  });

  await page.locator("#contactSend").click();
  await expect(page.locator("#contactErr")).toBeVisible();
  await expect(page.locator("#contactMsg")).toHaveValue("Here's a screenshot.");
  const rows = await page.evaluate(() => window.__contactInserts);
  expect(rows.length).toBe(0);
});

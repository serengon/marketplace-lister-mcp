import type { Page } from "playwright";
import { getContext } from "./browser.js";

/**
 * Marketplace conversations: list them, read one, send one reply.
 *
 * Every conversation has a unique Messenger thread id (the number in
 * facebook.com/messages/t/<id>). list_inbox returns it, and read/send open the
 * thread by that id directly. Matching by name used to pick the wrong chat
 * when two buyers shared a name ("Lautaro" twice) or one name contained
 * another ("Mar" inside "Marcelo").
 *
 * Everything runs in its OWN tab of the dedicated browser and closes it after,
 * so a create_listing draft sitting in the main tab is never navigated away.
 */

const MESSAGES_URL = "https://www.facebook.com/messages/t/";
const ID_RE = /^\d{5,25}$/;

async function withTab<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export interface InboxRow {
  id: string;
  buyer: string;
  listing: string;
  preview: string;
  when: string;
}

const WHEN_RE =
  /^(\d{1,2}:\d{2}\s*(am|pm)?|Lun|Mar|Mié|Jue|Vie|Sáb|Dom|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d+\s*(min|h|d|días?|sem|w)|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/i;

/** Open Messenger's "Marketplace" folder, which lists every buyer thread. */
async function openMarketplaceFolder(page: Page): Promise<void> {
  await page.goto(MESSAGES_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  const folder = page.locator("[role=row]").filter({ hasText: /^\s*Marketplace\s/ }).first();
  if ((await folder.count()) === 0) throw new Error(`Marketplace folder not found in Messenger at ${page.url()}`);
  await folder.click({ timeout: 10000 });
  await page.waitForTimeout(4000);
}

function parseRow(href: string, raw: string): InboxRow | null {
  const id = href.match(/\/messages\/t\/(\d+)/)?.[1];
  if (!id) return null;
  const lines = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "·");
  if (lines.length === 0) return null;
  const sep = lines[0].indexOf(" · ");
  if (sep < 1) return null; // not a "Buyer · Listing" Marketplace thread
  const rest = lines.slice(1);
  let when = "";
  if (rest.length && WHEN_RE.test(rest[rest.length - 1])) when = rest.pop()!;
  return {
    id,
    buyer: lines[0].slice(0, sep).trim(),
    listing: lines[0].slice(sep + 3).trim(),
    preview: rest.join(" ").replace(/\s*·\s*$/, "").slice(0, 200),
    when,
  };
}

async function readRows(page: Page): Promise<InboxRow[]> {
  const raws: [string, string][] = await page.evaluate(() =>
    [...document.querySelectorAll("a[href*='/messages/t/']")].map(
      (a) => [a.getAttribute("href") || "", (a as HTMLElement).innerText || ""] as [string, string]
    )
  );
  const seen = new Set<string>();
  const rows: InboxRow[] = [];
  for (const [href, raw] of raws) {
    const row = parseRow(href, raw);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

/** Scroll the chat list so older threads load, collecting rows as they render. */
async function collect(page: Page, scrolls: number): Promise<InboxRow[]> {
  const byId = new Map<string, InboxRow>();
  for (let i = 0; i <= scrolls; i++) {
    for (const r of await readRows(page)) if (!byId.has(r.id)) byId.set(r.id, r);
    if (i === scrolls) break;
    await page.mouse.move(180, 700);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(1200);
  }
  return [...byId.values()];
}

export async function listInbox(scrolls = 3): Promise<InboxRow[]> {
  return withTab(async (page) => {
    await openMarketplaceFolder(page);
    return collect(page, scrolls);
  });
}

/** "Escribe en <buyer> · <listing>" / "Write to <buyer> · <listing>" */
const COMPOSER_LABEL = /^(?:Escribe en|Write to|Message)\s+(.+?)\s+·\s+(.+)$/;

function composer(page: Page) {
  return page.locator("[contenteditable=true][role=textbox]").filter({ visible: true }).first();
}

/** Open the thread by id and name it from its composer label. */
async function openThread(page: Page, id: string): Promise<{ row: InboxRow; canWrite: boolean }> {
  if (!ID_RE.test(id)) throw new Error(`"${id}" is not a thread id. Use the id from list_inbox.`);
  await page.goto(`${MESSAGES_URL}${id}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  if (!page.url().includes(`/messages/t/${id}`)) {
    throw new Error(`Thread ${id} did not open (landed on ${page.url()}). It may have been deleted.`);
  }
  const box = composer(page);
  const canWrite = (await box.count()) > 0;
  let buyer = "";
  let listing = "";
  if (canWrite) {
    const m = ((await box.getAttribute("aria-label")) || "").match(COMPOSER_LABEL);
    if (m) [, buyer, listing] = m;
  }
  if (!buyer) {
    // Left or read-only threads have no composer: fall back to the page header.
    const head = await page.evaluate(() => {
      const h = [...document.querySelectorAll("[role=main] h2, [role=main] h1, [role=main] [role=heading]")]
        .map((e) => (e as HTMLElement).innerText || "")
        .find((t) => t.includes(" · "));
      return h || "";
    });
    const sep = head.indexOf(" · ");
    if (sep > 0) {
      buyer = head.slice(0, sep).trim();
      listing = head.slice(sep + 3).trim();
    }
  }
  return { row: { id, buyer, listing, preview: "", when: "" }, canWrite };
}

export interface ThreadMessage {
  time: string;
  from: string; // the buyer's name, or "Tú"/"You" for the seller
  text: string;
}

const SAFETY_NOTICE = /^(Si te vas a reunir con alguien en persona|If you're meeting someone)/;
const STARTED = /inició este chat\.?$|started this chat\.?$/;

/**
 * Messages of the open thread, oldest first. Each bubble carries an aria-label
 * "Presionar Enter, Mensaje enviado <time> por <who>: <text>", which is far
 * more stable than the rendered layout. The page shows one thread, so the
 * whole main area is the scope.
 */
async function readMessages(page: Page): Promise<ThreadMessage[]> {
  const labels: string[] = await page.evaluate(() =>
    [...(document.querySelector("[role=main]") || document.body).querySelectorAll("[aria-label]")]
      .map((e) => e.getAttribute("aria-label") || "")
      .filter((a) => /^(Presionar Enter, )?(Mensaje enviado|Message sent)|^(Press Enter, )?Message sent/.test(a))
  );

  const out: ThreadMessage[] = [];
  const re = /(?:Mensaje enviado|Message sent)\s*:?\s*(.+?)\s+(?:por|by)\s*:?\s*([^:]+?):\s*([\s\S]*)$/;
  for (const a of labels) {
    const m = a.match(re);
    if (!m) continue;
    const [, time, from, body] = m;
    const text = body.trim();
    if (!text || SAFETY_NOTICE.test(text) || STARTED.test(text)) continue;
    const last = out[out.length - 1];
    if (last && last.text === text && last.from === from.trim()) continue;
    out.push({ time: time.trim(), from: from.trim(), text });
  }
  return out;
}

export async function readThread(
  id: string
): Promise<{ thread: InboxRow; messages: ThreadMessage[]; canWrite: boolean; screenshot: Buffer }> {
  return withTab(async (page) => {
    const { row, canWrite } = await openThread(page, id);
    const messages = await readMessages(page);
    const screenshot = await page.screenshot();
    return { thread: row, messages, canWrite, screenshot };
  });
}

const ME = /^(Tú|You)$/i;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export type SendResult =
  | { status: "sent"; thread: InboxRow; messages: ThreadMessage[]; screenshot: Buffer }
  | { status: "unconfirmed" | "skipped_duplicate" | "dry_run"; thread: InboxRow; detail: string; messages: ThreadMessage[]; screenshot: Buffer };

/**
 * Send exactly one message to one thread. Never retries: if delivery cannot be
 * confirmed, it says so and the caller must look before trying again, because
 * a blind retry is how a buyer ends up with the same message twice.
 *
 * `expectBuyer`, when given, must equal the thread's buyer name: a cheap guard
 * against a mistyped id sending to the wrong person.
 */
export async function sendMessage(id: string, text: string, expectBuyer?: string, dryRun = false): Promise<SendResult> {
  return withTab(async (page) => {
    const { row, canWrite } = await openThread(page, id);
    if (!canWrite) throw new Error(`Thread ${id} (${row.buyer} · ${row.listing}) has no message box: you may have left it. Nothing was sent.`);
    if (expectBuyer && norm(expectBuyer).toLowerCase() !== norm(row.buyer).toLowerCase()) {
      throw new Error(`Thread ${id} belongs to "${row.buyer}", not "${expectBuyer}". Nothing was sent.`);
    }
    const before = await readMessages(page);
    const want = norm(text);

    if (before.some((m) => ME.test(m.from) && norm(m.text) === want)) {
      return {
        status: "skipped_duplicate",
        thread: row,
        detail: "That exact message was already sent in this thread. Nothing was sent.",
        messages: before,
        screenshot: await page.screenshot(),
      };
    }

    const box = composer(page);
    await box.click({ timeout: 10000 });
    // The composer can hold a leftover draft; clear it so only `text` goes out.
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    // Shift+Enter for line breaks: a bare Enter would send each line separately.
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press("Shift+Enter");
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 15 });
    }
    await page.waitForTimeout(500);
    if (dryRun) {
      const typed = norm((await box.innerText().catch(() => "")) || "");
      const shot = await page.screenshot();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      return { status: "dry_run", thread: row, detail: `composer held: ${typed}`, messages: before, screenshot: shot };
    }
    await page.keyboard.press("Enter");

    let after: ThreadMessage[] = before;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      after = await readMessages(page);
      const mine = after.filter((m) => ME.test(m.from));
      if (mine.length && norm(mine[mine.length - 1].text) === want) {
        return { status: "sent", thread: row, messages: after, screenshot: await page.screenshot() };
      }
    }
    const leftover = norm((await box.innerText().catch(() => "")) || "");
    return {
      status: "unconfirmed",
      thread: row,
      detail: leftover
        ? "The text is still in the composer, so it was most likely NOT sent. Check the screenshot; do not retry blindly."
        : "The composer is empty but the message did not show up in the thread yet. It may have been sent; read the thread before trying again.",
      messages: after,
      screenshot: await page.screenshot(),
    };
  });
}

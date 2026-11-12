import type { Page } from "playwright";
import { getContext } from "./browser.js";

/**
 * Marketplace inbox: list buyer threads, read one, send one reply.
 *
 * Everything runs in its OWN tab of the dedicated browser and closes it after,
 * so a create_listing draft sitting in the main tab is never navigated away.
 *
 * A thread is identified by buyer name AND a piece of the listing title, and
 * the pair must match exactly one thread: matching on a first name alone once
 * opened the wrong conversation (two buyers called Ariel).
 */

const INBOX_URL = "https://www.facebook.com/marketplace/inbox";
const ROWS = "[role=main] [role=button], [role=main] a, [role=main] [role=row]";

export type InboxTab = "selling" | "buying";
const TAB_NAMES: Record<InboxTab, string[]> = {
  selling: ["Venta", "Selling"],
  buying: ["Compra", "Buying"],
};

async function withTab<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function openInbox(page: Page, tab: InboxTab): Promise<void> {
  await page.goto(INBOX_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  for (const name of TAB_NAMES[tab]) {
    const t = page.getByRole("tab", { name, exact: true }).first();
    if ((await t.count()) > 0) {
      await t.click({ timeout: 10000 });
      await page.waitForTimeout(2500);
      return;
    }
  }
  throw new Error(`Inbox tab not found (${TAB_NAMES[tab].join(" / ")}) at ${page.url()}`);
}

export interface InboxRow {
  buyer: string;
  listing: string;
  preview: string;
  when: string;
}

const WHEN_RE =
  /^(\d{1,2}:\d{2}\s*(am|pm)?|Lun|Mar|Mié|Jue|Vie|Sáb|Dom|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d+\s*(min|h|d|sem|w)|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/i;

function parseRow(raw: string): InboxRow | null {
  const parts = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const i = parts.findIndex((p) => p.startsWith("·"));
  if (i < 1) return null;
  const rest = parts.slice(i + 1);
  const when = rest.length > 1 && WHEN_RE.test(rest[rest.length - 1]) ? rest.pop()! : "";
  return {
    buyer: parts[0],
    listing: parts[i].replace(/^·\s*/, ""),
    preview: rest.join(" ").slice(0, 200),
    when,
  };
}

/** Scroll the thread list so older rows load. */
async function loadMore(page: Page, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.move(400, 700);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(1000);
  }
}

async function readRows(page: Page): Promise<InboxRow[]> {
  const raws: string[] = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].map((e) => (e as HTMLElement).innerText || ""),
    ROWS
  );
  const seen = new Set<string>();
  const rows: InboxRow[] = [];
  for (const r of raws) {
    const row = parseRow(r);
    if (!row) continue;
    const key = `${row.buyer}\u0000${row.listing}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

export async function listInbox(tab: InboxTab = "selling", scrolls = 3): Promise<InboxRow[]> {
  return withTab(async (page) => {
    await openInbox(page, tab);
    await loadMore(page, scrolls);
    return readRows(page);
  });
}

/**
 * Find the one thread whose buyer equals `buyer` (case-insensitive) and whose
 * listing title contains `listing`, scrolling for older rows if needed. Throws
 * with the candidates when there are none or several.
 */
async function findThread(page: Page, buyer: string, listing: string): Promise<InboxRow> {
  const b = buyer.trim().toLowerCase();
  const l = listing.trim().toLowerCase();
  let rows: InboxRow[] = [];
  for (let i = 0; i < 8; i++) {
    rows = await readRows(page);
    const hits = rows.filter((r) => r.buyer.toLowerCase() === b && r.listing.toLowerCase().includes(l));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new Error(
        `"${buyer}" + "${listing}" matches several threads: ${hits.map((h) => `${h.buyer} · ${h.listing}`).join("; ")}. Pass more of the listing title.`
      );
    }
    await loadMore(page, 1);
  }
  const sameBuyer = rows.filter((r) => r.buyer.toLowerCase().includes(b));
  throw new Error(
    `No thread with buyer "${buyer}" on a listing containing "${listing}". ` +
      (sameBuyer.length
        ? `Threads with that name: ${sameBuyer.map((r) => `${r.buyer} · ${r.listing}`).join("; ")}`
        : `Threads seen: ${rows.map((r) => `${r.buyer} · ${r.listing}`).join("; ")}`)
  );
}

/** The composer of the chat "<buyer> · <listing>": its aria-label names both. */
function composerFor(page: Page, row: InboxRow) {
  return page
    .locator("[contenteditable=true][role=textbox]")
    .filter({ visible: true })
    .and(page.locator(`[aria-label*=${JSON.stringify(row.buyer)}]`))
    .and(page.locator(`[aria-label*=${JSON.stringify(row.listing.slice(0, 40))}]`))
    .first();
}

async function openThread(page: Page, buyer: string, listing: string, tab: InboxTab): Promise<InboxRow> {
  await openInbox(page, tab);
  const row = await findThread(page, buyer, listing);
  await page
    .locator(ROWS)
    .filter({ hasText: row.buyer })
    .filter({ hasText: row.listing })
    .first()
    .click({ timeout: 10000 });
  await page.waitForTimeout(4000);
  if ((await composerFor(page, row).count()) === 0) {
    throw new Error(`Clicked the row but the chat "${row.buyer} · ${row.listing}" did not open.`);
  }
  return row;
}

export interface ThreadMessage {
  time: string;
  from: string; // the buyer's name, or "Tú"/"You" for the seller
  text: string;
}

const SAFETY_NOTICE = /^(Si te vas a reunir con alguien en persona|If you're meeting someone)/;
const STARTED = /inició este chat\.?$|started this chat\.?$/;

/**
 * Messages of the open chat for `row`, oldest first. Each bubble carries an
 * aria-label "Presionar Enter, Mensaje enviado <time> por <who>: <text>",
 * which is far more stable than the rendered layout.
 */
async function readMessages(page: Page, row: InboxRow): Promise<ThreadMessage[]> {
  const labels: string[] = await page.evaluate(
    ({ buyer, listing }) => {
      // Scope to the chat whose composer names this thread, when it can be found.
      const box = [...document.querySelectorAll("[contenteditable=true][role=textbox]")].find((b) => {
        const al = b.getAttribute("aria-label") || "";
        return al.includes(buyer) && al.includes(listing);
      });
      let scope: Element = document.body;
      if (box) {
        let el: Element | null = box;
        while (el && !el.querySelector('[aria-label*="Mensaje enviado"], [aria-label*="Message sent"]')) el = el.parentElement;
        if (el) scope = el;
      }
      return [...scope.querySelectorAll("[aria-label]")]
        .map((e) => e.getAttribute("aria-label") || "")
        .filter((a) => /Mensaje enviado|Message sent/.test(a));
    },
    { buyer: row.buyer, listing: row.listing.slice(0, 40) }
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
  buyer: string,
  listing: string,
  tab: InboxTab = "selling"
): Promise<{ thread: InboxRow; messages: ThreadMessage[]; screenshot: Buffer }> {
  return withTab(async (page) => {
    const row = await openThread(page, buyer, listing, tab);
    const messages = await readMessages(page, row);
    const screenshot = await page.screenshot();
    return { thread: row, messages, screenshot };
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
 */
export async function sendMessage(
  buyer: string,
  listing: string,
  text: string,
  tab: InboxTab = "selling",
  dryRun = false
): Promise<SendResult> {
  return withTab(async (page) => {
    const row = await openThread(page, buyer, listing, tab);
    const before = await readMessages(page, row);
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

    const box = composerFor(page, row);
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
      after = await readMessages(page, row);
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

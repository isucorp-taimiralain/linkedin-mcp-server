import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAccessToken, getConfigDir, getGoogleApiKey } from "./auth.js";
import { LinkedInClient } from "./linkedin.js";

type PostVisibility = "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
type PostLanguage = "en" | "es";

interface AutoPostConfig {
  niche: string;
  keywords: string[];
  audience?: string;
  visibility?: PostVisibility;
  hashtags?: string[];
  postLanguage?: PostLanguage;
  maxArticleAgeHours?: number;
  itemsPerKeyword?: number;
  market?: string;
}

interface ValidAutoPostConfig {
  niche: string;
  keywords: string[];
  audience?: string;
  visibility: PostVisibility;
  hashtags?: string[];
  postLanguage: PostLanguage;
  maxArticleAgeHours: number;
  itemsPerKeyword: number;
  market: string;
}

interface NewsCandidate {
  keyword: string;
  title: string;
  description: string;
  source: string;
  link: string;
  publishedAt: Date;
  score: number;
}

interface AutoPostHistoryEntry {
  keyword: string;
  title: string;
  link: string;
  postedAt: string;
}

interface AutoPostHistory {
  entries: AutoPostHistoryEntry[];
}

export interface PreparedAutoPost {
  candidate: NewsCandidate;
  commentary: string;
  imageSearchQuery: string;
  config: ValidAutoPostConfig;
  googleApiKey: string | null;
  dynamicHashtags?: string[];
}

export interface AutoPostRunResult {
  postId: string;
  articleTitle: string;
  articleLink: string;
  source: string;
  keyword: string;
}

const DEFAULT_MAX_ARTICLE_AGE_HOURS = 96;
const DEFAULT_ITEMS_PER_KEYWORD = 8;
const MAX_ITEMS_PER_KEYWORD = 20;
const MAX_KEYWORDS = 8;
const MAX_HISTORY_ENTRIES = 200;
const DEFAULT_MARKET = "en-US";
const DEFAULT_POST_LANGUAGE: PostLanguage = "es";
const AUTOMATION_CONFIG_FILE = "automation.json";
const AUTOMATION_HISTORY_FILE = "automation-history.json";

function getAutomationHistoryPath(): string {
  return join(getConfigDir(), AUTOMATION_HISTORY_FILE);
}

export function getAutomationConfigPath(): string {
  return join(getConfigDir(), AUTOMATION_CONFIG_FILE);
}

async function ensureAutomationDirectory(): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
}

function createAutomationConfigTemplate(): AutoPostConfig {
  return {
    niche: "Your Niche",
    keywords: ["Keyword One", "Keyword Two", "Keyword Three"],
    audience: "Your Target Audience",
    postLanguage: "es",
    visibility: "PUBLIC",
    hashtags: ["LinkedIn", "Trends", "Growth"],
    maxArticleAgeHours: 96,
    itemsPerKeyword: 8,
    market: "en-US",
  };
}

function normalizeHashtag(tag: string): string {
  const cleaned = tag.replace(/^#+/, "").replace(/[^a-zA-Z0-9]/g, "").trim();
  if (!cleaned) {
    return "";
  }
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " ",
  };

  let decoded = value;
  for (const [entity, replacement] of Object.entries(namedEntities)) {
    decoded = decoded.replace(new RegExp(entity, "g"), replacement);
  }

  decoded = decoded.replace(/&#(\d+);/g, (_match: string, valueAsText: string) =>
    String.fromCharCode(Number(valueAsText))
  );
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_match: string, valueAsText: string) =>
    String.fromCharCode(parseInt(valueAsText, 16))
  );

  return decoded;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function sanitizeRssText(value: string): string {
  const withoutCdata = value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return cleanText(decodeHtmlEntities(stripHtml(withoutCdata)));
}

function getFirstTagValue(block: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i");
  const match = block.match(pattern);
  return match ? match[1] : null;
}

function getItemBlocks(rssXml: string): string[] {
  return rssXml.match(/<item>([\s\S]*?)<\/item>/gi) ?? [];
}

function unwrapBingArticleUrl(rawUrl: string): string {
  try {
    const parsedUrl = new URL(rawUrl);
    const embeddedUrl = parsedUrl.searchParams.get("url");
    if (embeddedUrl && /^https?:\/\//i.test(embeddedUrl)) {
      return embeddedUrl;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

function normalizeArticleUrl(rawUrl: string): string {
  const trackingParams = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "oc",
    "ref",
    "fbclid",
    "gclid",
  ];

  try {
    const parsedUrl = new URL(rawUrl);
    parsedUrl.hash = "";
    for (const paramName of trackingParams) {
      parsedUrl.searchParams.delete(paramName);
    }
    return parsedUrl.toString();
  } catch {
    return rawUrl;
  }
}

function toLowerTermSet(config: ValidAutoPostConfig): Set<string> {
  const terms = new Set<string>();
  for (const keyword of config.keywords) {
    const normalized = keyword.trim().toLowerCase();
    if (normalized.length >= 3) {
      terms.add(normalized);
    }
  }

  for (const token of config.niche.toLowerCase().split(/[^a-zA-Z0-9]+/)) {
    const normalized = token.trim();
    if (normalized.length >= 3) {
      terms.add(normalized);
    }
  }

  return terms;
}

function computeCandidateScore(
  title: string,
  description: string,
  publishedAt: Date,
  terms: Set<string>,
  maxAgeHours: number
): number {
  const loweredTitle = title.toLowerCase();
  const loweredDescription = description.toLowerCase();
  let relevance = 0;

  for (const term of terms) {
    if (loweredTitle.includes(term)) {
      relevance += 8;
      continue;
    }
    if (loweredDescription.includes(term)) {
      relevance += 3;
    }
  }

  const ageHours = Math.max(0, (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60));
  const freshness = Math.max(0, maxAgeHours - ageHours);

  return relevance + freshness;
}

function parseVisibility(value: string | undefined): PostVisibility {
  if (value === "PUBLIC" || value === "CONNECTIONS" || value === "LOGGED_IN") {
    return value;
  }
  return "PUBLIC";
}

function parseLanguage(value: string | undefined): PostLanguage {
  return value === "en" ? "en" : "es";
}

function validateAndNormalizeConfig(config: AutoPostConfig): ValidAutoPostConfig {
  const niche = cleanText(config.niche ?? "");
  if (!niche) {
    throw new Error("automation.json requires a non-empty 'niche' field.");
  }

  const keywords = (config.keywords || [])
    .map((keyword) => cleanText(keyword))
    .filter((keyword) => keyword.length > 0)
    .slice(0, MAX_KEYWORDS);

  if (keywords.length === 0) {
    throw new Error("automation.json requires at least one keyword in 'keywords'.");
  }

  const audience = config.audience ? cleanText(config.audience) : undefined;
  const visibility = parseVisibility(config.visibility);
  const postLanguage = parseLanguage(config.postLanguage || DEFAULT_POST_LANGUAGE);
  const maxArticleAgeHours =
    typeof config.maxArticleAgeHours === "number" && config.maxArticleAgeHours > 0
      ? Math.floor(config.maxArticleAgeHours)
      : DEFAULT_MAX_ARTICLE_AGE_HOURS;
  const itemsPerKeywordRaw =
    typeof config.itemsPerKeyword === "number" && config.itemsPerKeyword > 0
      ? Math.floor(config.itemsPerKeyword)
      : DEFAULT_ITEMS_PER_KEYWORD;
  const itemsPerKeyword = Math.min(itemsPerKeywordRaw, MAX_ITEMS_PER_KEYWORD);
  const market = cleanText(config.market || DEFAULT_MARKET);
  const hashtags = (config.hashtags || [])
    .map((tag) => normalizeHashtag(tag))
    .filter((tag) => tag.length > 0)
    .slice(0, 5);

  return {
    niche,
    keywords,
    audience,
    visibility,
    hashtags: hashtags.length > 0 ? hashtags : undefined,
    postLanguage,
    maxArticleAgeHours,
    itemsPerKeyword,
    market,
  };
}

async function loadAutoPostConfig(): Promise<ValidAutoPostConfig> {
  await ensureAutomationDirectory();
  const configPath = getAutomationConfigPath();

  if (!existsSync(configPath)) {
    const template = createAutomationConfigTemplate();
    await writeFile(configPath, JSON.stringify(template, null, 2), "utf-8");
    throw new Error(
      `Automation config not found. A template was created at ${configPath}. Update it with your niche and keywords.`
    );
  }

  const rawConfig = await readFile(configPath, "utf-8");
  const parsedConfig = JSON.parse(rawConfig) as AutoPostConfig;
  return validateAndNormalizeConfig(parsedConfig);
}

async function loadAutoPostHistory(): Promise<AutoPostHistory> {
  await ensureAutomationDirectory();
  const historyPath = getAutomationHistoryPath();
  if (!existsSync(historyPath)) {
    return { entries: [] };
  }

  const rawHistory = await readFile(historyPath, "utf-8");
  const parsed = JSON.parse(rawHistory) as AutoPostHistory;
  if (!parsed.entries || !Array.isArray(parsed.entries)) {
    return { entries: [] };
  }

  return {
    entries: parsed.entries
      .filter((entry) => Boolean(entry.link && entry.title))
      .map((entry) => ({
        keyword: cleanText(entry.keyword || ""),
        title: cleanText(entry.title || ""),
        link: normalizeArticleUrl(cleanText(entry.link || "")),
        postedAt: entry.postedAt || new Date(0).toISOString(),
      })),
  };
}

async function saveAutoPostHistory(history: AutoPostHistory): Promise<void> {
  await ensureAutomationDirectory();
  const historyPath = getAutomationHistoryPath();
  await writeFile(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

function hasBeenPosted(history: AutoPostHistory, link: string, title: string): boolean {
  const normalizedLink = normalizeArticleUrl(link);
  const normalizedTitle = cleanText(title).toLowerCase();

  return history.entries.some((entry) => {
    const sameLink = normalizeArticleUrl(entry.link) === normalizedLink;
    const sameTitle = cleanText(entry.title).toLowerCase() === normalizedTitle;
    return sameLink || sameTitle;
  });
}

async function fetchRssForKeyword(keyword: string, market: string): Promise<string> {
  const feedUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(keyword)}&format=rss&mkt=${encodeURIComponent(market)}`;
  const response = await fetch(feedUrl, {
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      "User-Agent": "linkedin-mcp-server/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch RSS for "${keyword}" (status ${response.status}).`);
  }

  return response.text();
}

function parseBingNewsRss(keyword: string, rssXml: string, config: ValidAutoPostConfig): NewsCandidate[] {
  const termSet = toLowerTermSet(config);
  const items = getItemBlocks(rssXml).slice(0, config.itemsPerKeyword);
  const candidates: NewsCandidate[] = [];

  for (const item of items) {
    const titleRaw = getFirstTagValue(item, "title");
    const descriptionRaw = getFirstTagValue(item, "description");
    const linkRaw = getFirstTagValue(item, "link");
    const sourceRaw = getFirstTagValue(item, "News:Source");
    const pubDateRaw = getFirstTagValue(item, "pubDate");

    const title = sanitizeRssText(titleRaw || "");
    const description = sanitizeRssText(descriptionRaw || "");
    const source = sanitizeRssText(sourceRaw || "");
    const link = normalizeArticleUrl(unwrapBingArticleUrl(sanitizeRssText(linkRaw || "")));
    const publishedAtText = sanitizeRssText(pubDateRaw || "");

    if (!title || !link || !publishedAtText) {
      continue;
    }

    const publishedAt = new Date(publishedAtText);
    if (Number.isNaN(publishedAt.getTime())) {
      continue;
    }

    const score = computeCandidateScore(
      title,
      description,
      publishedAt,
      termSet,
      config.maxArticleAgeHours
    );

    candidates.push({
      keyword,
      title,
      description,
      source,
      link,
      publishedAt,
      score,
    });
  }

  return candidates;
}

function rotatingTemplateIndex(length: number): number {
  // Advances every 3 days, matching the posting cadence
  const periodDays = 3;
  const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * periodDays));
  return dayIndex % length;
}

function trimDescription(description: string, maxChars = 220): string {
  const clean = description.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars).trimEnd();
  const lastDot = cut.lastIndexOf(".");
  return lastDot > maxChars * 0.6 ? cut.slice(0, lastDot + 1) : `${cut}...`;
}

function buildCommentaryInSpanish(candidate: NewsCandidate, _config: ValidAutoPostConfig): string {
  const { title, link, description } = candidate;
  const insight = description ? trimDescription(description) : title;

  // Hooks derived from the article title — unique each rotation
  const titleWords = title.split(" ").slice(0, 6).join(" ");

  const templates: string[] = [
    // 1 — Dato + conclusión directa
    [
      `"${titleWords}…" — esto me parece importante.`,
      "",
      insight,
      "",
      `Lo leí aquí → ${link}`,
      "",
      `Mi conclusión: quien entiende esto antes no solo lleva ventaja — define el ritmo al que los demás tienen que adaptarse.`,
    ].join("\n"),

    // 2 — Dato concreto + síntesis
    [
      `Acabo de leer algo que cambia cómo veo el sector:`,
      "",
      insight,
      "",
      `Artículo completo: ${link}`,
      "",
      `Lo que me quedo: no es una tendencia futura. Ya está pasando. Y la brecha entre los que se adaptan y los que esperan se agranda cada mes.`,
    ].join("\n"),

    // 3 — Tres puntos clave + conclusión
    [
      `Este artículo lo resume en una idea que vale la pena entender:`,
      "",
      `→ ${insight}`,
      `→ El timing importa: quien actúa ahora lleva ventaja.`,
      `→ Ignorarlo tiene un costo real, aunque tarde en verse.`,
      "",
      `Lee el artículo: ${link}`,
      "",
      `En resumen: los cambios de fondo siempre importan más que los titulares. Vale entender la mecánica, no solo el resultado.`,
    ].join("\n"),

    // 4 — Storytelling + reflexión
    [
      `Hoy leí algo que me hizo repensar cómo funciona esto:`,
      "",
      insight,
      "",
      `→ ${link}`,
      "",
      `Lo que más me llama la atención: la gente que mueve temprano no tiene mejores predicciones. Solo actúa sobre señales que otros ignoran.`,
    ].join("\n"),

    // 5 — Urgencia real + conclusión
    [
      `Esto está pasando ahora mismo, y vale leerlo:`,
      "",
      insight,
      "",
      `Más contexto: ${link}`,
      "",
      `Por qué lo comparto: no para generar ruido, sino porque entender el mecanismo detrás de esto vale más que cualquier titular.`,
    ].join("\n"),
  ];

  return templates[rotatingTemplateIndex(templates.length)];
}

function buildCommentaryInEnglish(candidate: NewsCandidate, _config: ValidAutoPostConfig): string {
  const { title, link, description } = candidate;
  const insight = description ? trimDescription(description) : title;

  // Use first meaningful words from the title as an anchor for the hook
  const titleHook = title.split(" ").slice(0, 7).join(" ");

  const templates: string[] = [
    // 1 — Article-specific hook + conclusion
    [
      `"${titleHook}…" — worth reading.`,
      "",
      insight,
      "",
      `Full article → ${link}`,
      "",
      `The takeaway: the people who spot this early adapt faster. That gap compounds over time — and it's already happening.`,
    ].join("\n"),

    // 2 — Already in motion + conclusion
    [
      `I just read something that changed how I see this space:`,
      "",
      insight,
      "",
      `Source: ${link}`,
      "",
      `What stands out to me: this isn't a prediction anymore. It's already in motion, and the window to adapt is narrowing.`,
    ].join("\n"),

    // 3 — Three takeaways + conclusion
    [
      `This article in 3 ideas:`,
      "",
      `→ ${insight}`,
      `→ Timing matters: early movers hold the advantage.`,
      `→ Ignoring this has a real cost, even if it's slow.`,
      "",
      `Read the full thing: ${link}`,
      "",
      `Bottom line: the shift is already underway. The gap between those who adapt and those who don't is widening.`,
    ].join("\n"),

    // 4 — Market moved + conclusion
    [
      `Something worth knowing happened in this space:`,
      "",
      insight,
      "",
      `Full piece: ${link}`,
      "",
      `My read: the fundamentals here matter more than the headlines. Worth understanding the underlying mechanics, not just the outcome.`,
    ].join("\n"),

    // 5 — Position early + conclusion
    [
      `I keep seeing this pattern repeat:`,
      "",
      insight,
      "",
      `More here: ${link}`,
      "",
      `The through-line: the people who move early don't have better predictions — they just act on signals others ignore.`,
    ].join("\n"),
  ];

  return templates[rotatingTemplateIndex(templates.length)];
}

function buildCommentary(candidate: NewsCandidate, config: ValidAutoPostConfig): string {
  if (config.postLanguage === "en") {
    return buildCommentaryInEnglish(candidate, config);
  }
  return buildCommentaryInSpanish(candidate, config);
}

const IMAGE_SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
  "by", "from", "how", "why", "what", "when", "where", "that", "this",
  "will", "can", "could", "should", "would", "has", "have", "had",
  "its", "it", "as", "not", "no", "new", "now", "just", "more",
  "than", "over", "top", "best", "most", "your", "they", "their",
]);

export function buildImageSearchQuery(candidate: NewsCandidate): string {
  const titleTokens = candidate.title
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3 && !IMAGE_SEARCH_STOPWORDS.has(token))
    .slice(0, 4);

  const keywordTokens = candidate.keyword
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .slice(0, 2);

  const combined = [...new Set([...titleTokens, ...keywordTokens])].slice(0, 4);
  const subject = combined.join(" ");

  // Create an abstract AI prompt guaranteeing variety
  const styles = [
    "neon geometric",
    "minimalist digital",
    "cyberpunk neural network",
    "abstract data flow",
    "futuristic holographic",
    "fluid glowing",
  ];
  const randomStyle = styles[Math.floor(Math.random() * styles.length)];

  return `Abstract digital art representing ${subject}, ${randomStyle} style, dark background, no text, no watermark, 4k`;
}

function pickBestCandidate(
  candidates: NewsCandidate[],
  history: AutoPostHistory,
  maxArticleAgeHours: number
): NewsCandidate | null {
  const filtered = candidates.filter((candidate) => {
    const ageHours = (Date.now() - candidate.publishedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > maxArticleAgeHours) {
      return false;
    }
    return !hasBeenPosted(history, candidate.link, candidate.title);
  });

  if (filtered.length === 0) {
    return null;
  }

  filtered.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.publishedAt.getTime() - left.publishedAt.getTime();
  });

  return filtered[0];
}

// ─── Article content fetcher ──────────────────────────────────────────────────

const ARTICLE_FETCH_TIMEOUT_MS = 12000;
const ARTICLE_MAX_CHARS = 3000;

/**
 * Fetches the article URL and extracts the main readable text from the HTML.
 * Returns null on any error so callers can fall back to the RSS description.
 */
async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const html = await response.text();

    // Strip scripts, styles, nav, header, footer, aside
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(nav|header|footer|aside|figure|form|button|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (stripped.length < 100) return null;

    return stripped.slice(0, ARTICLE_MAX_CHARS);
  } catch {
    return null;
  }
}

// ─── AI text generation ───────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Calls Google Gemini 2.0 Flash for text generation.
 * Free tier: 1,500 requests/day, 15 requests/minute.
 */
async function callGeminiText(
  messages: ChatMessage[],
  googleApiKey: string,
  timeoutMs = 30000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Convert chat format to Gemini's content format
  const systemMsg = messages.find((m) => m.role === "system");
  const userMsgs = messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    contents: userMsgs.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: 900, temperature: 0.85 },
  };

  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(googleApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini text API ${response.status}: ${err.slice(0, 120)}`);
    }

    interface GeminiTextResponse {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }
    const data = (await response.json()) as GeminiTextResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error("Gemini returned empty text");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls Pollinations.ai for text generation (free, no API key required).
 */
async function callPollinationsText(
  messages: ChatMessage[],
  timeoutMs = 40000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai",
        messages,
        max_tokens: 900,
        temperature: 0.85,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Pollinations text API returned ${response.status}`);
    }

    interface PollinationsResponse {
      choices?: Array<{ message?: { content?: string } }>;
    }
    const data = (await response.json()) as PollinationsResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Pollinations returned empty response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the best available AI (Gemini → Pollinations) and returns generated text.
 * Throws if all providers fail.
 */
async function callAiText(
  messages: ChatMessage[],
  googleApiKey: string | null
): Promise<string> {
  if (googleApiKey) {
    try {
      return await callGeminiText(messages, googleApiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Gemini text failed (${msg.slice(0, 80)}), trying Pollinations…`);
    }
  }
  return callPollinationsText(messages);
}

async function generateAiCommentary(
  candidate: NewsCandidate,
  config: ValidAutoPostConfig,
  googleApiKey: string | null
): Promise<string> {
  const { title, description, link } = candidate;
  const isSpanish = config.postLanguage === "es";

  // Try to get the full article body for a richer summary
  console.error("  Fetching article content…");
  const articleBody = await fetchArticleText(link);
  const articleContent = articleBody
    ? articleBody
    : description || title;

  const systemPrompt = isSpanish
    ? `Eres Taimir, ingeniero de telecomunicaciones con más de 5 años como Full Stack Developer especializado en React, Node.js, TypeScript, diseño de APIs REST, CI/CD y GenAI. Trabajas en el sector fintech y escribes en LinkedIn desde tu propia voz técnica y profesional. Tus posts suenan completamente humanos, nunca corporativos. Eres directo, sin relleno, y cuando opinas lo haces desde tu experiencia real construyendo sistemas escalables y seguros.`
    : `You are Taimir, a Telecommunications Engineer with 5+ years as a Full Stack Developer specializing in React, Node.js, TypeScript, RESTful API design, CI/CD pipelines, and GenAI integration. You work in the fintech space. You write LinkedIn posts in your own technical and professional voice — direct, opinionated, and grounded in real experience building scalable, secure web applications. You never use corporate filler language. Your opinion is specific and technical, not generic.`;

  const userPrompt = isSpanish
    ? `Escribe un post de LinkedIn basado en el siguiente artículo. Mínimo 300 palabras. Que suene totalmente tuyo.

Título del artículo: ${title}
Contenido:
${articleContent}

Enlace: ${link}

Estructura obligatoria — sigue este orden exacto:

[GANCHO — 1 línea]
Una frase de apertura directa e inesperada, sacada de la idea central del artículo. No empieces con tu nombre ni con "Acabo de leer". El gancho tiene que hacer que alguien quiera seguir leyendo.

[RESEÑA REAL DEL ARTÍCULO — 150 a 200 palabras]
Explica con detalle qué cuenta el artículo: los puntos concretos que desarrolla, los datos o argumentos que presenta, cómo llega a sus conclusiones. No parafrasees el título. Escribe como si le explicaras el artículo a un colega ingeniero que no lo leyó. Usa tus propias palabras. Párrafos cortos.

[OPINIÓN TÉCNICA PERSONAL — 80 a 100 palabras]
Da tu opinión real como Full Stack Developer con foco en fintech. Qué te parece relevante o discutible desde tu experiencia construyendo APIs, pipelines CI/CD, sistemas con React/Node.js o integraciones GenAI. Sé específico — no digas "esto es importante", di por qué lo es para alguien que trabaja en sistemas reales.

[ENLACE]
Incluye el enlace de forma natural en una línea sola.

[CIERRE — 1 a 2 frases]
Una reflexión final que sintetice el valor del artículo. Sin pregunta al lector. Sin llamado a la acción.

[HASHTAGS — ÚLTIMA LÍNEA]
Escribe EXACTAMENTE 4 hashtags relevantes al tema. Nada más después de los hashtags.

Reglas de formato:
- Sin asteriscos, sin markdown, sin negritas
- Párrafos separados por línea en blanco
- PROHIBIDO usar: "¿Tú cómo lo ves?", "¿Qué opinas?", "Comparte si", "¿Lo habías visto venir?", "el mercado se movió"`
    : `Write a LinkedIn post based on the following article. Minimum 300 words. It must sound entirely like you.

Article title: ${title}
Content:
${articleContent}

Link: ${link}

Mandatory structure — follow this exact order:

[HOOK — 1 line]
A direct, unexpected opening line rooted in the article's core idea. Do not start with your name or "I just read". The hook must make someone want to keep reading.

[REAL ARTICLE REVIEW — 150 to 200 words]
Explain in detail what the article covers: the specific points it develops, the data or arguments it presents, how it reaches its conclusions. Do not paraphrase the title. Write as if you're explaining the article to a fellow engineer who hasn't read it. Use your own words. Short paragraphs.

[PERSONAL TECHNICAL OPINION — 80 to 100 words]
Give your real opinion as a Full Stack Developer focused on fintech. What stands out or seems debatable from your experience building APIs, CI/CD pipelines, React/Node.js systems, or GenAI integrations. Be specific — don't say "this is important", say why it matters to someone building real systems.

[LINK]
Include the link naturally on its own line.

[CLOSING — 1 to 2 sentences]
A final reflection that synthesizes the article's value. No reader question. No call to action.

[HASHTAGS — LAST LINE]
Write EXACTLY 4 hashtags relevant to the topic. Nothing after the hashtags.

Formatting rules:
- No asterisks, no markdown, no bold text
- Paragraphs separated by blank lines
- FORBIDDEN endings: "What do you think?", "How will this shift your approach?", "Drop your take", "Share if", "What's your read on this?"`;

  return callAiText(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    googleApiKey
  );
}

// ─── Candidates ───────────────────────────────────────────────────────────────

async function collectCandidates(config: ValidAutoPostConfig): Promise<NewsCandidate[]> {
  const allCandidates: NewsCandidate[] = [];

  for (const keyword of config.keywords) {
    try {
      const rssXml = await fetchRssForKeyword(keyword, config.market);
      const candidates = parseBingNewsRss(keyword, rssXml, config);
      allCandidates.push(...candidates);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Skipping keyword "${keyword}": ${errorMessage}`);
    }
  }

  return allCandidates;
}

export async function prepareAutoPost(): Promise<PreparedAutoPost> {
  const config = await loadAutoPostConfig();
  const googleApiKey = getGoogleApiKey();
  const history = await loadAutoPostHistory();
  const candidates = await collectCandidates(config);
  const bestCandidate = pickBestCandidate(candidates, history, config.maxArticleAgeHours);

  if (!bestCandidate) {
    throw new Error(
      "No relevant article found. Try broadening keywords, changing market, or increasing maxArticleAgeHours."
    );
  }

  console.error(`Generating post with AI (${googleApiKey ? "Gemini" : "Pollinations"} first)...`);
  let commentary = await generateAiCommentary(bestCandidate, config, googleApiKey).catch((aiError: unknown) => {
    const reason = aiError instanceof Error ? aiError.message : String(aiError);
    console.error(`AI generation failed (${reason}), using template fallback...`);
    return buildCommentary(bestCandidate, config);
  });

  // Extract hashtags from the end of the AI commentary
  let dynamicHashtags: string[] | undefined = undefined;
  const hashtagRegex = /(?:\s*#\w+)+[^a-zA-Z0-9]*$/;
  const match = commentary.match(hashtagRegex);
  if (match) {
    const tagsText = match[0];
    dynamicHashtags = tagsText
      .split(/[^#\w]+/)
      .filter((t) => t.startsWith("#") || t.length > 1)
      .map((t) => t.replace("#", ""));
    commentary = commentary.replace(hashtagRegex, "").trim();
    console.error(`  Extracted dynamic hashtags: ${dynamicHashtags.join(", ")}`);
  } else {
    console.error("  No dynamic hashtags found at the end of AI commentary.");
  }

  return {
    candidate: bestCandidate,
    commentary,
    imageSearchQuery: buildImageSearchQuery(bestCandidate),
    config,
    googleApiKey,
    dynamicHashtags,
  };
}

export async function runAutoPostJob(): Promise<AutoPostRunResult> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error("Missing or expired LinkedIn token. Run 'pnpm auth' to authenticate again.");
  }

  const prepared = await prepareAutoPost();
  const client = new LinkedInClient(accessToken);

  const basePost = {
    text: prepared.commentary,
    visibility: prepared.config.visibility,
    hashtags: prepared.dynamicHashtags && prepared.dynamicHashtags.length > 0 
      ? prepared.dynamicHashtags 
      : prepared.config.hashtags,
    altText: prepared.candidate.title,
  };

  async function tryWithFallback() {
    // ── Attempt 1: DALL-E & Pollinations.ai AI generation ──
    try {
      // Append random seed to guarantee variety in case it falls back to Pollinations
      const promptWithSeed = `${prepared.imageSearchQuery} --seed ${Math.floor(Math.random() * 1000000)}`;
      const result = await client.createImagePost({
        ...basePost,
        imageGenerationPrompt: promptWithSeed,
      });
      return result;
    } catch (pollinationsErr: unknown) {
      const reason = pollinationsErr instanceof Error ? pollinationsErr.message : String(pollinationsErr);
      console.error(`DALL-E/Pollinations failed (${reason}), trying Google Gemini…`);
    }

    // ── Attempt 2: Google Gemini (if key provided) ──
    if (prepared.googleApiKey) {
      try {
        const result = await client.createImagePost({
          ...basePost,
          imageGooglePrompt: prepared.imageSearchQuery,
          googleApiKey: prepared.googleApiKey,
        });
        return result;
      } catch (geminiErr: unknown) {
        const reason = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
        console.error(`Google Gemini image failed (${reason}). All AI image providers failed.`);
        throw new Error(`All AI image generation providers failed. Last error: ${reason}`);
      }
    }

    throw new Error(`All AI image generation providers failed.`);
  }

  const postResult = await tryWithFallback();

  if (!postResult.success || !postResult.id) {
    throw new Error("LinkedIn did not confirm the post creation.");
  }

  const history = await loadAutoPostHistory();
  const historyEntry: AutoPostHistoryEntry = {
    keyword: prepared.candidate.keyword,
    title: prepared.candidate.title,
    link: normalizeArticleUrl(prepared.candidate.link),
    postedAt: new Date().toISOString(),
  };
  const updatedHistory: AutoPostHistory = {
    entries: [historyEntry, ...history.entries].slice(0, MAX_HISTORY_ENTRIES),
  };
  await saveAutoPostHistory(updatedHistory);

  return {
    postId: postResult.id,
    articleTitle: prepared.candidate.title,
    articleLink: prepared.candidate.link,
    source: prepared.candidate.source || "Unknown",
    keyword: prepared.candidate.keyword,
  };
}

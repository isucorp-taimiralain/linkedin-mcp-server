#!/usr/bin/env node

/**
 * One-shot post script — posts the supplied text + abstract AI image.
 *
 * Image priority:
 *   1. Google Gemini / Imagen (if google_api_key in credentials + billing enabled)
 *   2. Pollinations.ai flux / turbo (when up — includes C2PA metadata → CR badge)
 *   3. LoremFlickr tech/abstract stock photo (always available, no CR badge)
 */

import { getAccessToken, getGoogleApiKey } from "./auth.js";
import { LinkedInClient, type ImagePostOptions } from "./linkedin.js";

const POST_TEXT = `How do you write a unit test for "Chill"?

Amazon just pushed an update to Alexa+ allowing users to toggle between personalities like Brief, Chill, or Sweet. Under the hood, they're tuning knobs for expressiveness, formality, and directness.

As a user, I love this. I usually just want the "Brief" version of everything.

But as a system architect, this highlights the biggest headache in modern AI integration: the death of deterministic responses.

We used to rely on strict API contracts. Input A always equals Output B.

Now, we have to build frontend clients and downstream services that can handle "Brief" data, "Sweet" conversational wrappers, or "Chill" slang without throwing parsing errors.

If you're building GenAI features right now, you aren't just shipping a prompt. You're shipping a dynamic system where the "personality" is basically a chaotic variable in your integration tests.

We have to stop testing for string matches and start testing for semantic intent.

How are you handling automated testing when your backend response style changes on the fly? 🤖

https://lnkd.in/ebSeUwnk`;

const HASHTAGS = [
  "GenAI",
  "SoftwareArchitecture",
  "LLM",
  "DevOps",
  "Testing",
  "BackendEngineering",
  "AWS",
  "ProductEngineering",
];

const IMAGE_PROMPT =
  "abstract generative art, dark background, glowing neon data streams branching into three " +
  "divergent paths, minimalist geometry, chaotic neural network nodes, electric blue purple teal, " +
  "no faces, no text, no watermark, digital art, 4k";

const ALT_TEXT =
  "Abstract visualization of non-deterministic AI personality layers — " +
  "data streams branching into Brief, Chill and Sweet nodes on a dark background.";

const BASE_OPTIONS = {
  text: POST_TEXT,
  hashtags: HASHTAGS,
  altText: ALT_TEXT,
  visibility: "PUBLIC" as const,
};

async function tryPublish(
  client: LinkedInClient,
  label: string,
  options: ImagePostOptions
): Promise<{ success: true; id: string; message?: string } | null> {
  console.log(`  Trying: ${label} …`);
  try {
    const result = await client.createImagePost(options);
    if (result.success && result.id) {
      return { success: true, id: result.id, message: result.message };
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ✗ ${msg.split("\n")[0]}`);
    return null;
  }
}

async function fetchImageBytes(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "linkedin-mcp-server/1.0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error("Empty response");
  const contentType = response.headers.get("content-type")?.split(";")[0].trim() || "image/jpeg";
  return { bytes, contentType };
}

async function main(): Promise<void> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    console.error("Not authenticated. Run `pnpm auth` first.");
    process.exit(1);
  }

  const googleApiKey = getGoogleApiKey();
  const client = new LinkedInClient(accessToken);

  console.log("Publishing to LinkedIn with AI-generated abstract image…\n");
  console.log("Post text preview:");
  console.log("─".repeat(60));
  console.log(POST_TEXT);
  console.log("─".repeat(60));
  console.log(`\nHashtags : ${HASHTAGS.map((h) => `#${h}`).join(" ")}`);
  console.log(`Prompt   : "${IMAGE_PROMPT}"\n`);

  // ── Attempt 1: Google Gemini/Imagen (requires billing) ─────────────────────
  if (googleApiKey) {
    const result = await tryPublish(client, "Google Gemini image generation", {
      ...BASE_OPTIONS,
      imageGooglePrompt: IMAGE_PROMPT,
      googleApiKey,
    });
    if (result) {
      console.log("\n✓ Post published via Google Gemini!");
      console.log(`  Post ID : ${result.id}`);
      if (result.message) console.log(`  Image   : ${result.message}`);
      return;
    }
  }

  // ── Attempt 2: Pollinations.ai (free, C2PA when up) ────────────────────────
  const pollinationsResult = await tryPublish(client, "Pollinations.ai (C2PA)", {
    ...BASE_OPTIONS,
    imageGenerationPrompt: IMAGE_PROMPT,
  });
  if (pollinationsResult) {
    console.log("\n✓ Post published via Pollinations.ai (with CR badge)!");
    console.log(`  Post ID : ${pollinationsResult.id}`);
    if (pollinationsResult.message) console.log(`  Image   : ${pollinationsResult.message}`);
    return;
  }

  // ── Attempt 3: LoremFlickr stock photo fallback ─────────────────────────────
  console.log("  Trying: LoremFlickr stock photo fallback (no CR badge) …");
  const loremUrl = "https://loremflickr.com/1600/900/technology,abstract,network,digital";
  try {
    const { bytes, contentType } = await fetchImageBytes(loremUrl);
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const ext = contentType === "image/png" ? ".png" : ".jpg";
    const tmpPath = join(tmpdir(), `linkedin-post-fallback${ext}`);
    await writeFile(tmpPath, Buffer.from(bytes));
    console.log(`  ✓ Stock photo saved (${bytes.byteLength} bytes)`);
    console.warn(
      "  ⚠ Note: stock photo — no CR badge on LinkedIn.\n" +
      "    Enable billing at https://ai.dev/projects to use Google Imagen next time."
    );

    const result = await client.createImagePost({ ...BASE_OPTIONS, imagePath: tmpPath });
    if (result.success && result.id) {
      console.log("\n✓ Post published (stock photo fallback)!");
      console.log(`  Post ID : ${result.id}`);
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ LoremFlickr failed: ${msg}`);
  }

  console.error("\nAll image sources failed. Post was NOT published.");
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});

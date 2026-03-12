/**
 * LinkedIn API Client
 * Supports profile access, posting content, and sharing articles.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const LINKEDIN_API_URL = "https://api.linkedin.com";
const MAX_POST_LENGTH = 3000;
const MAX_HASHTAGS = 5;
const AUTO_HASHTAGS_COUNT = 4;

type PostVisibility = "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(Object.values(IMAGE_MIME_BY_EXTENSION));
const GENERATED_IMAGE_MODELS = ["flux", "turbo"] as const;
const GENERATED_IMAGE_WIDTH = 1600;
const GENERATED_IMAGE_HEIGHT = 900;

const COMMON_STOPWORDS = new Set<string>([
  "this",
  "that",
  "with",
  "from",
  "into",
  "over",
  "under",
  "after",
  "before",
  "about",
  "would",
  "could",
  "should",
  "have",
  "has",
  "been",
  "were",
  "just",
  "your",
  "what",
  "when",
  "where",
  "keep",
  "split",
  "architecture",
  "component",
  "components",
  "real",
  "world",
  "more",
  "less",
  "make",
  "made",
  "than",
  "them",
  "then",
  "will",
  "also",
  "using",
  "into",
  "much",
  "very",
]);

export interface PostResult {
  success: boolean;
  id?: string;
  message?: string;
}

export interface Profile {
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
}

export interface ImagePostOptions {
  text: string;
  visibility?: PostVisibility;
  hashtags?: string[];
  imagePath?: string;
  imageUrl?: string;
  imageSearchQuery?: string;
  imageGenerationPrompt?: string;
  imageGooglePrompt?: string;
  googleApiKey?: string;
  altText?: string;
}

interface PreparedImage {
  bytes: ArrayBuffer;
  contentType: string;
  source: string;
}

interface RegisterImageUploadResponse {
  value?: {
    asset?: string;
    uploadMechanism?: {
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: {
        uploadUrl?: string;
      };
    };
  };
}

export class LinkedInClient {
  private accessToken: string;
  private memberUrn: string | null = null;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private getHeaders(version: boolean = true): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    };
    if (version) {
      headers["LinkedIn-Version"] = "202401";
    }
    return headers;
  }

  private normalizeHashtag(tag: string): string | null {
    const cleaned = tag
      .trim()
      .replace(/^#+/, "")
      .replace(/[^a-zA-Z0-9]/g, "");
    if (cleaned.length < 2) {
      return null;
    }
    return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
  }

  private getAutoHashtags(text: string): string[] {
    const words = text
      .replace(/#[a-zA-Z0-9]+/g, " ")
      .split(/[^a-zA-Z0-9]+/)
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word.length >= 4 && !COMMON_STOPWORDS.has(word));

    const uniqueTags: string[] = [];
    const seen = new Set<string>();

    for (const word of words) {
      if (seen.has(word)) {
        continue;
      }
      seen.add(word);

      const hashtag = this.normalizeHashtag(word);
      if (!hashtag) {
        continue;
      }

      uniqueTags.push(hashtag);
      if (uniqueTags.length >= AUTO_HASHTAGS_COUNT) {
        break;
      }
    }

    if (uniqueTags.length === 0) {
      return ["LinkedIn", "Tech"];
    }

    return uniqueTags;
  }

  private buildPostTextWithHashtags(text: string, hashtags?: string[]): { text: string; hashtags: string[] } {
    const normalizedHashtags = (hashtags || [])
      .map((tag) => this.normalizeHashtag(tag))
      .filter((tag): tag is string => Boolean(tag))
      .slice(0, MAX_HASHTAGS);

    const finalHashtags =
      normalizedHashtags.length > 0
        ? normalizedHashtags
        : this.getAutoHashtags(text).slice(0, MAX_HASHTAGS);

    const baseText = text.trim();
    const hashtagLine = finalHashtags.map((tag) => `#${tag}`).join(" ");
    const suffix = `\n\n${hashtagLine}`;
    const maxBaseLength = MAX_POST_LENGTH - suffix.length;

    if (maxBaseLength <= 0) {
      throw new Error("Hashtags are too long for LinkedIn's 3000 character limit");
    }

    const trimmedBase =
      baseText.length > maxBaseLength ? baseText.slice(0, maxBaseLength).trimEnd() : baseText;

    return {
      text: `${trimmedBase}${suffix}`,
      hashtags: finalHashtags,
    };
  }

  private parseMimeType(contentTypeHeader: string | null): string | null {
    if (!contentTypeHeader) {
      return null;
    }

    const normalized = contentTypeHeader.split(";")[0].trim().toLowerCase();
    if (normalized === "image/jpg") {
      return "image/jpeg";
    }

    if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) {
      return null;
    }

    return normalized;
  }

  private getMimeTypeFromPath(pathLike: string): string | null {
    const extension = extname(pathLike).toLowerCase();
    return IMAGE_MIME_BY_EXTENSION[extension] || null;
  }

  private isHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private async loadLocalImage(imagePath: string): Promise<PreparedImage> {
    const raw = await readFile(imagePath);
    const bytes: ArrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (bytes.byteLength === 0) {
      throw new Error(`Image file is empty: ${imagePath}`);
    }

    const contentType = this.getMimeTypeFromPath(imagePath);
    if (!contentType) {
      throw new Error(
        "Unsupported image extension. Supported formats: .jpg, .jpeg, .png, .gif, .webp"
      );
    }

    return {
      bytes,
      contentType,
      source: `local file (${imagePath})`,
    };
  }

  private async downloadImageFromUrl(imageUrl: string, sourceLabel: string): Promise<PreparedImage> {
    if (!this.isHttpUrl(imageUrl)) {
      throw new Error(`Invalid image URL: ${imageUrl}`);
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status} (${imageUrl})`);
    }

    const bytes: ArrayBuffer = await response.arrayBuffer();
    if (bytes.byteLength === 0) {
      throw new Error(`Downloaded image is empty (${imageUrl})`);
    }

    const contentTypeFromHeader = this.parseMimeType(response.headers.get("content-type"));
    const contentTypeFromPath = this.getMimeTypeFromPath(new URL(response.url).pathname);
    const contentType = contentTypeFromHeader || contentTypeFromPath;

    if (!contentType) {
      throw new Error(
        "Unsupported image type from URL. Supported formats: image/jpeg, image/png, image/gif, image/webp"
      );
    }

    return {
      bytes,
      contentType,
      source: sourceLabel,
    };
  }

  private async downloadImageFromSearchQuery(query: string): Promise<PreparedImage> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("imageSearchQuery cannot be empty");
    }

    // We no longer use stock image APIs (Unsplash, LoremFlickr).
    // Always fall back to AI generation for searches if explicitly called.
    return this.generateImageFromPrompt(query);
  }

  private async generateImageFromPrompt(prompt: string): Promise<PreparedImage> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      throw new Error("imageGenerationPrompt cannot be empty");
    }

    let lastError: unknown = null;

    // 1. DALL-E proxy (Primary free image generator)
    try {
      const dalleResponse = await fetch("https://apis.scrimba.com/openai/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Abstract digital art, ${normalizedPrompt}, dark background, neon colors, no text, no watermark`,
          n: 1,
          size: "1024x1024",
        }),
      });

      if (dalleResponse.ok) {
        const dalleData = await dalleResponse.json();
        const imageUrl = dalleData.data?.[0]?.url;
        if (imageUrl) {
          return await this.downloadImageFromUrl(
            imageUrl,
            `DALL-E image generation — prompt: "${normalizedPrompt}"`
          );
        }
      } else {
        lastError = new Error(`DALL-E proxy error: ${dalleResponse.status}`);
      }
    } catch (dalleError) {
      console.error("DALL-E proxy failed", dalleError);
      lastError = dalleError;
    }

    // 2. Fallback to Pollinations.ai if DALL-E proxy is down
    for (const model of GENERATED_IMAGE_MODELS) {
      const params = new URLSearchParams({
        width: String(GENERATED_IMAGE_WIDTH),
        height: String(GENERATED_IMAGE_HEIGHT),
        nologo: "true",
        private: "true",
        model,
      });
      const generatedImageUrl =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(normalizedPrompt)}` +
        `?${params.toString()}`;

      try {
        return await this.downloadImageFromUrl(
          generatedImageUrl,
          `generated image from prompt "${normalizedPrompt}" (${model})`
        );
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw new Error(`Failed to generate image from prompt: ${lastError.message}`);
    }

    throw new Error("Failed to generate image from prompt");
  }

  private async generateImageFromGoogleImagen(
    prompt: string,
    googleApiKey: string
  ): Promise<PreparedImage> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      throw new Error("imageGooglePrompt cannot be empty");
    }
    if (!googleApiKey.trim()) {
      throw new Error("Google API key is required for imageGooglePrompt");
    }

    /**
     * Gemini image generation models (free tier via generateContent API).
     * These models return inline image data in the response.
     */
    const models = [
      "gemini-2.0-flash-exp-image-generation",
      "gemini-2.5-flash-image",
    ] as const;

    interface GeminiPart {
      text?: string;
      inlineData?: { mimeType: string; data: string };
    }
    interface GeminiResponse {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      error?: { message?: string };
    }

    const GEMINI_IMG_MAX_RETRIES = 2;
    const GEMINI_IMG_RETRY_BASE_MS = 10000;
    let lastError: unknown = null;

    for (const model of models) {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
        `?key=${encodeURIComponent(googleApiKey)}`;

      let modelSuccess = false;
      for (let attempt = 0; attempt <= GEMINI_IMG_MAX_RETRIES && !modelSuccess; attempt++) {
        try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: normalizedPrompt }] }],
            generationConfig: {
              responseModalities: ["IMAGE", "TEXT"],
            },
          }),
        });

        if (response.status === 429) {
          const retryAfterRaw = response.headers.get("Retry-After");
          const waitMs = retryAfterRaw
            ? Number(retryAfterRaw) * 1000
            : GEMINI_IMG_RETRY_BASE_MS * Math.pow(2, attempt);
          if (attempt < GEMINI_IMG_MAX_RETRIES) {
            console.error(`  Gemini image 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${GEMINI_IMG_MAX_RETRIES})…`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          throw new Error(`Google Gemini image 429: rate limit after ${GEMINI_IMG_MAX_RETRIES} retries`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Google Gemini API ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as GeminiResponse;

        if (data.error?.message) {
          throw new Error(`Google Gemini error: ${data.error.message}`);
        }

        const parts = data.candidates?.[0]?.content?.parts ?? [];
        const imagePart = parts.find((p) => p.inlineData?.data);

        if (!imagePart?.inlineData?.data) {
          throw new Error(`${model} returned no image data`);
        }

        const contentType = imagePart.inlineData.mimeType || "image/png";
        const binaryString = atob(imagePart.inlineData.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        return {
          bytes: bytes.buffer,
          contentType,
          source: `Google Gemini image generation (${model}) — prompt: "${normalizedPrompt}"`,
        };
        } catch (error) {
          lastError = error;
          // Non-429 errors: skip to next model immediately
          if (!(error instanceof Error && error.message.includes("429"))) {
            modelSuccess = false;
            break;
          }
        }
      } // end retry loop
    } // end model loop

    if (lastError instanceof Error) {
      throw new Error(`Google image generation failed: ${lastError.message}`);
    }
    throw new Error("Google image generation failed");
  }

  private async resolveImageForPost(
    text: string,
    options: {
      imagePath?: string;
      imageUrl?: string;
      imageSearchQuery?: string;
      imageGenerationPrompt?: string;
      imageGooglePrompt?: string;
      googleApiKey?: string;
    }
  ): Promise<PreparedImage> {
    const { imagePath, imageUrl, imageSearchQuery, imageGenerationPrompt, imageGooglePrompt, googleApiKey } = options;
    const selectedSourceCount = [imagePath, imageUrl, imageSearchQuery, imageGenerationPrompt, imageGooglePrompt].filter(
      (value) => Boolean(value && value.trim().length > 0)
    ).length;

    if (selectedSourceCount > 1) {
      throw new Error(
        "Provide only one image source: imagePath, imageUrl, imageSearchQuery, imageGenerationPrompt, or imageGooglePrompt"
      );
    }

    if (imagePath && imagePath.trim().length > 0) {
      return this.loadLocalImage(imagePath);
    }

    if (imageUrl && imageUrl.trim().length > 0) {
      return this.downloadImageFromUrl(imageUrl, `public image URL (${imageUrl})`);
    }

    if (imageSearchQuery && imageSearchQuery.trim().length > 0) {
      return this.downloadImageFromSearchQuery(imageSearchQuery);
    }

    if (imageGooglePrompt && imageGooglePrompt.trim().length > 0) {
      if (!googleApiKey || !googleApiKey.trim()) {
        throw new Error("googleApiKey is required when using imageGooglePrompt");
      }
      return this.generateImageFromGoogleImagen(imageGooglePrompt, googleApiKey);
    }

    if (imageGenerationPrompt && imageGenerationPrompt.trim().length > 0) {
      return this.generateImageFromPrompt(imageGenerationPrompt);
    }

    try {
      return await this.downloadImageFromSearchQuery(text);
    } catch {
      return this.generateImageFromPrompt(text);
    }
  }

  private async registerImageUpload(memberUrn: string): Promise<{ asset: string; uploadUrl: string }> {
    const response = await fetch(`${LINKEDIN_API_URL}/v2/assets?action=registerUpload`, {
      method: "POST",
      headers: this.getHeaders(false),
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: memberUrn,
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to register image upload: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as RegisterImageUploadResponse;
    const uploadUrl =
      data.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]
        ?.uploadUrl;
    const asset = data.value?.asset;

    if (!uploadUrl || !asset) {
      throw new Error("LinkedIn did not return upload URL or asset URN for the image");
    }

    return { asset, uploadUrl };
  }

  private async uploadImageToLinkedIn(
    uploadUrl: string,
    bytes: ArrayBuffer,
    contentType: string
  ): Promise<void> {
    let response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": contentType,
      },
      body: bytes,
    });

    if (response.ok || response.status === 201 || response.status === 202) {
      return;
    }

    response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
      body: bytes,
    });

    if (response.ok || response.status === 201 || response.status === 202) {
      return;
    }

    const errorText = await response.text();
    throw new Error(`Failed to upload image binary: ${response.status} - ${errorText}`);
  }

  /**
   * Get the member URN for the authenticated user
   */
  async getMemberUrn(): Promise<string> {
    if (this.memberUrn) {
      return this.memberUrn;
    }

    // Try REST /me endpoint first
    try {
      const response = await fetch(`${LINKEDIN_API_URL}/rest/me`, {
        headers: this.getHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.sub) {
          this.memberUrn = `urn:li:person:${data.sub}`;
          return this.memberUrn;
        }
      }
    } catch (error) {
      // Continue to fallback
    }

    // Try userinfo endpoint
    try {
      const response = await fetch(`${LINKEDIN_API_URL}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.sub) {
          this.memberUrn = `urn:li:person:${data.sub}`;
          return this.memberUrn;
        }
      }
    } catch (error) {
      // Continue to fallback
    }

    // Try v2 /me endpoint
    try {
      const response = await fetch(`${LINKEDIN_API_URL}/v2/me`, {
        headers: this.getHeaders(false),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.id) {
          this.memberUrn = `urn:li:person:${data.id}`;
          return this.memberUrn;
        }
      }
    } catch (error) {
      // Continue
    }

    throw new Error(
      "Unable to determine member URN. Please ensure you have 'Sign In with LinkedIn using OpenID Connect' product enabled in your LinkedIn app."
    );
  }

  /**
   * Get user profile information
   */
  async getProfile(): Promise<Profile> {
    // Try userinfo endpoint (OpenID Connect)
    try {
      const response = await fetch(`${LINKEDIN_API_URL}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      // Continue to fallback
    }

    // Try REST /me endpoint
    try {
      const response = await fetch(`${LINKEDIN_API_URL}/rest/me`, {
        headers: this.getHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        return {
          sub: data.sub || data.id,
          name: data.name || data.localizedFirstName,
        };
      }
    } catch (error) {
      // Continue to fallback
    }

    // Try v2 /me endpoint
    const response = await fetch(`${LINKEDIN_API_URL}/v2/me`, {
      headers: this.getHeaders(false),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        sub: data.id,
        given_name: data.localizedFirstName,
        family_name: data.localizedLastName,
        name: `${data.localizedFirstName || ""} ${data.localizedLastName || ""}`.trim(),
      };
    }

    throw new Error("Failed to fetch profile");
  }

  /**
   * Create a text post on LinkedIn
   */
  async createPost(
    text: string,
    visibility: PostVisibility = "PUBLIC",
    hashtags?: string[]
  ): Promise<PostResult> {
    const memberUrn = await this.getMemberUrn();
    const { text: postText } = this.buildPostTextWithHashtags(text, hashtags);

    // Try REST Posts API first (newer API)
    const postData = {
      author: memberUrn,
      commentary: postText,
      visibility: visibility,
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    let response = await fetch(`${LINKEDIN_API_URL}/rest/posts`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(postData),
    });

    if (response.ok || response.status === 201) {
      const postId = response.headers.get("x-restli-id") || "created";
      return { success: true, id: postId };
    }

    // Fallback to legacy ugcPosts API
    const legacyPostData = {
      author: memberUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: postText },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": visibility,
      },
    };

    response = await fetch(`${LINKEDIN_API_URL}/v2/ugcPosts`, {
      method: "POST",
      headers: this.getHeaders(false),
      body: JSON.stringify(legacyPostData),
    });

    if (response.ok || response.status === 201) {
      const data = await response.json();
      return { success: true, id: data.id };
    }

    const errorText = await response.text();
    throw new Error(`Failed to create post: ${response.status} - ${errorText}`);
  }

  /**
   * Create a post with an article/link
   */
  async createArticlePost(
    text: string,
    articleUrl: string,
    title?: string,
    description?: string,
    visibility: PostVisibility = "PUBLIC",
    hashtags?: string[]
  ): Promise<PostResult> {
    const memberUrn = await this.getMemberUrn();
    const { text: postText } = this.buildPostTextWithHashtags(text, hashtags);

    // Try REST Posts API with article
    const postData: Record<string, unknown> = {
      author: memberUrn,
      commentary: postText,
      visibility: visibility,
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        article: {
          source: articleUrl,
          title: title,
          description: description,
        },
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    let response = await fetch(`${LINKEDIN_API_URL}/rest/posts`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(postData),
    });

    if (response.ok || response.status === 201) {
      const postId = response.headers.get("x-restli-id") || "created";
      return { success: true, id: postId };
    }

    // Fallback to legacy ugcPosts API
    const mediaItem: Record<string, unknown> = {
      status: "READY",
      originalUrl: articleUrl,
    };

    if (title) {
      mediaItem.title = { text: title };
    }
    if (description) {
      mediaItem.description = { text: description };
    }

    const legacyPostData = {
      author: memberUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: postText },
          shareMediaCategory: "ARTICLE",
          media: [mediaItem],
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": visibility,
      },
    };

    response = await fetch(`${LINKEDIN_API_URL}/v2/ugcPosts`, {
      method: "POST",
      headers: this.getHeaders(false),
      body: JSON.stringify(legacyPostData),
    });

    if (response.ok || response.status === 201) {
      const data = await response.json();
      return { success: true, id: data.id };
    }

    const errorText = await response.text();
    throw new Error(`Failed to create article post: ${response.status} - ${errorText}`);
  }

  /**
   * Create a post with a single image.
   * Image sources supported: local path, public URL, internet search query, or generated prompt.
   */
  async createImagePost(options: ImagePostOptions): Promise<PostResult> {
    const {
      text,
      visibility = "PUBLIC",
      hashtags,
      imagePath,
      imageUrl,
      imageSearchQuery,
      imageGenerationPrompt,
      imageGooglePrompt,
      googleApiKey,
      altText,
    } = options;

    const memberUrn = await this.getMemberUrn();
    const { text: postText } = this.buildPostTextWithHashtags(text, hashtags);
    const preparedImage = await this.resolveImageForPost(text, {
      imagePath,
      imageUrl,
      imageSearchQuery,
      imageGenerationPrompt,
      imageGooglePrompt,
      googleApiKey,
    });

    const { asset, uploadUrl } = await this.registerImageUpload(memberUrn);
    await this.uploadImageToLinkedIn(uploadUrl, preparedImage.bytes, preparedImage.contentType);

    const mediaItem: Record<string, unknown> = {
      status: "READY",
      media: asset,
    };

    if (altText && altText.trim().length > 0) {
      mediaItem.description = { text: altText.trim() };
    }

    const legacyPostData = {
      author: memberUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: postText },
          shareMediaCategory: "IMAGE",
          media: [mediaItem],
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": visibility,
      },
    };

    const response = await fetch(`${LINKEDIN_API_URL}/v2/ugcPosts`, {
      method: "POST",
      headers: this.getHeaders(false),
      body: JSON.stringify(legacyPostData),
    });

    if (response.ok || response.status === 201) {
      let postId = response.headers.get("x-restli-id") || "created";
      try {
        const body = (await response.json()) as { id?: string };
        if (body.id) {
          postId = body.id;
        }
      } catch {
        // Ignore JSON parsing errors and keep header-based ID.
      }
      return {
        success: true,
        id: postId,
        message: preparedImage.source,
      };
    }

    const errorText = await response.text();
    throw new Error(`Failed to create image post: ${response.status} - ${errorText}`);
  }

  /**
   * Get user's recent posts (may require additional permissions)
   */
  async getPosts(count: number = 10): Promise<{ posts: unknown[]; message?: string }> {
    const memberUrn = await this.getMemberUrn();

    // Try to fetch posts using ugcPosts API
    const response = await fetch(
      `${LINKEDIN_API_URL}/v2/ugcPosts?q=authors&authors=List(${encodeURIComponent(memberUrn)})&count=${count}`,
      {
        headers: this.getHeaders(false),
      }
    );

    if (response.ok) {
      const data = await response.json();
      return { posts: data.elements || [] };
    }

    // This often requires additional permissions
    return {
      posts: [],
      message: "Unable to fetch posts. This may require additional LinkedIn API permissions.",
    };
  }

  /**
   * Delete a post (if supported)
   */
  async deletePost(postId: string): Promise<{ success: boolean; message?: string }> {
    // Try REST API
    let response = await fetch(`${LINKEDIN_API_URL}/rest/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
      headers: this.getHeaders(),
    });

    if (response.ok || response.status === 204) {
      return { success: true };
    }

    // Try legacy API
    response = await fetch(`${LINKEDIN_API_URL}/v2/ugcPosts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
      headers: this.getHeaders(false),
    });

    if (response.ok || response.status === 204) {
      return { success: true };
    }

    return {
      success: false,
      message: `Failed to delete post: ${response.status}`,
    };
  }

  /**
   * Get connection count (may require additional permissions)
   */
  async getConnectionsCount(): Promise<{ count: number | string; message?: string }> {
    const response = await fetch(
      `${LINKEDIN_API_URL}/v2/connections?q=viewer&start=0&count=0`,
      {
        headers: this.getHeaders(false),
      }
    );

    if (response.ok) {
      const data = await response.json();
      return { count: data.paging?.total || 0 };
    }

    return {
      count: "unavailable",
      message: "Connection count may require additional permissions.",
    };
  }
}

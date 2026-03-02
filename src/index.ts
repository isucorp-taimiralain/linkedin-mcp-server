#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAccessToken, isAuthenticated, getConfigDir, getUserInfo } from "./auth.js";
import { LinkedInClient } from "./linkedin.js";

// Tool definitions
const tools = [
  {
    name: "linkedin_get_profile",
    description: "Get the authenticated user's LinkedIn profile information including name, email, and profile picture.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "linkedin_create_post",
    description:
      "Create a text post on LinkedIn. Supports different visibility options: PUBLIC (everyone), CONNECTIONS (1st degree connections only), or LOGGED_IN (LinkedIn members only).",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The content of the post (max 3000 characters)",
        },
        visibility: {
          type: "string",
          enum: ["PUBLIC", "CONNECTIONS", "LOGGED_IN"],
          description: "Post visibility: PUBLIC (default), CONNECTIONS, or LOGGED_IN",
        },
        hashtags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional hashtags. If omitted, hashtags are auto-generated and appended at the end of the post.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "linkedin_create_article_post",
    description:
      "Create a LinkedIn post with an article/link. Great for sharing blog posts, news articles, or any web content with your network.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Commentary to accompany the article",
        },
        articleUrl: {
          type: "string",
          description: "URL of the article to share",
        },
        title: {
          type: "string",
          description: "Optional title for the article preview",
        },
        description: {
          type: "string",
          description: "Optional description for the article preview",
        },
        visibility: {
          type: "string",
          enum: ["PUBLIC", "CONNECTIONS", "LOGGED_IN"],
          description: "Post visibility: PUBLIC (default), CONNECTIONS, or LOGGED_IN",
        },
        hashtags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional hashtags. If omitted, hashtags are auto-generated and appended at the end of the post.",
        },
      },
      required: ["text", "articleUrl"],
    },
  },
  {
    name: "linkedin_create_image_post",
    description:
      "Create a LinkedIn post with exactly one image. Supports local file path, public image URL, internet image search query, or AI image generation prompt.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Commentary for the image post (hashtags will be appended at the end)",
        },
        imagePath: {
          type: "string",
          description: "Local image path (.jpg, .jpeg, .png, .gif, .webp)",
        },
        imageUrl: {
          type: "string",
          description: "Public image URL",
        },
        imageSearchQuery: {
          type: "string",
          description:
            "Search query to fetch a related internet image. Use this instead of imagePath/imageUrl.",
        },
        imageGenerationPrompt: {
          type: "string",
          description:
            "Prompt to generate an image from AI. Use this instead of imagePath/imageUrl/imageSearchQuery.",
        },
        altText: {
          type: "string",
          description: "Optional accessibility text for the image",
        },
        hashtags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional hashtags. If omitted, hashtags are auto-generated and appended at the end of the post.",
        },
        visibility: {
          type: "string",
          enum: ["PUBLIC", "CONNECTIONS", "LOGGED_IN"],
          description: "Post visibility: PUBLIC (default), CONNECTIONS, or LOGGED_IN",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "linkedin_get_posts",
    description:
      "Get the authenticated user's recent LinkedIn posts. Note: This may require additional API permissions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        count: {
          type: "number",
          description: "Number of posts to retrieve (default: 10, max: 50)",
        },
      },
    },
  },
  {
    name: "linkedin_delete_post",
    description: "Delete a LinkedIn post by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        postId: {
          type: "string",
          description: "The ID of the post to delete",
        },
      },
      required: ["postId"],
    },
  },
  {
    name: "linkedin_get_connections_count",
    description:
      "Get the number of LinkedIn connections. Note: This may require additional API permissions.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

async function main() {
  const server = new Server(
    {
      name: "linkedin-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Initialize LinkedIn client lazily
  let linkedinClient: LinkedInClient | null = null;

  const ensureClient = (): LinkedInClient => {
    if (linkedinClient) return linkedinClient;

    const accessToken = getAccessToken();
    if (!accessToken) {
      throw new Error(
        `Not authenticated. Please run 'npm run auth' in the linkedin-mcp-server directory to authenticate.\n` +
          `Config directory: ${getConfigDir()}`
      );
    }

    linkedinClient = new LinkedInClient(accessToken);
    return linkedinClient;
  };

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const client = ensureClient();

      switch (name) {
        case "linkedin_get_profile": {
          const profile = await client.getProfile();
          const userInfo = getUserInfo();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...profile,
                    ...userInfo,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "linkedin_create_post": {
          const { text, visibility, hashtags } = args as {
            text: string;
            visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
            hashtags?: string[];
          };

          if (!text || text.trim().length === 0) {
            throw new Error("Post text cannot be empty");
          }

          if (text.length > 3000) {
            throw new Error("Post text exceeds 3000 character limit");
          }

          if (hashtags && (!Array.isArray(hashtags) || hashtags.some((tag) => typeof tag !== "string"))) {
            throw new Error("hashtags must be an array of strings");
          }

          const result = await client.createPost(text, visibility || "PUBLIC", hashtags);
          return {
            content: [
              {
                type: "text",
                text: `Post created successfully!\nPost ID: ${result.id}\nVisibility: ${visibility || "PUBLIC"}`,
              },
            ],
          };
        }

        case "linkedin_create_article_post": {
          const { text, articleUrl, title, description, visibility, hashtags } = args as {
            text: string;
            articleUrl: string;
            title?: string;
            description?: string;
            visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
            hashtags?: string[];
          };

          if (!text || text.trim().length === 0) {
            throw new Error("Post text cannot be empty");
          }

          if (!articleUrl || !articleUrl.startsWith("http")) {
            throw new Error("Invalid article URL");
          }

          if (hashtags && (!Array.isArray(hashtags) || hashtags.some((tag) => typeof tag !== "string"))) {
            throw new Error("hashtags must be an array of strings");
          }

          const result = await client.createArticlePost(
            text,
            articleUrl,
            title,
            description,
            visibility || "PUBLIC",
            hashtags
          );
          return {
            content: [
              {
                type: "text",
                text: `Article post created successfully!\nPost ID: ${result.id}\nArticle: ${articleUrl}\nVisibility: ${visibility || "PUBLIC"}`,
              },
            ],
          };
        }

        case "linkedin_create_image_post": {
          const {
            text,
            imagePath,
            imageUrl,
            imageSearchQuery,
            imageGenerationPrompt,
            altText,
            visibility,
            hashtags,
          } = args as {
            text: string;
            imagePath?: string;
            imageUrl?: string;
            imageSearchQuery?: string;
            imageGenerationPrompt?: string;
            altText?: string;
            visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
            hashtags?: string[];
          };

          if (!text || text.trim().length === 0) {
            throw new Error("Post text cannot be empty");
          }

          if (hashtags && (!Array.isArray(hashtags) || hashtags.some((tag) => typeof tag !== "string"))) {
            throw new Error("hashtags must be an array of strings");
          }

          if (altText && typeof altText !== "string") {
            throw new Error("altText must be a string");
          }

          const result = await client.createImagePost({
            text,
            visibility: visibility || "PUBLIC",
            hashtags,
            imagePath,
            imageUrl,
            imageSearchQuery,
            imageGenerationPrompt,
            altText,
          });

          return {
            content: [
              {
                type: "text",
                text:
                  `Image post created successfully!\nPost ID: ${result.id}\nVisibility: ${visibility || "PUBLIC"}` +
                  (result.message ? `\nImage source: ${result.message}` : ""),
              },
            ],
          };
        }

        case "linkedin_get_posts": {
          const { count } = args as { count?: number };
          const result = await client.getPosts(Math.min(count || 10, 50));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "linkedin_delete_post": {
          const { postId } = args as { postId: string };
          const result = await client.deletePost(postId);
          return {
            content: [
              {
                type: "text",
                text: result.success
                  ? "Post deleted successfully."
                  : `Failed to delete post: ${result.message}`,
              },
            ],
          };
        }

        case "linkedin_get_connections_count": {
          const result = await client.getConnectionsCount();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LinkedIn MCP Server running on stdio");
}

main().catch(console.error);

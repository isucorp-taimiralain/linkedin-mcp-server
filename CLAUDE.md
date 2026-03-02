# LinkedIn MCP Server

MCP server for LinkedIn posting and profile management using LinkedIn's OAuth 2.0 API.

## Tech Stack

- TypeScript / Node.js 18+
- MCP SDK (@modelcontextprotocol/sdk)
- LinkedIn REST API
- OAuth 2.0 authentication

## Available Tools (7 total)

- `linkedin_get_profile` - Get authenticated user's profile
- `linkedin_create_post` - Create text post (max 3000 chars)
- `linkedin_create_article_post` - Share article with commentary
- `linkedin_create_image_post` - Create single-image post (local path, URL, internet search, or generated image)
- `linkedin_get_posts` - Get recent posts
- `linkedin_delete_post` - Delete a post
- `linkedin_get_connections_count` - Get connection count

### Visibility Options

- `PUBLIC` - Visible to everyone (default)
- `CONNECTIONS` - 1st-degree connections only
- `LOGGED_IN` - LinkedIn members only

## Setup

### 1. Create LinkedIn Developer App

1. Go to [LinkedIn Developer Portal](https://developer.linkedin.com/apps)
2. Create app with company page
3. Add redirect URL: `http://127.0.0.1:3000/callback`
4. Request products: "Sign In with LinkedIn" + "Share on LinkedIn"

### 2. Install & Configure

```bash
npm install && npm run build

mkdir -p ~/.linkedin-mcp

# Add credentials
cat > ~/.linkedin-mcp/credentials.json << 'EOF'
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
EOF

# Authenticate
npm run auth

# Add to Claude Code
claude mcp add linkedin -- node ~/personal-projects/linkedin-mcp-server/dist/index.js
```

## File Locations

- Credentials: `~/.linkedin-mcp/credentials.json`
- Auth token: `~/.linkedin-mcp/token.json`

## Key Files

- `src/index.ts` - MCP server and tool definitions
- `src/linkedin.ts` - LinkedIn API client
- `src/auth.ts` / `src/auth-cli.ts` - OAuth authentication

## Limitations

- Post character limit: 3000
- Tokens expire after 60 days (re-run `npm run auth`)
- Feed reading requires partner-level access

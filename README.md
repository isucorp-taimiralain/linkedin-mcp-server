# linkedin-mcp-server

> LinkedIn MCP Server — post content, share articles, and manage your LinkedIn profile through Claude using the official LinkedIn API.

[![npm version](https://img.shields.io/npm/v/@dev-hitesh-gupta/linkedin-mcp-server.svg)](https://www.npmjs.com/package/@dev-hitesh-gupta/linkedin-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)

**7 tools** for creating posts, sharing articles, posting with images, managing your profile, and more — powered by the official LinkedIn REST API with OAuth 2.0.

## Tools

| Tool | Description | Permissions Required |
|------|-------------|---------------------|
| `linkedin_get_profile` | Get your LinkedIn profile information | Basic (OpenID) |
| `linkedin_create_post` | Create a text post (up to 3000 chars) with hashtags at the end | Share on LinkedIn |
| `linkedin_create_article_post` | Share an article link with commentary and hashtags at the end | Share on LinkedIn |
| `linkedin_create_image_post` | Create a single-image post (local path, URL, search query, or generated image) | Share on LinkedIn |
| `linkedin_get_posts` | Get your recent posts | Share on LinkedIn ⚠️ |
| `linkedin_delete_post` | Delete a post by ID | Share on LinkedIn |
| `linkedin_get_connections_count` | Get your total connection count | ⚠️ May need partner access |

> ⚠️ **API Limitations:** `linkedin_get_posts` and `linkedin_get_connections_count` use LinkedIn endpoints that may require elevated or partner-level API access depending on your app's approval status. The core tools (get profile, create post, share article, delete post) work with standard access.

---

## Setup

LinkedIn requires creating a Developer App to get OAuth credentials. This takes about 10 minutes.

### Step 1 — Create a LinkedIn Developer App

1. Go to [developer.linkedin.com/apps](https://developer.linkedin.com/apps)
2. Click **"Create app"**
3. Fill in the required fields:
   - **App name**: e.g. `My LinkedIn MCP`
   - **LinkedIn Page**: You need a LinkedIn company page linked — create a simple one at [linkedin.com/company/setup/new](https://www.linkedin.com/company/setup/new/) if you don't have one
   - **App logo**: Upload any image (required)
4. Agree to the terms and click **"Create app"**

### Step 2 — Configure OAuth Redirect URL

1. In your new app, go to the **"Auth"** tab
2. Under **"OAuth 2.0 settings"**, find **"Authorized redirect URLs for your app"**
3. Click **"Add redirect URL"** and enter exactly:
   ```
   http://127.0.0.1:3000/callback
   ```
4. Click **"Update"**
5. Copy your **Client ID** and **Client Secret** from this page — you'll need them next

### Step 3 — Request API Products

1. Go to the **"Products"** tab in your app
2. Request access to both of these products:
   - **Sign In with LinkedIn using OpenID Connect** — click "Request access" → Select → Agree
   - **Share on LinkedIn** — click "Request access" → Select → Agree
3. Both are typically approved instantly for personal use

### Step 4 — Install & Configure

```bash
# Install globally
pnpm add -g @dev-hitesh-gupta/linkedin-mcp-server

# Create config directory and add your credentials
mkdir -p ~/.linkedin-mcp
cat > ~/.linkedin-mcp/credentials.json << 'EOF'
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
EOF

# Authenticate — opens browser for LinkedIn sign-in
linkedin-mcp-server auth
```

Your access token is saved to `~/.linkedin-mcp/token.json` and valid for 60 days.

### Step 5 — Add to Claude Code

```bash
claude mcp add linkedin -- pnpm dlx @dev-hitesh-gupta/linkedin-mcp-server
```

Or manually in your Claude config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["@dev-hitesh-gupta/linkedin-mcp-server"]
    }
  }
}
```

---

## Usage Examples

**Create a post:**
```
Post to LinkedIn: "Just shipped a new open-source MCP server for LinkedIn automation! Check it out. #opensource #ai"
```

**Share an article:**
```
Share this article on LinkedIn: https://example.com/article
My commentary: "Great read on the future of AI tooling"
```

**Create an image post:**
```
Create a LinkedIn image post:
Text: "From messy component to scalable architecture"
imageSearchQuery: "software architecture diagram clean code"
hashtags: ["SoftwareArchitecture", "Refactoring", "CleanCode"]
```

**Control visibility:**

| Value | Who sees it |
|-------|-------------|
| `PUBLIC` | Everyone on LinkedIn (default) |
| `CONNECTIONS` | Your 1st-degree connections only |
| `LOGGED_IN` | Any logged-in LinkedIn member |

---

## Automated Niche Posting (Every 3 Days)

The project now includes an auto-post workflow that:

- Finds relevant trending articles for your niche from public news feeds
- Scores and selects the best recent candidate
- Avoids reposting the same article (history file)
- Publishes one LinkedIn article post automatically

### 1) Configure your niche

Run this once:

```bash
pnpm build
pnpm autopost:dry-run
```

On first run, a template config is created at:

`~/.linkedin-mcp/automation.json`

Fill it with your niche and keywords, for example:

```json
{
  "niche": "AI Automation For SMB Operations",
  "keywords": [
    "ai automation",
    "workflow automation",
    "small business operations"
  ],
  "audience": "Founders and operations leaders",
  "postLanguage": "es",
  "visibility": "PUBLIC",
  "hashtags": ["AI", "Automation", "BusinessGrowth"],
  "maxArticleAgeHours": 96,
  "itemsPerKeyword": 8,
  "market": "en-US"
}
```

### 2) Run a single automatic post

```bash
pnpm autopost
```

### 3) Install cron (every 3 days)

Installs a managed cron entry that runs every 3 days at 09:00:

```bash
pnpm autopost:cron:install
```

Custom time:

```bash
pnpm autopost:cron:install -- --hour=9 --minute=30
```

Remove cron entry:

```bash
pnpm autopost:cron:remove
```

Automation files:

- Config: `~/.linkedin-mcp/automation.json`
- History: `~/.linkedin-mcp/automation-history.json`
- Cron logs: `~/.linkedin-mcp/autopost.log`

---

## Re-authentication

LinkedIn tokens expire after **60 days**. Re-authenticate when needed:

```bash
rm ~/.linkedin-mcp/token.json
linkedin-mcp-server auth
```

---

## Data & Auth Storage

All data is stored locally:

```
~/.linkedin-mcp/
├── credentials.json    # Your LinkedIn app Client ID + Secret
└── token.json          # OAuth access token (expires in 60 days)
```

> **Security:** Never commit these files to version control.

---

## Troubleshooting

**"Not authenticated" error:**
```bash
linkedin-mcp-server auth
```

**"Unable to determine member URN":**
Ensure the **Sign In with LinkedIn using OpenID Connect** product is approved in your app's Products tab.

**Post creation fails:**
Ensure the **Share on LinkedIn** product is approved. Check the Products tab in your LinkedIn Developer app.

**"Access blocked" during sign-in:**
Your LinkedIn app may still be under review. Check the Products tab for approval status.

**Token expired:**
```bash
rm ~/.linkedin-mcp/token.json && linkedin-mcp-server auth
```

**`linkedin_get_posts` or `linkedin_get_connections_count` returns errors:**
These tools use LinkedIn API endpoints that require elevated permissions not available with standard developer access. This is a LinkedIn API restriction.

---

## Requirements

- Node.js 18+
- A LinkedIn account
- LinkedIn Developer App with OAuth credentials (see setup above)

## License

MIT — [Hitesh Gupta](https://github.com/dev-hitesh-gupta)

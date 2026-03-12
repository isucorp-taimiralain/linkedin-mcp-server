import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { URL } from "url";

// LinkedIn OAuth settings
const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

// Scopes for LinkedIn API
// openid, profile, email - for Sign In with LinkedIn (OpenID Connect)
// w_member_social - for posting content
const SCOPES = ["openid", "profile", "email", "w_member_social"];

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".linkedin-mcp"
);
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");

export interface Credentials {
  client_id: string;
  client_secret: string;
  redirect_uri?: string;
  google_api_key?: string;
}

export interface TokenData {
  access_token: string;
  expires_in: number;
  expires_at: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  sub?: string;
  name?: string;
  email?: string;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadCredentials(): Credentials | null {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const content = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    console.error("Error loading credentials:", error);
  }
  return null;
}

export function loadToken(): TokenData | null {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const content = fs.readFileSync(TOKEN_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    console.error("Error loading token:", error);
  }
  return null;
}

function saveToken(token: TokenData): void {
  ensureConfigDir();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function isAuthenticated(): boolean {
  const token = loadToken();
  if (!token) return false;

  // Check if token is expired
  if (token.expires_at && Date.now() >= token.expires_at) {
    return false;
  }

  return true;
}

export function getAccessToken(): string | null {
  const token = loadToken();
  if (!token) return null;

  // Check if token is expired
  if (token.expires_at && Date.now() >= token.expires_at) {
    console.error("Token expired. Please run 'pnpm auth' to re-authenticate.");
    return null;
  }

  return token.access_token;
}

export function getGoogleApiKey(): string | null {
  const credentials = loadCredentials();
  return credentials?.google_api_key ?? null;
}

export function getUserInfo(): { sub?: string; name?: string; email?: string } | null {
  const token = loadToken();
  if (!token) return null;
  return {
    sub: token.sub,
    name: token.name,
    email: token.email,
  };
}

async function exchangeCodeForToken(
  code: string,
  credentials: Credentials,
  redirectUri: string
): Promise<TokenData> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    redirect_uri: redirectUri,
  });

  const response = await fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokenData = await response.json();

  // Calculate expiration timestamp
  const expiresAt = Date.now() + tokenData.expires_in * 1000;

  return {
    ...tokenData,
    expires_at: expiresAt,
  };
}

async function fetchUserInfo(accessToken: string): Promise<{ sub?: string; name?: string; email?: string }> {
  // Try userinfo endpoint first (OpenID Connect)
  try {
    const response = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      return {
        sub: data.sub,
        name: data.name,
        email: data.email,
      };
    }
  } catch (error) {
    console.error("Failed to fetch userinfo:", error);
  }

  // Fallback to REST /me endpoint
  try {
    const response = await fetch("https://api.linkedin.com/rest/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": "202401",
      },
    });

    if (response.ok) {
      const data = await response.json();
      return {
        sub: data.sub || data.id,
        name: data.name || data.localizedFirstName,
      };
    }
  } catch (error) {
    console.error("Failed to fetch /me:", error);
  }

  return {};
}

export async function authenticateInteractive(): Promise<TokenData> {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new Error(
      `Credentials not found. Please create ${CREDENTIALS_PATH} with your LinkedIn OAuth credentials.\n\n` +
        `Example:\n` +
        `{\n` +
        `  "client_id": "your_client_id",\n` +
        `  "client_secret": "your_client_secret"\n` +
        `}`
    );
  }

  const redirectUri = credentials.redirect_uri || "http://127.0.0.1:3000/callback";

  // Parse redirect URI to get port and path
  const parsedRedirectUri = new URL(redirectUri);
  const callbackPort = parseInt(parsedRedirectUri.port) || 3000;
  const callbackPath = parsedRedirectUri.pathname || "/callback";
  const callbackHost = parsedRedirectUri.hostname || "127.0.0.1";

  // Build authorization URL
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: credentials.client_id,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state: Math.random().toString(36).substring(7),
  });

  const authUrl = `${LINKEDIN_AUTH_URL}?${authParams.toString()}`;

  console.log("\nAuthorize this app by visiting this URL:\n");
  console.log(authUrl);
  console.log("\nWaiting for authorization...\n");

  // Start local server to receive callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "", `http://${callbackHost}:${callbackPort}`);
        if (url.pathname === callbackPath) {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(
              `<html><body><h1>Error</h1><p>${error}: ${url.searchParams.get("error_description")}</p></body></html>`
            );
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              "<html><body><h1>Authentication successful!</h1><p>You can close this window and return to the terminal.</p></body></html>"
            );
            server.close();
            resolve(code);
          } else {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(
              "<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>"
            );
            reject(new Error("No authorization code received"));
          }
        }
      } catch (error) {
        reject(error);
      }
    });

    server.listen(callbackPort, callbackHost, () => {
      console.log(`Listening on http://${callbackHost}:${callbackPort} for OAuth callback...`);
    });

    // Open browser automatically
    import("open").then((open) => {
      open.default(authUrl);
    });
  });

  // Exchange code for token
  const tokenData = await exchangeCodeForToken(code, credentials, redirectUri);

  // Fetch user info and add to token data
  const userInfo = await fetchUserInfo(tokenData.access_token);
  tokenData.sub = userInfo.sub;
  tokenData.name = userInfo.name;
  tokenData.email = userInfo.email;

  // Save token
  saveToken(tokenData);

  console.log("\nAuthentication successful!");
  console.log(`Logged in as: ${tokenData.name || tokenData.email || tokenData.sub || "Unknown"}`);
  console.log(`Token saved to: ${TOKEN_PATH}`);
  console.log(`Token expires: ${new Date(tokenData.expires_at).toLocaleString()}`);

  return tokenData;
}

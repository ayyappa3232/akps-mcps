import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveProjectPath } from "../utils/projectResolver.js";

/* -------------------------------------------------------------------------- */
/*  Report types                                                              */
/* -------------------------------------------------------------------------- */

type Severity = "critical" | "high" | "medium" | "low" | "info";
type Confidence = "high" | "medium" | "low";

/**
 * strict   - known provider formats, private keys, connection strings, JWTs.
 * balanced - strict plus passwords and keyword assignments such as `apiKey = "..."`.
 * thorough - balanced plus long random-looking strings.
 */
type Sensitivity = "strict" | "balanced" | "thorough";

type SecretCategory =
  | "provider-key"
  | "token"
  | "credential"
  | "private-key"
  | "generic"
  | "sensitive-file";

/**
 * committed - the file is tracked by git.
 * untracked - the file is in a git repository, is not tracked, and is not ignored.
 * ignored   - the file is not tracked and is covered by .gitignore.
 * unknown   - no git repository was found.
 */
type Exposure = "committed" | "untracked" | "ignored" | "unknown";

interface SecretLocation {
  filePath: string;
  line: number;
  /** The source line with every detected value replaced by a mask. */
  lineText: string;
  exposure: Exposure;
  severity: Severity;
  isTest: boolean;
  isDoc: boolean;
  isEnvFile: boolean;
}

interface SecretRemediation {
  title: string;
  summary: string;
  steps: string[];
  /** Before and after example. The "before" line is already masked. */
  code?: string;
  caveats: string[];
}

interface SecretFinding {
  /** Stable within one report. Not derived from the secret in a way that can be reversed. */
  id: string;
  ruleId: string;
  name: string;
  provider?: string;
  category: SecretCategory;
  severity: Severity;
  confidence: Confidence;
  /** Masked preview. Never the full value. */
  masked: string;
  /** Length of the secret in characters. 0 for sensitive files. */
  length: number;
  /** Shannon entropy in bits per character. 0 for sensitive files. */
  entropy: number;
  description: string;
  /** Extra detail such as "expired JWT" or "common development default". */
  note?: string;
  exposure: Exposure;
  committed: boolean;
  locations: SecretLocation[];
  hiddenLocations: number;
  locationCount: number;
  fileCount: number;
  remediation: SecretRemediation;
}

interface FileHotspot {
  filePath: string;
  count: number;
  topSeverity: Severity;
  committed: boolean;
}

interface Safeguards {
  gitRepository: boolean;
  /** True when a typical `.env` path is covered by .gitignore. */
  envFilesIgnored: boolean;
  preCommitScanner: boolean;
  ciScanner: boolean;
}

interface SecretReport {
  success: boolean;
  tool: "detect_secrets";
  projectPath: string;
  filePath?: string;
  sensitivity: Sensitivity;
  includeTests: boolean;
  /** Always true. Reports never contain a full secret value. */
  redacted: true;
  filesScanned: number;
  filesSkipped: number;
  bytesScanned: number;
  gitDetected: boolean;
  /** False when the git index could not be read, so "committed" is a best guess. */
  gitTrackingKnown: boolean;
  totalSecrets: number;
  totalLocations: number;
  committedCount: number;
  criticalHighCount: number;
  sensitiveFileCount: number;
  /** Sensitive files such as .env that are correctly ignored. Not reported as findings. */
  safeSensitiveFiles: number;
  summary: Record<Severity, number>;
  categoryCounts: Record<SecretCategory, number>;
  findings: SecretFinding[];
  hotspots: FileHotspot[];
  safeguards: Safeguards;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Internal types                                                            */
/* -------------------------------------------------------------------------- */

interface RuleMeta {
  id: string;
  name: string;
  provider?: string;
  category: SecretCategory;
  severity: Severity;
  confidence: Confidence;
  tier: Sensitivity;
  description: string;
  /** Provider-specific revoke or rotate instruction. */
  revoke?: string;
  /** Environment variable name used in suggested fixes. */
  envName?: string;
  /** Characters of the value that stay visible in the mask. */
  keep?: number;
}

interface PatternRule extends RuleMeta {
  regex: RegExp;
  /** Capture group that holds the secret. The secret must be the last thing in the match. */
  group?: number;
  /** Cheap substring test. The regex only runs when one of these is present. */
  hint?: string[];
  validate?: (value: string, line: string) => boolean;
}

interface Candidate {
  start: number;
  end: number;
  ruleId: string;
  priority: number;
  value: string;
  key?: string;
  note?: string;
  severity?: Severity;
  /** Replaces the default mask in the displayed line. */
  display?: string;
}

interface FileContext {
  filePath: string;
  exposure: Exposure;
  isTest: boolean;
  isDoc: boolean;
  isTemplate: boolean;
  isEnvLike: boolean;
  extension: string;
}

interface Group {
  fingerprint: string;
  meta: RuleMeta;
  priority: number;
  masked: string;
  length: number;
  entropy: number;
  note?: string;
  locations: SecretLocation[];
  keyNames: Set<string>;
  confidence: Confidence;
}

interface IgnoreRule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

interface IgnoreFile {
  dirAbs: string;
  rules: IgnoreRule[];
}

interface SourceEntry {
  abs: string;
  rel: string;
  size: number;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "out",
  ".vite",
  "vendor",
  "bower_components",
  ".yarn",
  ".pnpm-store",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".terraform",
  "generated-diagrams",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".ogg",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".jar", ".war", ".class",
  ".dll", ".exe", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".wasm", ".map", ".psd", ".ai", ".p12", ".pfx", ".jks", ".keystore",
]);

const LOCK_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
  "bun.lockb",
]);

const TEST_PATH_PATTERN =
  /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|e2e|cypress|fixtures?|mocks?|stories)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/i;

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);

const ENV_LIKE_EXTENSIONS = new Set([
  ".env",
  ".properties",
  ".ini",
  ".conf",
  ".cfg",
  ".toml",
  ".yml",
  ".yaml",
  ".sh",
  ".bash",
  ".zsh",
  ".tfvars",
]);

const TEMPLATE_PATTERN = /\.(example|sample|template|dist|defaults?)$|(^|[._-])(example|sample|template)([._-]|$)/i;

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_LENGTH = 4_000;
const MAX_FINDINGS = 500;
const MAX_LOCATIONS_PER_FINDING = 25;
const MAX_ENTROPY_FINDINGS = 150;
const MAX_HOTSPOTS = 12;
const MAX_WARNINGS = 25;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const CONFIDENCE_ORDER: Confidence[] = ["high", "medium", "low"];
const EXPOSURE_RANK: Record<Exposure, number> = {
  committed: 0,
  untracked: 1,
  unknown: 2,
  ignored: 3,
};

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  strict: 0,
  balanced: 1,
  thorough: 2,
};

const PRIORITY = {
  entropy: 0,
  keyword: 1,
  token: 2,
  provider: 3,
} as const;

/* -------------------------------------------------------------------------- */
/*  Rules                                                                     */
/* -------------------------------------------------------------------------- */

function provider(
  id: string,
  name: string,
  providerName: string,
  regex: string,
  options: {
    severity?: Severity;
    confidence?: Confidence;
    group?: number;
    hint?: string[];
    keep?: number;
    envName: string;
    description: string;
    revoke: string;
    flags?: string;
    validate?: PatternRule["validate"];
  }
): PatternRule {
  return {
    id,
    name,
    provider: providerName,
    category: "provider-key",
    severity: options.severity ?? "critical",
    confidence: options.confidence ?? "high",
    tier: "strict",
    regex: new RegExp(regex, options.flags ?? "g"),
    group: options.group,
    hint: options.hint,
    keep: options.keep,
    envName: options.envName,
    description: options.description,
    revoke: options.revoke,
    validate: options.validate,
  };
}

const PATTERN_RULES: PatternRule[] = [
  provider("aws-access-key", "AWS access key ID", "AWS", "\\b((?:AKIA|ASIA)[0-9A-Z]{16})\\b", {
    group: 1,
    hint: ["AKIA", "ASIA"],
    keep: 4,
    envName: "AWS_ACCESS_KEY_ID",
    description:
      "AWS access key IDs identify an IAM user or role. Together with the secret key they allow API calls to your AWS account.",
    revoke:
      "In the AWS console open IAM, find the user, and under Security credentials make this access key inactive, then delete it. Create a new key and update your deployment.",
  }),
  provider(
    "aws-secret-key",
    "AWS secret access key",
    "AWS",
    "(?:aws_?secret_?(?:access_?)?key|secret_?access_?key)[\"']?\\s*[:=]\\s*[\"']?([A-Za-z0-9/+=]{40})\\b",
    {
      group: 1,
      flags: "gi",
      hint: ["ecret"],
      keep: 0,
      envName: "AWS_SECRET_ACCESS_KEY",
      description:
        "An AWS secret access key signs API requests. Anyone with it, plus the access key ID, can act as that IAM identity.",
      revoke:
        "In IAM, deactivate and delete the access key this secret belongs to, then issue a new pair. Review CloudTrail for use of the old key.",
    }
  ),
  provider("github-token", "GitHub token", "GitHub", "\\b(gh[pousr]_[A-Za-z0-9]{36,255})\\b", {
    group: 1,
    hint: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    keep: 4,
    envName: "GITHUB_TOKEN",
    description:
      "GitHub tokens grant API access with the permissions of the account or app that created them.",
    revoke:
      "In GitHub open Settings, Developer settings, Personal access tokens, and delete this token. For an app or Actions token, revoke it from the app settings and create a new one.",
  }),
  provider(
    "github-fine-grained",
    "GitHub fine-grained token",
    "GitHub",
    "\\b(github_pat_[A-Za-z0-9_]{50,255})\\b",
    {
      group: 1,
      hint: ["github_pat_"],
      keep: 11,
      envName: "GITHUB_TOKEN",
      description:
        "Fine-grained GitHub personal access tokens grant repository access as the user who created them.",
      revoke:
        "In GitHub open Settings, Developer settings, Fine-grained tokens, and delete this token, then create a replacement with the least access you need.",
    }
  ),
  provider("gitlab-token", "GitLab personal access token", "GitLab", "\\b(glpat-[A-Za-z0-9_-]{20,})\\b", {
    group: 1,
    hint: ["glpat-"],
    keep: 6,
    envName: "GITLAB_TOKEN",
    description: "GitLab personal access tokens give API access as the user who created them.",
    revoke: "In GitLab open User settings, Access tokens, and revoke this token, then create a new one.",
  }),
  provider("slack-token", "Slack token", "Slack", "\\b(xox[abprs]-[A-Za-z0-9-]{10,})\\b", {
    group: 1,
    hint: ["xox"],
    keep: 5,
    envName: "SLACK_BOT_TOKEN",
    description: "Slack tokens let the holder read or post messages in the workspace, depending on their scopes.",
    revoke: "In the Slack app settings under OAuth & Permissions, revoke or rotate the token and reinstall the app.",
  }),
  provider(
    "slack-webhook",
    "Slack incoming webhook",
    "Slack",
    "(https://hooks\\.slack\\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+)",
    {
      group: 1,
      severity: "high",
      hint: ["hooks.slack.com"],
      keep: 0,
      envName: "SLACK_WEBHOOK_URL",
      description: "Anyone with a Slack webhook URL can post messages into the channel it belongs to.",
      revoke: "In the Slack app settings under Incoming Webhooks, remove this webhook and add a new one.",
    }
  ),
  provider("stripe-live", "Stripe live secret key", "Stripe", "\\b([sr]k_live_[A-Za-z0-9]{20,})\\b", {
    group: 1,
    hint: ["_live_"],
    keep: 8,
    envName: "STRIPE_SECRET_KEY",
    description: "A live Stripe secret key can create charges, refund payments, and read customer data.",
    revoke: "In the Stripe dashboard open Developers, API keys, and roll this key. Stripe lets you set an expiry for the old one.",
  }),
  provider("stripe-test", "Stripe test secret key", "Stripe", "\\b(sk_test_[A-Za-z0-9]{20,})\\b", {
    group: 1,
    severity: "low",
    hint: ["sk_test_"],
    keep: 8,
    envName: "STRIPE_SECRET_KEY",
    description: "A Stripe test key only touches test data, but it still should not live in source control.",
    revoke: "In the Stripe dashboard open Developers, API keys, and roll the test key.",
  }),
  provider("stripe-webhook", "Stripe webhook signing secret", "Stripe", "\\b(whsec_[A-Za-z0-9]{24,})\\b", {
    group: 1,
    severity: "high",
    hint: ["whsec_"],
    keep: 6,
    envName: "STRIPE_WEBHOOK_SECRET",
    description: "The signing secret lets someone forge webhook events that your server will trust.",
    revoke: "In the Stripe dashboard open the webhook endpoint and roll its signing secret.",
  }),
  provider("google-api-key", "Google API key", "Google", "\\b(AIza[0-9A-Za-z_-]{35})\\b", {
    group: 1,
    severity: "medium",
    hint: ["AIza"],
    keep: 4,
    envName: "GOOGLE_API_KEY",
    description:
      "Google API keys are often used in browsers and may be public by design. They are risky when unrestricted, because anyone can run up your quota or billing.",
    revoke:
      "In Google Cloud Console open APIs & Services, Credentials, restrict the key by HTTP referrer or IP and API, or delete it and create a new one.",
  }),
  provider("google-oauth-secret", "Google OAuth client secret", "Google", "\\b(GOCSPX-[A-Za-z0-9_-]{28})\\b", {
    group: 1,
    severity: "high",
    hint: ["GOCSPX-"],
    keep: 7,
    envName: "GOOGLE_CLIENT_SECRET",
    description: "The client secret lets someone impersonate your OAuth application.",
    revoke: "In Google Cloud Console open Credentials, the OAuth client, and reset the secret.",
  }),
  provider("anthropic-key", "Anthropic API key", "Anthropic", "\\b(sk-ant-[A-Za-z0-9_-]{30,})\\b", {
    group: 1,
    hint: ["sk-ant-"],
    keep: 7,
    envName: "ANTHROPIC_API_KEY",
    description: "An Anthropic API key lets anyone make requests billed to your account.",
    revoke: "In the Anthropic Console open API keys and delete this key, then create a new one.",
  }),
  provider("openai-key", "OpenAI API key", "OpenAI", "\\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,})\\b", {
    group: 1,
    hint: ["sk-"],
    keep: 3,
    envName: "OPENAI_API_KEY",
    description: "An OpenAI API key lets anyone make requests billed to your account.",
    revoke: "In the OpenAI dashboard open API keys and revoke this key, then create a new one.",
    validate: (value) => !/^sk-ant-/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value),
  }),
  provider("huggingface-token", "Hugging Face token", "Hugging Face", "\\b(hf_[A-Za-z0-9]{34,})\\b", {
    group: 1,
    severity: "high",
    hint: ["hf_"],
    keep: 3,
    envName: "HF_TOKEN",
    description: "A Hugging Face token gives access to your models, datasets, and spaces.",
    revoke: "In Hugging Face open Settings, Access tokens, and delete this token.",
  }),
  provider("sendgrid-key", "SendGrid API key", "SendGrid", "\\b(SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43})\\b", {
    group: 1,
    hint: ["SG."],
    keep: 3,
    envName: "SENDGRID_API_KEY",
    description: "A SendGrid key can send email as your domain, which attackers use for phishing.",
    revoke: "In SendGrid open Settings, API Keys, and delete this key.",
  }),
  provider("twilio-key", "Twilio API key", "Twilio", "\\b(SK[0-9a-fA-F]{32})\\b", {
    group: 1,
    severity: "high",
    hint: ["SK"],
    keep: 2,
    envName: "TWILIO_API_KEY",
    description: "A Twilio API key SID is half of a credential pair that can send messages and place calls.",
    revoke: "In the Twilio console open Account, API keys & tokens, and delete this key.",
    validate: (value) => /[0-9]/.test(value) && /[a-fA-F]/.test(value.slice(2)),
  }),
  provider("mailgun-key", "Mailgun API key", "Mailgun", "\\b(key-[0-9a-f]{32})\\b", {
    group: 1,
    severity: "high",
    hint: ["key-"],
    keep: 4,
    envName: "MAILGUN_API_KEY",
    description: "A Mailgun key can send email as your domain.",
    revoke: "In Mailgun open API Security and regenerate the key.",
  }),
  provider("npm-token", "npm access token", "npm", "\\b(npm_[A-Za-z0-9]{36})\\b", {
    group: 1,
    hint: ["npm_"],
    keep: 4,
    envName: "NPM_TOKEN",
    description: "An npm token can publish packages as you, which is how supply-chain attacks start.",
    revoke: "On npmjs.com open Access Tokens and revoke this token.",
  }),
  provider("pypi-token", "PyPI upload token", "PyPI", "\\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})\\b", {
    group: 1,
    hint: ["pypi-"],
    keep: 5,
    envName: "PYPI_TOKEN",
    description: "A PyPI token can upload releases of your packages.",
    revoke: "On pypi.org open Account settings, API tokens, and remove this token.",
  }),
  provider("shopify-token", "Shopify access token", "Shopify", "\\b(shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32})\\b", {
    group: 1,
    hint: ["shp"],
    keep: 6,
    envName: "SHOPIFY_ACCESS_TOKEN",
    description: "A Shopify token gives access to the store's admin API.",
    revoke: "In the Shopify admin open the app or custom app and rotate its API credentials.",
  }),
  provider("digitalocean-token", "DigitalOcean token", "DigitalOcean", "\\b(do[opr]_v1_[a-f0-9]{64})\\b", {
    group: 1,
    hint: ["_v1_"],
    keep: 7,
    envName: "DIGITALOCEAN_TOKEN",
    description: "A DigitalOcean token can create, change, and delete your cloud resources.",
    revoke: "In the DigitalOcean control panel open API, Tokens, and delete this token.",
  }),
  provider(
    "discord-bot-token",
    "Discord bot token",
    "Discord",
    "\\b([MNO][A-Za-z\\d_-]{23,25}\\.[A-Za-z\\d_-]{6}\\.[A-Za-z\\d_-]{27,38})\\b",
    {
      group: 1,
      severity: "high",
      hint: ["."],
      keep: 4,
      envName: "DISCORD_BOT_TOKEN",
      description: "A Discord bot token lets someone control the bot and everything it can access.",
      revoke: "In the Discord developer portal open the bot page and reset the token.",
      validate: (value) => !/^[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]+$/.test(value) && /[0-9]/.test(value),
    }
  ),
  provider("telegram-bot-token", "Telegram bot token", "Telegram", "\\b(\\d{8,10}:[A-Za-z0-9_-]{35})\\b", {
    group: 1,
    severity: "high",
    hint: [":"],
    keep: 4,
    envName: "TELEGRAM_BOT_TOKEN",
    description: "A Telegram bot token gives full control of the bot.",
    revoke: "Message BotFather, choose the bot, and use /revoke to issue a new token.",
  }),
  provider("azure-storage-key", "Azure storage account key", "Azure", "AccountKey=([A-Za-z0-9+/=]{60,})", {
    group: 1,
    hint: ["AccountKey="],
    keep: 0,
    envName: "AZURE_STORAGE_KEY",
    description: "A storage account key gives full access to every blob, queue, and table in the account.",
    revoke: "In the Azure portal open the storage account, Access keys, and rotate the key.",
  }),
  provider("firebase-server-key", "Firebase Cloud Messaging server key", "Firebase", "\\b(AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140})\\b", {
    group: 1,
    severity: "high",
    hint: ["AAAA"],
    keep: 4,
    envName: "FCM_SERVER_KEY",
    description: "A legacy FCM server key can send push notifications to your users.",
    revoke: "In the Firebase console open Project settings, Cloud Messaging, and migrate to the HTTP v1 API, then delete the legacy key.",
  }),
  provider("npmrc-auth-token", "npm registry auth token", "npm", "_authToken\\s*=\\s*([A-Za-z0-9._~+/=-]{16,})", {
    group: 1,
    severity: "high",
    hint: ["_authToken"],
    keep: 0,
    envName: "NPM_TOKEN",
    description: "A registry auth token in .npmrc lets someone install private packages or publish as you.",
    revoke: "On your registry, revoke this token and create a new one. Reference it in .npmrc as ${NPM_TOKEN}.",
  }),
];

const GENERIC_META: Record<string, RuleMeta> = {
  "private-key": {
    id: "private-key",
    name: "Private key",
    category: "private-key",
    severity: "critical",
    confidence: "high",
    tier: "strict",
    keep: 0,
    envName: "PRIVATE_KEY",
    description:
      "A private key proves identity. Anyone who has it can decrypt traffic, sign data, or log in as the owner.",
    revoke:
      "Generate a new key pair, replace the public key wherever the old one was trusted (servers, certificate authority, cloud provider), and revoke the old key.",
  },
  "connection-string": {
    id: "connection-string",
    name: "Credentials in a connection string",
    category: "credential",
    severity: "high",
    confidence: "high",
    tier: "strict",
    keep: 0,
    envName: "DATABASE_URL",
    description:
      "The URL contains a username and password. Anyone who can read the code can connect to that service.",
    revoke: "Change the password on the database or service, then update the URL wherever it is used.",
  },
  jwt: {
    id: "jwt",
    name: "JSON Web Token",
    category: "token",
    severity: "medium",
    confidence: "medium",
    tier: "strict",
    keep: 3,
    envName: "AUTH_TOKEN",
    description:
      "A JWT is a signed login token. If it has not expired, whoever holds it can act as the user it was issued to.",
    revoke:
      "Revoke the session or refresh token that issued it, and rotate the signing secret if the token is long-lived.",
  },
  "bearer-token": {
    id: "bearer-token",
    name: "Hard-coded authorization header",
    category: "token",
    severity: "high",
    confidence: "medium",
    tier: "strict",
    keep: 0,
    envName: "API_TOKEN",
    description: "An Authorization header with a fixed token gives its holder the same API access as the code.",
    revoke: "Revoke the token with the service that issued it and create a new one.",
  },
  "keyword-secret": {
    id: "keyword-secret",
    name: "Hard-coded secret",
    category: "generic",
    severity: "medium",
    confidence: "medium",
    tier: "balanced",
    keep: 0,
    envName: "SECRET",
    description:
      "A value is assigned to a variable or setting whose name suggests a password, key, or token.",
    revoke: "Change the password or regenerate the key or token with whatever service it belongs to.",
  },
  "keyword-password": {
    id: "keyword-password",
    name: "Hard-coded password",
    category: "credential",
    severity: "high",
    confidence: "medium",
    tier: "balanced",
    keep: 0,
    envName: "PASSWORD",
    description: "A password is written directly in a file that is shared with everyone who can read the project.",
    revoke: "Change the password on the system it belongs to.",
  },
  "entropy-string": {
    id: "entropy-string",
    name: "High-entropy string",
    category: "generic",
    severity: "low",
    confidence: "low",
    tier: "thorough",
    keep: 0,
    envName: "SECRET",
    description:
      "A long random-looking string was found. It could be a key or token, or it could be an identifier or hash that is safe to share.",
    revoke: "If this is a real secret, regenerate it with the service that issued it.",
  },
  "sensitive-file": {
    id: "sensitive-file",
    name: "Sensitive file in the project",
    category: "sensitive-file",
    severity: "high",
    confidence: "high",
    tier: "strict",
    keep: 0,
    envName: "SECRET",
    description: "This kind of file normally holds credentials and should not be in version control.",
    revoke: "Rotate every credential stored in the file.",
  },
};

const RULE_META = new Map<string, RuleMeta>([
  ...PATTERN_RULES.map((rule): [string, RuleMeta] => [rule.id, rule]),
  ...Object.entries(GENERIC_META),
]);

const KEYWORD_SOURCE =
  "pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?(?:token|key|secret)|credentials?|signing[_-]?key|encryption[_-]?key|client[_-]?secret";

const QUOTED_ASSIGN = new RegExp(
  `([A-Za-z0-9_.\\-]{0,40}(?:${KEYWORD_SOURCE})[A-Za-z0-9_.\\-]{0,24})["']?\\s*(?::=|=>|[:=])\\s*(["'\`])((?:(?!\\2)[^\\r\\n]){6,200}?)\\2`,
  "gi"
);

const UNQUOTED_ASSIGN = new RegExp(
  `^\\s*(?:export\\s+)?([A-Za-z0-9_.\\-]*(?:${KEYWORD_SOURCE})[A-Za-z0-9_.\\-]*)\\s*[:=]\\s*([^\\s#"'\`$\\{\\[<%!*&|>][^\\s#]{5,199})`,
  "i"
);

const CONNECTION_STRING = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:@/'"`<>]{1,64}):([^\s@/'"`<>]{3,128})@([^\s/'"`<>?#]+)/gi;

const JWT_PATTERN = /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

const BEARER_PATTERN =
  /(?:authorization|auth)["']?\s*[:=]\s*["'`]?\s*(?:bearer|token|basic)\s+([A-Za-z0-9._~+/=-]{20,})/gi;

const STRING_LITERAL = /(["'`])([A-Za-z0-9+/=_-]{28,128})\1/g;

const IGNORE_MARKER = /pragma:\s*allowlist\s*secret|gitleaks:allow|secret-detector:ignore|nosecret|noqa:\s*secret/i;

const EXCLUDED_KEY_SUFFIX = new Set([
  "label", "placeholder", "hint", "text", "title", "message", "error", "errors",
  "type", "name", "field", "input", "prompt", "description", "length", "min", "max",
  "required", "regex", "pattern", "strength", "policy", "confirm", "expires", "expiry",
  "ttl", "endpoint", "url", "uri", "path", "header", "prefix", "count", "id", "ref",
  "env", "var", "variable",
]);

const COMMON_PLACEHOLDER_WORDS = new Set([
  "password", "passwd", "pass", "secret", "token", "apikey", "api_key", "changeme",
  "change_me", "null", "undefined", "none", "true", "false", "string", "example",
  "default", "test", "testing", "dummy", "sample", "placeholder", "redacted",
  "todo", "tbd", "xxx", "required", "optional", "empty",
]);

const DEV_DEFAULT_PASSWORDS = new Set([
  "postgres", "root", "admin", "password", "pass", "123456", "guest", "mysql",
  "user", "test", "secret", "changeme", "dev", "development",
]);

const DEV_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|db|database|postgres|mysql|mongo|mongodb|redis|rabbitmq|host\.docker\.internal)(:\d+)?$/i;

const SENSITIVE_FILE_RULES: Array<{
  test: (base: string, rel: string) => boolean;
  label: string;
  severity: Severity;
  what: string;
}> = [
  {
    test: (base) => /^\.env(\..+)?$/i.test(base) && !TEMPLATE_PATTERN.test(base),
    label: "Environment file",
    severity: "high",
    what: "environment variables, which usually include passwords and API keys",
  },
  {
    test: (base) => base === ".envrc",
    label: "direnv file",
    severity: "high",
    what: "environment variables, which usually include passwords and API keys",
  },
  {
    test: (base) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base),
    label: "SSH private key",
    severity: "critical",
    what: "an SSH private key that can log in to servers",
  },
  {
    test: (base) => /\.(p12|pfx|jks|keystore)$/i.test(base),
    label: "Key store",
    severity: "critical",
    what: "a certificate and private key bundle",
  },
  {
    test: (base) => base === ".htpasswd" || base === ".netrc" || base === ".pgpass" || base === ".dockercfg",
    label: "Credentials file",
    severity: "high",
    what: "stored logins",
  },
  {
    test: (_base, rel) => /(^|\/)\.aws\/credentials$/.test(rel) || /(^|\/)\.docker\/config\.json$/.test(rel),
    label: "Cloud or registry credentials",
    severity: "critical",
    what: "stored cloud or container registry logins",
  },
  {
    test: (base) => /^terraform\.tfstate(\.backup)?$/.test(base),
    label: "Terraform state",
    severity: "high",
    what: "infrastructure state, which often contains passwords and keys in plain text",
  },
  {
    test: (base) => /\.tfvars$/i.test(base) && !TEMPLATE_PATTERN.test(base),
    label: "Terraform variables",
    severity: "medium",
    what: "variable values that frequently include secrets",
  },
  {
    test: (base) =>
      /^(serviceAccountKey|service-account.*|.*-credentials|client_secret.*|secrets?)\.(json|ya?ml)$/i.test(base),
    label: "Credentials file",
    severity: "high",
    what: "service credentials",
  },
];

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function downgrade(severity: Severity, steps: number): Severity {
  const index = SEVERITY_ORDER.indexOf(severity) + steps;
  return SEVERITY_ORDER[Math.min(index, SEVERITY_ORDER.length - 1)];
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

function shannon(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }

  return Math.round(entropy * 100) / 100;
}

function uniqueRatio(value: string): number {
  return new Set(value).size / Math.max(1, value.length);
}

function maskValue(value: string, keep: number): string {
  const visible = Math.min(keep, Math.max(0, value.length - 8));
  return `${value.slice(0, visible)}${"•".repeat(8)}`;
}

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function toEnvName(key: string | undefined, fallback: string): string {
  if (!key) return fallback;
  const parts = words(key);
  if (parts.length === 0) return fallback;
  return parts.join("_").toUpperCase();
}

function toCamel(envName: string): string {
  const parts = envName.toLowerCase().split("_").filter(Boolean);
  return parts
    .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("");
}

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();

  if (COMMON_PLACEHOLDER_WORDS.has(lower)) return true;
  if (/^[x*•._\-#0]+$/i.test(value)) return true;
  if (/example|placeholder|your[_-]|<[^>]*>|\$\{|\{\{|%s|%\(|changeme|change[_-]me|replace[_-]?me|redacted|dummy|fake|insert[_-]|xxxx|todo/i.test(value)) {
    return true;
  }
  if (/^(process\.env|import\.meta|os\.environ|os\.getenv|env\.|config\.|settings\.|getenv)/i.test(value)) {
    return true;
  }
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*\(.*\)$/.test(value)) return true;
  if (value.length >= 8 && uniqueRatio(value) < 0.2) return true;

  return false;
}

function isLikelyPath(value: string): boolean {
  return (
    /^(https?:)?\/\//i.test(value) ||
    /^[./~]/.test(value) ||
    (/\//.test(value) && /\.[a-z]{1,5}$/i.test(value))
  );
}

function fileContextFor(rel: string, exposure: Exposure): FileContext {
  const base = path.posix.basename(rel);
  const extension = path.posix.extname(base).toLowerCase();
  const isEnvBase = /^\.env/i.test(base);

  return {
    filePath: rel,
    exposure,
    isTest: TEST_PATH_PATTERN.test(rel),
    isDoc: DOC_EXTENSIONS.has(extension),
    isTemplate: TEMPLATE_PATTERN.test(base),
    isEnvLike:
      isEnvBase ||
      ENV_LIKE_EXTENSIONS.has(extension) ||
      base === "Dockerfile" ||
      base.startsWith("docker-compose"),
    extension: isEnvBase ? ".env" : extension,
  };
}

/* -------------------------------------------------------------------------- */
/*  .gitignore and git index                                                  */
/* -------------------------------------------------------------------------- */

function globToRegex(glob: string): string {
  let result = "";

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];

    if (char === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = glob[i + 2];

        if (before && after === "/") {
          result += "(?:.*/)?";
          i += 2;
        } else if (before && after === undefined) {
          result += ".*";
          i += 1;
        } else {
          result += "[^/]*";
          i += 1;
        }
      } else {
        result += "[^/]*";
      }
    } else if (char === "?") {
      result += "[^/]";
    } else if (char === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        result += "\\[";
      } else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        result += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if (char === "\\" && i + 1 < glob.length) {
      result += `\\${glob[i + 1]}`;
      i += 1;
    } else {
      result += char.replace(/[.+^${}()|\]\\]/g, "\\$&");
    }
  }

  return result;
}

function compileIgnoreRule(raw: string): IgnoreRule | null {
  let line = raw.replace(/\r$/, "");
  if (!line.trim() || line.startsWith("#")) return null;

  line = line.replace(/(?<!\\)\s+$/, "");

  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }

  if (!line) return null;

  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);

  try {
    const body = globToRegex(line);
    return {
      regex: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`),
      negate,
      dirOnly,
    };
  } catch {
    return null;
  }
}

function parseIgnoreFile(text: string): IgnoreRule[] {
  return text
    .split("\n")
    .map(compileIgnoreRule)
    .filter((rule): rule is IgnoreRule => rule !== null);
}

class GitIgnore {
  private readonly cache = new Map<string, boolean>();

  constructor(
    private readonly baseAbs: string,
    private readonly files: IgnoreFile[],
  ) {
    this.files.sort((a, b) => a.dirAbs.length - b.dirAbs.length);
  }

  private matchOne(candidateAbs: string, isDir: boolean): boolean {
    let ignored = false;

    for (const file of this.files) {
      const relative = path.relative(file.dirAbs, candidateAbs);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;

      const target = normalizePath(relative);
      if (!target) continue;

      for (const rule of file.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(target)) ignored = !rule.negate;
      }
    }

    return ignored;
  }

  /** A file is ignored when it, or any folder above it, is ignored. */
  isIgnored(abs: string): boolean {
    const cached = this.cache.get(abs);
    if (cached !== undefined) return cached;

    const relative = normalizePath(path.relative(this.baseAbs, abs));
    const segments = relative.split("/").filter(Boolean);
    let current = this.baseAbs;
    let result = false;

    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      const isDir = i < segments.length - 1;

      if (this.matchOne(current, isDir)) {
        result = true;
        break;
      }
    }

    this.cache.set(abs, result);
    return result;
  }
}

function findGitRoot(start: string): string | undefined {
  let current = start;

  for (let depth = 0; depth < 8; depth++) {
    try {
      if (fs.statSync(path.join(current, ".git")).isDirectory()) return current;
    } catch {
      // Keep looking upward.
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/** Reads the list of tracked paths from .git/index (versions 2 and 3). Paths are relative to the repository root. */
function readTrackedFiles(gitRoot: string): Set<string> | undefined {
  let buffer: Buffer;

  try {
    buffer = fs.readFileSync(path.join(gitRoot, ".git", "index"));
  } catch {
    return undefined;
  }

  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "DIRC") return undefined;

  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) return undefined;

  const count = buffer.readUInt32BE(8);
  const tracked = new Set<string>();
  let offset = 12;

  for (let i = 0; i < count; i++) {
    if (offset + 62 > buffer.length) return undefined;

    const flags = buffer.readUInt16BE(offset + 60);
    let fixed = 62;
    if (version === 3 && (flags & 0x4000) !== 0) fixed += 2;

    const pathStart = offset + fixed;
    const nameLength = flags & 0x0fff;
    let pathEnd: number;

    if (nameLength < 0x0fff) {
      pathEnd = pathStart + nameLength;
    } else {
      pathEnd = buffer.indexOf(0, pathStart);
      if (pathEnd === -1) return undefined;
    }

    if (pathEnd > buffer.length) return undefined;

    tracked.add(buffer.toString("utf8", pathStart, pathEnd));

    const entryLength = Math.ceil((fixed + (pathEnd - pathStart) + 1) / 8) * 8;
    offset += entryLength;
  }

  return tracked;
}

/* -------------------------------------------------------------------------- */
/*  File discovery                                                            */
/* -------------------------------------------------------------------------- */

function discoverFiles(root: string): {
  entries: SourceEntry[];
  ignoreFiles: IgnoreFile[];
  truncated: boolean;
} {
  const entries: SourceEntry[] = [];
  const ignoreFiles: IgnoreFile[] = [];
  let truncated = false;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const abs = path.join(dir, child.name);

      if (child.isDirectory()) {
        if (!SKIP_DIRS.has(child.name)) stack.push(abs);
        continue;
      }

      if (!child.isFile()) continue;

      if (child.name === ".gitignore") {
        try {
          ignoreFiles.push({
            dirAbs: dir,
            rules: parseIgnoreFile(fs.readFileSync(abs, "utf8")),
          });
        } catch {
          // An unreadable .gitignore only reduces accuracy.
        }
      }

      if (entries.length >= MAX_FILES) {
        truncated = true;
        continue;
      }

      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }

      entries.push({
        abs,
        rel: normalizePath(path.relative(root, abs)),
        size,
      });
    }
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return { entries, ignoreFiles, truncated };
}

function looksBinary(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, 8_000);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Detection                                                                 */
/* -------------------------------------------------------------------------- */

function allowed(meta: RuleMeta, sensitivity: Sensitivity): boolean {
  return SENSITIVITY_RANK[meta.tier] <= SENSITIVITY_RANK[sensitivity];
}

function decodeJwt(token: string): { expired: boolean; issuer?: string } | undefined {
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
      iss?: unknown;
    };

    const expired = typeof json.exp === "number" && json.exp * 1000 < Date.now();
    const issuer = typeof json.iss === "string" ? json.iss.slice(0, 60) : undefined;
    return { expired, issuer };
  } catch {
    return undefined;
  }
}

function detectPatternCandidates(line: string, sensitivity: Sensitivity): Candidate[] {
  const found: Candidate[] = [];

  for (const rule of PATTERN_RULES) {
    if (!allowed(rule, sensitivity)) continue;
    if (rule.hint && !rule.hint.some((hint) => line.includes(hint))) continue;

    for (const match of line.matchAll(rule.regex)) {
      const value = match[rule.group ?? 0];
      if (!value || match.index === undefined) continue;

      if (/EXAMPLE/.test(value) || uniqueRatio(value) < 0.25) continue;
      if (rule.validate && !rule.validate(value, line)) continue;

      const start = match.index + match[0].lastIndexOf(value);
      found.push({
        start,
        end: start + value.length,
        ruleId: rule.id,
        priority: PRIORITY.provider,
        value,
      });
    }
  }

  return found;
}

function detectConnectionStrings(line: string): Candidate[] {
  const found: Candidate[] = [];
  if (!line.includes("://")) return found;

  for (const match of line.matchAll(CONNECTION_STRING)) {
    const [, scheme, user, password, host] = match;
    if (match.index === undefined) continue;
    if (isPlaceholder(password) || isPlaceholder(user)) continue;
    if (/^(file|about|data|chrome|vscode|node|npm)$/i.test(scheme)) continue;

    const devDefault =
      DEV_HOSTS.test(host.replace(/^.*@/, "")) &&
      DEV_DEFAULT_PASSWORDS.has(password.toLowerCase());

    const start = match.index + match[0].indexOf(`:${password}@`) + 1;

    found.push({
      start,
      end: start + password.length,
      ruleId: "connection-string",
      priority: PRIORITY.provider,
      value: password,
      key: scheme.toLowerCase().startsWith("mongo")
        ? "MONGODB_URI"
        : scheme.toLowerCase().startsWith("redis")
          ? "REDIS_URL"
          : "DATABASE_URL",
      severity: devDefault ? "low" : undefined,
      note: devDefault ? "Looks like a common development default on a local host." : undefined,
    });
  }

  return found;
}

function detectTokens(line: string): Candidate[] {
  const found: Candidate[] = [];

  if (line.includes("eyJ")) {
    for (const match of line.matchAll(JWT_PATTERN)) {
      if (match.index === undefined) continue;
      const info = decodeJwt(match[1]);
      if (!info) continue;

      found.push({
        start: match.index,
        end: match.index + match[1].length,
        ruleId: "jwt",
        priority: PRIORITY.token,
        value: match[1],
        severity: info.expired ? "low" : undefined,
        note: info.expired
          ? "This token has already expired, but it still shows how tokens are handled in this project."
          : info.issuer
            ? `Issued by ${info.issuer}.`
            : undefined,
      });
    }
  }

  if (/authorization|auth/i.test(line)) {
    for (const match of line.matchAll(BEARER_PATTERN)) {
      const value = match[1];
      if (!value || match.index === undefined) continue;
      if (isPlaceholder(value) || /^[A-Za-z_$][\w$.]*$/.test(value) && value.length < 24) continue;

      const start = match.index + match[0].lastIndexOf(value);
      found.push({
        start,
        end: start + value.length,
        ruleId: "bearer-token",
        priority: PRIORITY.token,
        value,
      });
    }
  }

  return found;
}

function acceptKeywordValue(key: string, value: string): boolean {
  const keyWords = words(key);
  const last = keyWords[keyWords.length - 1];
  if (!last || EXCLUDED_KEY_SUFFIX.has(last)) return false;
  if (["is", "has", "should", "show", "use", "enable", "enabled"].includes(keyWords[0])) return false;

  if (isPlaceholder(value) || isLikelyPath(value)) return false;
  if (/\s/.test(value)) return false;

  const isPassword = /pass|pwd/i.test(key);
  const hasDigit = /[0-9]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasSymbol = /[^A-Za-z0-9]/.test(value);
  const entropy = shannon(value);

  // Letters joined by - _ or . are identifiers or words, not secrets,
  // unless the string is long and random-looking.
  if (
    /^[A-Za-z]+(?:[-_.][A-Za-z]+)*$/.test(value) &&
    !(hasUpper && hasLower && value.length >= 16 && entropy >= 4.0)
  ) {
    return false;
  }

  if (isPassword) {
    if (value.length < 8) return false;
    return hasDigit || hasSymbol || (hasUpper && hasLower) || entropy >= 3;
  }

  if (value.length < 12 || entropy < 3.0) return false;
  return hasDigit || (hasUpper && hasLower) || hasSymbol;
}

function detectKeywordAssignments(line: string, context: FileContext): Candidate[] {
  const found: Candidate[] = [];
  if (line.length < 10) return found;
  if (!/pass|pwd|secret|token|key|credential/i.test(line)) return found;

  for (const match of line.matchAll(QUOTED_ASSIGN)) {
    const key = match[1];
    const value = match[3];
    if (match.index === undefined || !acceptKeywordValue(key, value)) continue;

    const start = match.index + match[0].lastIndexOf(value);
    found.push({
      start,
      end: start + value.length,
      ruleId: /pass|pwd/i.test(key) ? "keyword-password" : "keyword-secret",
      priority: PRIORITY.keyword,
      value,
      key,
    });
  }

  if (context.isEnvLike && found.length === 0) {
    const match = UNQUOTED_ASSIGN.exec(line);

    if (match) {
      const key = match[1];
      const value = match[2].replace(/[,;]+$/, "");

      if (
        acceptKeywordValue(key, value) &&
        !/^(true|false|null|~)$/i.test(value)
      ) {
        const start = line.lastIndexOf(value);
        found.push({
          start,
          end: start + value.length,
          ruleId: /pass|pwd/i.test(key) ? "keyword-password" : "keyword-secret",
          priority: PRIORITY.keyword,
          value,
          key,
        });
      }
    }
  }

  return found;
}

function detectEntropyStrings(line: string): Candidate[] {
  const found: Candidate[] = [];

  if (/^\s*(import|export .* from|const .* = require)\b/.test(line)) return found;
  if (/integrity|sha(256|384|512)-|data:image|base64,|http[s]?:\/\//i.test(line)) return found;

  for (const match of line.matchAll(STRING_LITERAL)) {
    const value = match[2];
    if (match.index === undefined) continue;
    if (/^[a-f0-9]+$/i.test(value) && [32, 40, 64, 96, 128].includes(value.length)) continue;
    if (/^[a-z]+(-[a-z0-9]+)+$/.test(value) || /^[a-z]+(_[a-z0-9]+)+$/.test(value)) continue;
    if (/^[A-Z][a-z]+([A-Z][a-z0-9]+)+$/.test(value)) continue;
    if (isPlaceholder(value)) continue;

    const entropy = shannon(value);
    const mixed = /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
    if (entropy < 4.3 || !mixed) continue;

    const start = match.index + match[0].indexOf(value);
    found.push({
      start,
      end: start + value.length,
      ruleId: "entropy-string",
      priority: PRIORITY.entropy,
      value,
    });
  }

  return found;
}

function detectPrivateKey(
  lines: string[],
  index: number,
): { endLine: number; value: string; display: string } | undefined {
  const line = lines[index];
  const header = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----/.exec(line);
  if (!header || header.index === undefined) return undefined;

  let body = line.slice(header.index + header[0].length);
  let end = index;

  const footer = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
  let closed = footer.test(body);

  while (!closed && end + 1 < lines.length && end - index < 120) {
    end += 1;
    body += `\n${lines[end]}`;
    closed = footer.test(lines[end]);
  }

  const cleaned = body
    .replace(footer, "")
    .replace(/Proc-Type:.*|DEK-Info:.*/g, "")
    .replace(/\\n|\\r|\s+/g, "");

  if (cleaned.length < 40 || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) return undefined;
  if (uniqueRatio(cleaned.slice(0, 200)) < 0.1) return undefined;

  return {
    endLine: end,
    value: cleaned.slice(0, 200),
    display: `-----BEGIN ${header[1]}----- ${"•".repeat(8)} (${end - index + 1} line${end === index ? "" : "s"})`,
  };
}

function resolveOverlaps(candidates: Candidate[]): Candidate[] {
  const ordered = [...candidates].sort(
    (a, b) => b.priority - a.priority || a.start - b.start,
  );
  const accepted: Candidate[] = [];

  for (const candidate of ordered) {
    const overlaps = accepted.some(
      (other) => candidate.start < other.end && other.start < candidate.end,
    );
    if (!overlaps) accepted.push(candidate);
  }

  return accepted.sort((a, b) => a.start - b.start);
}

function redactLine(line: string, accepted: Candidate[]): string {
  let result = line;

  for (const candidate of [...accepted].sort((a, b) => b.start - a.start)) {
    const meta = RULE_META.get(candidate.ruleId);
    const mask = candidate.display ?? maskValue(candidate.value, meta?.keep ?? 0);
    result = `${result.slice(0, candidate.start)}${mask}${result.slice(candidate.end)}`;
  }

  const leading = result.length - result.trimStart().length;
  result = result.trim();

  if (result.length > 170) {
    // The first value keeps its position because replacements run from the end.
    const anchor = Math.max(
      0,
      Math.min(accepted[0].start - leading - 60, result.length - 170),
    );
    result = `${anchor > 0 ? "…" : ""}${result.slice(anchor, anchor + 170)}…`;
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Remediation                                                               */
/* -------------------------------------------------------------------------- */

type Language =
  | "js"
  | "python"
  | "go"
  | "java"
  | "ruby"
  | "php"
  | "csharp"
  | "rust"
  | "shell"
  | "yaml"
  | "docker"
  | "terraform"
  | "env"
  | "other";

function languageOf(file: string): Language {
  const base = path.posix.basename(file);
  const extension = path.posix.extname(base).toLowerCase();

  if (/^\.env/i.test(base) || extension === ".properties") return "env";
  if (base === "Dockerfile") return "docker";

  switch (extension) {
    case ".ts": case ".tsx": case ".js": case ".jsx": case ".mjs": case ".cjs": return "js";
    case ".py": return "python";
    case ".go": return "go";
    case ".java": case ".kt": case ".kts": case ".scala": return "java";
    case ".rb": return "ruby";
    case ".php": return "php";
    case ".cs": return "csharp";
    case ".rs": return "rust";
    case ".sh": case ".bash": case ".zsh": return "shell";
    case ".yml": case ".yaml": return "yaml";
    case ".tf": case ".tfvars": return "terraform";
    default: return "other";
  }
}

function afterSnippet(language: Language, envName: string, file: string): string {
  const camel = toCamel(envName);
  const snake = envName.toLowerCase();

  switch (language) {
    case "js":
      return `const ${camel} = process.env.${envName};\nif (!${camel}) throw new Error("${envName} is not set");`;
    case "python":
      return `import os\n\n${snake} = os.environ["${envName}"]`;
    case "go":
      return `${camel} := os.Getenv("${envName}")\nif ${camel} == "" {\n\tlog.Fatal("${envName} is not set")\n}`;
    case "java":
      return `String ${camel} = System.getenv("${envName}");`;
    case "ruby":
      return `${snake} = ENV.fetch("${envName}")`;
    case "php":
      return `$${camel} = getenv('${envName}');`;
    case "csharp":
      return `var ${camel} = Environment.GetEnvironmentVariable("${envName}");`;
    case "rust":
      return `let ${snake} = std::env::var("${envName}")?;`;
    case "shell":
      return `: "\${${envName}:?${envName} is not set}"`;
    case "yaml":
      return /(^|\/)\.github\/workflows\//.test(file)
        ? `\${{ secrets.${envName} }}`
        : `\${${envName}}`;
    case "docker":
      return `# Mount the secret at build time instead of storing it in the image\nRUN --mount=type=secret,id=${snake} \\\n    export ${envName}=$(cat /run/secrets/${snake}) && ./build.sh`;
    case "terraform":
      return `variable "${snake}" {\n  type      = string\n  sensitive = true\n}\n\n# Supply it with TF_VAR_${snake} or your secrets manager`;
    case "env":
      return `# Keep the real value in your secrets manager or CI settings.\n# Commit only a template with a placeholder:\n${envName}=replace-me`;
    default:
      return `# Read ${envName} from the environment or a secrets manager instead of the file`;
  }
}

function keyFileSnippet(language: Language): string {
  switch (language) {
    case "js":
      return `const privateKey = fs.readFileSync(process.env.PRIVATE_KEY_PATH!, "utf8");`;
    case "python":
      return `import os\n\nwith open(os.environ["PRIVATE_KEY_PATH"]) as handle:\n    private_key = handle.read()`;
    case "go":
      return `privateKey, err := os.ReadFile(os.Getenv("PRIVATE_KEY_PATH"))`;
    default:
      return `# Mount the key as a file at deploy time and read its path from PRIVATE_KEY_PATH`;
  }
}

function buildRemediation(
  meta: RuleMeta,
  group: Group,
  note?: string,
): SecretRemediation {
  const worst = [...group.locations].sort(
    (a, b) => EXPOSURE_RANK[a.exposure] - EXPOSURE_RANK[b.exposure],
  )[0];

  const committed = group.locations.some((location) => location.exposure === "committed");
  const onlyIgnored = group.locations.every((location) => location.exposure === "ignored");
  const fileCount = new Set(group.locations.map((location) => location.filePath)).size;

  const keyName = [...group.keyNames][0];
  const envName = meta.provider
    ? meta.envName ?? "SECRET"
    : toEnvName(keyName, meta.envName ?? "SECRET");

  const language = languageOf(worst.filePath);
  const after =
    meta.id === "private-key"
      ? keyFileSnippet(language)
      : afterSnippet(language, envName, worst.filePath);

  const steps: string[] = [];

  if (onlyIgnored) {
    steps.push(
      "This value sits in a file that git ignores, which is the right place for a local secret. Nothing to do unless the file was ever shared, uploaded, or committed in the past. If it was, rotate it.",
    );
  } else {
    steps.push(
      `Treat this value as compromised and rotate it first. ${meta.revoke ?? "Regenerate it with the service that issued it."}`,
    );
  }

  const where =
    fileCount === 1
      ? worst.filePath
      : fileCount === 2
        ? "both files"
        : `all ${fileCount} files`;

  if (!onlyIgnored) {
    steps.push(
      meta.id === "private-key"
        ? `Remove the key from ${where} and supply it at deploy time as a mounted file or a secret from your secrets manager (see the example).`
        : `Remove it from ${where} and read it from an environment variable or a secrets manager instead (see the example).`,
    );
  }

  if (worst.exposure !== "ignored" && /^\.env/i.test(path.posix.basename(worst.filePath))) {
    steps.push("Add this file to .gitignore, and run `git rm --cached` on it if it is already tracked.");
  }

  if (committed) {
    steps.push(
      "It is in git history. Rewriting history with `git filter-repo --replace-text` (or BFG) removes it from future clones, but copies that already exist keep it, which is why rotating comes first.",
    );
  }

  steps.push(
    "Add a secret scanner to a pre-commit hook and to CI so the next one is caught before it is pushed.",
  );

  const caveats: string[] = [];
  if (language === "js") {
    caveats.push(
      "Anything bundled into browser code is public. Prefixes such as VITE_ and NEXT_PUBLIC_ expose a variable to the browser, so keep secrets on a server and call that server from the client.",
    );
  }
  if (note) caveats.push(note);
  if (meta.id === "google-api-key") {
    caveats.push("Keys meant for the browser are acceptable if they are restricted to your domains and APIs.");
  }
  if (meta.id === "entropy-string") {
    caveats.push("If this is a public identifier or a hash, add `secret-detector:ignore` in a comment on that line.");
  }

  const exampleBefore = worst.lineText;
  const code = `// before\n${exampleBefore}\n\n// after\n${after}`;

  return {
    title: onlyIgnored ? "Keep it out of version control" : "Rotate it, then move it out of the code",
    summary: onlyIgnored
      ? "The value is stored where it belongs. Confirm it never reached a shared place."
      : committed
        ? "Because the value is in git, rotation is the only thing that makes it safe again."
        : "The value is in your working tree. Rotate it, move it out, and make sure it is never committed.",
    steps,
    code: meta.category === "sensitive-file" ? undefined : code,
    caveats,
  };
}

function buildFileRemediation(
  label: string,
  what: string,
  rel: string,
  exposure: Exposure,
): SecretRemediation {
  const base = path.posix.basename(rel);
  const committed = exposure === "committed";

  const steps = [
    `Add ${base === ".env" || base.startsWith(".env") ? "`.env*` (and `!.env.example`)" : `\`${base}\``} to .gitignore.`,
  ];

  if (committed) {
    steps.push(`Stop tracking it with \`git rm --cached ${rel}\` and commit the change.`);
    steps.push(
      `Rotate every credential stored in it. It is in git history, so anyone with the repository already has a copy.`,
    );
    steps.push(
      "Remove it from history with `git filter-repo --path " +
        rel +
        " --invert-paths` (or BFG) and force-push, then ask collaborators to re-clone.",
    );
  } else {
    steps.push("If it has ever been committed, pushed, or shared, rotate the credentials inside it.");
  }

  steps.push("Keep a copy with placeholder values (for example `.env.example`) so teammates know what to set.");

  return {
    title: committed
      ? `Stop tracking this ${label.toLowerCase()} and rotate what it holds`
      : `Make sure git ignores this ${label.toLowerCase()}`,
    summary: `Files of this kind normally hold ${what}. This one should not be in version control.`,
    steps,
    code: `# .gitignore\n${base.startsWith(".env") ? ".env\n.env.*\n!.env.example" : base}`,
    caveats: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Safeguards                                                                */
/* -------------------------------------------------------------------------- */

const SCANNER_NAMES = /gitleaks|trufflehog|detect-secrets|git-secrets|talisman|secretlint|ggshield|secret[-_ ]scan/i;

function readSmall(file: string): string {
  try {
    if (fs.statSync(file).size > 200_000) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function detectSafeguards(
  root: string,
  gitRoot: string | undefined,
  gitIgnore: GitIgnore,
): Safeguards {
  const preCommitSources = [
    path.join(root, ".pre-commit-config.yaml"),
    path.join(root, ".husky", "pre-commit"),
    path.join(root, "lefthook.yml"),
    path.join(root, "package.json"),
  ];

  const ciSources = [
    path.join(root, ".gitlab-ci.yml"),
    path.join(root, "azure-pipelines.yml"),
    path.join(root, ".circleci", "config.yml"),
    path.join(root, "Jenkinsfile"),
  ];

  try {
    const workflows = path.join(root, ".github", "workflows");
    for (const name of fs.readdirSync(workflows)) {
      if (/\.ya?ml$/i.test(name)) ciSources.push(path.join(workflows, name));
    }
  } catch {
    // No workflows folder.
  }

  return {
    gitRepository: gitRoot !== undefined,
    envFilesIgnored: gitIgnore.isIgnored(path.join(root, ".env")),
    preCommitScanner: preCommitSources.some((file) => SCANNER_NAMES.test(readSmall(file))),
    ciScanner: ciSources.some((file) => SCANNER_NAMES.test(readSmall(file))),
  };
}

/* -------------------------------------------------------------------------- */
/*  Main analysis                                                             */
/* -------------------------------------------------------------------------- */

export async function detectSecrets(
  projectPath: string,
  filePath?: string,
  options: {
    sensitivity?: Sensitivity;
    includeTests?: boolean;
  } = {},
): Promise<SecretReport> {
  const sensitivity = options.sensitivity ?? "balanced";
  const includeTests = options.includeTests ?? true;

  if (!(sensitivity in SENSITIVITY_RANK)) {
    throw new Error("sensitivity must be strict, balanced, or thorough.");
  }

  if (
    filePath !== undefined &&
    (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("filePath must be relative to projectPath.");
  }

  const resolvedProject = await resolveProjectPath(projectPath);
  const root = fs.realpathSync(resolvedProject.projectPath);
  const warnings: string[] = [];

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings were omitted.");
  };

  /* ---- Files and git state ---- */

  const discovered = discoverFiles(root);

  if (discovered.truncated) {
    warn(`Only the first ${MAX_FILES} files were scanned. Narrow the project path for complete results.`);
  }

  const gitRoot = findGitRoot(root);
  const tracked = gitRoot ? readTrackedFiles(gitRoot) : undefined;
  const prefix = gitRoot ? normalizePath(path.relative(gitRoot, root)) : "";

  if (gitRoot && !tracked) {
    warn(
      "Git was found but its index could not be read (it may use a newer format). Files are reported as untracked or ignored, but \"committed\" cannot be confirmed.",
    );
  }

  const ignoreFiles = [...discovered.ignoreFiles];

  if (gitRoot && gitRoot !== root) {
    let current = path.dirname(root);
    for (let depth = 0; depth < 8; depth++) {
      const file = path.join(current, ".gitignore");
      try {
        ignoreFiles.push({ dirAbs: current, rules: parseIgnoreFile(fs.readFileSync(file, "utf8")) });
      } catch {
        // No .gitignore at this level.
      }
      if (current === gitRoot) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const gitIgnore = new GitIgnore(gitRoot ?? root, ignoreFiles);

  const exposureCache = new Map<string, Exposure>();
  const exposureOf = (entry: SourceEntry): Exposure => {
    const cached = exposureCache.get(entry.rel);
    if (cached) return cached;

    let result: Exposure;
    const repoPath = prefix ? `${prefix}/${entry.rel}` : entry.rel;

    if (tracked?.has(repoPath)) result = "committed";
    else if (gitRoot && gitIgnore.isIgnored(entry.abs)) result = "ignored";
    else if (gitRoot && tracked) result = "untracked";
    else if (gitRoot) result = "unknown";
    else result = "unknown";

    exposureCache.set(entry.rel, result);
    return result;
  };

  const focus = filePath ? normalizePath(filePath).replace(/\/$/, "") : undefined;
  let entries = discovered.entries;

  if (focus) {
    entries = entries.filter((entry) => entry.rel === focus || entry.rel.startsWith(`${focus}/`));
    if (entries.length === 0) {
      throw new Error(`No scannable files were found at ${focus}.`);
    }
  }

  if (entries.length === 0) {
    throw new Error(`No files were found in ${root}.`);
  }

  /* ---- Scan ---- */

  const runKey = randomBytes(16);
  const fingerprint = (value: string) =>
    createHmac("sha256", runKey).update(value).digest("hex").slice(0, 12);

  const groups = new Map<string, Group>();
  const fileFindings: SecretFinding[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  let bytesScanned = 0;
  let entropyFindings = 0;
  let safeSensitiveFiles = 0;
  let entropyCapped = false;
  let findingsCapped = false;

  for (const entry of entries) {
    const base = path.posix.basename(entry.rel);
    const extension = path.posix.extname(base).toLowerCase();
    const exposure = exposureOf(entry);
    const context = fileContextFor(entry.rel, exposure);

    /* Sensitive files are reported by name, even when binary. */
    const sensitive = SENSITIVE_FILE_RULES.find((rule) => rule.test(base, entry.rel));

    if (sensitive && !context.isTemplate) {
      if (exposure === "ignored") {
        safeSensitiveFiles++;
      } else {
        const severity =
          exposure === "committed" ? sensitive.severity : downgrade(sensitive.severity, 1);

        fileFindings.push({
          id: fingerprint(`file:${entry.rel}`),
          ruleId: "sensitive-file",
          name: `${sensitive.label} is not ignored by git`,
          category: "sensitive-file",
          severity,
          confidence: "high",
          masked: base,
          length: 0,
          entropy: 0,
          description: `${entry.rel} normally holds ${sensitive.what}. ${
            exposure === "committed"
              ? "It is tracked by git, so it is part of the repository history."
              : exposure === "untracked"
                ? "It is not tracked yet, but nothing stops it from being committed."
                : "No .gitignore rule covers it."
          }`,
          exposure,
          committed: exposure === "committed",
          locations: [
            {
              filePath: entry.rel,
              line: 1,
              lineText: "(whole file)",
              exposure,
              severity,
              isTest: context.isTest,
              isDoc: false,
              isEnvFile: /^\.env/i.test(base),
            },
          ],
          hiddenLocations: 0,
          locationCount: 1,
          fileCount: 1,
          remediation: buildFileRemediation(sensitive.label, sensitive.what, entry.rel, exposure),
        });
      }
    }

    if (
      BINARY_EXTENSIONS.has(extension) ||
      LOCK_FILES.has(base) ||
      /\.min\.[cm]?(js|css)$/.test(base)
    ) {
      filesSkipped++;
      continue;
    }

    if (!includeTests && context.isTest) {
      filesSkipped++;
      continue;
    }

    if (entry.size > MAX_FILE_BYTES) {
      filesSkipped++;
      warn(`Skipped ${entry.rel} because it is larger than 1 MB.`);
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(entry.abs);
    } catch {
      filesSkipped++;
      continue;
    }

    if (looksBinary(buffer)) {
      filesSkipped++;
      continue;
    }

    filesScanned++;
    bytesScanned += buffer.length;

    const lines = buffer.toString("utf8").split(/\r?\n/);

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;

      /* Private keys span several lines. */
      if (line.includes("PRIVATE KEY")) {
        const key = detectPrivateKey(lines, index);

        if (key && !IGNORE_MARKER.test(line)) {
          const meta = RULE_META.get("private-key")!;
          const id = fingerprint(key.value);
          const severity = adjustSeverity(meta.severity, context);

          addLocation(groups, id, meta, PRIORITY.provider, key.value, undefined, undefined, {
            filePath: entry.rel,
            line: index + 1,
            lineText: key.display,
            exposure,
            severity,
            isTest: context.isTest,
            isDoc: context.isDoc,
            isEnvFile: context.isEnvLike && /^\.env/i.test(base),
          }, "high", "");

          index = key.endLine;
          continue;
        }
      }

      if (line.length > MAX_LINE_LENGTH) continue;
      if (index > 0 && IGNORE_MARKER.test(lines[index - 1])) continue;
      if (IGNORE_MARKER.test(line)) continue;

      let candidates: Candidate[] = [
        ...detectPatternCandidates(line, sensitivity),
        ...detectConnectionStrings(line),
        ...detectTokens(line),
      ];

      if (SENSITIVITY_RANK[sensitivity] >= SENSITIVITY_RANK.balanced) {
        candidates.push(...detectKeywordAssignments(line, context));
      }

      if (sensitivity === "thorough" && !entropyCapped) {
        candidates.push(...detectEntropyStrings(line));
      }

      if (candidates.length === 0) continue;

      candidates = resolveOverlaps(candidates);
      const redacted = redactLine(line, candidates);

      for (const candidate of candidates) {
        const meta = RULE_META.get(candidate.ruleId);
        if (!meta) continue;

        if (candidate.ruleId === "entropy-string") {
          if (entropyFindings >= MAX_ENTROPY_FINDINGS) {
            entropyCapped = true;
            continue;
          }
          entropyFindings++;
        }

        const id = fingerprint(candidate.value);
        const baseSeverity = candidate.severity ?? meta.severity;
        const severity = adjustSeverity(baseSeverity, context);

        addLocation(
          groups,
          id,
          meta,
          candidate.priority,
          candidate.value,
          candidate.key,
          candidate.note,
          {
            filePath: entry.rel,
            line: index + 1,
            lineText: redacted,
            exposure,
            severity,
            isTest: context.isTest,
            isDoc: context.isDoc,
            isEnvFile: context.isEnvLike && /^\.env/i.test(base),
          },
          meta.confidence,
          context.isTemplate || context.isDoc ? "low-context" : "",
        );
      }
    }
  }

  if (entropyCapped) {
    warn(
      `More than ${MAX_ENTROPY_FINDINGS} high-entropy strings were found. Only the first ${MAX_ENTROPY_FINDINGS} are listed. Use Balanced sensitivity to reduce noise.`,
    );
  }

  /* ---- Build findings ---- */

  const findings: SecretFinding[] = [];

  for (const group of groups.values()) {
    const sortedLocations = [...group.locations].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        EXPOSURE_RANK[a.exposure] - EXPOSURE_RANK[b.exposure] ||
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line,
    );

    const worstExposure = sortedLocations
      .map((location) => location.exposure)
      .sort((a, b) => EXPOSURE_RANK[a] - EXPOSURE_RANK[b])[0];

    const severity = sortedLocations
      .map((location) => location.severity)
      .reduce((a, b) => maxSeverity(a, b));

    findings.push({
      id: group.fingerprint,
      ruleId: group.meta.id,
      name: group.meta.name,
      provider: group.meta.provider,
      category: group.meta.category,
      severity,
      confidence: group.confidence,
      masked: group.masked,
      length: group.length,
      entropy: group.entropy,
      description: group.meta.description,
      note: group.note,
      exposure: worstExposure,
      committed: sortedLocations.some((location) => location.exposure === "committed"),
      locations: sortedLocations.slice(0, MAX_LOCATIONS_PER_FINDING),
      hiddenLocations: Math.max(0, sortedLocations.length - MAX_LOCATIONS_PER_FINDING),
      locationCount: sortedLocations.length,
      fileCount: new Set(sortedLocations.map((location) => location.filePath)).size,
      remediation: buildRemediation(group.meta, { ...group, locations: sortedLocations }, group.note),
    });
  }

  findings.push(...fileFindings);

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      EXPOSURE_RANK[a.exposure] - EXPOSURE_RANK[b.exposure] ||
      CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence) ||
      b.locationCount - a.locationCount ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

  if (findings.length > MAX_FINDINGS) {
    findingsCapped = true;
    findings.length = MAX_FINDINGS;
  }

  if (findingsCapped) {
    warn(`Only the ${MAX_FINDINGS} most serious findings are listed.`);
  }

  /* ---- Totals ---- */

  const summary: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  const categoryCounts: Record<SecretCategory, number> = {
    "provider-key": 0,
    token: 0,
    credential: 0,
    "private-key": 0,
    generic: 0,
    "sensitive-file": 0,
  };

  const hotspotMap = new Map<string, FileHotspot>();

  for (const finding of findings) {
    summary[finding.severity]++;
    categoryCounts[finding.category]++;

    for (const location of finding.locations) {
      const entry = hotspotMap.get(location.filePath) ?? {
        filePath: location.filePath,
        count: 0,
        topSeverity: "info" as Severity,
        committed: false,
      };

      entry.count++;
      entry.topSeverity = maxSeverity(entry.topSeverity, location.severity);
      entry.committed = entry.committed || location.exposure === "committed";
      hotspotMap.set(location.filePath, entry);
    }
  }

  const hotspots = [...hotspotMap.values()]
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.topSeverity) - SEVERITY_ORDER.indexOf(b.topSeverity) ||
        b.count - a.count ||
        a.filePath.localeCompare(b.filePath),
    )
    .slice(0, MAX_HOTSPOTS);

  return {
    success: true,
    tool: "detect_secrets",
    projectPath: root,
    filePath: focus,
    sensitivity,
    includeTests,
    redacted: true,
    filesScanned,
    filesSkipped,
    bytesScanned,
    gitDetected: gitRoot !== undefined,
    gitTrackingKnown: tracked !== undefined,
    totalSecrets: findings.length,
    totalLocations: findings.reduce((sum, finding) => sum + finding.locationCount, 0),
    committedCount: findings.filter((finding) => finding.committed).length,
    criticalHighCount: summary.critical + summary.high,
    sensitiveFileCount: fileFindings.length,
    safeSensitiveFiles,
    summary,
    categoryCounts,
    findings,
    hotspots,
    safeguards: detectSafeguards(root, gitRoot, gitIgnore),
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  Grouping                                                                  */
/* -------------------------------------------------------------------------- */

function adjustSeverity(base: Severity, context: FileContext): Severity {
  let steps = 0;

  if (context.exposure === "ignored") steps += 2;
  if (context.isTest) steps += 1;
  if (context.isDoc || context.isTemplate) steps += 1;

  return downgrade(base, steps);
}

function addLocation(
  groups: Map<string, Group>,
  fingerprintValue: string,
  meta: RuleMeta,
  priority: number,
  value: string,
  key: string | undefined,
  note: string | undefined,
  location: SecretLocation,
  confidence: Confidence,
  contextFlag: string,
): void {
  let group = groups.get(fingerprintValue);

  if (!group) {
    group = {
      fingerprint: fingerprintValue,
      meta,
      priority,
      masked:
        meta.id === "private-key"
          ? location.lineText.replace(/\s•+.*$/, "")
          : maskValue(value, meta.keep ?? 0),
      length: value.length,
      entropy: shannon(value),
      note,
      locations: [],
      keyNames: new Set(),
      confidence,
    };
    groups.set(fingerprintValue, group);
  } else if (priority > group.priority) {
    group.meta = meta;
    group.priority = priority;
    group.masked = maskValue(value, meta.keep ?? 0);
  }

  if (key) group.keyNames.add(key);
  if (note && !group.note) group.note = note;

  const effective: Confidence = contextFlag === "low-context" ? "low" : confidence;
  if (CONFIDENCE_ORDER.indexOf(effective) < CONFIDENCE_ORDER.indexOf(group.confidence)) {
    group.confidence = effective;
  }

  const duplicate = group.locations.some(
    (existing) => existing.filePath === location.filePath && existing.line === location.line,
  );
  if (!duplicate) group.locations.push(location);
}

/* -------------------------------------------------------------------------- */
/*  MCP registration                                                          */
/* -------------------------------------------------------------------------- */

export function registerDetectSecretsTool(server: McpServer) {
  server.registerTool(
    "detect_secrets",
    {
      description:
        "Find hard-coded secrets in a project: provider API keys and tokens (AWS, GitHub, Stripe, Slack, Google, OpenAI and more), private keys, passwords and credentials in connection strings, JWTs, and sensitive files such as .env that are not git-ignored. Every finding shows whether the file is committed to git, ignored, or untracked, with a masked preview, never the full value, plus the provider-specific steps to rotate it and a code example for moving it to an environment variable.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .describe("Absolute path to the project directory"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Optional file or folder, relative to projectPath. When set, only that file or folder is scanned.",
          ),
        sensitivity: z
          .enum(["strict", "balanced", "thorough"])
          .optional()
          .describe(
            "strict: known provider formats only. balanced (default): adds passwords and keyword assignments. thorough: adds high-entropy strings.",
          ),
        includeTests: z
          .boolean()
          .optional()
          .describe("Scan test, mock and fixture files. Default true."),
      }),
    },
    async ({ projectPath, filePath, sensitivity, includeTests }) => {
      try {
        const report = await detectSecrets(projectPath, filePath, {
          sensitivity,
          includeTests,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  tool: "detect_secrets",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to scan for secrets.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}

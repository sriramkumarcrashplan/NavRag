import fs from 'node:fs';
import deepmerge from 'deepmerge';

const packageJson = JSON.parse(fs.readFileSync('../package.json', 'utf8'));

const isFirefox = process.env.__FIREFOX__ === 'true';
const isOpera   = process.env.__OPERA__ === 'true';


const RAG_ORIGINS    = (process.env.RAG_ORIGINS    || 'https://parablu-rag-chatbot.parablu.com').split(',').map(s => s.trim()).filter(Boolean);
const OPENAI_ORIGINS = (process.env.OPENAI_ORIGINS || 'https://api.openai.com').split(',').map(s => s.trim()).filter(Boolean);
const GEMINI_ORIGINS = (process.env.GEMINI_ORIGINS || 'https://generativelanguage.googleapis.com').split(',').map(s => s.trim()).filter(Boolean);

// Build connect-src for extension pages (incl. service worker)
const CONNECT_SRC = ["'self'", ...RAG_ORIGINS, ...OPENAI_ORIGINS, ...GEMINI_ORIGINS].join(' ');

// Helper to normalize origins for host_permissions (ensure /* suffix, strip trailing slashes)
const withWildcard = (o) => `${o.replace(/\/+$/, '')}/*`;

/**
 * If you want to disable the sidePanel, delete withSidePanel and remove it below.
 */
function withSidePanel(manifest) {
  // Firefox does not support sidePanel
  if (isFirefox) return manifest;
  return deepmerge(manifest, {
    side_panel: {
      default_path: 'side-panel/index.html',
    },
    permissions: ['sidePanel'],
  });
}

/**
 * Opera sidebar support (harmless for Chrome).
 */
function withOperaSidebar(manifest) {
  if (isFirefox || !isOpera) return manifest;
  return deepmerge(manifest, {
    sidebar_action: {
      default_panel: 'side-panel/index.html',
      default_title: 'Crashplan Navigator',
      default_icon: 'icon-32.png',
    },
  });
}

/**
 * After changing, reload at chrome://extensions
 * @type {chrome.runtime.ManifestV3}
 */
const manifest = withOperaSidebar(
  withSidePanel({
    manifest_version: 3,
    default_locale: 'en',

    // i18n
    name: '__MSG_app_metadata_name__',
    version: packageJson.version,
    description: '__MSG_app_metadata_description__',

    // Content scripts currently target all pages; keep as-is or tighten later.
    host_permissions: [
      '<all_urls>',
      ...RAG_ORIGINS.map(withWildcard),
      ...OPENAI_ORIGINS.map(withWildcard),
      ...GEMINI_ORIGINS.map(withWildcard),
    ],

    permissions: ['storage', 'scripting', 'tabs', 'activeTab', 'debugger', 'unlimitedStorage', 'webNavigation'],

    // ✅ Critical: allow background + side panel to fetch OpenAI, Gemini, and RAG
    content_security_policy: {
      // Applies to extension pages (side panel, options) AND the MV3 service worker
      extension_pages: `script-src 'self'; object-src 'self'; connect-src ${CONNECT_SRC}`,
    },

    options_page: 'options/index.html',

    background: {
      service_worker: 'background.iife.js',
      type: 'module',
    },

    action: {
      default_icon: 'icon-32.png',
    },

    icons: {
      128: 'icon-128.png',
    },

    content_scripts: [
      {
        matches: ['http://*/*', 'https://*/*', '<all_urls>'],
        all_frames: true,
        js: ['content/index.iife.js'],
      },
    ],

    web_accessible_resources: [
      {
        resources: [
          '*.js',
          '*.css',
          '*.svg',
          'icon-128.png',
          'icon-32.png',
          'permission/index.html',
          'permission/permission.js',
        ],
        matches: ['*://*/*'],
      },
    ],
  }),
);

export default manifest;

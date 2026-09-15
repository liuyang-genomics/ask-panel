/**
 * Site definitions - THE FILE THAT NEEDS MAINTENANCE.
 *
 * Everything else here is stable. These selectors are not: each site is a
 * private SPA that reskins without notice, and a reskin breaks exactly one
 * entry below. Fixing it needs no JavaScript knowledge, only a CSS selector.
 *
 * To fix a broken site:
 *   node panel.mjs probe                  # which selector reads MISSING?
 *   node panel.mjs dump --sites <site>    # what the page actually shows
 * Then open that site in the browser, inspect the element, update the array.
 * Selectors are tried in order, so put the specific one first and leave the
 * generic one as a fallback.
 *
 * Fields:
 *   label     human name used in output
 *   match     regex identifying one of this site's tabs by URL
 *   newUrl    where to go to start a fresh conversation
 *   urlAsk    optional: build a URL that carries the question and self-submits.
 *             Used only for a fresh chat - never in --continue mode, where it
 *             would silently start a new thread and lose the site's context.
 *   input     composer element(s)
 *   send      send button(s)
 *   stop      "stop generating" button(s); presence means still generating
 *   answer    assistant turn(s); the last/longest match is the answer
 *   userMsg   user turn(s); a new one appearing proves the question was sent
 */

export const SITES = {
  chatgpt: {
    label: 'ChatGPT',
    match: /chatgpt\.com|chat\.openai\.com/,
    newUrl: 'https://chatgpt.com/',
    input: ['#prompt-textarea', 'div[contenteditable="true"]'],
    send: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send" i]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    answer: ['[data-message-author-role="assistant"]'],
    userMsg: ['[data-message-author-role="user"]'],
  },
  claude: {
    label: 'Claude',
    match: /claude\.ai/,
    newUrl: 'https://claude.ai/new',
    input: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
    send: ['button[aria-label*="Send" i]', 'button[type="submit"]'],
    stop: ['button[aria-label*="Stop" i]'],
    answer: ['.font-claude-response', '.font-claude-message', '[data-is-streaming] .grid-cols-1'],
    userMsg: ['[data-testid="user-message"]', '.font-user-message'],
  },
  gemini: {
    label: 'Gemini',
    match: /gemini\.google\.com/,
    newUrl: 'https://gemini.google.com/app',
    input: ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor', 'div[contenteditable="true"]'],
    send: ['button.send-button', 'button[aria-label*="Send" i]', 'button[mattooltip*="Send" i]'],
    stop: ['button[aria-label*="Stop" i]'],
    answer: ['model-response message-content', 'message-content.model-response-text', '.model-response-text'],
    userMsg: ['user-query'],
  },
  grok: {
    label: 'Grok',
    match: /grok\.com|x\.com\/i\/grok/,
    newUrl: 'https://grok.com/',
    input: ['textarea[aria-label*="Ask" i]', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[type="submit"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'],
    stop: ['button[aria-label*="Stop" i]'],
    answer: ['.message-bubble', '.response-content-markdown', '[data-message-author="assistant"]'],
    userMsg: ['[data-testid="user-message"]'],
  },
  deepseek: {
    label: 'DeepSeek',
    match: /deepseek\.com/,
    newUrl: 'https://chat.deepseek.com/',
    input: ['textarea#chat-input', 'textarea'],
    send: ['div[role="button"][aria-disabled="false"]', 'button[type="submit"]'],
    stop: [],
    answer: ['.ds-markdown', '._4f9bf79'],
    userMsg: ['._9663006', '.fbb737a4'],
  },
  perplexity: {
    label: 'Perplexity',
    match: /perplexity\.ai/,
    newUrl: 'https://www.perplexity.ai/',
    // Perplexity's Lexical editor refuses a synthetic paste, so a fresh question
    // goes in through its own query URL, which also self-submits.
    urlAsk: (q) => 'https://www.perplexity.ai/search/new?q=' + encodeURIComponent(q),
    input: ['div[contenteditable="true"]#ask-input', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[data-testid="submit-button"]', 'button[aria-label*="Submit" i]', 'button[type="submit"]'],
    stop: ['button[aria-label*="Stop" i]'],
    answer: ['[id^="markdown-content-"]', '.prose'],
    userMsg: [],
  },
};

/** The subset of a site definition that gets shipped into the page. */
export const bare = (s) => ({
  input: s.input, send: s.send, stop: s.stop, answer: s.answer, userMsg: s.userMsg || [],
});

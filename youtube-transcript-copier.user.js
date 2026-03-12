// ==UserScript==
// @name         YouTube Transcript Copier (Optimized SPA Version)
// @match        https://www.youtube.com/*
// @license      MIT
// @grant        GM.setClipboard
// @version      1.3
// @author       WanderingMeow, Amir Tehrani
// @description  (Updated for new YouTube UI) Adds a styled button to copy the YouTube video transcript, with a timestamp toggle. Works on playlist pages and now, also soft-navigation.
// @namespace    https://greasyfork.org/
// @icon         https://www.google.com/s2/favicons?domain=youtube.com
// ==/UserScript==

/**
 * @file YouTube Transcript Copier — Userscript
 *
 * Injects a "Copy Transcript" button onto YouTube watch pages.
 * Clicking the button programmatically opens the transcript panel,
 * scrolls it to load all lazy-rendered segments, extracts the text,
 * and copies it to the clipboard.
 *
 * A nested pill button toggles whether `[mm:ss]` timestamps are
 * included in the output.
 *
 * @license MIT
 */

(function () {
    'use strict';

    // =====================================================================
    //  Configuration
    // =====================================================================

    /**
     * Static CSS selectors for the various DOM elements the script
     * interacts with or creates.
     *
     * @readonly
     * @type {Object.<string, string>}
     */
    const SEL = {
        /** Transcript panel candidates (first match wins). */
        PANEL_PRIMARY: 'ytd-macro-markers-list-renderer > #content, ytd-macro-markers-list-renderer',
        PANEL_FALLBACK: 'ytd-engagement-panel-section-list-renderer #content',
        /** Any transcript segment that confirms the panel is loaded. */
        HAS_SEGMENTS: 'transcript-segment-view-model',

        /** Structural elements inside the transcript panel. */
        SECTION: 'ytd-item-section-renderer',
        CHAPTER_TITLE: 'h3.ytwTimelineChapterViewModelTitle',
        SEGMENT: 'transcript-segment-view-model',
        SEGMENT_FALLBACK: 'ytd-transcript-segment-renderer',
        TIMESTAMP: '.ytwTranscriptSegmentViewModelTimestamp',
        TEXT: 'span.yt-core-attributed-string',

        /** YouTube chrome buttons. */
        MORE_ACTIONS: 'button[aria-label="More actions"]',
        SHOW_TRANSCRIPT: '[aria-label="Show transcript"]',

        /** Robust list of potential targets to handle different YouTube layouts (e.g., playlist vs. standard). */
        BUTTON_TARGETS: [
            '#owner', // Reliable on both layouts, next to channel info
            '#above-the-fold #actions-inner', // Reliable on both layouts, inside like/share container
            '#top-row.ytd-watch-metadata', // Reliable fallback
            '#meta-contents', // Original target, works on non-playlist pages
            '#above-the-fold', // Final fallback
        ],

        /** DOM id used to deduplicate the injected stylesheet. */
        STYLE_ID: 'yt-transcript-button-styles',
    };

    /**
     * Timeouts (ms) for polling loops that wait for UI elements to appear.
     *
     * @readonly
     * @type {Object.<string, number>}
     */
    const TIMEOUT = {
        /** Max time waiting for the "Show transcript" button. */
        BUTTON_FOUND: 10_000,
        /** Max time waiting for the transcript panel to render. */
        PANEL_LOADED: 15_000,
        /** Poll interval — transcript button search. */
        BUTTON_POLL: 250,
        /** Poll interval — transcript panel search. */
        PANEL_POLL: 1000,
        /** Retry interval for injecting the copy button. */
        BUTTON_CREATE: 500,
        /** Duration of the "Copied!" success flash. */
        SUCCESS_FLASH: 1_500,
        /** Delay before auto-selecting text in the fallback modal. */
        MODAL_SELECT: 100,
        /** Poll interval while auto-scrolling the transcript panel. */
        SCROLL_POLL: 300,
        /** Max iterations for the auto-scroll loop. */
        SCROLL_MAX_ITERATIONS: 200,
        /** Time to wait for segments to load after each scroll. */
        SCROLL_LOAD_WAIT: 400,
    };

    // =====================================================================
    //  Mutable state
    // =====================================================================

    /**
     * Reference to the injected `<button>` element, or `null` when absent.
     * @type {HTMLButtonElement | null}
     */
    let copyButton = null;

    /**
     * Reference to the `Text` node holding the button's label.
     * @type {Text | null}
     */
    let buttonTextNode = null;

    /**
     * Whether the user wants `[mm:ss]` timestamps in the copied output.
     * @type {boolean}
     */
    let includeTimestamps = false;

    /**
     * Interval id for the button-creation retry loop, or `null`.
     * @type {number | null}
     */
    let createRetryId = null;

    /**
     * Interval id for the "Show transcript" button poll, or `null`.
     * @type {number | null}
     */
    let buttonPollId = null;

    /**
     * Timeout id for the "Show transcript" button search, or `null`.
     * @type {number | null}
     */
    let buttonTimeoutId = null;

    /**
     * Interval id for the transcript-panel poll, or `null`.
     * @type {number | null}
     */
    let panelPollId = null;

    /**
     * Timeout id for the transcript-panel search, or `null`.
     * @type {number | null}
     */
    let panelTimeoutId = null;

    // =====================================================================
    //  Initialization
    // =====================================================================

    /**
     * Boot the script: listen for YouTube's SPA navigation events and
     * perform an initial run for the current page.
     */
    function init() {
        // Listen for YouTube's internal finish event to trigger the script
        window.addEventListener('yt-navigate-finish', onNavigate);
        onNavigate();
    }

    /**
     * Fires on every in-app navigation (including the initial page load).
     * Tears down any previous state and, on `/watch` pages, injects
     * (or schedules injection of) the copy button.
     *
     * @returns {void}
     */
    function onNavigate() {
        resetState();

        // Check if we are on a video page
        if (window.location.pathname === '/watch') {
            if (!createButton()) {
                createRetryId = setInterval(retryCreate, TIMEOUT.BUTTON_CREATE);
            }
        }
    }

    /**
     * Attempt to create the button; clear the retry loop on success.
     *
     * @returns {void}
     */
    function retryCreate() {
        if (createButton()) {
            clearInterval(createRetryId);
            createRetryId = null;
        }
    }

    // =====================================================================
    //  DOM Utilities
    // =====================================================================

    /**
     * Return `el.textContent.trim()`, or `''` when `el` is `null`.
     *
     * @param {Element | null} el
     * @returns {string}
     */
    function textOf(el) {
        return el ? el.textContent.trim() : '';
    }

    /**
     * Query `parent.querySelectorAll(selector)` and return the first
     * element that is currently visible in the layout
     * (`offsetParent !== null`), or `null` if none qualify.
     *
     * @param {ParentNode}   parent
     * @param {string}       selector
     * @returns {Element | null}
     */
    function firstVisible(parent, selector) {
        for (const el of parent.querySelectorAll(selector)) {
            if (el.offsetParent !== null) return el;
        }
        return null;
    }

    // =====================================================================
    //  Transcript Panel Detection
    // =====================================================================

    /**
     * Locate the transcript container once the panel has opened.
     *
     * The primary selector matches the modern YouTube transcript renderer
     * (`ytd-macro-markers-list-renderer`).  The fallback catches older
     * markup under `ytd-engagement-panel-section-list-renderer`.
     * Both are validated by checking for at least one
     * `transcript-segment-view-model` descendant.
     *
     * @returns {HTMLElement | null} The panel element, or `null` if not found / not yet loaded.
     */
    function findPanel() {
        let panel = document.querySelector(SEL.PANEL_PRIMARY);
        if (panel && panel.querySelector(SEL.HAS_SEGMENTS)) return panel;

        panel = document.querySelector(SEL.PANEL_FALLBACK);
        if (panel && panel.querySelector(SEL.HAS_SEGMENTS)) return panel;

        return null;
    }

    /**
     * Find the scrollable container inside the transcript panel.
     *
     * YouTube's transcript uses lazy-loading: segments are only
     * rendered when they enter the scroll viewport.  This function
     * locates the element with `overflow-y: auto|scroll` so we can
     * programmatically scroll it to force-load every segment.
     *
     * @param {HTMLElement} panel - The transcript panel element.
     * @returns {HTMLElement} The scrollable container, or `panel` as a fallback.
     */
    function findScrollableContainer(panel) {
        const candidates = [
            'ytd-transcript-segment-list-renderer',
            'ytd-transcript-renderer',
            'ytd-engagement-panel-section-list-renderer',
        ];

        for (const sel of candidates) {
            const el = panel.querySelector(sel);
            if (el) {
                const cs = getComputedStyle(el);
                if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
                    return /** @type {HTMLElement} */ (el);
                }
            }
        }

        // Walk all descendants looking for any scrollable element.
        for (const el of panel.querySelectorAll('*')) {
            const cs = getComputedStyle(/** @type {HTMLElement} */(el));
            if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
                return /** @type {HTMLElement} */ (el);
            }
        }

        return panel;
    }

    /**
     * Count every transcript segment currently in the DOM, checking
     * both the modern and legacy segment selectors.
     *
     * @param {HTMLElement} panel
     * @returns {number}
     */
    function countSegments(panel) {
        return panel.querySelectorAll(`${SEL.SEGMENT}, ${SEL.SEGMENT_FALLBACK}`).length;
    }

    // =====================================================================
    //  Auto-scroll — force lazy-loaded segments to render
    // =====================================================================

    /**
     * Return a `Promise` that resolves after `ms` milliseconds.
     *
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Scroll the transcript panel to the bottom in steps, waiting after
     * each step for YouTube to lazily render new segments.  Continues
     * until the segment count stabilises (no new segments for two
     * consecutive checks) and the container has reached `scrollTopMax`.
     *
     * After loading is complete the container is scrolled back to the
     * top so that the panel looks untouched.
     *
     * @param {HTMLElement} panel - The transcript panel element.
     * @returns {Promise<void>} Resolves when all segments are loaded.
     */
    async function autoScrollPanel(panel) {
        const container = findScrollableContainer(panel);
        let previousCount = 0;
        let stableRounds = 0;

        for (let i = 0; i < TIMEOUT.SCROLL_MAX_ITERATIONS; i++) {
            container.scrollTop = container.scrollHeight;
            await delay(TIMEOUT.SCROLL_LOAD_WAIT);

            const currentCount = countSegments(panel);

            if (currentCount > previousCount) {
                // New segments appeared — keep scrolling.
                previousCount = currentCount;
                stableRounds = 0;
            } else {
                stableRounds++;
            }

            // Two consecutive stable rounds *and* the container is
            // scrolled all the way down → we're done.
            const atBottom =
                container.scrollHeight - container.scrollTop - container.clientHeight < 2;
            if (stableRounds >= 2 && atBottom) break;
        }

        // Scroll back to top so the panel looks normal.
        container.scrollTop = 0;
        await delay(200);
    }

    // =====================================================================
    //  Text Builders
    // =====================================================================

    /**
     * Build the formatted transcript string.
     *
     * Delegates to {@link buildTimestamped} or {@link buildPlain}
     * depending on the current `includeTimestamps` state.
     *
     * @param {HTMLElement} panel - The transcript panel returned by {@link findPanel}.
     * @returns {string} Formatted transcript text, or `''` if no segments were found.
     */
    function buildText(panel) {
        return includeTimestamps ? buildTimestamped(panel) : buildPlain(panel);
    }

    /**
     * Build a transcript string **with** `[mm:ss]` timestamps.
     *
     * Structure inside each `ytd-item-section-renderer`:
     * ```
     * #header  →  h3.ytwTimelineChapterViewModelTitle   (optional chapter label)
     * #contents
     *     └── transcript-segment-view-model
     *           ├── .ytwTranscriptSegmentViewModelTimestamp
     *           └── span.yt-core-attributed-string
     * ```
     *
     * @param {HTMLElement} panel
     * @returns {string}
     */
    function buildTimestamped(panel) {
        const lines = /** @type {string[]} */ ([]);
        let firstChapter = true;

        for (const section of panel.querySelectorAll(SEL.SECTION)) {
            const chapter = textOf(section.querySelector(SEL.CHAPTER_TITLE));

            if (chapter) {
                if (!firstChapter) lines.push('');
                lines.push(`## ${chapter}`, '');
                firstChapter = false;
            }

            for (const seg of section.querySelectorAll(SEL.SEGMENT)) {
                const text = textOf(seg.querySelector(SEL.TEXT));
                if (!text) continue;

                const ts = textOf(seg.querySelector(SEL.TIMESTAMP));
                lines.push(ts ? `[${ts}]  ${text}` : text);
            }
        }

        return lines.join('\n');
    }

    /**
     * Build a transcript string **without** timestamps.
     *
     * Segments within each chapter are joined with spaces into a
     * continuous paragraph, preserving chapter headings as Markdown
     * `##` headers.
     *
     * @param {HTMLElement} panel
     * @returns {string}
     */
    function buildPlain(panel) {
        const parts = /** @type {string[]} */ ([]);
        let firstChapter = true;

        for (const section of panel.querySelectorAll(SEL.SECTION)) {
            const chapter = textOf(section.querySelector(SEL.CHAPTER_TITLE));

            if (chapter) {
                if (!firstChapter) parts.push('', '');
                parts.push(`## ${chapter}`, '');
                firstChapter = false;
            }

            const words = /** @type {string[]} */ ([]);
            for (const seg of section.querySelectorAll(SEL.SEGMENT)) {
                const text = textOf(seg.querySelector(SEL.TEXT));
                if (text) words.push(text);
            }

            parts.push(words.join(' '));
        }

        return parts.join('\n');
    }

    // =====================================================================
    //  Button — creation & insertion
    // =====================================================================

    /**
     * Create the "Copy Transcript" button (with the timestamp pill) and
     * attempt to insert it into the page.
     *
     * Returns `true` on success, `false` if no suitable insertion point
     * was found (the caller should retry later).
     *
     * @returns {boolean}
     */
    function createButton() {
        if (document.getElementById('show-transcript-button')) return true;

        copyButton = document.createElement('button');
        copyButton.id = 'show-transcript-button';
        copyButton.classList.add('yt-transcript-button');
        copyButton.setAttribute('aria-label', 'Copy Transcript');

        buttonTextNode = document.createTextNode('Copy Transcript');
        copyButton.appendChild(buttonTextNode);

        const pill = createPill();
        copyButton.appendChild(pill);
        copyButton.addEventListener('click', onButtonClick);

        return insertButton();
    }

    /**
     * Create the small "(No Time)" / "(Time)" pill that sits inside the
     * main button and toggles timestamp inclusion.
     *
     * @returns {HTMLSpanElement}
     */
    function createPill() {
        const pill = document.createElement('span');
        pill.id = 'timestamp-toggle';
        pill.textContent = ' (No Time)';
        pill.style.cssText = `
            font-size: 0.75em;
            margin-left: 6px;
            color: rgba(255, 255, 255, 0.7);
            cursor: pointer;
            user-select: none;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 12px;
            padding: 3px 6px;
            display: inline-block;
            vertical-align: middle;
            transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
            background-color: rgba(0, 0, 0, 0.1);
        `;

        pill.addEventListener('mouseover', function () {
            this.style.borderColor = 'rgba(255, 255, 255, 0.9)';
            this.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
        });
        pill.addEventListener('mouseout', function () {
            this.style.borderColor = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.3)';
            this.style.backgroundColor = includeTimestamps ? 'rgba(0,0,0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
        });

        return pill;
    }

    /**
     * Delegated click handler for the copy button.
     *
     * If the click lands on the timestamp pill, toggle the mode and
     * stop propagation.  Otherwise, kick off the copy workflow.
     *
     * @param {MouseEvent} event
     * @returns {void}
     */
    function onButtonClick(event) {
        const pill = /** @type {HTMLElement | null} */
            (document.getElementById('timestamp-toggle'));

        if (pill && pill.contains(/** @type {Node} */(event.target))) {
            toggleTimestamps(pill);
            event.stopPropagation();
            event.preventDefault();
            return;
        }

        handleCopy();
    }

    /**
     * Toggle the `includeTimestamps` flag and update the pill's label
     * and active-state styling.
     *
     * @param {HTMLElement} pill - The timestamp toggle pill element.
     * @returns {void}
     */
    function toggleTimestamps(pill) {
        includeTimestamps = !includeTimestamps;

        pill.textContent = includeTimestamps ? ' (Time)' : ' (No Time)';
        pill.style.color = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.7)';
        pill.style.borderColor = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.3)';
        pill.style.backgroundColor = includeTimestamps ? 'rgba(0,0,0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
    }

    /**
     * Walk the priority-ordered target list and insert the copy button
     * immediately after the first visible candidate.
     *
     * Injects the stylesheet on the first successful insertion.
     *
     * @returns {boolean} `true` if the button was inserted.
     */
    function insertButton() {
        for (const sel of SEL.BUTTON_TARGETS) {
            const targetElement = firstVisible(document, sel);
            // Check if the element exists AND is visible before inserting the button.
            if (targetElement && targetElement.parentNode) {
                targetElement.parentNode.insertBefore(/** @type {Node} */(copyButton), targetElement.nextSibling);
                injectStyles();
                return true;
            }
        }
        return false;
    }

    // =====================================================================
    //  Clipboard operations
    // =====================================================================

    /**
     * High-level copy handler.
     *
     * Orchestrates the full workflow:
     * 1. Flash "Copying…" on the button.
     * 2. Temporarily hide the playlist panel (avoids targeting conflicts).
     * 3. Click "More actions" → "Show transcript".
     * 4. Poll until the transcript panel is loaded.
     * 5. Auto-scroll the panel to force-load all lazy segments.
     * 6. Build and copy the text.
     *
     * @returns {void}
     */
    function handleCopy() {
        setButtonState('Copying…');

        // Temporarily hide the playlist panel so "More actions" targets
        // the video (not the playlist).
        const playlistPanel = /** @type {HTMLElement | null} */
            (document.querySelector('ytd-playlist-panel-renderer#playlist'));
        if (playlistPanel) playlistPanel.style.display = 'none';

        const moreActions = document.querySelector(SEL.MORE_ACTIONS);
        if (!moreActions) {
            setError('Error');
            if (playlistPanel) playlistPanel.style.display = '';
            return;
        }
        moreActions.click();

        // Poll for the "Show transcript" button in the opened menu.
        buttonPollId = setInterval(() => {
            const btn = document.querySelector(SEL.SHOW_TRANSCRIPT);
            if (!btn) return;

            clearInterval(buttonPollId);
            clearTimeout(buttonTimeoutId);
            btn.click();

            // Now poll for the panel to fully render.
            panelPollId = setInterval(async () => {
                const panel = findPanel();
                if (!panel) return;

                clearInterval(panelPollId);
                clearTimeout(panelTimeoutId);

                try {
                    // Give the panel a moment to initialise its scroll
                    // container, then auto-scroll to load every segment.
                    await delay(500);
                    setButtonState('Loading…');
                    await autoScrollPanel(panel);

                    const text = buildText(panel);
                    if (text) {
                        tryCopy(text);
                    } else {
                        setError('No Text Found');
                    }
                } catch {
                    setError('Scroll Error');
                } finally {
                    if (playlistPanel) playlistPanel.style.display = '';
                }
            }, TIMEOUT.PANEL_POLL);

            panelTimeoutId = setTimeout(() => {
                clearInterval(panelPollId);
                setError('Transcript Not Found');
                if (playlistPanel) playlistPanel.style.display = '';
            }, TIMEOUT.PANEL_LOADED);
        }, TIMEOUT.BUTTON_POLL);

        buttonTimeoutId = setTimeout(() => {
            clearInterval(buttonPollId);
            setError('Transcript Not Found');
            if (playlistPanel) playlistPanel.style.display = '';
        }, TIMEOUT.BUTTON_FOUND);
    }

    /**
     * Copy `text` to the clipboard using a fallback chain:
     *
     * 1. **GM.setClipboard** — preferred in userscript environments.
     * 2. **navigator.clipboard.writeText** — standard async API
     *    (requires secure context).
     * 3. **document.execCommand('copy')** — legacy synchronous API.
     * 4. **Manual-copy modal** — last resort when all APIs fail.
     *
     * @param {string} text - The transcript text to copy.
     * @returns {void}
     */
    function tryCopy(text) {
        // 1. Greasemonkey / Tampermonkey API.
        if (typeof GM !== 'undefined' && typeof GM.setClipboard === 'function') {
            try {
                GM.setClipboard(text, 'text');
                setSuccess();
                return;
            } catch {
                // Fall through to next method.
            }
        }

        // 2. Modern async Clipboard API.
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text)
                .then(setSuccess)
                .catch(() => {
                    if (!fallbackCopy(text)) showModal(text);
                });
            return;
        }

        // 3. Legacy execCommand → 4. Modal fallback.
        if (!fallbackCopy(text)) {
            showModal(text);
        }
    }

    /**
     * Attempt to copy via the deprecated `document.execCommand('copy')`.
     *
     * Creates an off-screen `<textarea>`, selects its content, and
     * issues the copy command.  The element is removed immediately.
     *
     * @param {string} text - Text to copy.
     * @returns {boolean} `true` if `execCommand` reported success.
     */
    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        ta.style.cssText = 'position:fixed;top:20px;left:20px;z-index:2147483647;width:1px;height:1px;opacity:0.01;';
        ta.contentEditable = 'true';

        document.body.appendChild(ta);
        ta.focus();
        ta.setSelectionRange(0, ta.value.length);

        const ok = document.execCommand('copy');
        ta.remove();

        if (ok) setSuccess();
        return ok;
    }

    /**
     * Show a full-screen overlay modal with the transcript in a
     * `<textarea>` so the user can select-and-copy manually.
     *
     * @param {string} text - The transcript text to display.
     * @returns {void}
     */
    function showModal(text) {
        document.getElementById('yt-transcript-modal-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'yt-transcript-modal-overlay';
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 2147483647;
            background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
            display: flex; align-items: center; justify-content: center;
            font-family: 'Roboto', sans-serif;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: #1e1e1e; color: #e0e0e0; border-radius: 16px;
            width: 90%; max-width: 700px; max-height: 80vh;
            display: flex; flex-direction: column;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
            border: 1px solid rgba(255,255,255,0.1);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex; align-items: center; justify-content: space-between;
            padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1);
        `;

        const title = document.createElement('span');
        title.textContent = 'Transcript \u2014 Select All & Copy (Ctrl+C / Cmd+C)';
        title.style.cssText = 'font-size: 16px; font-weight: 500;';
        header.appendChild(title);

        const closeX = makeButton('\u2715', {
            'background': 'rgba(255,255,255,0.1)', 'border': 'none',
            'color': '#e0e0e0', 'width': '32px', 'height': '32px',
            'border-radius': '50%', 'cursor': 'pointer', 'font-size': '16px',
            'display': 'flex', 'align-items': 'center', 'justify-content': 'center',
        }, 'rgba(255,80,80,0.4)', 'rgba(255,255,255,0.1)');
        closeX.onclick = () => overlay.remove();
        header.appendChild(closeX);
        modal.appendChild(header);

        // Textarea
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.readOnly = true;
        textarea.style.cssText = `
            flex: 1; min-height: 300px; margin: 0; padding: 16px 20px;
            background: transparent; color: #e0e0e0; border: none;
            font-family: 'DM Mono', 'Courier New', monospace; font-size: 13px;
            line-height: 1.6; resize: none; outline: none;
            white-space: pre-wrap; word-wrap: break-word;
        `;
        modal.appendChild(textarea);

        // Footer
        const footer = document.createElement('div');
        footer.style.cssText = `
            display: flex; justify-content: flex-end; gap: 10px;
            padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.1);
        `;

        const selectAll = makeButton('Select All', {
            'background': 'rgba(0,123,255,0.8)', 'border': 'none',
            'color': 'white', 'padding': '8px 20px', 'border-radius': '20px',
            'cursor': 'pointer', 'font-size': '14px', 'font-weight': '500',
        }, 'rgba(0,90,180,0.9)', 'rgba(0,123,255,0.8)');
        selectAll.onclick = () => { textarea.focus(); textarea.select(); };
        footer.appendChild(selectAll);

        const closeBtn = makeButton('Close', {
            'background': 'rgba(255,255,255,0.1)', 'border': 'none',
            'color': '#e0e0e0', 'padding': '8px 20px', 'border-radius': '20px',
            'cursor': 'pointer', 'font-size': '14px', 'font-weight': '500',
        }, 'rgba(255,255,255,0.2)', 'rgba(255,255,255,0.1)');
        closeBtn.onclick = () => overlay.remove();
        footer.appendChild(closeBtn);

        modal.appendChild(footer);
        overlay.appendChild(modal);

        // Dismiss interactions
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const onEsc = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); } };
        document.addEventListener('keydown', onEsc);

        document.body.appendChild(overlay);

        setTimeout(() => { textarea.focus(); textarea.select(); }, TIMEOUT.MODAL_SELECT);

        setButtonState('Copy Manually');
    }

    /**
     * Create a `<button>` element with inline base styles and hover /
     * mouseout transitions.
     *
     * @param   {string}              label       Text content.
     * @param   {Object.<string, string>} base    CSS declarations applied directly.
     * @param   {string}              hoverBg     Background colour on hover.
     * @param   {string}              [restBg]    Background colour on mouseout (defaults to `base.background`).
     * @returns {HTMLButtonElement}
     */
    function makeButton(label, base, hoverBg, restBg) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = Object.entries(base).map(([k, v]) => `${k}:${v}`).join(';') + '; transition: background 0.2s;';
        const initial = restBg || base.background || '';
        btn.onmouseover = () => { btn.style.background = hoverBg; };
        btn.onmouseout = () => { btn.style.background = initial; };
        return btn;
    }

    // =====================================================================
    //  Button state helpers
    // =====================================================================

    /**
     * Update the button label.
     *
     * - `"Copied!"` — flash green, then revert to "Copy Transcript"
     *   after {@link TIMEOUT.SUCCESS_FLASH}.
     * - Any other text — set label, revert to "Copy Transcript" after
     *   the same delay (unless an error state is active).
     *
     * @param {string} text
     * @returns {void}
     */
    function setButtonState(text) {
        if (!buttonTextNode || !copyButton) return;
        buttonTextNode.textContent = text;
        if (text === "Copied!") {
            copyButton.style.backgroundColor = "rgba(40, 167, 69, 0.9)";
        }
        setTimeout(() => {
            if (buttonTextNode) buttonTextNode.textContent = 'Copy Transcript';
            if (copyButton) copyButton.style.backgroundColor = 'rgba(0, 123, 255, 0.8)';
        }, TIMEOUT.SUCCESS_FLASH);
    }

    /**
     * Set the button to a persistent error state (red) with the given label.
     *
     * @param {string} label - Error message shown on the button.
     * @returns {void}
     */
    function setError(label) {
        if (!buttonTextNode || !copyButton) return;
        buttonTextNode.textContent = label;
        copyButton.style.backgroundColor = 'rgba(220, 53, 69, 0.8)';
    }

    /**
     * Convenience: flash "Copied!" in green.
     *
     * @returns {void}
     */
    function setSuccess() {
        setButtonState('Copied!');
    }

    // =====================================================================
    //  CSS
    // =====================================================================

    /**
     * Inject the `<style>` block that styles the copy button.
     * Safe to call multiple times — a second call is a no-op.
     *
     * @returns {void}
     */
    function injectStyles() {
        if (document.getElementById(SEL.STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = SEL.STYLE_ID;
        style.textContent = `
            .yt-transcript-button {
                background-color: rgba(0, 123, 255, 0.8);
                border: none;
                color: white;
                padding: 10px 18px;
                text-align: center;
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                font-size: 15px;
                margin: 4px 2px;
                cursor: pointer;
                border-radius: 24px;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                font-family: 'Roboto', sans-serif;
                font-weight: 500;
                position: relative;
                overflow: hidden;
            }

            .yt-transcript-button:hover {
                background-color: rgba(0, 90, 180, 0.9);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                transform: translateY(-1px);
            }

            .yt-transcript-button:focus {
                outline: none;
                box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.3);
            }
        `;
        document.head.appendChild(style);
    }

    // =====================================================================
    //  Cleanup
    // =====================================================================

    /**
     * Remove the copy button and clear every active interval / timeout.
     * Called before each navigation to prevent stale references.
     *
     * @returns {void}
     */
    function resetState() {
        document.getElementById('show-transcript-button')?.remove();
        clearInterval(createRetryId);
        clearInterval(buttonPollId);
        clearTimeout(buttonTimeoutId);
        clearInterval(panelPollId);
        clearTimeout(panelTimeoutId);
        createRetryId = null;
        buttonPollId = null;
        buttonTimeoutId = null;
        panelPollId = null;
        panelTimeoutId = null;
        copyButton = null;
        buttonTextNode = null;
    }

    // =====================================================================
    //  Boot
    // =====================================================================

    init();
})();

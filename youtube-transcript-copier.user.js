// ==UserScript==
// @name         YouTube Transcript Copier (Button Only...for now!)
// @match        https://www.youtube.com/watch*
// @grant        none
// @version      1.1
// @author       Amir Tehrani
// @description  Adds a styled button to copy the YouTube video transcript, with a timestamp toggle. Now works on playlist pages.
// @namespace    https://greasyfork.org/
// @icon         https://www.google.com/s2/favicons?domain=youtube.com
// ==/UserScript==

(function() {
    'use strict';

    let observer = null;
    let currentURL = window.location.href;
    let insertionAttempts = 0;
    const maxAttempts = 20;
    let retryInterval = null;
    let includeTimestamps = false; // Default: no timestamps
    let copyButton = null;
    let buttonTextNode = null;
    let transcriptPanelTimeout = null; // Timeout for panel loading
    let transcriptButtonTimeout = null; // Timeout for the "Show transcript" button

    function createTranscriptButton() {
        if (document.getElementById('show-transcript-button')) {
            return true;
        }

        copyButton = document.createElement('button');
        copyButton.id = 'show-transcript-button';
        copyButton.classList.add('yt-transcript-button');
        copyButton.setAttribute('aria-label', 'Copy Transcript'); // Accessibility

        buttonTextNode = document.createTextNode('Copy Transcript');
        copyButton.appendChild(buttonTextNode);

        const timestampSpan = document.createElement('span');
        timestampSpan.id = 'timestamp-toggle';
        timestampSpan.textContent = ' (No Time)';
        timestampSpan.style.cssText = `
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

        timestampSpan.addEventListener('mouseover', function() {
            this.style.borderColor = 'rgba(255, 255, 255, 0.9)';
            this.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
        });
        timestampSpan.addEventListener('mouseout', function() {
            this.style.borderColor = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.3)';
            this.style.backgroundColor = includeTimestamps ? 'rgba(0,0,0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
        });

        copyButton.appendChild(timestampSpan);

        timestampSpan.addEventListener('click', function(event) {
            event.stopPropagation(); // Prevent main button click
            includeTimestamps = !includeTimestamps;
            this.textContent = includeTimestamps ? ' (Time)' : ' (No Time)';
            this.style.color = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.7)';
            this.style.borderColor = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.3)';
            this.style.backgroundColor = includeTimestamps ? 'rgba(0,0,0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
        });

        copyButton.addEventListener('click', handleCopyClick);

        return insertButton();
    }

    function insertButton() {
        // Robust list of potential targets to handle different YouTube layouts (e.g., playlist vs. standard).
        const potentialTargets = [
            '#owner', // Reliable on both layouts, next to channel info
            '#above-the-fold #actions-inner', // Reliable on both layouts, inside like/share container
            '#top-row.ytd-watch-metadata', // Reliable fallback
            '#meta-contents', // Original target, works on non-playlist pages
            '#above-the-fold' // Final fallback
        ];

        for (const targetSelector of potentialTargets) {
            const targetElement = document.querySelector(targetSelector);
            // Check if the element exists AND is visible before inserting the button.
            if (targetElement && targetElement.offsetParent !== null) {
                targetElement.parentNode.insertBefore(copyButton, targetElement.nextSibling);
                injectStyles();
                return true;
            }
        }
        return false;
    }

    function handleCopyClick() {
        updateButtonText('Copying...');

        const playlistPanel = document.querySelector('ytd-playlist-panel-renderer#playlist');

        // This function will be called to restore the UI to its original state.
        function cleanup() {
            if (playlistPanel) {
                playlistPanel.style.display = ''; // Restore playlist visibility
            }
        }

        // On playlist pages, the playlist panel conflicts with the transcript panel.
        // Temporarily hide it to allow the transcript to load.
        if (playlistPanel) {
            playlistPanel.style.display = 'none';
        }

        const moreActionsButton = document.querySelector('button[aria-label="More actions"]');
        if (!moreActionsButton) {
            console.error("Could not find 'More actions' button.");
            updateButtonText("Error");
            copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            cleanup(); // Ensure cleanup happens on early failure
            return;
        }
        moreActionsButton.click();

        const buttonIntervalId = setInterval(() => {
            const transcriptButton = document.querySelector('[aria-label="Show transcript"]');
            if (transcriptButton) {
                transcriptButton.click();
                clearInterval(buttonIntervalId);
                clearTimeout(transcriptButtonTimeout);

                const panelIntervalId = setInterval(() => {
                    const transcriptPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #content');
                    if (transcriptPanel && transcriptPanel.querySelector('ytd-transcript-segment-renderer')) {
                        clearInterval(panelIntervalId);
                        clearTimeout(transcriptPanelTimeout);
                        copyTranscriptText(transcriptPanel, cleanup); // Pass cleanup to the next function
                    }
                }, 100);

                transcriptPanelTimeout = setTimeout(() => {
                    clearInterval(panelIntervalId);
                    console.error("Transcript panel or segments not found after timeout.");
                    if (copyButton) {
                        updateButtonText("Transcript Not Found");
                        copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
                    }
                    cleanup(); // Cleanup on timeout
                }, 15000);
            }
        }, 250);

        transcriptButtonTimeout = setTimeout(() => {
            clearInterval(buttonIntervalId);
            if (copyButton) {
                updateButtonText("Transcript Not Found")
                copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            }
            console.error("Transcript button not found after timeout.");
            cleanup(); // Cleanup on timeout
        }, 10000);
    }

    function copyTranscriptText(transcriptPanel, cleanupCallback) {
        if (!transcriptPanel) {
            console.error("Transcript container not found.");
            updateButtonText("Error");
            if (cleanupCallback) cleanupCallback();
            return;
        }

        let transcriptText = "";

        if (includeTimestamps) {
            transcriptPanel.querySelectorAll('ytd-transcript-segment-renderer').forEach(line => {
                const timestampElement = line.querySelector('.segment-timestamp');
                const textElement = line.querySelector('.segment-text');
                if (timestampElement && textElement) {
                    transcriptText += timestampElement.textContent.trim() + " " + textElement.textContent.trim() + "\n";
                }
            });
        } else {
            transcriptPanel.querySelectorAll('.segment-text').forEach(segment => {
                transcriptText += segment.textContent.trim() + " ";
            });
        }

        navigator.clipboard.writeText(transcriptText)
            .then(() => {
              updateButtonText("Copied!");
              if (cleanupCallback) cleanupCallback(); // Cleanup on success
            })
            .catch(err => {
                console.error('Failed to copy transcript:', err);
                if (copyButton) {
                    updateButtonText("Copy Failed");
                    copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
                }
                if (cleanupCallback) cleanupCallback(); // Cleanup on failure
            });
    }

    function updateButtonText(text) {
        if (copyButton && buttonTextNode) {
            buttonTextNode.textContent = text;
            if (text === "Copied!") {
                copyButton.style.backgroundColor = "rgba(40, 167, 69, 0.9)";
                  setTimeout(() => {
                        buttonTextNode.textContent = 'Copy Transcript';
                         copyButton.style.backgroundColor = 'rgba(0, 123, 255, 0.8)';

                         const timestampToggle = document.getElementById('timestamp-toggle');
                         if (timestampToggle) {
                             timestampToggle.textContent = includeTimestamps ? ' (Time)' : ' (No Time)';
                             timestampToggle.style.color = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.7)';
                             timestampToggle.style.borderColor = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.3)';
                             timestampToggle.style.backgroundColor = includeTimestamps ? 'rgba(0,0,0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
                         }
                    }, 1500);
            } else if (text.startsWith("Error") || text === "Copy Failed" || text === "Transcript Not Found") {
                 copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            }
        }
    }

    function injectStyles() {
        if (document.getElementById('yt-transcript-button-styles')) return;

        const style = document.createElement('style');
        style.id = 'yt-transcript-button-styles';
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
                will-change: transform, box-shadow, background-color;
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

            .yt-transcript-button:active {
                background-color: rgba(0, 60, 120, 0.9);
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
                transform: translateY(1px);
            }
        `;
        document.head.appendChild(style);
    }

    function attemptButtonCreation() {
        insertionAttempts++;
        if (createTranscriptButton() || insertionAttempts >= maxAttempts) {
            clearInterval(retryInterval);
            retryInterval = null;
            if (insertionAttempts >= maxAttempts) {
                console.error('Could not insert the button after multiple attempts.');
            }
        }
    }

    function setupObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver(handleMutations);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function handleMutations(mutations) {
        if (window.location.href !== currentURL) {
            currentURL = window.location.href;
            resetState();
            startProcess();
        }
    }

    function resetState() {
        const button = document.getElementById('show-transcript-button');
        if (button) {
            button.remove();
        }
        insertionAttempts = 0;
        if (retryInterval) {
            clearInterval(retryInterval);
            retryInterval = null;
        }
        clearTimeout(transcriptPanelTimeout);
        clearTimeout(transcriptButtonTimeout);
        transcriptPanelTimeout = null;
        transcriptButtonTimeout = null;

        if (observer) {
          observer.disconnect();
          observer = null;
        }

        copyButton = null;
        buttonTextNode = null;
    }

    function startProcess() {
        if (!createTranscriptButton()) {
            retryInterval = setInterval(attemptButtonCreation, 500);
        }
        setupObserver();
    }

    startProcess();
})();

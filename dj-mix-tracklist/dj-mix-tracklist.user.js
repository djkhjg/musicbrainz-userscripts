// ==UserScript==
// @name         MusicBrainz: Better DJ Mix Tracklist display
// @namespace    https://musicbrainz.org/
// @version      1.0.0
// @description  Display DJ-mix relationships as a numbered tracklist using MusicBrainz relationship ordering.
// @homepageURL  https://github.com/djkhjg/musicbrainz-userscripts
// @supportURL   https://github.com/djkhjg/musicbrainz-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/djkhjg/musicbrainz-userscripts/main/dj-mix-tracklist/dj-mix-tracklist.user.js
// @updateURL    https://raw.githubusercontent.com/djkhjg/musicbrainz-userscripts/main/dj-mix-tracklist/dj-mix-tracklist.user.js
// @match        *://*.musicbrainz.org/release/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function getReleaseMBID() {
        const match = location.pathname.match(
            /^\/release\/([0-9a-f-]{36})/
        );

        return match ? match[1] : null;
    }

    function getRecordingMBID(link) {
        const match = link.href.match(
            /\/recording\/([0-9a-f-]{36})/
        );

        return match ? match[1] : null;
    }

    /*
     * Retrieve DJ-mix ordering from the MusicBrainz API.
     *
     * Map format:
     *
     *     recording MBID -> ordering-key
     */
    async function getDJMixOrdering() {
        const releaseMBID = getReleaseMBID();

        if (!releaseMBID) {
            return new Map();
        }

        const url =
            `/ws/2/release/${releaseMBID}` +
            '?fmt=json&inc=recordings+recording-rels+recording-level-rels';

        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(
                    `MusicBrainz API returned ${response.status}`
                );
            }

            const data = await response.json();
            const ordering = new Map();

            for (const medium of data.media || []) {
                for (const track of medium.tracks || []) {
                    const recording = track.recording;

                    if (!recording || !recording.relations) {
                        continue;
                    }

                    for (const relation of recording.relations) {
                        if (
                            relation.type !== 'DJ-mix' ||
                            relation.direction !== 'forward' ||
                            relation['target-type'] !== 'recording'
                        ) {
                            continue;
                        }

                        const targetMBID = relation.recording?.id;
                        const order = relation['ordering-key'];

                        if (
                            targetMBID &&
                            order !== undefined &&
                            order !== null &&
                            Number.isFinite(Number(order))
                        ) {
                            ordering.set(
                                targetMBID,
                                Number(order)
                            );
                        }
                    }
                }
            }

            console.log(
                'MusicBrainz: Better DJ Mix Tracklist display: Retrieved ordering:',
                ordering
            );

            return ordering;

        } catch (error) {
            console.error(
                'MusicBrainz: Better DJ Mix Tracklist display: API error:',
                error
            );

            return new Map();
        }
    }

    function processDJMixes(ordering) {
        const labels = document.querySelectorAll(
            '.title.wrap-anywhere .ars dl.ars > dt'
        );

        labels.forEach(dt => {
            if (dt.textContent.trim() !== 'DJ-mix of:') {
                return;
            }

            const dd = dt.nextElementSibling;

            if (!dd || dd.dataset.djMixProcessed) {
                return;
            }

            const recordingLinks = [
                ...dd.querySelectorAll('a[href^="/recording/"]')
            ];

            if (!recordingLinks.length) {
                return;
            }

            const nodes = [...dd.childNodes];

            const starts = recordingLinks.map(link => {
                const previous = link.previousSibling;

                if (
                    previous &&
                    previous.nodeType === Node.ELEMENT_NODE &&
                    previous.classList.contains('recordinglink')
                ) {
                    return nodes.indexOf(previous);
                }

                /*
                 * Fallback in case MusicBrainz ever changes its markup.
                 */
                return nodes.indexOf(link);
            });

            const list = document.createElement('div');
            list.className = 'mb-dj-mix-tracklist';

            starts.forEach((start, i) => {
                const end =
                    i + 1 < starts.length
                        ? starts[i + 1]
                        : nodes.length;

                const item = document.createElement('div');
                item.className = 'mb-dj-mix-track';

                const recordingMBID =
                    getRecordingMBID(recordingLinks[i]);

                /*
                 * Create the displayed relationship order.
                 */
                const order = document.createElement('span');
                order.className = 'mb-dj-mix-order';

                if (
                    recordingMBID &&
                    ordering.has(recordingMBID)
                ) {
                    order.textContent =
                        ordering.get(recordingMBID) + '.';
                } else {
                    order.textContent = '?.';
                    item.classList.add('mb-dj-mix-unordered');
                }

                item.appendChild(order);

                const content = document.createElement('span');
                content.className = 'mb-dj-mix-content';

                /*
                 * Copy this entire relationship, starting with its
                 * recording icon and ending immediately before the
                 * next recording icon.
                 */
                for (let j = start; j < end; j++) {
                    const node = nodes[j];

                    /*
                     * Remove the comma MusicBrainz uses between
                     * inline relationships.
                     */
                    if (
                        j === end - 1 &&
                        node.nodeType === Node.TEXT_NODE
                    ) {
                        const text =
                            node.textContent.replace(/(?:,|\band\b)\s*$/i, '');

                        if (text) {
                            content.appendChild(
                                document.createTextNode(text)
                            );
                        }

                        continue;
                    }

                    content.appendChild(node.cloneNode(true));
                }

                /*
                 * Hide recording/artist disambiguation comments.
                 */
                content.querySelectorAll('.comment').forEach(comment => {
                    comment.remove();
                });

                item.appendChild(content);
                list.appendChild(item);
            });

            /*
             * Put the tracklist on a new line after "DJ-mix of:".
             */
            const br = document.createElement('br');

            dd.replaceChildren(br, list);

            dd.classList.add('mb-dj-mix-list');
            dt.classList.add('mb-dj-mix-label');

            dd.dataset.djMixProcessed = 'true';
        });
    }

    const style = document.createElement('style');

    style.textContent = `
        .title.wrap-anywhere .ars dl.ars > dd.mb-dj-mix-list {
            display: block;
            margin-left: 2.5em;
        }

        .mb-dj-mix-tracklist {
            margin: 0.15em 0 0.25em 0;
        }

        .mb-dj-mix-track {
            display: flex;
            align-items: baseline;
            margin: 0;
            padding: 0;
            line-height: 1.35;
        }

        .mb-dj-mix-order {
            flex: 0 0 2em;
            text-align: right;
            margin-right: 0.5em;
        }

        .mb-dj-mix-content {
            flex: 1;
            min-width: 0;
        }
    `;

    document.head.appendChild(style);

    /*
     * One API request per release page.
     */
    getDJMixOrdering().then(ordering => {
        processDJMixes(ordering);

        /*
         * Subsequent DOM updates reuse the data already retrieved.
         */
        const observer = new MutationObserver(() => {
            processDJMixes(ordering);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });

})();
